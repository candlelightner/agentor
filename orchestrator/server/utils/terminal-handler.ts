import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import type { Peer } from 'crossws';
import { useDockerService, useContainerManager } from './services';
import { getPeerId, getPeerUrl, toBuffer } from './ws-utils';
import { authenticateWsPeer } from './auth-helpers';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';
import {
  operationSettlement,
  type OperationFailureWithSettlement,
  withOperationDeadline,
} from './operation-deadline';

interface TerminalContext {
  dockerStream?: Duplex;
  execId?: string;
  /** The Docker container id (resolved from the worker UUID) for tmux cleanup. */
  dockerContainerId?: string;
  tmuxSession?: string;
  closed: boolean;
  finish?: () => void;
  cleanupPromise?: Promise<void>;
}

const peerContexts = new Map<string, TerminalContext>();

function getTerminalContext(peer: Peer): TerminalContext {
  const id = getPeerId(peer);
  let ctx = peerContexts.get(id);
  if (!ctx) {
    ctx = { closed: false };
    peerContexts.set(id, ctx);
  }
  return ctx;
}

function cleanupPeerContext(peer: Peer): void {
  peerContexts.delete(getPeerId(peer));
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function cleanupTerminalSession(
  dockerContainerId: string,
  tmuxSession: string,
): Promise<void> {
  // killTmuxSession intentionally swallows errors. It cannot establish that
  // cleanup settled successfully; the result needs explicit command proof.
  const receipt = randomUUID();
  try {
    const result = await useDockerService().execCapture(
      dockerContainerId,
      [
        'python3',
        '-c',
        "import subprocess,sys; r=subprocess.run(['tmux','kill-session','-t','='+sys.argv[1]],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL); sys.exit(r.returncode) if r.returncode else print(sys.argv[2])",
        tmuxSession,
        receipt,
      ],
      { operationLabel: 'Docker terminal cleanup' },
    );
    if (
      result.exitCode !== 0 ||
      result.stdout.toString() !== `${receipt}\n` ||
      result.stderr.length
    ) {
      throw Object.assign(
        new Error('Terminal cleanup could not be verified'),
        { statusCode: 503 },
      );
    }
  } catch (error) {
    await holdUncertain(error);
  }
}

async function holdUncertain(error: unknown): Promise<never> {
  await Promise.resolve(
    (error as OperationFailureWithSettlement)?.[operationSettlement],
  ).catch(() => {});
  // Explicit tmux/exec reconciliation is unfinished. Keep this process's
  // drain closed to snapshots until authoritative reconciliation exists.
  return new Promise<never>(() => {});
}

function finishTerminalSession(ctx: TerminalContext, peer: Peer): void {
  if (ctx.closed) return;
  ctx.closed = true;
  ctx.finish?.();
  cleanupPeerContext(peer);
  try {
    peer.close();
  } catch {}
}

// The first capture is the worker's UUID `id` (the route segment), NOT a Docker
// container id — the handler resolves the live Docker container id from it.
function parseWsParams(
  url: string | undefined,
): { workerId: string; windowIndex: number } | null {
  if (!url) return null;
  const match = url.match(/\/ws\/terminal\/([^/?]+)(?:\/([^/?]+))?/);
  if (!match?.[1]) return null;
  const rawIndex = match[2];
  const windowIndex = rawIndex != null ? parseInt(rawIndex, 10) : 0;
  return {
    workerId: match[1],
    windowIndex: Number.isNaN(windowIndex) ? 0 : windowIndex,
  };
}

function handleTerminalOpen(peer: Peer): void {
  const ctx = getTerminalContext(peer);
  const dockerService = useDockerService();
  const params = parseWsParams(getPeerUrl(peer));

  if (!params) {
    try {
      peer.send('\r\nError: Could not determine container from WebSocket URL\r\n');
    } catch {}
    try {
      peer.close();
    } catch {}
    cleanupPeerContext(peer);
    return;
  }

  let lifetime: ReturnType<typeof instanceControlPlaneCoordinator.fork>;
  try {
    lifetime = instanceControlPlaneCoordinator.fork();
  } catch {
    try {
      peer.send(
        '\r\nWorker runtime is unavailable (maintenance in progress). Retry shortly.\r\n',
      );
    } catch {}
    try {
      peer.close();
    } catch {}
    cleanupPeerContext(peer);
    return;
  }
  const finish = deferred<void>();
  const ready = deferred<void>();
  ctx.finish = () => finish.resolve();

  const sessionCleanup = lifetime.run(async () => {
    let capturedContainerId: string | undefined;
    let capturedTmuxSession: string | undefined;
    let stream: Duplex | undefined;
    let streamClosed: Promise<void> | undefined;
    let attachStarted = false;

    try {
      const auth = await terminalWsHandler.authenticate(peer);
      // A disconnect during authentication must not launch a new exec.
      if (ctx.closed) return;
      if (!auth) {
        try {
          peer.send('\r\nUnauthorized\r\n');
        } catch {}
        try {
          peer.close();
        } catch {}
        return;
      }
      const info = useContainerManager().get(params.workerId);
      if (!info) {
        try {
          peer.send('\r\nContainer not found\r\n');
        } catch {}
        try {
          peer.close();
        } catch {}
        return;
      }
      if (auth.user.role !== 'admin' && info.userId !== auth.user.id) {
        try {
          peer.send('\r\nForbidden\r\n');
        } catch {}
        try {
          peer.close();
        } catch {}
        return;
      }

      capturedContainerId = info.containerId;
      ctx.dockerContainerId = capturedContainerId;

      // The lifetime owns the actual attach, not a bounded caller wait. A late
      // result must still be destroyed and its exact linked session cleaned.
      attachStarted = true;
      const attached = await dockerService.execAttachTmuxWindow(
        capturedContainerId,
        params.windowIndex,
      );

      const attachedStream = attached.stream;
      stream = attachedStream;
      capturedTmuxSession = attached.tmuxSession;
      ctx.dockerStream = attachedStream;
      ctx.tmuxSession = capturedTmuxSession;

      streamClosed = new Promise<void>((resolve) => {
        const onClose = () => {
          if (!attachedStream.closed) return;
          attachedStream.off('close', onClose);
          resolve();
        };
        attachedStream.on('close', onClose);
        onClose();
      });

      // Install error/close observers before destroying an abandoned result.
      // close notifications signal finish, but only actual .closed settles it.
      stream.on('error', (err) => {
        try {
          useLogger().error(`[terminal-ws] Docker stream error: ${err.message}`);
        } catch {}
        finishTerminalSession(ctx, peer);
      });
      stream.on('close', () => finishTerminalSession(ctx, peer));
      stream.on('end', () => finishTerminalSession(ctx, peer));

      ctx.execId = attached.exec.id;

      stream.on('data', (chunk: Buffer) => {
        if (ctx.closed) return;
        try {
          peer.send(chunk);
        } catch {
          finishTerminalSession(ctx, peer);
        }
      });

      if (ctx.closed || stream.destroyed || stream.readableEnded || stream.closed) {
        finish.resolve();
        finishTerminalSession(ctx, peer);
      }
      ready.resolve();
      await finish.promise;
    } catch (err) {
      ready.reject(err);
      finishTerminalSession(ctx, peer);
      // A failed Docker attach can have created hidden exec/session state.
      // Even a settled client request cannot prove that state quiescent.
      if (attachStarted && (!stream || !capturedTmuxSession)) {
        await holdUncertain(err);
      } else {
        await Promise.resolve(
          (err as OperationFailureWithSettlement)?.[operationSettlement],
        ).catch(() => {});
      }
    } finally {
      if (stream && capturedContainerId && capturedTmuxSession) {
        try {
          stream.destroy();
          // Always install before destruction and validate actual closed state.
          // If construction failed before observing closure, retain uncertainty.
          if (!streamClosed) await holdUncertain(undefined);
          await streamClosed;
          await cleanupTerminalSession(capturedContainerId, capturedTmuxSession);
        } catch (error) {
          await holdUncertain(error);
        }
      }
      ready.resolve();
      ctx.closed = true;
      cleanupPeerContext(peer);
    }
  });

  // The bounded client notification is independent from the resource owner.
  // Catching its deadline never retires sessionCleanup or discards a result.
  void withOperationDeadline(ready.promise, 15_000, 'Docker terminal attach')
    .catch((err) => {
      try {
        useContainerManager().reportRuntimeFailure(
          params.workerId,
          'Docker terminal attach',
          err,
          ctx.dockerContainerId,
        );
      } catch {}
      try {
        useLogger().error(
          `[terminal-ws] worker ${params.workerId} terminal attach failed: ${(err as { code?: string })?.code || 'runtime unavailable'}`,
        );
      } catch {}
      try {
        peer.send(
          '\r\nWorker runtime is unavailable. Retry or use managed recovery.\r\n',
        );
      } catch {}
      finishTerminalSession(ctx, peer);
    })
    .catch(() => {});

  ctx.cleanupPromise = sessionCleanup;
  void sessionCleanup.catch(() => {});
}

function handleTerminalMessage(peer: Peer, message: unknown): void {
  const ctx = peerContexts.get(getPeerId(peer));
  if (!ctx || ctx.closed || !ctx.dockerStream) return;

  const dockerService = useDockerService();

  // Try to detect JSON resize messages
  let text: string | undefined;
  try {
    if (typeof message === 'string') {
      text = message;
    } else {
      const msg = message as { text?: () => string };
      if (typeof msg.text === 'function') {
        text = msg.text();
      } else if (Buffer.isBuffer(message) && message.length < 200) {
        text = message.toString('utf-8');
      }
    }
  } catch {}

  // Only attempt a JSON parse when the frame actually looks like a resize
  // object (`{...}`). Interactive keystrokes are the hot path and never start
  // with `{`, so this avoids a throw-and-catch on every character typed.
  if (text && text.length < 200 && text.charCodeAt(0) === 0x7b /* '{' */) {
    try {
      const parsed = JSON.parse(text);
      if (
        parsed.type === 'resize' &&
        parsed.cols &&
        parsed.rows &&
        ctx.execId
      ) {
        void instanceControlPlaneCoordinator
          .run(async () => {
            await withOperationDeadline(
              dockerService.resizeExec(ctx.execId!, parsed.cols, parsed.rows),
              5_000,
              'Docker terminal resize',
            );
          })
          .catch(() => {});
        return;
      }
    } catch {}
  }

  const raw = toBuffer(message);
  if (raw && ctx.dockerStream && !ctx.closed) {
    let writing:
      | ReturnType<typeof instanceControlPlaneCoordinator.fork>
      | undefined;
    try {
      writing = instanceControlPlaneCoordinator.fork();
    } catch {
      // Barrier active or admission closed
      finishTerminalSession(ctx, peer);
      return;
    }
    void writing
      .run(
        () =>
          new Promise<void>((resolve, reject) => {
            ctx.dockerStream!.write(raw, (error) =>
              error ? reject(error) : resolve(),
            );
          }),
      )
      .catch(() => finishTerminalSession(ctx, peer));
  }
}

function handleTerminalClose(peer: Peer): void {
  const ctx = peerContexts.get(getPeerId(peer));
  if (ctx) finishTerminalSession(ctx, peer);
}

export const terminalWsHandler = {
  authenticate: authenticateWsPeer,
  open: handleTerminalOpen,
  message: handleTerminalMessage,
  close: handleTerminalClose,
  error: handleTerminalClose,
};
