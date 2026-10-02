import { expect, test } from '@playwright/test';
import { createServer, request, type ClientRequest, type RequestOptions } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { Socket } from 'node:net';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { createDockerArchiveTransfer } from '../../orchestrator/server/utils/docker-archive-transfer';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement, OperationDeadlineError } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function heldWritable() {
  const destroying = deferred(), released = deferred();
  const stream = new Writable({ autoDestroy: false, write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) {
    destroying.resolve(); void released.promise.then(() => callback(error));
  } });
  return { stream, destroying, released };
}
function heldResponse(statusCode = 200) {
  const destroying = deferred(), released = deferred();
  const stream = Object.assign(new Readable({ read() {}, destroy(error, callback) {
    destroying.resolve(); void released.promise.then(() => callback(error));
  } }), { statusCode });
  return { stream, destroying, released };
}
function fixture(timeoutMs = 1000) {
  const coordinator = new InstanceControlPlaneCoordinator(), req = heldWritable(), socket = heldWritable();
  const seen: RequestOptions[] = [];
  const open = createDockerArchiveTransfer({ coordinator, timeoutMs, request: options => {
    seen.push(options); queueMicrotask(() => req.stream.emit('socket', socket.stream));
    return req.stream as unknown as ClientRequest;
  } });
  return { coordinator, req, socket, seen, open, async close() {
    req.stream.destroy(); socket.stream.destroy(); req.released.resolve(); socket.released.resolve();
    await expect.poll(() => coordinator.activeOperations).toBe(0);
  } };
}

test('pre-aborted archive never creates a request and preserves cancellation error', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.open({ kind: 'archive', containerId: 'worker', path: '/workspace', signal: controller.signal }))
    .rejects.toMatchObject({ code: 'OPERATION_ABORTED', statusCode: 499 });
  expect(f.seen).toEqual([]); expect(f.coordinator.activeOperations).toBe(0);
});

test('closed barrier rejects archive before acquiring the socket', async () => {
  const f = fixture(), barrier = f.coordinator.begin('archive-admission', 'snapshot');
  try {
    await expect(f.open({ kind: 'export', containerId: 'worker' })).rejects.toMatchObject({ statusCode: 423 });
    expect(f.seen).toEqual([]); barrier.assertDrained();
  } finally { barrier.release(); }
});

test('invalid resource identity cannot change endpoint structure or acquire a socket', async () => {
  const f = fixture();
  for (const containerId of ['', '.', '..', 'a\0b'])
    await expect(f.open({ kind: 'export', containerId })).rejects.toThrow('Invalid Docker archive resource');
  for (const path of ['relative', '/a\0b', '/'.repeat(4097)])
    await expect(f.open({ kind: 'archive', containerId: 'worker', path })).rejects.toThrow('Invalid Docker archive resource');
  expect(f.seen).toEqual([]); expect(f.coordinator.activeOperations).toBe(0);
});

test('request error is prompt but request and socket actual close remain independently owned', async () => {
  const f = fixture(), original = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  const result = f.open({ kind: 'export', containerId: 'worker' }).catch(error => error);
  f.req.stream.emit('error', original); const error = await result;
  const barrier = f.coordinator.begin('archive-request-error', 'snapshot');
  try {
    expect(error).toBeInstanceOf(Error); expect(error).toMatchObject({ code: 'ECONNREFUSED', message: original.message });
    f.req.stream.emit('close'); f.socket.stream.emit('close');
    expect(f.req.stream.closed).toBe(false); expect(f.socket.stream.closed).toBe(false);
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    f.req.released.resolve();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    f.socket.released.resolve(); await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
  } finally { barrier.release(); await f.close(); }
});

for (const mode of ['timeout', 'abort'] as const) {
  test(`${mode} retains a response arriving after rejected setup until all actual closures`, async () => {
    const f = fixture(mode === 'timeout' ? 20 : 1000), response = heldResponse(), controller = new AbortController();
    const result = f.open({ kind: 'workspace', containerId: 'worker', path: '/workspace', signal: controller.signal }).catch(error => error);
    if (mode === 'abort') controller.abort();
    const error = await result, barrier = f.coordinator.begin(`archive-late-${mode}`, 'snapshot');
    try {
      expect(error).toBeInstanceOf(OperationDeadlineError);
      expect(error).toMatchObject({ code: mode === 'timeout' ? 'DOCKER_OPERATION_TIMEOUT' : 'OPERATION_ABORTED', data: { operation: 'Docker workspace archive preparation' } });
      f.req.stream.emit('response', response.stream); await response.destroying.promise;
      response.stream.emit('close'); f.req.stream.emit('close');
      f.req.released.resolve(); f.socket.released.resolve();
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      response.released.resolve(); await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
    } finally { response.released.resolve(); barrier.release(); await f.close(); }
  });
}

test('successful headers return unchanged stream but do not release request or response ownership', async () => {
  const f = fixture(), response = heldResponse(), controller = new AbortController();
  const opening = f.open({ kind: 'archive', containerId: 'id/name?x#y', path: '/workspace/a?b&c=1#d', signal: controller.signal });
  f.req.stream.emit('response', response.stream); const stream = await opening;
  expect(stream).toBe(response.stream);
  expect(f.seen).toEqual([{ socketPath: '/var/run/docker.sock', method: 'GET', path: '/containers/id%2Fname%3Fx%23y/archive?path=%2Fworkspace%2Fa%3Fb%26c%3D1%23d', agent: false, headers: { Connection: 'close' } }]);
  const barrier = f.coordinator.begin('archive-streaming', 'snapshot');
  try {
    controller.abort(); await response.destroying.promise;
    f.req.released.resolve(); f.socket.released.resolve();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    response.released.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { response.released.resolve(); barrier.release(); await f.close(); }
});

test('non-200 daemon errors preserve status and bounded JSON diagnostic', async () => {
  const f = fixture(), response = heldResponse(404);
  const result = f.open({ kind: 'archive', containerId: 'worker', path: '/missing' }).catch(error => error);
  f.req.stream.emit('response', response.stream); response.stream.push('{"message":"No such container: worker"}'); response.stream.push(null);
  const error = await result, barrier = f.coordinator.begin('archive-error-body', 'snapshot');
  try {
    expect(error).toMatchObject({ statusCode: 404, reason: 'no such container', json: null });
    expect(error.message).toContain('No such container: worker');
    f.req.released.resolve(); f.socket.released.resolve();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    response.released.resolve(); await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
  } finally { response.released.resolve(); barrier.release(); await f.close(); }
});

test('oversized daemon error body stops at bounded diagnostic without consuming unbounded input', async () => {
  const f = fixture(), response = heldResponse(500);
  const result = f.open({ kind: 'export', containerId: 'worker' }).catch(error => error);
  f.req.stream.emit('response', response.stream); response.stream.push(Buffer.alloc(65537, 120));
  const error = await result;
  try {
    expect(error).toMatchObject({ statusCode: 500 }); expect(error.message).toContain('exceeded the size limit'); expect(error.message.length).toBeLessThan(200);
    await response.destroying.promise;
  } finally { response.released.resolve(); await f.close(); await error[operationSettlement]; }
});

test('non-200 headers do not end setup deadline while error body is stalled', async () => {
  const f = fixture(20), response = heldResponse(500);
  const result = f.open({ kind: 'export', containerId: 'worker' }).catch(error => error);
  f.req.stream.emit('response', response.stream); response.stream.push('partial');
  const error = await result;
  try { expect(error).toMatchObject({ code: 'DOCKER_OPERATION_TIMEOUT' }); await response.destroying.promise; }
  finally { response.released.resolve(); await f.close(); await error[operationSettlement]; }
});

for (const event of ['upgrade', 'connect'] as const) {
  test(`unexpected ${event} retains transferred socket and response until actual closure`, async () => {
    const f = fixture(), response = heldResponse(101), extraSocket = heldWritable();
    const result = f.open({ kind: 'export', containerId: 'worker' }).catch(error => error);
    f.req.stream.emit(event, response.stream, extraSocket.stream, Buffer.alloc(0));
    const error = await result, barrier = f.coordinator.begin(`archive-${event}`, 'snapshot');
    try {
      expect(error.message).toContain('Unexpected Docker protocol upgrade');
      response.released.resolve(); f.req.released.resolve(); f.socket.released.resolve();
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      extraSocket.released.resolve(); await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
    } finally { extraSocket.released.resolve(); response.released.resolve(); barrier.release(); await f.close(); }
  });
}

test('synchronous request creation failure retires its preregistered child', async () => {
  const coordinator = new InstanceControlPlaneCoordinator(); let calls = 0;
  const open = createDockerArchiveTransfer({ coordinator, request: () => { calls++; throw new Error('request creation failed'); } });
  await expect(open({ kind: 'export', containerId: 'worker' })).rejects.toThrow('request creation failed');
  expect(calls).toBe(1); expect(coordinator.activeOperations).toBe(0);
});

test('real local Unix HTTP success/error closes exclusive request, socket and response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-http-')), socketPath = join(directory, 'test.sock');
  const paths: string[] = [], coordinator = new InstanceControlPlaneCoordinator();
  const server = createServer((req, res) => {
    paths.push(req.url!);
    if (req.url!.includes('/missing/')) { res.writeHead(404); res.end('{"message":"missing test resource"}'); }
    else { res.writeHead(200, { 'Content-Type': 'application/x-tar' }); res.end('synthetic tar bytes'); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  const open = createDockerArchiveTransfer({ coordinator, request: options => {
    expect(options.socketPath).toBe('/var/run/docker.sock'); return request({ ...options, socketPath });
  } });
  try {
    const stream = await open({ kind: 'export', containerId: 'worker' }), chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('synthetic tar bytes');
    const error = await open({ kind: 'archive', containerId: 'missing', path: '/workspace' }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 404 }); await error[operationSettlement];
    const barrier = coordinator.begin('archive-real-local', 'snapshot');
    try { await barrier.drain({ timeoutMs: 1000 }); } finally { barrier.release(); }
    expect(paths).toEqual(['/containers/worker/export', '/containers/missing/archive?path=%2Fworkspace']);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('all service archive methods fail closed on mismatched effective modem before dialing', async () => {
  let connections = 0;
  const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = function () { connections++; throw new Error('test forbids all connections'); } as any;
  const service = Object.create(DockerService.prototype) as DockerService;
  const base = { protocol: 'http', socketPath: '/var/run/docker.sock', headers: {} };
  try {
    for (const modem of [undefined, { ...base, host: '127.0.0.1' }, { ...base, protocol: 'ssh' },
      { ...base, socketPath: '/synthetic/other.sock' }, { ...base, socketPath: () => '/var/run/docker.sock' },
      { ...base, socketPathCache: '/synthetic/cached.sock' }, { ...base, version: 'v1.45' },
      { ...base, agent: {} }, { ...base, headers: { Authorization: 'synthetic-secret' } }, { ...base, headers: [] }]) {
      (service as any).docker = { modem };
      for (const action of [() => service.getWorkspaceArchive('worker'), () => service.getArchive('worker', '/workspace'), () => service.exportContainer('worker')]) {
        const error = await action().catch(error => error);
        expect(error).toMatchObject({ statusCode: 503, code: 'DOCKER_ARCHIVE_ENDPOINT_UNSUPPORTED' });
        expect(error.message).not.toContain('synthetic'); expect(error.message).not.toContain('127.0.0.1');
      }
    }
    expect(connections).toBe(0);
  } finally { Socket.prototype.connect = originalConnect; }
});

test('pinned docker-modem host environment cannot silently redirect only archive reads to local Docker', async () => {
  const keys = ['DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'DOCKER_PATH_PREFIX', 'DOCKER_CLIENT_TIMEOUT'];
  const previous = keys.map(key => [key, process.env[key]] as const);
  let connections = 0; const originalConnect = Socket.prototype.connect;
  Socket.prototype.connect = function () { connections++; throw new Error('test forbids all connections'); } as any;
  try {
    for (const key of keys) delete process.env[key];
    for (const host of ['tcp://127.0.0.1:1', 'ssh://synthetic-user@127.0.0.1:1']) {
      process.env.DOCKER_HOST = host;
      const service = new DockerService({} as any);
      expect((service as any).docker.modem.host).toBe('127.0.0.1');
      for (const action of [() => service.getWorkspaceArchive('worker'), () => service.getArchive('worker', '/workspace'), () => service.exportContainer('worker')])
        await expect(action()).rejects.toMatchObject({ statusCode: 503, code: 'DOCKER_ARCHIVE_ENDPOINT_UNSUPPORTED' });
    }
    for (const host of [undefined, 'unix:///var/run/docker.sock', 'unix:///synthetic/ignored.sock']) {
      if (host === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = host;
      const service = new DockerService({} as any), controller = new AbortController(); controller.abort();
      // Explicit constructor socket wins over Unix env defaults. Test only
      // pre-aborted setup: no daemon is contacted even on supported layouts.
      expect((service as any).docker.modem.socketPath).toBe('/var/run/docker.sock');
      for (const action of [() => service.getWorkspaceArchive('worker', controller.signal), () => service.getArchive('worker', '/workspace', controller.signal), () => service.exportContainer('worker', controller.signal)])
        await expect(action()).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
    }
    expect(connections).toBe(0);
  } finally {
    Socket.prototype.connect = originalConnect;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
