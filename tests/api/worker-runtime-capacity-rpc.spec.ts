import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { connect as tlsConnect, createServer as tlsServer, type TLSSocket } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { createCapacityRpcClient, createCapacityRpcServer, type CapacityRpcClientOptions,
  type CapacityRpcServerOptions } from '../../orchestrator/server/utils/worker-runtime-capacity-rpc';
import { CAPACITY_RPC_MAX_FRAME_BYTES, encodeCapacityRpcFrame, decodeCapacityRpcPayload,
  parseCapacityRpcRequest, parseCapacityRpcResponse } from '../../orchestrator/server/utils/worker-runtime-capacity-rpc-schema';
import { capacityLedgerEnvelopeDigest, RuntimeCapacityLedger } from '../../orchestrator/server/utils/worker-runtime-capacity-ledger';
import type { RuntimeCapacityMeasurementRequest } from '../../orchestrator/server/utils/worker-runtime-capacity-protocol';

const identity = { hostId: 'test-host', serviceId: 'test-capacity', daemonId: 'test-daemon' };
const hostname = 'test-host.capacity.invalid';
const policy = { maxEvidenceAgeMs: 1000, maxLifetimeMs: 10_000, maxScanDurationMs: 1000, maxScanEntries: '100' };
const accounting = { version: 1 as const,
  constraints: [{ id: 'fs', kind: 'filesystem' as const, available: { bytes: '1000', inodes: '1000' }, safetyFloor: { bytes: '1', inodes: '1' } }],
  destinations: [{ id: 'rootfs', constraintIds: ['fs'] }],
  demands: [{ id: 'snapshot', destinationId: 'rootfs', amount: { bytes: '10', inodes: '10' } }] };
function request(): RuntimeCapacityMeasurementRequest {
  return { version: 1, kind: 'capacity-measurement-request', nonce: 'a'.repeat(64), issuedAtMs: 1000, expiresAtMs: 2000,
    binding: { ...identity, layoutGeneration: '1', maintenanceEpoch: 'test-epoch', operationId: 'test-op',
      ownerId: 'test-owner', workerId: 'test-worker', sourceContainerId: 'b'.repeat(64), targetRuntime: 'kata-qemu',
      inventoryDigest: 'sha256:' + 'c'.repeat(64), envelopeDigest: capacityLedgerEnvelopeDigest(accounting),
      phase: 'stopped-source', expectedSourceState: 'stopped' } };
}
function measurement(r = request()) {
  return { evidence: { version: 1, kind: 'capacity-measurement-evidence', request: r, sequence: '1',
    issuedAtMs: 1001, expiresAtMs: 2000, scan: { status: 'complete', sourceState: 'stopped',
      startedAtMs: 1000, completedAtMs: 1001, entries: '1' } }, accounting: structuredClone(accounting) };
}
function rpcRequest() { return { version: 1, kind: 'capacity-rpc-request', generation: '1', requestId: 'd'.repeat(64), method: 'measure', request: request() }; }
type Certificate = { cert: Buffer; key: Buffer; pin: string };
let directory: string, ca: Buffer, otherCa: Buffer, serverCert: Certificate, clientCert: Certificate,
  rotatedServer: Certificate, rotatedClient: Certificate, rogueClient: Certificate, expiredServer: Certificate;
let number = 0;
const socketPath = () => join(directory, `s${number++}`);
function openssl(...args: string[]) { execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] }); }
async function certificate(name: string, authority: string, role: 'server' | 'client', days = '1'): Promise<Certificate> {
  const key = join(directory, name + '.key'), csr = join(directory, name + '.csr'), cert = join(directory, name + '.pem');
  openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key,
    '-out', csr, '-subj', '/CN=' + (role === 'server' ? hostname : name));
  const extensions = join(directory, name + '.ext');
  await writeFile(extensions, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=' +
    (role === 'server' ? 'serverAuth\nsubjectAltName=DNS:' + hostname : 'clientAuth') + '\n', { mode: 0o600 });
  openssl('x509', '-req', '-in', csr, '-CA', join(directory, authority + '.pem'), '-CAkey', join(directory, authority + '.key'),
    '-CAcreateserial', '-days', days, '-out', cert, '-extfile', extensions);
  const bytes = await readFile(cert);
  return { cert: bytes, key: await readFile(key), pin: createHash('sha256').update(new X509Certificate(bytes).raw).digest('hex') };
}
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'capacity-rpc-'));
  for (const name of ['ca', 'other-ca']) openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', join(directory, name + '.key'), '-out', join(directory, name + '.pem'), '-days', '1', '-subj', '/CN=' + name,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  ca = await readFile(join(directory, 'ca.pem')); otherCa = await readFile(join(directory, 'other-ca.pem'));
  serverCert = await certificate('server', 'ca', 'server'); rotatedServer = await certificate('server-rotated', 'ca', 'server');
  clientCert = await certificate('client', 'ca', 'client'); rotatedClient = await certificate('client-rotated', 'ca', 'client');
  rogueClient = await certificate('rogue-client', 'other-ca', 'client'); expiredServer = await certificate('expired-server', 'ca', 'server', '-1');
});
test.afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
function clientOptions(path: string): CapacityRpcClientOptions {
  return { socketPath: path, ca, cert: clientCert.cert, key: clientCert.key, identity, generation: '1',
    peerCertificatePins: [serverCert.pin], isGenerationCurrent: () => true, now: () => 1001, policy, timeoutMs: 1000, serviceHostname: hostname };
}
function serverOptions(path: string): CapacityRpcServerOptions {
  return { ...clientOptions(path), cert: serverCert.cert, key: serverCert.key, peerCertificatePins: [clientCert.pin],
    maxConnections: 8, maxHandlers: 2, measure: async r => measurement(r) };
}
const replay = () => ({ ...identity, sequence: '0' });
async function rejectExchange(client: CapacityRpcClientOptions, server: CapacityRpcServerOptions) {
  let calls = 0;
  const service = await createCapacityRpcServer({ ...server, measure: async r => { calls++; return measurement(r); } });
  try { await expect(createCapacityRpcClient(client).measure(request(), replay())).rejects.toThrow(); expect(calls).toBe(0); }
  finally { await service.close(); }
}
async function rawSend(path: string, data: Buffer, halfClose = true): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    const socket = tlsConnect({ path, ca, cert: clientCert.cert, key: clientCert.key, servername: hostname,
      rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, () => {
      if (halfClose) socket.end(data); else socket.write(data);
    });
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.on('data', chunk => chunks.push(chunk)); socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks)); });
  });
}

test('mutually authenticated Unix RPC returns detached digest-bound accounting and evidence, never a ticket', async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => { calls++; return measurement(r); } });
  try {
    const client = createCapacityRpcClient(clientOptions(path));
    const result = await client.measure(request(), replay());
    expect(result).toEqual(measurement());
    result.accounting.demands[0]!.amount.bytes = '99';
    expect((await client.measure(request(), replay())).accounting).toEqual(accounting);
    expect(calls).toBe(2); // transport intentionally does not consume nonce/replay state
    await expect(client.measure(request(), { ...replay(), sequence: '1' })).rejects.toThrow();
  } finally { await service.close(); }
});
test('authenticated payload fits ledger callback without treating transport success as reservation', async () => {
  const path = socketPath(), control = await mkdtemp(join(directory, 'ledger-'));
  const service = await createCapacityRpcServer(serverOptions(path));
  const ledger = await RuntimeCapacityLedger.open({ directory: control, identity, create: true, now: () => 1001, policy });
  try {
    await ledger.reconcile({ expectedStateDigest: (await ledger.inspect()).stateDigest,
      reviewDigest: 'sha256:' + 'e'.repeat(64), layoutGeneration: '1', maintenanceEpoch: 'test-epoch' });
    await ledger.prepare(request());
    const client = createCapacityRpcClient(clientOptions(path));
    await client.measure(request(), replay());
    expect((await ledger.inspect()).state.entries[0]!.status).toBe('pending');
    expect(await ledger.reserve(request(), r => client.measure(r, replay()))).toMatchObject({ status: 'reserved', sequence: '1' });
  } finally { await ledger.close(); await service.close(); }
});
for (const failure of ['client-pin', 'server-pin', 'server-ca', 'client-ca', 'hostname', 'expired-server', 'generation', 'identity'])
  test(`rejects ${failure} before measurement dispatch`, async () => {
    const path = socketPath(), client = clientOptions(path), server = serverOptions(path);
    if (failure === 'client-pin') server.peerCertificatePins = [rotatedClient.pin];
    if (failure === 'server-pin') client.peerCertificatePins = [rotatedServer.pin];
    if (failure === 'server-ca') client.ca = otherCa;
    if (failure === 'client-ca') { client.cert = rogueClient.cert; client.key = rogueClient.key; server.peerCertificatePins = [rogueClient.pin]; }
    if (failure === 'hostname') client.serviceHostname = 'wrong.capacity.invalid';
    if (failure === 'expired-server') { server.cert = expiredServer.cert; server.key = expiredServer.key; client.peerCertificatePins = [expiredServer.pin]; }
    if (failure === 'generation') client.generation = '2';
    if (failure === 'identity') server.identity = { ...identity, daemonId: 'different-daemon' };
    await rejectExchange(client, server);
  });
test('rotation permits exactly the configured overlapping pins and rejects removed generation before reply', async () => {
  const path = socketPath(); let active = true;
  const service = await createCapacityRpcServer({ ...serverOptions(path), cert: rotatedServer.cert, key: rotatedServer.key,
    peerCertificatePins: [clientCert.pin, rotatedClient.pin], isGenerationCurrent: () => active,
    measure: async r => { active = false; return measurement(r); } });
  try {
    const client = createCapacityRpcClient({ ...clientOptions(path), cert: rotatedClient.cert, key: rotatedClient.key,
      peerCertificatePins: [serverCert.pin, rotatedServer.pin] });
    await expect(client.measure(request(), replay())).rejects.toThrow();
  } finally { await service.close(); }
});
test('overlapping rotation accepts both fresh authenticated identities without sessions', async () => {
  const path = socketPath();
  const service = await createCapacityRpcServer({ ...serverOptions(path), cert: rotatedServer.cert, key: rotatedServer.key,
    peerCertificatePins: [clientCert.pin, rotatedClient.pin] });
  try {
    for (const leaf of [clientCert, rotatedClient]) {
      const client = createCapacityRpcClient({ ...clientOptions(path), cert: leaf.cert, key: leaf.key,
        peerCertificatePins: [serverCert.pin, rotatedServer.pin] });
      expect((await client.measure(request(), replay())).evidence.sequence).toBe('1');
    }
  } finally { await service.close(); }
});
test('client revocation while a reply is in flight refuses the reply', async () => {
  const path = socketPath(); let active = true;
  const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => { active = false; return measurement(r); } });
  try { await expect(createCapacityRpcClient({ ...clientOptions(path), isGenerationCurrent: () => active }).measure(request(), replay())).rejects.toThrow(); }
  finally { await service.close(); }
});
for (const failure of ['stale', 'future', 'incomplete', 'wrong-nonce', 'wrong-sequence', 'wrong-envelope', 'malformed-accounting', 'extra-accounting-authority'])
  test(`trusted handler's ${failure} output cannot become authenticated success`, async () => {
    const path = socketPath();
    const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => {
      const value: any = measurement(r);
      if (failure === 'stale') value.evidence.expiresAtMs = 1001;
      if (failure === 'future') value.evidence.issuedAtMs = 1002;
      if (failure === 'incomplete') value.evidence.scan.status = 'partial';
      if (failure === 'wrong-nonce') value.evidence.request.nonce = 'e'.repeat(64);
      if (failure === 'wrong-sequence') value.evidence.sequence = '0';
      if (failure === 'wrong-envelope') value.accounting.demands[0].amount.bytes = '11';
      if (failure === 'malformed-accounting') value.accounting.constraints[0].available.bytes = '01';
      if (failure === 'extra-accounting-authority') value.accounting.reservations = [];
      return value;
    } });
    try { await expect(createCapacityRpcClient(clientOptions(path)).measure(request(), replay())).rejects.toThrow(); }
    finally { await service.close(); }
  });
for (const failure of ['zero-length', 'oversized-length', 'truncated', 'double-frame', 'duplicate-key', 'invalid-utf8', 'unknown-method', 'extra-path'])
  test(`bounded parser rejects ${failure} before dispatch`, async () => {
    const path = socketPath(); let calls = 0;
    const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => { calls++; return measurement(r); } });
    let frame = encodeCapacityRpcFrame(rpcRequest());
    if (failure === 'zero-length') frame = Buffer.alloc(4);
    if (failure === 'oversized-length') { frame = Buffer.alloc(4); frame.writeUInt32BE(CAPACITY_RPC_MAX_FRAME_BYTES + 1); }
    if (failure === 'truncated') frame = frame.subarray(0, frame.length - 1);
    if (failure === 'double-frame') frame = Buffer.concat([frame, frame]);
    if (failure === 'duplicate-key') { const body = Buffer.from('{"version":1,"version":1}'); frame = Buffer.alloc(body.length + 4); frame.writeUInt32BE(body.length); body.copy(frame, 4); }
    if (failure === 'invalid-utf8') { frame = Buffer.from([0, 0, 0, 1, 0xff]); }
    if (failure === 'unknown-method') frame = encodeCapacityRpcFrame({ ...rpcRequest(), method: 'reserve' });
    if (failure === 'extra-path') frame = encodeCapacityRpcFrame({ ...rpcRequest(), path: '/not-permitted' });
    try { expect((await rawSend(path, frame)).length).toBe(0); expect(calls).toBe(0); }
    finally { await service.close(); }
  });
test('unsettled handler retains its slot after deadline; no repeated work or capacity release is inferred', async () => {
  const path = socketPath(); let calls = 0, aborted = false, release!: () => void;
  const service = await createCapacityRpcServer({ ...serverOptions(path), timeoutMs: 120, maxHandlers: 1,
    measure: async (r, signal) => { calls++; signal.addEventListener('abort', () => { aborted = true; });
      await new Promise<void>(resolve => { release = resolve; }); return measurement(r); } });
  try {
    const client = createCapacityRpcClient({ ...clientOptions(path), timeoutMs: 500 });
    await expect(client.measure(request(), replay())).rejects.toThrow();
    await expect.poll(() => aborted).toBe(true);
    await expect(client.measure(request(), replay())).rejects.toThrow();
    expect(calls).toBe(1);
  } finally { release?.(); await service.close(); }
});
test('abort stops waiting, signals handler and does not assert cancellation settlement', async () => {
  const path = socketPath(), cancel = new AbortController(); let seen!: () => void;
  const observed = new Promise<void>(resolve => { seen = resolve; });
  const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async (_r, signal) => {
    cancel.abort(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { seen(); resolve(); }, { once: true }));
    throw new Error('not logged');
  } });
  try {
    await expect(createCapacityRpcClient(clientOptions(path)).measure(request(), replay(), cancel.signal)).rejects.toThrow();
    await observed;
  } finally { await service.close(); }
});
test('handshake and unfinished request have absolute deadlines before handler dispatch', async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), timeoutMs: 100, measure: async r => { calls++; return measurement(r); } });
  try {
    const start = Date.now();
    await new Promise<void>(resolve => { const socket = netConnect(path); socket.on('error', () => {}); socket.on('close', () => resolve()); });
    expect(Date.now() - start).toBeLessThan(1000);
    expect((await rawSend(path, encodeCapacityRpcFrame(rpcRequest()), false)).length).toBe(0);
    expect(calls).toBe(0);
  } finally { await service.close(); }
});
test('fixed connection bound includes unauthenticated stalled handshakes', async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), maxConnections: 1, maxHandlers: 1,
    measure: async r => { calls++; return measurement(r); } });
  const held = netConnect(path); held.on('error', () => {});
  try {
    await new Promise<void>(resolve => held.once('connect', resolve));
    await expect(createCapacityRpcClient(clientOptions(path)).measure(request(), replay())).rejects.toThrow();
    expect(calls).toBe(0);
  } finally { held.destroy(); await service.close(); }
});
test('fixed client request bound rejects the ninth call without queueing or dispatch', async () => {
  const path = socketPath(); let calls = 0; const releases: Array<() => void> = [];
  const service = await createCapacityRpcServer({ ...serverOptions(path), maxConnections: 16, maxHandlers: 16,
    measure: async r => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return measurement(r); } });
  const client = createCapacityRpcClient(clientOptions(path));
  const pending = Array.from({ length: 8 }, () => client.measure(request(), replay()));
  // Attach rejection handlers immediately in case a failing test reaches timeout.
  const settled = Promise.allSettled(pending);
  try {
    await expect(client.measure(request(), replay())).rejects.toThrow();
    await expect.poll(() => calls).toBe(8);
    for (const release of releases) release();
    expect((await settled).every(result => result.status === 'fulfilled')).toBe(true);
  } finally { for (const release of releases) release(); await service.close(); await settled; }
});
for (const mode of ['missing-certificate', 'tls12', 'wrong-purpose']) test(`TLS rejects ${mode} before RPC dispatch`, async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), peerCertificatePins: [clientCert.pin, serverCert.pin],
    measure: async r => { calls++; return measurement(r); } });
  try {
    await new Promise<void>(resolve => {
      const leaf = mode === 'wrong-purpose' ? serverCert : clientCert;
      const socket = tlsConnect({ path, ca, servername: hostname, rejectUnauthorized: true,
        ...(mode !== 'missing-certificate' ? { cert: leaf.cert, key: leaf.key } : {}),
        minVersion: mode === 'tls12' ? 'TLSv1.2' : 'TLSv1.3', maxVersion: mode === 'tls12' ? 'TLSv1.2' : 'TLSv1.3' }, () => {
        socket.end(encodeCapacityRpcFrame(rpcRequest()));
      });
      socket.on('error', () => {}); socket.on('close', () => resolve());
    });
    expect(calls).toBe(0);
  } finally { await service.close(); }
});
test('fragmented request is accepted only after its exact EOF boundary', async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => { calls++; return measurement(r); } });
  try {
    const received = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [], frame = encodeCapacityRpcFrame(rpcRequest());
      const socket = tlsConnect({ path, ca, cert: clientCert.cert, key: clientCert.key, servername: hostname,
        rejectUnauthorized: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, () => {
        for (const byte of frame) socket.write(Buffer.from([byte]));
        expect(calls).toBe(0); socket.end();
      });
      socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject);
      socket.on('end', () => { socket.destroy(); resolve(Buffer.concat(chunks)); });
    });
    expect(parseCapacityRpcResponse(decodeCapacityRpcPayload(received.subarray(4))).status).toBe('ok');
    expect(calls).toBe(1);
  } finally { await service.close(); }
});
test('already aborted or stale local requests cannot reach the service', async () => {
  const path = socketPath(); let calls = 0;
  const service = await createCapacityRpcServer({ ...serverOptions(path), measure: async r => { calls++; return measurement(r); } });
  try {
    await expect(createCapacityRpcClient(clientOptions(path)).measure(request(), replay(), AbortSignal.abort())).rejects.toThrow();
    await expect(createCapacityRpcClient({ ...clientOptions(path), now: () => 2000 }).measure(request(), replay())).rejects.toThrow();
    expect(calls).toBe(0);
  } finally { await service.close(); }
});
test('occupied socket is not removed/replaced and endpoint outage has no network fallback', async () => {
  const path = socketPath(); const service = await createCapacityRpcServer(serverOptions(path));
  try {
    await expect(createCapacityRpcServer(serverOptions(path))).rejects.toThrow();
    expect((await createCapacityRpcClient(clientOptions(path)).measure(request(), replay())).evidence.sequence).toBe('1');
    await expect(createCapacityRpcClient(clientOptions(socketPath())).measure(request(), replay())).rejects.toThrow();
  } finally { await service.close(); }
});
test('local schema boundary rejects getters, nesting, symbols, array holes and unbounded data without evaluating hooks', () => {
  let invoked = false;
  expect(() => encodeCapacityRpcFrame({ get value() { invoked = true; return 1; } })).toThrow();
  expect(invoked).toBe(false);
  for (const value of [{ [Symbol('x')]: 1 }, new Array(2), { x: 'x'.repeat(CAPACITY_RPC_MAX_FRAME_BYTES) },
    Array(65).fill(1), { x: -0 }, { toJSON() { invoked = true; return 1; } }]) expect(() => encodeCapacityRpcFrame(value)).toThrow();
  let deep: unknown = null; for (let i = 0; i < 14; i++) deep = { deep };
  expect(() => encodeCapacityRpcFrame(deep)).toThrow(); expect(invoked).toBe(false);
  expect(() => decodeCapacityRpcPayload(Buffer.from('{ "x":1}'))).toThrow();
  expect(() => parseCapacityRpcRequest({ ...rpcRequest(), version: 2 })).toThrow();
  expect(() => parseCapacityRpcResponse({ version: 1, kind: 'capacity-rpc-response', generation: '1', requestId: 'd'.repeat(64), status: 'error', error: 'private message' })).toThrow();
});
test('operator configuration bounds fail closed', async () => {
  const base = clientOptions(socketPath());
  for (const patch of [{ socketPath: 'relative' }, { socketPath: '/x\0y' }, { timeoutMs: 0 }, { timeoutMs: 30_001 },
    { peerCertificatePins: [] }, { peerCertificatePins: [serverCert.pin, serverCert.pin] }, { generation: '0' },
    { serviceHostname: 'unix:///socket' }, { policy: { ...policy, maxScanEntries: '0' } }])
    expect(() => createCapacityRpcClient({ ...base, ...patch } as any)).toThrow();
  await expect(createCapacityRpcServer({ ...serverOptions(socketPath()), maxConnections: 33 })).rejects.toThrow();
  await expect(createCapacityRpcServer({ ...serverOptions(socketPath()), maxHandlers: 9 })).rejects.toThrow();
  expect(() => createCapacityRpcClient({ ...base, isGenerationCurrent: () => false })).not.toThrow();
  await expect(createCapacityRpcClient({ ...base, isGenerationCurrent: () => false }).measure(request(), replay())).rejects.toThrow();
});

for (const failure of ['request-id', 'generation', 'unknown-field', 'malformed-accounting', 'envelope-digest', 'replayed', 'extra-frame'])
  test(`client rejects authenticated service's ${failure} response`, async () => {
    const path = socketPath(); const sockets = new Set<TLSSocket>();
    const service = tlsServer({ ca, cert: serverCert.cert, key: serverCert.key, requestCert: true, rejectUnauthorized: true,
      allowHalfOpen: true, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, socket => {
      sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
      const chunks: Buffer[] = []; socket.on('data', chunk => chunks.push(chunk));
      socket.on('end', () => {
        const req = parseCapacityRpcRequest(decodeCapacityRpcPayload(Buffer.concat(chunks).subarray(4)));
        const response: any = { version: 1, kind: 'capacity-rpc-response', generation: '1', requestId: req.requestId,
          status: 'ok', measurement: measurement(req.request) };
        if (failure === 'request-id') response.requestId = 'f'.repeat(64);
        if (failure === 'generation') response.generation = '2';
        if (failure === 'unknown-field') response.ticket = true;
        if (failure === 'malformed-accounting') response.measurement.accounting.constraints[0].available.inodes = '-1';
        if (failure === 'envelope-digest') response.measurement.accounting.demands[0].amount.bytes = '11';
        if (failure === 'replayed') response.measurement.evidence.sequence = '1';
        const frame = encodeCapacityRpcFrame(response);
        socket.end(failure === 'extra-frame' ? Buffer.concat([frame, frame]) : frame);
      });
    });
    await new Promise<void>(resolve => service.listen(path, resolve));
    try {
      await expect(createCapacityRpcClient(clientOptions(path)).measure(request(), { ...replay(), sequence: failure === 'replayed' ? '1' : '0' })).rejects.toThrow();
    } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => service.close(() => resolve())); }
  });
