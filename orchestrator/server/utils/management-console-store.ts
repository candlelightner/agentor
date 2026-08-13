import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { useContainerManager, useDockerService } from "./services";
import {
  redactManagedBufferSlice,
  workerOutputRedactionValues,
} from "./worker-output-redaction";

interface ConsoleSession {
  id: string;
  /** Management workspace which created this linked tmux session. */
  workspaceId: string;
  workerId: string;
  dockerContainerId: string;
  tmuxSession: string;
  stream: Duplex;
  output: Buffer;
  offset: number;
  openedAt: string;
  touchedAt: number;
  state: "open" | "closed" | "failed";
  error?: string;
  idleTimer?: NodeJS.Timeout;
}

const MAX_OUTPUT = 1024 * 1024;
const MAX_SESSIONS = 16;
const IDLE_MS = 15 * 60_000;
/** Docker exec/attach calls can wait forever when a worker is being rebuilt.
 * Keep MCP requests bounded so stale workers produce a useful error. */
const DOCKER_OPERATION_TIMEOUT_MS = 15_000;

async function withTimeout<T>(
  operation: Promise<T>,
  message: string,
  timeoutMs = DOCKER_OPERATION_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(statusError(504, message)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Interactive console sessions for the management MCP. Sessions attach to a
 * linked tmux session inside one resolved worker; they never execute on the
 * orchestrator host. Output is bounded in memory and sessions expire on idle. */
export class ManagementConsoleStore {
  private readonly sessions = new Map<string, ConsoleSession>();

  async open(workspaceId: string, workerId: string, windowIndex = 0) {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS)
      throw statusError(429, "Too many management console sessions");
    const worker = useContainerManager().get(workerId);
    if (!worker || worker.status !== "running" || !worker.containerId)
      throw statusError(409, "Target worker is not running");
    if (!Number.isSafeInteger(windowIndex) || windowIndex < 0)
      throw statusError(400, "windowIndex must be a non-negative integer");
    const attached = await withTimeout(
      useDockerService().execAttachTmuxWindow(worker.containerId, windowIndex),
      "Opening console session timed out; verify the worker is running and retry.",
    );
    const session: ConsoleSession = {
      id: randomUUID(),
      workspaceId,
      workerId,
      dockerContainerId: worker.containerId,
      tmuxSession: attached.tmuxSession,
      stream: attached.stream,
      output: Buffer.alloc(0),
      offset: 0,
      openedAt: new Date().toISOString(),
      touchedAt: Date.now(),
      state: "open",
    };
    this.sessions.set(session.id, session);
    this.touch(session);
    attached.stream.on("data", (chunk: Buffer) => this.append(session, chunk));
    attached.stream.on("end", () => {
      void this.finish(session, "closed");
    });
    attached.stream.on("error", () => {
      session.error = "Worker console stream failed";
      void this.finish(session, "failed");
    });
    return this.public(session);
  }

  async read(workspaceId: string, id: string, from?: number) {
    const session = this.get(workspaceId, id);
    const requested = Number.isInteger(from)
      ? Math.max(0, Number(from))
      : session.offset;
    const start = Math.max(requested, session.offset);
    this.touch(session);
    let slice = {
      output: session.output.subarray(start - session.offset).toString("utf8"),
      start: start - session.offset,
      safeEnd: session.output.length,
    };
    const worker = useContainerManager().get(session.workerId);
    if (worker) {
      slice = redactManagedBufferSlice(
        session.output,
        start - session.offset,
        await workerOutputRedactionValues(worker),
        session.offset > 0,
      );
    }
    return {
      ...this.public(session),
      from: session.offset + slice.start,
      nextOffset: session.offset + slice.safeEnd,
      truncated: requested < session.offset,
      output: slice.output,
    };
  }

  write(workspaceId: string, id: string, input: string) {
    const session = this.get(workspaceId, id);
    if (session.state !== "open")
      throw statusError(409, "Console session is closed");
    if (typeof input !== "string" || Buffer.byteLength(input) > 64 * 1024)
      throw statusError(400, "Console input must be at most 64 KiB");
    session.stream.write(input);
    this.touch(session);
    return {
      id,
      workerId: session.workerId,
      acceptedBytes: Buffer.byteLength(input),
    };
  }

  interrupt(workspaceId: string, id: string) {
    return this.write(workspaceId, id, "\x03");
  }

  async close(workspaceId: string, id: string) {
    const session = this.get(workspaceId, id);
    this.sessions.delete(id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.state = "closed";
    session.stream.end();
    await withTimeout(
      useDockerService().killTmuxSession(
        session.dockerContainerId,
        session.tmuxSession,
      ),
      "Closing console session timed out; it may already be stale.",
      5_000,
    ).catch(() => undefined);
    return { id, workerId: session.workerId, state: "closed" as const };
  }

  async closeAll() {
    await Promise.allSettled(
      [...this.sessions.values()].map((session) =>
        this.close(session.workspaceId, session.id),
      ),
    );
  }
  target(workspaceId: string, id: string): string | undefined {
    const session = this.sessions.get(id);
    return session?.workspaceId === workspaceId ? session.workerId : undefined;
  }

  private get(workspaceId: string, id: string) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) throw statusError(404, "Console session not found");
    // Do not reveal whether a valid session exists to another administrative
    // workspace. This remains useful if Agentor ever supports more than its
    // current singleton trusted workspace.
    if (session.workspaceId !== workspaceId)
      throw statusError(404, "Console session not found");
    return session;
  }

  private append(session: ConsoleSession, chunk: Buffer) {
    session.output = Buffer.concat([session.output, Buffer.from(chunk)]);
    if (session.output.length > MAX_OUTPUT) {
      const removed = session.output.length - MAX_OUTPUT;
      session.output = session.output.subarray(removed);
      session.offset += removed;
    }
    this.touch(session);
  }

  private sweep() {
    const expired = [...this.sessions.values()].filter(
      (session) => Date.now() - session.touchedAt > IDLE_MS,
    );
    for (const session of expired)
      void this.close(session.workspaceId, session.id).catch(() => {});
  }

  private touch(session: ConsoleSession) {
    session.touchedAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.close(session.workspaceId, session.id).catch(() => {}),
      IDLE_MS,
    );
    session.idleTimer.unref?.();
  }

  private async finish(session: ConsoleSession, state: "closed" | "failed") {
    if (!this.sessions.delete(session.id)) return;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.state = state;
    await useDockerService()
      .killTmuxSession(session.dockerContainerId, session.tmuxSession)
      .catch(() => {});
  }

  private public(session: ConsoleSession) {
    return {
      id: session.id,
      workerId: session.workerId,
      state: session.state,
      openedAt: session.openedAt,
      ...(session.error ? { error: session.error } : {}),
    };
  }
}

function statusError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

let singleton: ManagementConsoleStore | undefined;
export function useManagementConsoleStore() {
  return (singleton ??= new ManagementConsoleStore());
}
