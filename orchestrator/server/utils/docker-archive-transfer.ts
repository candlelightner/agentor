import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';
import type { InstanceControlPlaneCoordinator } from './instance-control-plane-coordinator';
import { withOperationDeadline, operationSettlement, type OperationFailureWithSettlement } from './operation-deadline';

type ArchiveInput = { containerId: string; signal?: AbortSignal } & (
  { kind: 'workspace' | 'archive'; path: string } | { kind: 'export' }
);
const labels = {
  workspace: 'Docker workspace archive preparation',
  archive: 'Docker archive preparation',
  export: 'Docker root-filesystem export preparation',
} as const;
const MAX_ERROR_BYTES = 64 * 1024;

function closed(resource: ClientRequest | IncomingMessage | Socket): Promise<void> {
  return new Promise(resolve => {
    const observe = () => {
      if (!resource.closed) return;
      resource.off('close', observe); resolve();
    };
    resource.on('close', observe); observe();
  });
}
function withSettlement(error: unknown, settlement: Promise<void>): OperationFailureWithSettlement {
  const failure = error instanceof Error ? error : new Error('Docker archive transfer failed', { cause: error });
  return Object.create(Object.getPrototypeOf(failure), {
    ...Object.getOwnPropertyDescriptors(failure),
    [operationSettlement]: { value: settlement, enumerable: false },
  });
}
function httpFailure(status: number | undefined, body: string, oversized = false): Error {
  const reason = ({ 400: 'client error, bad parameters', 404: 'no such container', 500: 'server error' } as Record<number, string>)[status ?? 0];
  let cause = body;
  try { const value = JSON.parse(body); cause = typeof value?.message === 'string' ? value.message : typeof value?.error === 'string' ? value.error : body; } catch { /* Bounded plain-text daemon response. */ }
  return Object.assign(new Error(`(HTTP code ${status}) ${reason || 'unexpected'} - ${oversized ? 'Docker error response exceeded the size limit' : cause} `), {
    statusCode: status, reason, json: null,
  });
}

/** Internal transport seam, not API endpoint selection. Production below always
 * uses the fixed Docker Unix socket, no proxy, version negotiation or retries.
 * Tests inject only synthetic request objects or an isolated local HTTP socket.
 */
export function createDockerArchiveTransfer(options: {
  request?: (options: RequestOptions) => ClientRequest;
  coordinator?: InstanceControlPlaneCoordinator;
  timeoutMs?: number;
} = {}) {
  const request = options.request ?? httpRequest;
  const coordinator = options.coordinator ?? instanceControlPlaneCoordinator;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return async (input: ArchiveInput): Promise<IncomingMessage> => {
    if (typeof input.containerId !== 'string' || !input.containerId || input.containerId === '.' || input.containerId === '..' || input.containerId.length > 1024 || input.containerId.includes('\0') ||
        (input.kind !== 'export' && (typeof input.path !== 'string' || !input.path.startsWith('/') || input.path.length > 4096 || input.path.includes('\0'))))
      throw new TypeError('Invalid Docker archive resource');
    const pathname = `/containers/${encodeURIComponent(input.containerId)}/${input.kind === 'export' ? 'export' : `archive?path=${encodeURIComponent(input.path)}`}`;
    const lifetime = coordinator.fork();
    let settlement: Promise<void> | undefined;
    try {
      return await withOperationDeadline(linkedSignal => {
        let readyResolve!: (response: IncomingMessage) => void, readyReject!: (error: unknown) => void;
        const ready = new Promise<IncomingMessage>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
        settlement = lifetime.run(async () => {
          let req: ClientRequest | undefined, stopped = false, delivered = false, decided = false;
          const responses = new Set<IncomingMessage>(), sockets = new Set<Socket>();
          const resources: Promise<void>[] = [];
          const stop = () => {
            stopped = true;
            req?.destroy();
            for (const response of responses) response.destroy();
            for (const socket of sockets) socket.destroy();
          };
          const fail = (error: unknown) => {
            if (!decided) { decided = true; readyReject(error); }
            stop();
          };
          const abort = () => fail(new Error('Docker archive transfer cancelled'));
          const ownSocket = (socket: Socket) => {
            if (sockets.has(socket)) return;
            sockets.add(socket); resources.push(closed(socket));
            socket.on('error', fail);
            if (stopped) socket.destroy();
          };
          const ownResponse = (response: IncomingMessage) => {
            responses.add(response); resources.push(closed(response));
            response.on('error', fail);
            if (stopped || delivered) { response.destroy(); return; }
            if (response.statusCode === 200) {
              decided = true; delivered = true; readyResolve(response); return;
            }
            let bytes = 0; const chunks: Buffer[] = [];
            response.on('data', chunk => {
              const data = Buffer.from(chunk); bytes += data.byteLength;
              if (bytes > MAX_ERROR_BYTES) { fail(httpFailure(response.statusCode, '', true)); return; }
              chunks.push(data);
            });
            response.once('end', () => fail(httpFailure(response.statusCode, Buffer.concat(chunks).toString('utf8'))));
          };
          try {
            // The one-shot, non-pooled connection belongs exclusively to this
            // operation. Request error/callback completion is NOT closure.
            req = request({ socketPath: '/var/run/docker.sock', method: 'GET', path: pathname,
              agent: false, headers: { Connection: 'close' } });
            const requestClosed = closed(req);
            req.on('error', fail);
            req.on('socket', ownSocket);
            req.on('response', ownResponse);
            const unexpectedUpgrade = (response: IncomingMessage, socket: Socket) => {
              ownSocket(socket); stopped = true; ownResponse(response);
              fail(httpFailure(response.statusCode, 'Unexpected Docker protocol upgrade'));
            };
            req.on('upgrade', unexpectedUpgrade); req.on('connect', unexpectedUpgrade);
            linkedSignal.addEventListener('abort', abort, { once: true });
            input.signal?.addEventListener('abort', abort, { once: true });
            if (linkedSignal.aborted || input.signal?.aborted) abort(); else req.end();
            await requestClosed;
            // Native HTTP cannot attach another socket/response after actual
            // request close. Any late response before it remains owned above.
            if (!decided) fail(new Error('Docker archive request closed before response completion'));
            await Promise.all(resources);
          } catch (error) {
            fail(error);
            if (req) await closed(req);
            await Promise.all(resources);
          } finally {
            linkedSignal.removeEventListener('abort', abort);
            input.signal?.removeEventListener('abort', abort);
          }
        });
        void settlement.catch(readyReject);
        return ready;
      }, timeoutMs, labels[input.kind], input.signal);
    } catch (error) {
      if (settlement) throw withSettlement(error, settlement);
      throw error;
    } finally { lifetime.cancel(); }
  };
}

export const openDockerArchiveTransfer = createDockerArchiveTransfer();
