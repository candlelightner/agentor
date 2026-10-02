import { expect, test } from '@playwright/test';
import { EventEmitter, once } from 'node:events';
import { createServer, get } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { consumeWorkerExport } from '../../orchestrator/server/utils/worker-export-consumer';
import { requestCancellation } from '../../orchestrator/server/utils/request-cancellation';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const sink = () => new Writable({ write(_chunk, _encoding, callback) { callback(); } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function load(path: string, modules: Record<string, any>, globals: Record<string, any> = {}) {
  const source = await readFile(new URL('../../orchestrator/server/' + path, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Buffer, AbortController, structuredClone,
    require: (id: string) => modules[id] ?? (id.startsWith('node:') ? require(id) : {}), ...globals,
  });
  return exports;
}

test('consumed bytes do not complete an export before producer cleanup', async () => {
  const cleanup = deferred(), consumed = deferred(); let completed = false;
  const destination = sink(); destination.once('close', () => consumed.resolve());
  const task = consumeWorkerExport({ stream: Readable.from(['bundle']), settlement: cleanup.promise }, () => destination)
    .then(() => { completed = true; });
  await consumed.promise; await turn(); expect(completed).toBe(false);
  cleanup.resolve(); await task; expect(completed).toBe(true);
});

test('producer cleanup rejection fails a successfully consumed export', async () => {
  const cleanup = deferred(), consumed = deferred(), failure = new Error('cleanup denied');
  const destination = sink(); destination.once('close', () => consumed.resolve());
  const task = consumeWorkerExport({ stream: Readable.from(['bundle']), settlement: cleanup.promise }, () => destination);
  const rejected = expect(task).rejects.toBe(failure);
  await consumed.promise; cleanup.reject(failure); await rejected;
});

test('synchronous consumer setup failure destroys the bundle and waits delayed cleanup', async () => {
  const destroying = deferred(), release = deferred(), failure = new Error('destination unavailable');
  const stream = new Readable({ read() {}, destroy(error, callback) {
    destroying.resolve(); void release.promise.then(() => callback(error));
  } });
  const settlement = new Promise<void>(resolve => stream.once('close', resolve));
  let completed = false;
  const task = consumeWorkerExport({ stream, settlement }, () => { throw failure; }).catch(error => { completed = true; return error; });
  await destroying.promise; await turn(); expect(completed).toBe(false); expect(stream.closed).toBe(false);
  release.resolve(); expect(await task).toBe(failure); expect(stream.closed).toBe(true);
});

test('early producer rejection is observed and stops an active consumer', async () => {
  const cleanup = deferred(), stream = new Readable({ read() {} });
  const task = consumeWorkerExport({ stream, settlement: cleanup.promise }, sink);
  const rejected = expect(task).rejects.toBeTruthy();
  cleanup.reject(new Error('producer failed')); await rejected; expect(stream.closed).toBe(true);
});

test('destination error does not finish consumer until its actual delayed destruction', async () => {
  const destroying = deferred(), release = deferred(), failure = new Error('destination write failed');
  const stream = new Readable({ read() {} });
  const destination = new Writable({ write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) {
    destroying.resolve(); void release.promise.then(() => callback(error));
  } });
  const settlement = new Promise<void>(resolve => stream.once('close', resolve));
  let completed = false;
  const task = consumeWorkerExport({ stream, settlement }, () => destination).catch(error => { completed = true; return error; });
  await turn(); destination.emit('error', failure); await destroying.promise;
  destination.emit('close'); // Notification alone is not actual fd closure.
  await turn(); expect(completed).toBe(false); expect(destination.closed).toBe(false);
  expect(stream.closed).toBe(true);
  release.resolve(); expect(await task).toBe(failure); expect(destination.closed).toBe(true);
});

async function routeFixture(bundle: any, exportHook?: (signal: AbortSignal) => void, realHttp = false) {
  const errors: string[] = [], headers: unknown[] = [];
  const h3 = realHttp ? require('h3') : undefined;
  const modules = {
    '../../../utils/services': {
      useContainerManager: () => ({ get: () => ({}), exportWorker: async (_id: string, options: any) => {
        exportHook?.(options.signal); return bundle;
      } }),
      useLogger: () => ({ error: (message: string) => errors.push(message) }),
    },
    '../../../utils/auth-helpers': { requireContainerAccess() {} },
    '../../../utils/http-errors': { rethrowAsHttpError(error: unknown) { throw error; } },
    '../../../utils/request-cancellation': { requestCancellation },
    '../../../utils/worker-export-consumer': { consumeWorkerExport },
  };
  const loaded = await load('api/containers/[id]/export.get.ts', modules, {
    defineRouteMeta() {}, defineEventHandler: (handler: any) => handler,
    getRouterParam: () => 'worker', getQuery: h3?.getQuery ?? (() => ({})),
    setResponseHeaders: (event: any, value: unknown) => { headers.push(value); h3?.setResponseHeaders(event, value); },
  });
  const req = new EventEmitter(), res = sink();
  return { run: () => loaded.default({ node: { req, res } }), handler: loaded.default, errors, headers, req, res };
}

async function serve(handler: any, gate: InstanceControlPlaneCoordinator) {
  const h3 = require('h3'), app = h3.createApp();
  // Authentication/services are synthetic; the H3 and Node HTTP/stream paths
  // here are real. This is not whole-application or authenticated acceptance.
  app.use(h3.eventHandler((event: any) => gate.run(() => handler(event))));
  const server = createServer(h3.toNodeListener(app));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP port');
  return { url: `http://127.0.0.1:${address.port}/`, async close() {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}

test('real H3 response preserves bundle bytes and retains request admission through cleanup', async () => {
  const cleanup = deferred(), gate = new InstanceControlPlaneCoordinator();
  const f = await routeFixture({ stream: Readable.from(['bundle bytes']), filename: 'worker.tar', settlement: cleanup.promise }, undefined, true);
  const server = await serve(f.handler, gate);
  let barrier: ReturnType<typeof gate.begin> | undefined;
  try {
    const response = await new Promise<{ body: string; status: number | undefined; disposition: string | undefined }>((resolve, reject) => {
      get(server.url, res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(Buffer.from(chunk))); res.on('error', reject);
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString(), status: res.statusCode, disposition: res.headers['content-disposition'] }));
      }).on('error', reject);
    });
    expect(response).toEqual({ body: 'bundle bytes', status: 200, disposition: 'attachment; filename="worker.tar"' });
    barrier = gate.begin('local-export-http', 'snapshot');
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(f.errors).toEqual([]);
  } finally { cleanup.resolve(); barrier?.release(); await server.close(); }
});

test('real HTTP client disconnect closes producer and releases request after delayed destruction', async () => {
  const destroying = deferred(), release = deferred(), gate = new InstanceControlPlaneCoordinator();
  let sent = false;
  const stream = new Readable({ read() { if (!sent) { sent = true; this.push('chunk'); } }, destroy(error, callback) {
    destroying.resolve(); void release.promise.then(() => callback(error));
  } });
  const settlement = new Promise<void>(resolve => stream.once('close', resolve));
  const f = await routeFixture({ stream, filename: 'worker.tar', settlement }, undefined, true);
  const server = await serve(f.handler, gate);
  let barrier: ReturnType<typeof gate.begin> | undefined;
  const client = get(server.url, res => {
    res.on('error', () => {}); res.once('data', () => client.destroy());
  });
  client.on('error', () => {});
  try {
    await destroying.promise;
    barrier = gate.begin('local-export-disconnect', 'snapshot');
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(stream.closed).toBe(false); release.resolve();
    await barrier.drain({ timeoutMs: 1000 }); expect(stream.closed).toBe(true); expect(f.errors).toHaveLength(1);
  } finally { release.resolve(); client.destroy(); barrier?.release(); await server.close(); }
});

test('legacy route waits cleanup after response bytes and reports late failure safely', async () => {
  const cleanup = deferred(), failure = new Error('secret must not be logged');
  const f = await routeFixture({ stream: Readable.from(['bundle']), filename: 'worker.tar', settlement: cleanup.promise });
  let completed = false;
  const task = f.run().catch((error: unknown) => { completed = true; return error; });
  await new Promise<void>(resolve => f.res.once('finish', resolve));
  await turn(); expect(completed).toBe(false); expect(f.headers).toHaveLength(1);
  cleanup.reject(failure); expect(await task).toBe(failure);
  expect(f.errors).toEqual(['[export] legacy worker export transfer or cleanup failed']);
  expect(f.req.listenerCount('aborted')).toBe(0);
});

test('legacy disconnect during preparation is replayed without headers or leaked bundle', async () => {
  const stream = new Readable({ read() {} });
  const settlement = new Promise<void>(resolve => stream.once('close', resolve));
  let f: Awaited<ReturnType<typeof routeFixture>>;
  f = await routeFixture({ stream, filename: 'worker.tar', settlement }, () => f.req.emit('aborted'));
  await expect(f.run()).rejects.toThrow('Client disconnected');
  expect(f.headers).toHaveLength(0); expect(stream.closed).toBe(true);
  expect(f.req.listenerCount('aborted')).toBe(0);
});

test('legacy disconnect during transfer settles instead of hanging on destroyed source', async () => {
  const stream = new Readable({ read() { this.push('chunk'); this._read = () => {}; } });
  const settlement = new Promise<void>(resolve => stream.once('close', resolve));
  const f = await routeFixture({ stream, filename: 'worker.tar', settlement });
  const task = f.run(), rejected = expect(task).rejects.toBeTruthy();
  await turn(); f.req.emit('aborted'); await rejected;
  expect(stream.closed).toBe(true); expect(f.res.closed).toBe(true);
  expect(f.req.listenerCount('aborted')).toBe(0);
});

async function backupPrototype(bundle: any) {
  const loaded = await load('utils/backup-manager.ts', {
    './worker-export-consumer': { consumeWorkerExport },
    './services': { useContainerManager: () => ({
      get: () => ({ containerId: 'container', userId: 'owner', status: 'stopped' }),
      exportWorkerWithLifecycleFenceHeld: async () => bundle,
      exportWorker: async () => bundle,
    }), useLogger: () => ({ error() {} }) },
    './user-id': { assertSafeUserId() {} },
    './backup-paths': { extraBackupPaths: () => [] },
    './backup-provider': { publicBackupFailure: () => 'Export failed' },
  });
  return loaded.BackupManager.prototype;
}

test('native backup capture waits cleanup and propagates rejection before returning', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-export-consumer-'));
  const cleanup = deferred(), failure = new Error('cleanup failed');
  try {
    const stream = Readable.from(['bundle']), drained = new Promise<void>(resolve => stream.once('close', resolve));
    const proto = await backupPrototype({ stream, settlement: cleanup.promise });
    let completed = false;
    const task = proto.exportWorkspaceBundleWithLifecycleFenceHeld.call({}, 'owner', 'worker', join(directory, 'bundle.tar'), new AbortController().signal)
      .catch((error: unknown) => { completed = true; return error; });
    await drained; await turn(); expect(completed).toBe(false);
    cleanup.reject(failure); expect(await task).toBe(failure);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy backup does not enter encryption/upload after cleanup rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-export-consumer-'));
  const cleanup = deferred();
  try {
    const stream = Readable.from(['bundle']), drained = new Promise<void>(resolve => stream.once('close', resolve));
    const proto = await backupPrototype({ stream, settlement: cleanup.promise });
    const phases: string[] = [], job: any = { id: 'synthetic-job', workspaceId: 'worker', userId: 'owner' };
    const task = proto.run.call({ dataDir: directory, saveJob: async (record: any) => { phases.push(record.phase); } }, job);
    await drained; await turn(); expect(phases).toEqual(['exporting']);
    cleanup.reject(new Error('cleanup failed')); await task;
    expect(phases).toEqual(['exporting', 'failed']); expect(job.status).toBe('failed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
