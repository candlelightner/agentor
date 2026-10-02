import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import { instanceControlPlaneCoordinator } from './instance-snapshot-gate';
import type { InstanceControlPlaneCoordinator } from './instance-control-plane-coordinator';
import { combineSettlements, OperationDeadlineError, operationSettlement, withOperationDeadline } from './operation-deadline';

/** Internal server-owned command arguments. Never accept arbitrary Docker options. */
export interface DockerCommandExecSetup {
  stdin?: boolean;
  user?: string;
  workdir?: string;
}
export interface DockerCommandExecInspection { Running: boolean; ExitCode: number | null }
export interface DockerCommandExecTransport {
  setup(containerId: string, argv: string[], options: DockerCommandExecSetup, signal: AbortSignal): Promise<string>;
  start(execId: string, signal: AbortSignal): Promise<Duplex>;
  inspect(execId: string, signal: AbortSignal): Promise<DockerCommandExecInspection>;
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const EXEC_ID = /^[a-f0-9]{64}$/;
const safeErrors = new WeakSet<Error>();

function unavailable(message = 'Docker command transport is unavailable'): Error {
  const error = Object.assign(new Error(message), { code: 'DOCKER_COMMAND_UNAVAILABLE', statusCode: 502 });
  safeErrors.add(error);
  return error;
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
    throw Object.assign(new Error('Docker command transport does not support the effective daemon configuration'), {
      code: 'DOCKER_COMMAND_ENDPOINT_UNSUPPORTED', statusCode: 503,
    });
  }
}

function failureWithSettlement(error: unknown, settlement: Promise<unknown>): Error {
  // Native errors/daemon bodies may include argv or secrets. Preserve only
  // our fixed errors and all exposed failed-operation lifetimes.
  const failure = error instanceof Error && (safeErrors.has(error) || error instanceof OperationDeadlineError)
    ? error : unavailable();
  return Object.create(Object.getPrototypeOf(failure), {
    ...Object.getOwnPropertyDescriptors(failure),
    [operationSettlement]: { value: Promise.all([settlement, combineSettlements(error)]).then(() => undefined, () => undefined) },
  });
}

/** Owns the actual setup/start/inspect requests rather than Dockerode's early callback
 * promises. Test injection is internal only; production always uses this fixed
 * Unix socket, no pooled connections, redirects, retry, or authority expansion.
 * This proves client transport settlement only. Callers must separately retain
 * command/daemon mutation uncertainty until authoritative reconciliation. */
export function createDockerCommandExecTransport(options: {
  modem: unknown;
  request?: (options: RequestOptions) => ClientRequest;
  coordinator?: InstanceControlPlaneCoordinator;
  timeoutMs?: number;
}): DockerCommandExecTransport {
  const request = options.request ?? httpRequest;
  const gate = options.coordinator ?? instanceControlPlaneCoordinator;
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function send(kind: 'setup' | 'start' | 'inspect', id: string, body: object | undefined, signal: AbortSignal): Promise<string | Duplex | DockerCommandExecInspection> {
    assertEndpointCoherent(options.modem);
    const lease = gate.fork();
    let settlement: Promise<void> | undefined;
    try {
      return await withOperationDeadline(linkedSignal => {
        let resolveReady!: (value: string | Duplex | DockerCommandExecInspection) => void, rejectReady!: (error: unknown) => void;
        const ready = new Promise<string | Duplex | DockerCommandExecInspection>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
        settlement = lease.run(async () => {
          let req: ClientRequest | undefined, stopped = false, decided = false, candidate: string | Duplex | DockerCommandExecInspection | undefined;
          let initialWriteComplete = false, exposed = false;
          const failedSettlements: Promise<void>[] = [];
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
            const failed = combineSettlements(error); if (failed) failedSettlements.push(failed);
            if (!decided) { decided = true; rejectReady(error); }
            stop();
          };
          const deliver = () => {
            if (stopped || decided || candidate === undefined || !initialWriteComplete) return;
            decided = true; exposed = true; resolveReady(candidate);
            if (kind !== 'start') stop();
          };
          const abort = () => fail(unavailable('Docker command transport was cancelled'));
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
            for (let index = 0; index < failedSettlements.length; index++) await failedSettlements[index];
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
              if (bytes > MAX_RESPONSE_BYTES) { fail(unavailable('Docker command response exceeds its bound')); return; }
              chunks.push(data);
            });
            response.once('end', () => {
              if (stopped) return;
              if (!response.complete) { fail(unavailable('Docker command response was truncated')); return; }
              if (kind === 'start' || (response.statusCode !== 200 && !(kind === 'setup' && response.statusCode === 201))) {
                fail(unavailable(`Docker command request failed (HTTP ${response.statusCode ?? 'unknown'})`)); return;
              }
              try {
                const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable();
                if (kind === 'setup') {
                  if (typeof result.Id !== 'string' || !EXEC_ID.test(result.Id)) throw unavailable();
                  candidate = result.Id;
                } else {
                  if (typeof result.Running !== 'boolean' ||
                      !(result.ExitCode === null || (Number.isSafeInteger(result.ExitCode) && result.ExitCode >= 0 && result.ExitCode <= 255)) ||
                      (!result.Running && result.ExitCode === null)) throw unavailable();
                  candidate = { Running: result.Running, ExitCode: result.ExitCode };
                }
                deliver();
              } catch { fail(unavailable('Docker command returned invalid JSON')); }
            });
            response.once('close', () => {
              if (response.closed && !response.complete && !stopped) fail(unavailable('Docker command response was truncated'));
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
                  try { req!.write(chunk, encoding, error => { done(); if (error) fail(error); callback(error ? unavailable() : undefined); }); }
                  catch (error) { done(); fail(error); callback(unavailable()); }
                },
                final(callback) {
                  let done!: () => void;
                  writes.push(new Promise<void>(resolve => { done = resolve; }));
                  try { req!.end(() => { done(); callback(); }); }
                  catch (error) { done(); fail(error); callback(unavailable()); }
                },
                destroy(error, callback) {
                  stop();
                  void drainOwned().then(() => callback(error), () => callback(error));
                },
              });
              bridge.on('error', fail);
              // Native EOF/closure can precede consumption of buffered output.
              // Retire the Duplex only after its readable end is observed, or
              // explicit cancellation; keep its actual closure owned below.
              bridge.once('end', () => bridge!.destroy());
              response.on('data', chunk => { if (!bridge!.push(chunk)) response.pause(); });
              response.once('end', () => bridge!.push(null));
              response.once('close', () => { if (response.closed && !response.readableEnded) bridge!.destroy(unavailable('Docker command stream closed early')); });
              candidate = bridge; deliver(); return;
            }
            readBoundedResponse(response);
          };
          const ownUpgrade = (response: IncomingMessage, socket: Socket, head: Buffer, connect = false) => {
            ownSocket(socket); registerResponse(response, socket);
            if (stopped || candidate !== undefined || kind !== 'start' || connect || response.statusCode !== 101 ||
                String(response.headers.upgrade ?? '').toLowerCase() !== 'tcp' ||
                !String(response.headers.connection ?? '').toLowerCase().split(',').map(item => item.trim()).includes('upgrade')) {
              fail(unavailable('Docker command protocol upgrade was not accepted')); return;
            }
            // No data consumer has been attached yet. Do not explicitly pause
            // the handed-off socket: attaching a later data listener must be
            // able to start its normal flowing mode without a hidden resume.
            if (head.byteLength) socket.unshift(head);
            bridge = new Duplex({
              read() { socket.resume(); },
              write(chunk, encoding, callback) {
                let done!: () => void;
                writes.push(new Promise<void>(resolve => { done = resolve; }));
                try { socket.write(chunk, encoding, error => { done(); if (error) fail(error); callback(error ? unavailable() : undefined); }); }
                catch (error) { done(); fail(error); callback(unavailable()); }
              },
              final(callback) {
                let done!: () => void;
                writes.push(new Promise<void>(resolve => { done = resolve; }));
                try { socket.end(() => { done(); callback(); }); }
                catch (error) { done(); fail(error); callback(unavailable()); }
              },
              destroy(error, callback) {
                stop(); void drainOwned().then(() => callback(error), () => callback(error));
              },
            });
            bridge.on('error', fail);
            bridge.once('end', () => bridge!.destroy());
            socket.on('data', chunk => { if (!bridge!.push(chunk)) socket.pause(); });
            socket.once('end', () => bridge!.push(null));
            socket.once('close', () => {
              if (!socket.readableEnded && !stopped) bridge!.destroy(unavailable('Docker command stream closed early'));
              else if (bridge!.readableEnded && !bridge!.destroyed) bridge!.destroy();
            });
            socket.pause();
            candidate = bridge; deliver();
          };
          try {
            const serialized = body === undefined ? undefined : JSON.stringify(body);
            req = request({ socketPath: '/var/run/docker.sock', agent: false, method: kind === 'inspect' ? 'GET' : 'POST',
              path: kind === 'setup' ? `/containers/${encodeURIComponent(id)}/exec` : `/exec/${encodeURIComponent(id)}/${kind === 'start' ? 'start' : 'json'}`,
              headers: { ...(serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) }),
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
                if (kind === 'start') req.write(serialized!, written);
                else req.end(serialized, written);
              } catch (error) { completeWrite(); fail(error); }
            }
            await closed(req);
            if (!decided && candidate === undefined) fail(unavailable('Docker command request closed before a response'));
            await drainOwned();
            if (bridge && !bridge.closed) {
              if (stopped || bridge.readableEnded) bridge.destroy();
              await closed(bridge);
            }
            if (!decided) fail(unavailable('Docker command request did not complete'));
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
      }, timeoutMs, `Docker command ${kind}`, signal);
    } catch (error) {
      if (settlement) throw failureWithSettlement(error, settlement);
      throw error;
    } finally { lease.cancel(); }
  }

  return {
    setup(containerId, argv, settings, signal) {
      const validText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0');
      if (!validText(containerId) || containerId.length > 1024 || containerId === '.' || containerId === '..' ||
          !Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string' || value.includes('\0')) ||
          !validText(argv[0]) || !settings || typeof settings !== 'object' || Array.isArray(settings) ||
          (settings.stdin !== undefined && typeof settings.stdin !== 'boolean') ||
          (settings.user !== undefined && !validText(settings.user)) ||
          (settings.workdir !== undefined && (!validText(settings.workdir) || !settings.workdir.startsWith('/'))))
        return Promise.reject(new TypeError('Invalid Docker command setup'));
      return send('setup', containerId, { Cmd: [...argv], AttachStdin: settings.stdin ?? false,
        AttachStdout: true, AttachStderr: true, Tty: false,
        ...(settings.user === undefined ? {} : { User: settings.user }),
        ...(settings.workdir === undefined ? {} : { WorkingDir: settings.workdir }) }, signal) as Promise<string>;
    },
    start(execId, signal) {
      if (typeof execId !== 'string' || !EXEC_ID.test(execId)) return Promise.reject(new TypeError('Invalid Docker command identity'));
      return send('start', execId, { Detach: false, Tty: false }, signal) as Promise<Duplex>;
    },
    inspect(execId, signal) {
      if (typeof execId !== 'string' || !EXEC_ID.test(execId)) return Promise.reject(new TypeError('Invalid Docker command identity'));
      return send('inspect', execId, undefined, signal) as Promise<DockerCommandExecInspection>;
    },
  };
}
