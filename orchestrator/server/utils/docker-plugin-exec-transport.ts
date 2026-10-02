import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';
import type { InstanceControlPlaneCoordinator } from './instance-control-plane-coordinator';
import { operationSettlement, withOperationDeadline } from './operation-deadline';

export interface DockerPluginExecTransport {
  setup(containerId: string, operation: 'execute' | 'probe' | 'desktop', signal: AbortSignal): Promise<string>;
  start(execId: string, signal: AbortSignal): Promise<Duplex>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const EXEC_ID = /^[a-f0-9]{64}$/;

function unavailable(message = 'Docker plugin transport is unavailable'): Error {
  return Object.assign(new Error(message), { code: 'PLUGIN_RUNNER_UNAVAILABLE', statusCode: 502 });
}

function closed(resource: ClientRequest | IncomingMessage | Socket | Duplex): Promise<void> {
  return new Promise(resolve => {
    const observe = () => {
      if (!resource.closed) return;
      resource.off('close', observe); resolve();
    };
    resource.on('close', observe); observe();
  });
}

/** Same direct daemon as the existing worker Docker client. Never reinterpret
 * an effective remote/versioned/authenticated modem as the fixed local socket.
 * Kept local until the separately reviewed archive predicate can be shared. */
function assertEndpointCoherent(value: unknown): void {
  const modem = value as Record<string, unknown> | undefined;
  if (!modem || modem.host || modem.protocol !== 'http' || modem.socketPath !== '/var/run/docker.sock' ||
      (modem.socketPathCache !== undefined && modem.socketPathCache !== '/var/run/docker.sock') ||
      modem.version || modem.agent || modem.key || modem.cert || modem.ca ||
      (modem.headers !== undefined && (typeof modem.headers !== 'object' || modem.headers === null ||
        Array.isArray(modem.headers) || Reflect.ownKeys(modem.headers).length !== 0))) {
    throw Object.assign(new Error('Docker plugin transport does not support the effective daemon configuration'), {
      code: 'DOCKER_PLUGIN_ENDPOINT_UNSUPPORTED', statusCode: 503,
    });
  }
}

function failureWithSettlement(error: unknown, settlement: Promise<unknown>): Error {
  const failure = error instanceof Error ? error : unavailable();
  return Object.create(Object.getPrototypeOf(failure), {
    ...Object.getOwnPropertyDescriptors(failure),
    [operationSettlement]: { value: settlement.then(() => undefined, () => undefined) },
  });
}

/** Owns the actual setup/start requests rather than Dockerode's early callback
 * promises. Test injection is internal only; production always uses this fixed
 * Unix socket, no pooled connections, redirects, retry, or authority expansion.
 * This proves transport settlement, NOT runner mutation completion/receipt. */
export function createDockerPluginExecTransport(options: {
  modem: unknown;
  request?: (options: RequestOptions) => ClientRequest;
  coordinator?: InstanceControlPlaneCoordinator;
  timeoutMs?: number;
}): DockerPluginExecTransport {
  const request = options.request ?? httpRequest;
  const gate = options.coordinator ?? instanceControlPlaneCoordinator;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function post(kind: 'setup' | 'start', id: string, body: object, signal: AbortSignal): Promise<string | Duplex> {
    assertEndpointCoherent(options.modem);
    const lease = gate.fork();
    let settlement: Promise<void> | undefined;
    try {
      return await withOperationDeadline(linkedSignal => {
        let resolveReady!: (value: string | Duplex) => void, rejectReady!: (error: unknown) => void;
        const ready = new Promise<string | Duplex>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        settlement = lease.run(async () => {
          let req: ClientRequest | undefined, stopped = false, decided = false, candidate: string | Duplex | undefined;
          let initialWriteComplete = false, exposed = false;
          const sockets = new Set<Socket>(), responses = new Set<IncomingMessage>();
          const resourceClosures: Promise<void>[] = [], writes: Promise<void>[] = [];
          let bridge: Duplex | undefined;
          const stop = () => {
            stopped = true;
            req?.destroy();
            for (const response of responses) response.destroy();
            for (const socket of sockets) socket.destroy();
            bridge?.destroy();
          };
          const fail = (error: unknown) => {
            if (!decided) { decided = true; rejectReady(error); }
            stop();
          };
          const deliver = () => {
            if (stopped || decided || candidate === undefined || !initialWriteComplete) return;
            decided = true; exposed = true; resolveReady(candidate);
            if (kind === 'setup') stop();
          };
          const abort = () => fail(unavailable('Docker plugin transport was cancelled'));
          const ownSocket = (socket: Socket) => {
            if (sockets.has(socket)) return;
            sockets.add(socket); resourceClosures.push(closed(socket));
            socket.on('error', fail);
            if (stopped) socket.destroy();
          };
          const drainOwned = async () => {
            if (req) await closed(req);
            // Native HTTP cannot attach a new transport after actual request
            // close. Every response/socket delivered before close is owned.
            for (let index = 0; index < resourceClosures.length; index++) await resourceClosures[index];
            for (let index = 0; index < writes.length; index++) await writes[index];
          };
          const registerResponse = (response: IncomingMessage, upgradedSocket?: Socket) => {
            if (responses.has(response)) return;
            responses.add(response);
            response.on('error', fail);
            if (upgradedSocket) {
              // Upgrade responses have no normally consumed HTTP body. Do not
              // destroy the response while it still references the live socket.
              resourceClosures.push(closed(upgradedSocket).then(async () => {
                response.destroy(); await closed(response);
              }));
            } else resourceClosures.push(closed(response));
          };
          const readBoundedResponse = (response: IncomingMessage) => {
            let bytes = 0; const chunks: Buffer[] = [];
            response.on('data', chunk => {
              const data = Buffer.from(chunk); bytes += data.byteLength;
              if (bytes > MAX_RESPONSE_BYTES) { fail(unavailable('Docker plugin response exceeds its bound')); return; }
              chunks.push(data);
            });
            response.once('end', () => {
              if (stopped) return;
              if (!response.complete) { fail(unavailable('Docker plugin response was truncated')); return; }
              if (kind !== 'setup' || (response.statusCode !== 200 && response.statusCode !== 201)) {
                fail(unavailable(`Docker plugin request failed (HTTP ${response.statusCode ?? 'unknown'})`)); return;
              }
              try {
                const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!result || typeof result !== 'object' || Array.isArray(result) ||
                    typeof result.Id !== 'string' || !EXEC_ID.test(result.Id)) throw unavailable();
                candidate = result.Id; deliver();
              } catch { fail(unavailable('Docker plugin setup returned an invalid exec identity')); }
            });
            response.once('close', () => {
              if (response.closed && !response.complete && !stopped) fail(unavailable('Docker plugin response was truncated'));
            });
          };
          const ownResponse = (response: IncomingMessage) => {
            registerResponse(response);
            if (stopped || candidate !== undefined) { response.destroy(); return; }
            if (kind === 'start' && response.statusCode === 200 &&
                String(response.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() === 'application/vnd.docker.raw-stream') {
              // Documented non-upgrade form: keep the request writable for
              // stdin. IncomingMessage alone cannot implement that contract.
              response.pause();
              bridge = new Duplex({
                read() { response.resume(); },
                write(chunk, encoding, callback) {
                  let done!: () => void;
                  writes.push(new Promise<void>(resolve => { done = resolve; }));
                  try { req!.write(chunk, encoding, error => { done(); callback(error); }); }
                  catch (error) { done(); callback(error as Error); }
                },
                final(callback) {
                  let done!: () => void;
                  writes.push(new Promise<void>(resolve => { done = resolve; }));
                  try { req!.end(() => { done(); callback(); }); }
                  catch (error) { done(); callback(error as Error); }
                },
                destroy(error, callback) {
                  stop();
                  void drainOwned().then(() => callback(error), () => callback(error));
                },
              });
              bridge.on('error', fail);
              response.on('data', chunk => { if (!bridge!.push(chunk)) response.pause(); });
              response.once('end', () => bridge!.push(null));
              response.once('close', () => { if (response.closed && !response.readableEnded) bridge!.destroy(unavailable('Docker plugin stream closed early')); });
              candidate = bridge; deliver(); return;
            }
            readBoundedResponse(response);
          };
          const ownUpgrade = (response: IncomingMessage, socket: Socket, head: Buffer, connect = false) => {
            ownSocket(socket); registerResponse(response, socket);
            if (stopped || candidate !== undefined || kind !== 'start' || connect || response.statusCode !== 101 ||
                String(response.headers.upgrade ?? '').toLowerCase() !== 'tcp' ||
                !String(response.headers.connection ?? '').toLowerCase().split(',').map(item => item.trim()).includes('upgrade')) {
              fail(unavailable('Docker plugin protocol upgrade was not accepted')); return;
            }
            // No data consumer has been attached yet. Do not explicitly pause
            // the handed-off socket: attaching a later data listener must be
            // able to start its normal flowing mode without a hidden resume.
            if (head.byteLength) socket.unshift(head);
            candidate = socket; deliver();
          };
          try {
            const serialized = JSON.stringify(body);
            req = request({ socketPath: '/var/run/docker.sock', agent: false, method: 'POST',
              path: kind === 'setup' ? `/containers/${encodeURIComponent(id)}/exec` : `/exec/${encodeURIComponent(id)}/start`,
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized),
                Connection: kind === 'start' ? 'Upgrade' : 'close', ...(kind === 'start' ? { Upgrade: 'tcp' } : {}) } });
            req.on('error', fail); req.on('socket', ownSocket); req.on('response', ownResponse);
            req.on('upgrade', (response, socket, head) => ownUpgrade(response, socket, head));
            req.on('connect', (response, socket, head) => ownUpgrade(response, socket, head, true));
            linkedSignal.addEventListener('abort', abort, { once: true });
            signal.addEventListener('abort', abort, { once: true });
            if (linkedSignal.aborted || signal.aborted) abort();
            else {
              let completeWrite!: () => void;
              writes.push(new Promise<void>(resolve => { completeWrite = resolve; }));
              const written = (error?: Error | null) => {
                completeWrite();
                if (error) fail(error);
                else { initialWriteComplete = true; deliver(); }
              };
              try {
                // Like Docker's openStdin protocol, start leaves POST writable
                // after its initial JSON; setup sends a complete ordinary POST.
                if (kind === 'start') req.write(serialized, written);
                else req.end(serialized, written);
              } catch (error) { completeWrite(); fail(error); }
            }
            await closed(req);
            if (!decided && candidate === undefined) fail(unavailable('Docker plugin request closed before a response'));
            await drainOwned();
            if (bridge && !bridge.closed) { bridge.destroy(); await closed(bridge); }
            if (!decided) fail(unavailable('Docker plugin request did not complete'));
          } catch (error) { fail(error); await drainOwned(); }
          finally {
            linkedSignal.removeEventListener('abort', abort); signal.removeEventListener('abort', abort);
            // After delivery, transport errors belong to the returned stream;
            // request lifetime above still owns every resource until closure.
            if (!exposed && !decided) fail(unavailable());
          }
        });
        void settlement.catch(rejectReady);
        return ready;
      }, timeoutMs, kind === 'setup' ? 'Docker plugin-runner setup' : 'Docker plugin-runner start', signal);
    } catch (error) {
      if (settlement) throw failureWithSettlement(error, settlement);
      throw error;
    } finally { lease.cancel(); }
  }

  return {
    setup(containerId, operation, signal) {
      if (typeof containerId !== 'string' || !containerId || containerId.length > 1024 ||
          containerId === '.' || containerId === '..' || containerId.includes('\0') ||
          !['execute', 'probe', 'desktop'].includes(operation)) return Promise.reject(new TypeError('Invalid plugin exec resource'));
      return post('setup', containerId, { Cmd: ['/home/agent/apps/plugin-runner/runner.py', operation],
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, User: 'agent' }, signal) as Promise<string>;
    },
    start(execId, signal) {
      if (typeof execId !== 'string' || !EXEC_ID.test(execId)) return Promise.reject(new TypeError('Invalid plugin exec identity'));
      return post('start', execId, { Detach: false, Tty: false }, signal) as Promise<Duplex>;
    },
  };
}
