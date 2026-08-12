import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { useContainerManager, useDockerService } from "./services";
import { useWorkerConfigStore } from "./worker-config-store";

interface ConsoleSession {
  id: string;
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

/** Interactive console sessions for the management MCP. Sessions attach to a
 * linked tmux session inside one resolved worker; they never execute on the
 * orchestrator host. Output is bounded in memory and sessions expire on idle. */
export class ManagementConsoleStore {
  private readonly sessions = new Map<string, ConsoleSession>();

  async open(workerId: string, windowIndex = 0) {
    this.sweep();
    if (this.sessions.size >= MAX_SESSIONS)
      throw statusError(429, "Too many management console sessions");
    const worker = useContainerManager().get(workerId);
    if (!worker || worker.status !== "running" || !worker.containerId)
      throw statusError(409, "Target worker is not running");
    if (!Number.isSafeInteger(windowIndex) || windowIndex < 0)
      throw statusError(400, "windowIndex must be a non-negative integer");
    const attached = await useDockerService().execAttachTmuxWindow(
      worker.containerId,
      windowIndex,
    );
    const session: ConsoleSession = {
      id: randomUUID(),
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

  async read(id: string, from?: number) {
    const session = this.get(id);
    const requested = Number.isInteger(from) ? Math.max(0, Number(from)) : session.offset;
    const start = Math.max(requested, session.offset);
    const index = start - session.offset;
    this.touch(session);
    let output = session.output.subarray(index).toString("utf8");
    const worker = useContainerManager().get(session.workerId);
    if (worker) {
      const configured = await useWorkerConfigStore().resolveValues(
        worker.userId,
        worker.id,
      );
      for (const item of configured) {
        if (item.kind === "variable" || item.value.length < 4) continue;
        output = output.split(item.value).join("[REDACTED]");
      }
    }
    return {
      ...this.public(session),
      from: start,
      nextOffset: session.offset + session.output.length,
      truncated: requested < session.offset,
      output,
    };
  }

  write(id: string, input: string) {
    const session = this.get(id);
    if (session.state !== "open") throw statusError(409, "Console session is closed");
    if (typeof input !== "string" || Buffer.byteLength(input) > 64 * 1024)
      throw statusError(400, "Console input must be at most 64 KiB");
    session.stream.write(input);
    this.touch(session);
    return { id, workerId: session.workerId, acceptedBytes: Buffer.byteLength(input) };
  }

  interrupt(id: string) {
    return this.write(id, "\x03");
  }

  async close(id: string) {
    const session = this.get(id);
    this.sessions.delete(id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.state = "closed";
    session.stream.end();
    await useDockerService().killTmuxSession(
      session.dockerContainerId,
      session.tmuxSession,
    );
    return { id, workerId: session.workerId, state: "closed" as const };
  }

  async closeAll() {
    await Promise.allSettled([...this.sessions].map(([id]) => this.close(id)));
  }

  private get(id: string) {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) throw statusError(404, "Console session not found");
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
    for (const session of expired) void this.close(session.id).catch(() => {});
  }

  private touch(session: ConsoleSession) {
    session.touchedAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => void this.close(session.id).catch(() => {}),
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
