/** Isolated read-only measurement transport, NOT a capacity ticket/service.
 *
 * Operator-only construction: dedicated CA/key/cert, protected Unix-socket
 * parent, host/service/daemon-bound peer pins and generation policy. Never
 * accept these options from API input, worker settings or restored backups.
 * No TCP fallback, install/permission changes, logging, automatic retries,
 * ledger methods, quota operations, replay consumption or migration wiring.
 *
 * TLS authenticates identity, not measurement correctness, fencing, quotas or
 * durable nonce consumption. The ledger must verify and durably consume the
 * evidence sequence/nonce before any later use. The handler MUST be a bounded read-only
 * trusted measurement adapter. Cancellation is a request to stop, NOT proof
 * an operation stopped, and never releases capacity. A handler ignoring abort
 * retains its concurrency slot until settlement; close() does not certify it.
 *
 * Rotation uses a fresh operator configuration with at most two overlapping
 * certificate pins and a new generation. isGenerationCurrent must use trusted
 * local policy, never RPC state; revocation invalidates even in-flight replies.
 * This module neither persists nor distributes that policy. New connections
 * always perform certificate-chain/validity AND exact pin checks, TLS 1.3 only.
 */
import { constants as cryptoConstants, createHash, randomBytes } from 'node:crypto';
import { connect, createServer, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import { calculateRuntimeCapacityHeadroom } from './worker-runtime-capacity-accounting';
import { capacityLedgerEnvelopeDigest, type CapacityLedgerMeasurement } from './worker-runtime-capacity-ledger';
import { parseRuntimeCapacityMeasurementRequest, verifyRuntimeCapacityMeasurementEvidence,
  type RuntimeCapacityMeasurementRequest, type RuntimeCapacityReplayState,
  type RuntimeCapacityVerificationContext } from './worker-runtime-capacity-protocol';
import { CAPACITY_RPC_MAX_FRAME_BYTES, capacityRpcError, capacityRpcGeneration, capacityRpcIdentity, capacityRpcRecord,
  assertCapacityRpcIdentity, encodeCapacityRpcFrame, decodeCapacityRpcPayload,
  parseCapacityRpcRequest, parseCapacityRpcResponse, type CapacityRpcIdentity,
  type CapacityRpcRequest, type CapacityRpcResponse } from './worker-runtime-capacity-rpc-schema';

type Policy = Pick<RuntimeCapacityVerificationContext,
  'maxEvidenceAgeMs' | 'maxLifetimeMs' | 'maxScanDurationMs' | 'maxScanEntries'>;
interface CommonOptions {
  socketPath: string;
  /** PEM material supplied by operator provisioning, never read from an API. */
  ca: string | Buffer; cert: string | Buffer; key: string | Buffer;
  identity: CapacityRpcIdentity;
  generation: string;
  /** SHA256 of complete DER leaf certificates, lowercase hex; 1–2 pins. */
  peerCertificatePins: readonly string[];
  isGenerationCurrent: (generation: string) => boolean;
  now: () => number;
  policy: Policy;
  /** Whole connection budget including TLS, frame receipt, handler and reply. */
  timeoutMs: number;
}
export interface CapacityRpcClientOptions extends CommonOptions { serviceHostname: string }
export interface CapacityRpcServerOptions extends CommonOptions {
  maxConnections: number;
  maxHandlers: number;
  measure: (request: RuntimeCapacityMeasurementRequest, signal: AbortSignal) => Promise<unknown>;
}
type ValidatedOptions = CommonOptions & { peerCertificatePins: readonly string[] };
export type CapacityRpcMeasurement = Omit<CapacityLedgerMeasurement, 'evidence'> &
  Pick<ReturnType<typeof verifyRuntimeCapacityMeasurementEvidence>, 'evidence'>;
function verifyMeasurement(value: unknown, context: RuntimeCapacityVerificationContext): CapacityRpcMeasurement {
  // Bound and detach trusted adapter output too; getters/toJSON cannot smuggle
  // another value past accounting checks and into the authenticated response.
  const row = capacityRpcRecord(decodeCapacityRpcPayload(encodeCapacityRpcFrame(value).subarray(4)), ['evidence', 'accounting']);
  const accounting = capacityRpcRecord(row.accounting, ['version', 'constraints', 'destinations', 'demands']) as unknown as CapacityLedgerMeasurement['accounting'];
  // Empty reservations are schema/headroom sanity ONLY. This result is never
  // admission: the durable ledger must recompute with all actual reservations.
  calculateRuntimeCapacityHeadroom({ ...accounting, reservations: [] });
  if (capacityLedgerEnvelopeDigest(accounting) !== context.expectedRequest.binding.envelopeDigest) throw capacityRpcError();
  return { evidence: verifyRuntimeCapacityMeasurementEvidence(row.evidence, context).evidence, accounting };
}
function checkOptions(options: CommonOptions): ValidatedOptions {
  if (!isAbsolute(options.socketPath) || Buffer.byteLength(options.socketPath) > 100 || options.socketPath.includes('\0') ||
      !Number.isInteger(options.timeoutMs) || options.timeoutMs < 20 || options.timeoutMs > 30_000 ||
      typeof options.now !== 'function' || typeof options.isGenerationCurrent !== 'function') throw capacityRpcError();
  const pins = [...options.peerCertificatePins];
  if (pins.length < 1 || pins.length > 2 || new Set(pins).size !== pins.length || pins.some(pin => !/^[a-f0-9]{64}$/.test(pin))) throw capacityRpcError();
  for (const material of [options.ca, options.cert, options.key])
    if (!(typeof material === 'string' || Buffer.isBuffer(material)) || !material.length || Buffer.byteLength(material) > 64 * 1024) throw capacityRpcError();
  const policy = structuredClone(capacityRpcRecord(options.policy,
    ['maxEvidenceAgeMs', 'maxLifetimeMs', 'maxScanDurationMs', 'maxScanEntries'])) as Policy;
  // Validate policy immediately through the existing verifier, using a fully
  // synthetic schema fixture. No fixture value becomes real service authority.
  const identity = capacityRpcIdentity(options.identity);
  const request = syntheticRequest(identity);
  verifyRuntimeCapacityMeasurementEvidence({ version: 1, kind: 'capacity-measurement-evidence', request,
    sequence: '1', issuedAtMs: 1, expiresAtMs: 2, scan: { status: 'complete', sourceState: 'stopped',
      startedAtMs: 1, completedAtMs: 1, entries: '1' } }, {
    expectedRequest: request, replayState: { ...identity, sequence: '0' }, nowMs: 1, ...policy,
  });
  return { ...options, identity, generation: capacityRpcGeneration(options.generation),
    ca: Buffer.from(options.ca), cert: Buffer.from(options.cert), key: Buffer.from(options.key),
    policy, peerCertificatePins: Object.freeze(pins) };
}
function syntheticRequest(identity: CapacityRpcIdentity): RuntimeCapacityMeasurementRequest {
  return { version: 1, kind: 'capacity-measurement-request', nonce: 'a'.repeat(64), issuedAtMs: 1, expiresAtMs: 2,
    binding: { ...identity, layoutGeneration: '1', maintenanceEpoch: 'validation', operationId: 'validation',
      ownerId: 'validation', workerId: 'validation', sourceContainerId: 'a'.repeat(64), targetRuntime: 'kata-qemu',
      inventoryDigest: 'sha256:' + 'a'.repeat(64), envelopeDigest: 'sha256:' + 'a'.repeat(64),
      phase: 'stopped-source', expectedSourceState: 'stopped' } };
}
function current(options: ValidatedOptions): void {
  if (options.isGenerationCurrent(options.generation) !== true) throw capacityRpcError();
}
function fresh(request: RuntimeCapacityMeasurementRequest, options: ValidatedOptions): void {
  const now = options.now();
  if (!Number.isSafeInteger(now) || now < request.issuedAtMs || now >= request.expiresAtMs ||
      request.expiresAtMs - request.issuedAtMs > options.policy.maxLifetimeMs) throw capacityRpcError();
}
function authenticate(socket: TLSSocket, options: ValidatedOptions): void {
  current(options);
  const certificate = socket.getPeerCertificate();
  if (!socket.authorized || socket.isSessionReused() || socket.getProtocol() !== 'TLSv1.3' || !certificate.raw ||
      !options.peerCertificatePins.includes(createHash('sha256').update(certificate.raw).digest('hex'))) throw capacityRpcError();
}
/** Require EOF after one exact frame. Handler dispatch never races a trailing
 * second request: the client half-closes its TLS write side before dispatch. */
function readFrame(socket: TLSSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    // One allocation avoids quadratic re-copying with one-byte fragmentation.
    const bytes = Buffer.alloc(CAPACITY_RPC_MAX_FRAME_BYTES + 4);
    let received = 0, expected: number | undefined;
    const cleanup = () => { socket.off('data', data); socket.off('end', end); socket.off('close', closed); socket.off('error', failed); };
    const failed = () => { cleanup(); reject(capacityRpcError()); };
    const closed = () => failed();
    const data = (chunk: Buffer) => {
      if (received + chunk.length > bytes.length) { failed(); socket.destroy(); return; }
      chunk.copy(bytes, received); received += chunk.length;
      if (expected === undefined && received >= 4) {
        expected = bytes.readUInt32BE(0);
        if (!expected || expected > CAPACITY_RPC_MAX_FRAME_BYTES) { failed(); socket.destroy(); return; }
      }
      if (expected !== undefined && received > expected + 4) { failed(); socket.destroy(); }
    };
    const end = () => {
      cleanup();
      try {
        if (expected === undefined || received !== expected + 4) throw capacityRpcError();
        resolve(decodeCapacityRpcPayload(bytes.subarray(4, received)));
      } catch { reject(capacityRpcError()); }
    };
    socket.on('data', data); socket.once('end', end); socket.once('close', closed); socket.once('error', failed);
  });
}

/** One independently authenticated connection per request; never auto-retry.
 * The supplied replay state is only a snapshot; this function does NOT consume
 * it. Concurrent callers must serialize durable verification/consumption. */
export function createCapacityRpcClient(input: CapacityRpcClientOptions) {
  const options = checkOptions(input);
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(input.serviceHostname)) throw capacityRpcError();
  const serviceHostname = input.serviceHostname;
  let activeRequests = 0;
  return Object.freeze({ async measure(value: unknown, replay: RuntimeCapacityReplayState,
    signal?: AbortSignal): Promise<CapacityRpcMeasurement> {
    current(options);
    const request = parseRuntimeCapacityMeasurementRequest(value);
    assertCapacityRpcIdentity(request, options.identity); fresh(request, options);
    const replayState = structuredClone(replay);
    const requestId = randomBytes(32).toString('hex');
    const frame = encodeCapacityRpcFrame({ version: 1, kind: 'capacity-rpc-request', generation: options.generation,
      requestId, method: 'measure', request });
    if (signal?.aborted || activeRequests >= 8) throw capacityRpcError();
    activeRequests++;
    return new Promise<CapacityRpcMeasurement>((resolve, reject) => {
      let settled = false;
      const socket = connect({ path: options.socketPath, ca: options.ca, cert: options.cert, key: options.key,
        servername: serviceHostname, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' });
      const finish = (error?: Error, value?: CapacityRpcMeasurement) => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(capacityRpcError());
      const timer = setTimeout(abort, options.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      socket.on('error', abort);
      socket.once('close', () => { if (!settled) abort(); });
      socket.once('secureConnect', () => {
        try { authenticate(socket, options); } catch { abort(); return; }
        const receiving = readFrame(socket);
        socket.end(frame);
        receiving.then(raw => {
          try {
            current(options);
            const response = parseCapacityRpcResponse(raw);
            if (response.generation !== options.generation || response.requestId !== requestId || response.status !== 'ok') throw capacityRpcError();
            finish(undefined, verifyMeasurement(response.measurement, {
              expectedRequest: request, replayState, nowMs: options.now(), ...options.policy,
            }));
          } catch { abort(); }
        }, abort);
      });
    }).finally(() => { activeRequests--; });
  } });
}

/** Explicit Unix bind only. Refuses occupied paths; never unlinks, chmods or
 * chowns operator storage. The operator must protect the socket's parent and
 * preconfigure process umask/ownership. This function is not an installer. */
export async function createCapacityRpcServer(input: CapacityRpcServerOptions): Promise<{ close(): Promise<void> }> {
  const options = checkOptions(input);
  if (!Number.isInteger(input.maxConnections) || input.maxConnections < 1 || input.maxConnections > 32 ||
      !Number.isInteger(input.maxHandlers) || input.maxHandlers < 1 || input.maxHandlers > input.maxConnections ||
      typeof input.measure !== 'function') throw capacityRpcError();
  const maxConnections = input.maxConnections, maxHandlers = input.maxHandlers, measure = input.measure;
  current(options);
  const connections = new Set<Socket>(), controllers = new Set<AbortController>();
  let handlers = 0, closing = false;
  const server = createServer({ ca: options.ca, cert: options.cert, key: options.key,
    requestCert: true, rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3',
    handshakeTimeout: options.timeoutMs, allowHalfOpen: true, secureOptions: cryptoConstants.SSL_OP_NO_TICKET });
  server.on('tlsClientError', () => {}); // No peer-controlled error/payload logs.
  server.on('connection', raw => {
    if (closing || connections.size >= maxConnections) { raw.destroy(); return; }
    connections.add(raw);
    const timer = setTimeout(() => raw.destroy(), options.timeoutMs);
    raw.on('error', () => {});
    raw.once('close', () => { clearTimeout(timer); connections.delete(raw); });
  });
  server.on('secureConnection', socket => {
    const controller = new AbortController(); controllers.add(controller);
    socket.on('error', () => {});
    socket.once('close', () => { controller.abort(); controllers.delete(controller); });
    const stop = () => { controller.abort(); socket.destroy(); };
    try { authenticate(socket, options); } catch { stop(); return; }
    const reply = (request: CapacityRpcRequest, result: { status: 'ok'; measurement: unknown } |
      { status: 'error'; error: 'REJECTED' | 'UNAVAILABLE' | 'BUSY' }) => {
      if (closing || controller.signal.aborted || socket.destroyed) return;
      try {
        current(options);
        const response: CapacityRpcResponse = { version: 1, kind: 'capacity-rpc-response',
          generation: options.generation, requestId: request.requestId, ...result };
        socket.end(encodeCapacityRpcFrame(response));
      } catch { stop(); }
    };
    void readFrame(socket).then(async raw => {
      let request: CapacityRpcRequest;
      try {
        current(options); request = parseCapacityRpcRequest(raw);
        if (closing || controller.signal.aborted || request.generation !== options.generation) throw capacityRpcError();
        assertCapacityRpcIdentity(request.request, options.identity); fresh(request.request, options);
      } catch { stop(); return; }
      if (handlers >= maxHandlers) { reply(request, { status: 'error', error: 'BUSY' }); return; }
      handlers++;
      try {
        const result = await measure(structuredClone(request.request), controller.signal);
        if (controller.signal.aborted || closing) return;
        current(options);
        // Validation is not replay consumption. The ledger remains the sole
        // future durable authority; this read-only adapter cannot reserve.
        const verified = verifyMeasurement(result, {
          expectedRequest: request.request, replayState: { ...options.identity, sequence: '0' },
          nowMs: options.now(), ...options.policy,
        });
        reply(request, { status: 'ok', measurement: { evidence: verified.evidence, accounting: verified.accounting } });
      } catch { reply(request, { status: 'error', error: 'UNAVAILABLE' }); }
      finally { handlers--; }
    }, stop);
  });
  await new Promise<void>((resolve, reject) => {
    const error = () => { server.close(); reject(capacityRpcError()); };
    server.once('error', error);
    server.listen(options.socketPath, () => { server.off('error', error); resolve(); });
  });
  // Runtime listener failure ends service availability, never changes ledger.
  server.on('error', () => { for (const socket of connections) socket.destroy(); });
  return Object.freeze({ async close() {
    closing = true;
    for (const controller of controllers) controller.abort();
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } });
}
