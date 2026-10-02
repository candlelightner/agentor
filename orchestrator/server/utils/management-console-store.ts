import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { useContainerManager, useDockerService } from "./services";
import { instanceControlPlaneCoordinator } from "./instance-snapshot-gate";
import { operationSettlement, type OperationFailureWithSettlement, withOperationDeadline } from "./operation-deadline";
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
  requestFinish: () => void;
  cleanup: Promise<void>;
}

const MAX_OUTPUT = 1024 * 1024;
const MAX_SESSIONS = 16;
const IDLE_MS = 15 * 60_000;
/** Docker exec/attach calls can wait forever when a worker is being rebuilt.
 * Keep MCP requests bounded so stale workers produce a useful error. */
const DOCKER_OPERATION_TIMEOUT_MS = 15_000;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Interactive console sessions for the management MCP. Sessions attach to a
 * linked tmux session inside one resolved worker; they never execute on the
 * orchestrator host. Output is bounded in memory and sessions expire on idle. */
export class ManagementConsoleStore {
  private readonly sessions = new Map<string, ConsoleSession>();
  private activeLifetimes = 0;

  async open(workspaceId: string, workerId: string, windowIndex = 0) {
    return instanceControlPlaneCoordinator.run(() => this.openAdmitted(workspaceId, workerId, windowIndex));
  }

  private async openAdmitted(workspaceId: string, workerId: string, windowIndex: number) {
    this.sweep();
    if (this.activeLifetimes >= MAX_SESSIONS)
      throw statusError(429, "Too many management console sessions");
    const worker = useContainerManager().get(workerId);
    if (!worker || worker.status !== "running" || !worker.containerId)
      throw statusError(409, "Target worker is not running");
    if (!Number.isSafeInteger(windowIndex) || windowIndex < 0)
      throw statusError(400, "windowIndex must be a non-negative integer");
    const dockerContainerId = worker.containerId;
    const ready = deferred<ConsoleSession>();
    const lifetime = instanceControlPlaneCoordinator.fork();
    this.activeLifetimes++;
    let abandoned = false;
    let pendingSession: ConsoleSession | undefined;
    // This thunk owns attach, the live session, and all final cleanup. Timer
    // and stream callbacks only signal it; they never borrow a stale request's
    // context or attempt fresh admission after the barrier has closed.
    const cleanup: Promise<void> = lifetime.run(async () => {
      try {
        const attached = await useDockerService().execAttachTmuxWindow(dockerContainerId, windowIndex);
        const finish = deferred<void>();
        const session: ConsoleSession = {
          id: randomUUID(), workspaceId, workerId,
          dockerContainerId,
          tmuxSession: attached.tmuxSession, stream: attached.stream,
          output: Buffer.alloc(0), offset: 0,
          openedAt: new Date().toISOString(), touchedAt: Date.now(), state: "open",
          requestFinish: () => finish.resolve(), cleanup,
        };
        pendingSession = session;
        // Observe before destroying a late or disconnected stream. finished()
        // may reject on a standalone error BEFORE asynchronous _destroy ends;
        // destroyed=true likewise only means destruction has been requested.
        // Require actual closed state, and never retire on error/end alone.
        // If this stream cannot establish closure, keep the lifetime held.
        const streamClosed = new Promise<void>((resolve) => {
          const closed = () => {
            if (!session.stream.closed) return;
            session.stream.off("close", closed);
            resolve();
          };
          session.stream.on("close", closed);
          closed();
        });
        session.stream.on("data", (chunk: Buffer) => this.append(session, chunk));
        session.stream.on("end", () => this.finish(session, "closed"));
        session.stream.on("close", () => this.finish(session, "closed"));
        session.stream.on("error", () => {
          session.error = "Worker console stream failed";
          this.finish(session, "failed");
        });
        if (abandoned || session.stream.destroyed || session.stream.readableEnded) {
          this.finish(session, "closed");
        } else {
          this.sessions.set(session.id, session);
          this.touch(session);
        }
        // Resolve even for an abandoned result: the caller deadline's settlement
        // linkage must retire independently from the still-live cleanup lease.
        ready.resolve(session);
        await finish.promise;
        session.stream.destroy();
        await streamClosed;
        await this.cleanupSession(session);
      } catch (error) {
        ready.reject(error);
        // Attach can fail after creating a linked tmux session without returning
        // its name/stream. Client settlement cannot reconcile that hidden state.
        await this.holdUncertain(error);
      } finally {
        this.activeLifetimes--;
      }
    });
    // Every failure is observed; resource-owning failures are held inside the
    // thunk until authoritative cleanup can be established.
    void cleanup.catch(() => {});
    try {
      const session = await withOperationDeadline(
        () => ready.promise, DOCKER_OPERATION_TIMEOUT_MS,
        "Docker management console attach",
      );
      return this.public(session);
    } catch (error) {
      abandoned = true;
      if (pendingSession) this.finish(pendingSession, "closed");
      useContainerManager().reportRuntimeFailure(
        workerId,
        "Docker management console attach",
        error,
        dockerContainerId,
      );
      throw error;
    }
  }

  async read(workspaceId: string, id: string, from?: number) {
    return instanceControlPlaneCoordinator.run(() => this.readAdmitted(workspaceId, id, from));
  }

  private async readAdmitted(workspaceId: string, id: string, from?: number) {
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
    const writing = instanceControlPlaneCoordinator.fork();
    void writing.run(() => new Promise<void>((resolve, reject) => {
      session.stream.write(input, error => error ? reject(error) : resolve());
    })).catch(() => this.finish(session, "failed"));
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
    return instanceControlPlaneCoordinator.run(() => this.closeAdmitted(workspaceId, id));
  }

  private async closeAdmitted(workspaceId: string, id: string) {
    const session = this.get(workspaceId, id);
    this.finish(session, "closed");
    await withOperationDeadline(
      () => session.cleanup, 5_000,
      "Docker management console cleanup",
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
    if (session.state !== "open") return;
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
      this.finish(session, "closed");
  }

  private touch(session: ConsoleSession) {
    if (session.state !== "open") return;
    session.touchedAt = Date.now();
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(
      () => this.finish(session, "closed"),
      IDLE_MS,
    );
    session.idleTimer.unref?.();
  }

  private finish(session: ConsoleSession, state: "closed" | "failed") {
    if (session.state !== "open") return;
    this.sessions.delete(session.id);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.state = state;
    session.requestFinish();
  }

  private async cleanupSession(session: ConsoleSession): Promise<void> {
    // killTmuxSession intentionally swallows errors. It cannot establish that
    // cleanup settled successfully; the result needs explicit command proof.
    const receipt = randomUUID();
    try {
      const result = await useDockerService().execCapture(session.dockerContainerId, [
        "python3", "-c",
        "import subprocess,sys; r=subprocess.run(['tmux','kill-session','-t','='+sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); sys.exit(r.returncode) if r.returncode else print(sys.argv[2])",
        session.tmuxSession, receipt,
      ], { operationLabel: "Docker management console cleanup" });
      // execCapture has a legacy unknown-exit fallback. Only the exact receipt
      // emitted after a successful kill is accepted; default exit=0 is not proof.
      if (result.exitCode !== 0 || result.stdout.toString() !== `${receipt}\n` || result.stderr.length)
        throw statusError(503, "Management console cleanup could not be verified");
    } catch (error) {
      await this.holdUncertain(error);
    }
  }

  private async holdUncertain(error: unknown): Promise<never> {
    await Promise.resolve((error as OperationFailureWithSettlement)?.[operationSettlement]).catch(() => {});
    // Explicit tmux/exec reconciliation is unfinished. Keep this process's
    // drain closed to snapshots until authoritative reconciliation exists.
    return new Promise<never>(() => {});
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
