import { expect, test } from '@playwright/test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';
import { gunzipSync } from 'node:zlib';
import { packBundle, writeGzipFile, writeFilteredAgentsGz, workerExportFailureWithSettlement } from '../../orchestrator/server/utils/worker-export';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement, OperationDeadlineError } from '../../orchestrator/server/utils/operation-deadline';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useImageCatalogManager } from '../../orchestrator/server/utils/image-catalog';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const fs = require('node:fs'), fsp = require('node:fs/promises'), cp = require('node:child_process');
const tar = require('tar-stream');
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function patches() {
  const undo: Array<() => void> = [];
  return { set(target: any, key: string, value: any) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, { configurable: true, writable: true, value });
    syncBuiltinESMExports();
    undo.push(() => { if (descriptor) Object.defineProperty(target, key, descriptor); else delete target[key]; });
  }, close() { for (const restore of undo.reverse()) restore(); syncBuiltinESMExports(); } };
}
function heldSource(body?: string) {
  const destroying = deferred(), release = deferred(); let read = false;
  const stream = new Readable({ read() {
    if (!read && body !== undefined) { read = true; this.push(body); this.push(null); }
  }, destroy(error, callback) {
    destroying.resolve(); void release.promise.then(() => callback(error));
  } });
  return { stream, destroying, release };
}
async function collect(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  await pipeline(stream, new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }));
  return Buffer.concat(chunks);
}
async function entries(buffer: Buffer) {
  const result: Array<{ name: string; body: string }> = [], extract = tar.extract();
  extract.on('entry', (header: any, stream: any, next: any) => {
    collect(stream).then(body => { result.push({ name: header.name, body: body.toString() }); next(); }, next);
  });
  await pipeline(Readable.from([buffer]), extract);
  return result;
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('bundle destruction during stat retains producer lease without opening a file afterwards', async () => {
  const p = patches(), measured = deferred<any>(), entered = deferred(); let opens = 0;
  p.set(fsp, 'stat', async () => { entered.resolve(); return measured.promise; });
  p.set(fs, 'createReadStream', () => { opens++; throw new Error('must not open'); });
  const stream = packBundle([{ name: 'manifest.json', path: '/synthetic' }]);
  stream.on('error', () => {}); await entered.promise; stream.destroy();
  const barrier = gate.begin('export-stat', 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    measured.resolve({ size: 2 }); await stream.producerSettlement;
    await barrier.drain({ timeoutMs: 1000 }); expect(opens).toBe(0); expect(stream.closed).toBe(true);
  } finally { measured.resolve({ size: 2 }); barrier.release(); p.close(); }
});

for (const mode of ['success', 'disconnect', 'error'] as const) {
  test(`bundle ${mode} awaits actual delayed source close`, async () => {
    const p = patches(), source = heldSource(mode === 'success' ? '{}' : undefined), opened = deferred();
    p.set(fsp, 'stat', async () => ({ size: 2 }));
    p.set(fs, 'createReadStream', () => { opened.resolve(); return source.stream; });
    const stream = packBundle([{ name: 'manifest.json', path: '/synthetic' }]);
    const output = collect(stream).catch(error => error); await opened.promise;
    if (mode === 'disconnect') stream.destroy();
    if (mode === 'error') source.stream.destroy(new Error('source read failed'));
    await source.destroying.promise;
    const barrier = gate.begin(`export-source-${mode}`, 'snapshot');
    try {
      expect(source.stream.closed).toBe(false);
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      source.release.resolve(); await stream.producerSettlement; await barrier.drain({ timeoutMs: 1000 });
      const result = await output;
      if (mode === 'success') expect(await entries(result)).toEqual([{ name: 'manifest.json', body: '{}' }]);
      else expect(result).toBeInstanceOf(Error);
    } finally { source.release.resolve(); stream.destroy(); await output; barrier.release(); p.close(); }
  });
}

test('real bundle tar keeps names, ordering and bytes unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-export-producer-'));
  try {
    const files = ['manifest.json', 'workspace.tar.gz'].map(name => ({ name, path: join(directory, name) }));
    for (const file of files) await writeFile(file.path, `payload:${file.name}`);
    const stream = packBundle(files), output = await collect(stream); await stream.producerSettlement;
    expect(stream.closed).toBe(true);
    expect(await entries(output)).toEqual(files.map(file => ({ name: file.name, body: `payload:${file.name}` })));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('producer stat error reaches output and retires measured work', async () => {
  const p = patches(); p.set(fsp, 'stat', async () => { throw new Error('measurement denied'); });
  try {
    const stream = packBundle([{ name: 'manifest.json', path: '/synthetic' }]);
    await expect(collect(stream)).rejects.toThrow('measurement denied'); await stream.producerSettlement;
  } finally { p.close(); }
});

for (const mode of ['gzip', 'filtered'] as const) {
  test(`${mode} source failure retains actual source and writer destruction independently of caller catch`, async () => {
    const p = patches(), source = heldSource(), writerClosing = deferred(), writerRelease = deferred();
    const writer = new Writable({ write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) {
      writerClosing.resolve(); void writerRelease.promise.then(() => callback(error));
    } });
    p.set(fs, 'existsSync', () => false); p.set(fs, 'createWriteStream', () => writer);
    const result = (mode === 'gzip' ? writeGzipFile(source.stream, '/synthetic') :
      writeFilteredAgentsGz(source.stream, '/synthetic', [])).catch(error => error);
    source.stream.emit('error', new Error('read denied')); await source.destroying.promise;
    // Force the sibling branch to reject now, while source destruction is delayed.
    writer.destroy(new Error('write denied')); await writerClosing.promise;
    const barrier = gate.begin(`export-${mode}`, 'snapshot');
    try {
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      source.stream.emit('close'); writer.emit('close');
      expect(source.stream.closed).toBe(false); expect(writer.closed).toBe(false);
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      writerRelease.resolve(); expect(() => barrier.assertDrained()).toThrow(); source.release.resolve();
      const error = await result;
      expect(error).toBeInstanceOf(Error); expect(error[operationSettlement]).toBeInstanceOf(Promise);
      await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
    } finally { source.release.resolve(); writerRelease.resolve(); await result; barrier.release(); p.close(); }
  });
}

test('parallel gzip failure waits for child close and both pipe branches', async () => {
  const p = patches(), source = heldSource(), writerClosing = deferred(), writerRelease = deferred();
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { kills++; return false; } });
  let kills = 0;
  const writer = new Writable({ write(_chunk, _encoding, callback) { callback(); }, destroy(error, callback) {
    writerClosing.resolve(); void writerRelease.promise.then(() => callback(error));
  } });
  p.set(fs, 'existsSync', () => true); p.set(fs, 'createWriteStream', () => writer); p.set(cp, 'spawn', () => child);
  const result = writeGzipFile(source.stream, '/synthetic').catch(error => error);
  child.emit('error', new Error('child failed')); const error = await result;
  await source.destroying.promise; await writerClosing.promise;
  const barrier = gate.begin('export-pigz', 'snapshot');
  try {
    expect(error.message).toBe('child failed'); expect(kills).toBe(1);
    source.release.resolve(); writerRelease.resolve();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    child.stderr.destroy(); child.emit('close', 1, null);
    await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
  } finally { source.release.resolve(); writerRelease.resolve(); child.stderr.destroy(); child.emit('close', 1, null); barrier.release(); p.close(); }
});

test('real gzip and filtered agents payload remain consumable', async () => {
  const p = patches(), directory = await mkdtemp(join(tmpdir(), 'agentor-export-gzip-'));
  p.set(fs, 'existsSync', () => false);
  try {
    const path = join(directory, 'plain.gz');
    expect(await writeGzipFile(Readable.from(['plain content']), path)).toBeGreaterThan(0);
    expect(gunzipSync(await readFile(path)).toString()).toBe('plain content');
    const packed = tar.pack(); packed.entry({ name: '.agent-data/keep' }, 'kept'); packed.entry({ name: '.agent-data/auth.json' }, 'excluded'); packed.finalize();
    const filtered = join(directory, 'filtered.gz');
    expect(await writeFilteredAgentsGz(packed, filtered, ['auth.json'])).toBeGreaterThan(0);
    expect(await entries(gunzipSync(await readFile(filtered)))).toEqual([{ name: '.agent-data/keep', body: 'kept' }]);
  } finally { p.close(); await rm(directory, { recursive: true, force: true }); }
});

async function containerFixture() {
  const p = patches(), directory = await mkdtemp(join(tmpdir(), 'agentor-export-container-'));
  p.set(globalThis, 'useConfig', () => ({ dataDir: directory }));
  p.set(globalThis, 'useLogger', () => ({ info() {}, warn() {}, error() {}, debug() {} }));
  p.set(globalThis, 'usePortMappingStore', () => ({ list: () => [] }));
  p.set(globalThis, 'useDomainMappingStore', () => ({ list: () => [] }));
  const volumes = useManagedVolumeManager(); p.set(volumes, 'init', async () => {}); p.set(volumes, 'store', { forWorker: () => [] });
  const images = useImageCatalogManager(); p.set(images, 'init', async () => {});
  p.set(useWorkerConfigStore(), 'resolveValues', async () => []);
  const manager = new ContainerManager({} as any, { dataDir: directory } as any);
  (manager as any).environmentStore = { getById: () => ({ id: 'default', name: 'Default' }) };
  (manager as any).containers.set('worker', { id: 'worker', userId: 'synthetic-owner', status: 'stopped', containerId: 'synthetic-container', containerName: 'synthetic', displayName: 'Synthetic', imageName: 'synthetic', runtimeProfile: 'kata-qemu' });
  return { p, directory, manager, async close() { p.close(); await rm(directory, { recursive: true, force: true }); } };
}
const minimalOptions = { includeRootfs: false, includeWorkspace: false, includeAgents: false };

test('ContainerManager returned settlement and independent drain wait for actual staging rm', async () => {
  const f = await containerFixture(), removing = deferred(), released = deferred(), originalRm = fsp.rm;
  let removals = 0;
  f.p.set(fsp, 'rm', async (...args: any[]) => { removals++; removing.resolve(); await released.promise; return originalRm(...args); });
  const result = await f.manager.exportWorker('worker', minimalOptions), output = await collect(result.stream);
  await removing.promise; expect(await entries(output)).toHaveLength(2);
  const barrier = gate.begin('export-tmp-rm', 'snapshot');
  let settled = false; void result.settlement.then(() => { settled = true; });
  try {
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(settled).toBe(false); expect(removals).toBe(1);
    released.resolve(); await result.settlement; await barrier.drain({ timeoutMs: 1000 });
  } finally { released.resolve(); barrier.release(); await f.close(); }
});

test('preparation error preserves deadline semantics and waits underlying work before staging rm', async () => {
  const f = await containerFixture(), underlying = deferred(), removing = deferred(); const originalRm = fsp.rm;
  const original = new OperationDeadlineError('DOCKER_OPERATION_TIMEOUT', 'synthetic preparation', 1);
  Object.defineProperty(original, operationSettlement, { value: underlying.promise });
  f.p.set(fsp, 'rm', async (...args: any[]) => { removing.resolve(); return originalRm(...args); });
  const error = await f.manager.exportWorker('worker', { ...minimalOptions, onProgress: () => { throw original; } }).catch(error => error);
  const barrier = gate.begin('export-preparation', 'snapshot');
  try {
    expect(error).toBeInstanceOf(OperationDeadlineError); expect(error).toMatchObject({ statusCode: 504, code: 'DOCKER_OPERATION_TIMEOUT', data: original.data });
    expect(error[operationSettlement]).not.toBe(underlying.promise);
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    underlying.resolve(); await removing.promise; await error[operationSettlement]; await barrier.drain({ timeoutMs: 1000 });
  } finally { underlying.resolve(); barrier.release(); await f.close(); }
});

for (const mode of ['rm-denied', 'preparation-uncertain'] as const) {
  test(`${mode} exposes rejection and retains a process-local veto without retry`, async () => {
    const f = await containerFixture(), isolated = new InstanceControlPlaneCoordinator();
    f.p.set(gate, 'fork', () => isolated.fork());
    let removals = 0; const denied = Object.assign(new Error('cleanup denied'), { code: 'EACCES' });
    f.p.set(fsp, 'rm', async () => { removals++; throw denied; });
    let settlement: Promise<void>;
    if (mode === 'rm-denied') {
      const result = await f.manager.exportWorker('worker', minimalOptions); settlement = result.settlement;
      await collect(result.stream);
    } else {
      const pending = deferred();
      const original = workerExportFailureWithSettlement(new Error('preparation failed'), pending.promise);
      const error = await f.manager.exportWorkerWithLifecycleFenceHeld('worker', { ...minimalOptions, onProgress: () => { throw original; } }).catch(error => error);
      settlement = error[operationSettlement]; pending.reject(denied);
    }
    const barrier = isolated.begin(`export-${mode}`, 'snapshot');
    try {
      await expect(settlement).rejects.toBe(denied);
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(removals).toBe(mode === 'rm-denied' ? 1 : 0); expect(isolated.activeOperations).toBe(1);
    } finally { barrier.release(); await f.close(); }
  });
}
