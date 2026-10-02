import { expect, test } from '@playwright/test';
import { Duplex } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginRuntimeManager, DockerPluginWorkerExecutor, settleOnceWithDeadline } from '../../orchestrator/server/utils/plugin-runtime-manager';
import { PluginDefinitionStore } from '../../orchestrator/server/utils/plugin-definition-store';
import { PluginInstallationStore } from '../../orchestrator/server/utils/plugin-installation-store';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function runtimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-plugin-drain-'));
  const gate = new InstanceControlPlaneCoordinator();
  const definitions = new PluginDefinitionStore(directory), installations = new PluginInstallationStore(directory);
  await Promise.all([definitions.init(), installations.init()]);
  const definition = await definitions.create({ scope: 'owner', ownerId: 'owner', manifest: {
    schemaVersion: 1, name: 'Drain', slug: 'drain', description: '', version: '1',
    lifecycle: { start: { argv: ['true'], mode: 'background', timeoutSeconds: 1 } },
  } });
  const installed = await installations.create({ userId: 'owner', workerId: 'worker', definitionId: definition.id,
    definitionVersion: '1', definitionHash: definition.definitionHash });
  return { gate, definitions, installations, installed, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

for (const method of ['enable', 'disable'] as const) test(`${method} rejects before desired-state persistence while barrier closed`, async () => {
  const f = await runtimeFixture(); let writes = 0, executions = 0;
  const save = f.installations.setDesiredEnabled.bind(f.installations);
  f.installations.setDesiredEnabled = async (...args) => { writes++; return save(...args); };
  const runtime = new PluginRuntimeManager(f.definitions, f.installations, {
    execute: async () => { executions++; return { exitCode: 0 }; }, probe: async () => ({ exitCode: 0 }),
  }, { coordinator: f.gate });
  const barrier = f.gate.begin('closed', 'snapshot');
  try {
    await expect(runtime[method]('owner', f.installed.id, 'generation')).rejects.toMatchObject({ statusCode: 423 });
    expect(writes).toBe(0); expect(executions).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); await f.cleanup(); }
});

test('queued reconciliation keeps descendants admitted and does not block another worker', async () => {
  const f = await runtimeFixture(), entered = deferred(), release = deferred(); const calls: string[] = [];
  const second = await f.installations.create({ userId: 'owner', workerId: 'sibling', definitionId: f.installed.definitionId,
    definitionVersion: '1', definitionHash: f.installed.definitionHash });
  const runtime = new PluginRuntimeManager(f.definitions, f.installations, {
    execute: async request => {
      calls.push(request.workerId);
      if (request.workerId === 'worker') { entered.resolve(); await release.promise; }
      await f.gate.run(() => {}); return { exitCode: 0 };
    }, probe: async () => ({ exitCode: 0 }),
  }, { coordinator: f.gate });
  const first = runtime.reconcileInstallation('owner', f.installed.id, 'generation');
  const queued = runtime.reconcileInstallation('owner', f.installed.id, 'generation');
  await entered.promise;
  await runtime.reconcileInstallation('owner', second.id, 'generation');
  const barrier = f.gate.begin('queued', 'snapshot');
  try {
    expect(calls).toEqual(['worker', 'sibling']); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await Promise.all([first, queued]); await barrier.drain({ timeoutMs: 1000 });
    expect(calls).toEqual(['worker', 'sibling']);
  } finally { release.resolve(); await Promise.allSettled([first, queued]); barrier.release(); await f.cleanup(); }
});

for (const rejects of [false, true]) test(`caught phase deadline retains actual executor and descendant completion (rejects=${rejects})`, async () => {
  const gate = new InstanceControlPlaneCoordinator(), release = deferred(); let completed = false;
  const operation = settleOnceWithDeadline(async () => {
    await release.promise; await gate.run(() => { completed = true; });
    if (rejects) throw new Error('late rejection'); return 'done';
  }, 5, 'original phase timeout', gate).catch(error => error);
  const error = await operation;
  expect(error).toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT', message: 'original phase timeout' });
  expect(error[operationSettlement]).toBeInstanceOf(Promise);
  const barrier = gate.begin('timeout', 'snapshot');
  try {
    expect(completed).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(completed).toBe(true);
  } finally { release.resolve(); barrier.release(); }
});

test('failed executor retains same-worker queue through rejected settlement while sibling proceeds', async () => {
  const f = await runtimeFixture(), settlement = deferred(); let attempts = 0;
  const original = Object.assign(new Error('original execution failure'), { [operationSettlement]: settlement.promise });
  const sibling = await f.installations.create({ userId: 'owner', workerId: 'sibling', definitionId: f.installed.definitionId,
    definitionVersion: '1', definitionHash: f.installed.definitionHash });
  const runtime = new PluginRuntimeManager(f.definitions, f.installations, {
    execute: async request => {
      if (request.workerId === 'worker' && ++attempts === 1) throw original;
      await f.gate.run(() => {}); return { exitCode: 0 };
    }, probe: async () => ({ exitCode: 0 }),
  }, { coordinator: f.gate });
  await expect(runtime.reconcileInstallation('owner', f.installed.id, 'generation')).rejects.toBe(original);
  const queued = runtime.reconcileInstallation('owner', f.installed.id, 'generation');
  await runtime.reconcileInstallation('owner', sibling.id, 'generation');
  const barrier = f.gate.begin('executor-settlement', 'snapshot');
  try {
    expect(attempts).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    settlement.reject(new Error('late client rejection')); await queued;
    await barrier.drain({ timeoutMs: 1000 }); expect(attempts).toBe(2);
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally { settlement.resolve(); await queued; barrier.release(); await f.cleanup(); }
});

test('real manager timeout keeps later same-worker reconciliation behind actual executor', async () => {
  const f = await runtimeFixture(), entered = deferred(), release = deferred(); let attempts = 0;
  const runtime = new PluginRuntimeManager(f.definitions, f.installations, {
    execute: async () => {
      if (++attempts === 1) { entered.resolve(); await release.promise; }
      await f.gate.run(() => {}); return { exitCode: 0 };
    }, probe: async () => ({ exitCode: 0 }),
  }, { coordinator: f.gate, maxRequestTimeoutMs: 1000 });
  const first = runtime.reconcileInstallation('owner', f.installed.id, 'generation');
  const failure = expect(first).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  await entered.promise; await failure;
  const queued = runtime.reconcileInstallation('owner', f.installed.id, 'generation');
  const barrier = f.gate.begin('phase-timeout', 'snapshot');
  try {
    expect(attempts).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await queued; await barrier.drain({ timeoutMs: 1000 }); expect(attempts).toBe(2);
  } finally { release.resolve(); await queued; barrier.release(); await f.cleanup(); }
});

function transportFixture(options: { heldStart?: boolean; heldSetup?: boolean; heldDestroy?: boolean; heldWrite?: boolean } = {}) {
  const gate = new InstanceControlPlaneCoordinator(), setup = deferred<any>(), start = deferred<any>();
  const setupEntered = deferred(), startEntered = deferred(), sent = deferred(), destroying = deferred();
  let destroyDone: ((error?: Error | null) => void) | undefined, writeDone: ((error?: Error | null) => void) | undefined;
  const stream = new Duplex({
    read() {},
    write(_chunk, _encoding, done) { writeDone = done; sent.resolve(); if (!options.heldWrite) done(); },
    destroy(_error, done) { destroyDone = done; destroying.resolve(); if (!options.heldDestroy) done(); },
  });
  const exec = { start: async () => { startEntered.resolve(); return options.heldStart ? start.promise : stream; } };
  const container = {
    exec: async () => { setupEntered.resolve(); return options.heldSetup ? setup.promise : exec; },
    modem: { demuxStream: (source: Duplex, stdout: any) => source.on('data', chunk => stdout.write(chunk)) },
  };
  const executor = new DockerPluginWorkerExecutor({ getContainer: () => container } as any, () => 'container', gate, {
    // Preserve manager-level deferred setup/start fixtures independently of
    // the dedicated request-owning transport's synthetic/Unix-socket tests.
    setup: async () => { await container.exec(); return 'a'.repeat(64); },
    start: () => exec.start(),
  });
  const controller = new AbortController();
  const run = () => executor.execute({ workerId: 'worker', installationId: 'installation', phase: 'start',
    envKeys: [], secretKeys: [], systemEnvironment: {}, signal: controller.signal });
  return { gate, controller, stream, exec, setup, start, setupEntered, startEntered, sent, destroying, run,
    close: () => destroyDone?.(), finishWrite: () => writeDone?.() };
}

test('pre-aborted transport does not start Docker work or retain admission', async () => {
  const f = transportFixture(); f.controller.abort();
  await expect(f.run()).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  expect(f.gate.activeOperations).toBe(0);
});

test('direct Docker executor rejects barrier admission before looking up a container', async () => {
  const gate = new InstanceControlPlaneCoordinator(); let lookups = 0;
  const executor = new DockerPluginWorkerExecutor({} as any, () => { lookups++; return 'container'; }, gate);
  const barrier = gate.begin('executor-closed', 'snapshot');
  try {
    await expect(executor.execute({ workerId: 'worker', installationId: 'installation', phase: 'start',
      envKeys: [], secretKeys: [], systemEnvironment: {}, signal: new AbortController().signal })).rejects.toMatchObject({ statusCode: 423 });
    expect(lookups).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); }
});

for (const rejected of [false, true]) test(`aborted late setup retains real settlement without starting runner (rejected=${rejected})`, async () => {
  const f = transportFixture({ heldSetup: true }); const operation = f.run();
  const failed = expect(operation).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  await f.setupEntered.promise; f.controller.abort(); await failed;
  const barrier = f.gate.begin('setup', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    if (rejected) f.setup.reject(new Error('late setup failure')); else f.setup.resolve(f.exec);
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.stream.destroyed).toBe(false);
  } finally { f.setup.resolve(f.exec); barrier.release(); f.stream.destroy(); }
});

test('aborted late start destroys unconsumed transport and waits for asynchronous close', async () => {
  const f = transportFixture({ heldStart: true, heldDestroy: true }); const operation = f.run();
  const failed = expect(operation).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  await f.startEntered.promise; f.controller.abort(); await failed;
  const barrier = f.gate.begin('late-start', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); f.start.resolve(f.stream); await f.destroying.promise;
    expect(() => barrier.assertDrained()).toThrow(); f.close(); await barrier.drain({ timeoutMs: 1000 });
  } finally { f.start.resolve(f.stream); f.close(); barrier.release(); }
});

test('successful background receipt retires after actual close and pending stdin callback', async () => {
  const f = transportFixture({ heldDestroy: true, heldWrite: true }); const operation = f.run();
  await f.sent.promise; const barrier = f.gate.begin('receipt', 'snapshot');
  try {
    f.stream.push('{"exitCode":0}\n'); f.stream.push(null); await f.destroying.promise;
    expect(() => barrier.assertDrained()).toThrow(); f.close();
    expect(() => barrier.assertDrained()).toThrow(); f.finishWrite();
    await expect(operation).resolves.toEqual({ exitCode: 0 }); await barrier.drain({ timeoutMs: 1000 });
  } finally { f.finishWrite(); f.close(); barrier.release(); }
});

test('synthetic close cannot retire late-start cleanup before asynchronous destroy closes stream', async () => {
  const f = transportFixture({ heldStart: true, heldDestroy: true }); const operation = f.run();
  const failed = expect(operation).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  await f.startEntered.promise; f.controller.abort(); await failed;
  const barrier = f.gate.begin('synthetic-close', 'snapshot');
  try {
    f.start.resolve(f.stream); await f.destroying.promise;
    expect(f.stream.closed).toBe(false); f.stream.emit('close');
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    expect(f.stream.closed).toBe(false);
    f.close(); await barrier.drain({ timeoutMs: 1000 }); expect(f.stream.closed).toBe(true);
  } finally { f.start.resolve(f.stream); f.close(); barrier.release(); }
});

test('valid receipt plus synthetic close still waits for actual transport destruction', async () => {
  const f = transportFixture({ heldDestroy: true }); const operation = f.run();
  await f.sent.promise; const barrier = f.gate.begin('receipt-synthetic-close', 'snapshot');
  try {
    f.stream.push('{"exitCode":0}\n'); f.stream.push(null); await f.destroying.promise;
    f.stream.emit('close');
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    f.close(); await expect(operation).resolves.toEqual({ exitCode: 0 }); await barrier.drain({ timeoutMs: 1000 });
  } finally { f.close(); barrier.release(); }
});

test('aborted sent request remains uncertain after socket close without a runner receipt', async () => {
  const f = transportFixture({ heldDestroy: true }); const operation = f.run();
  const failed = expect(operation).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME_TIMEOUT' });
  await f.sent.promise; f.controller.abort(); await failed; await f.destroying.promise;
  const barrier = f.gate.begin('uncertain', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); f.close();
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
  } finally { f.close(); barrier.release(); }
  // Isolated test coordinator intentionally retains uncertainty: no assertion
  // that closed client transport proves runner termination or restart safety.
});

test('invalid runner response returns its original diagnostic but retains uncertain lifetime', async () => {
  const f = transportFixture(); const operation = f.run();
  const failed = expect(operation).rejects.toMatchObject({ code: 'PLUGIN_RUNNER_INVALID_RESPONSE' });
  await f.sent.promise; f.stream.push('not a receipt\n'); f.stream.push(null); await failed;
  const barrier = f.gate.begin('bad-receipt', 'snapshot');
  try { await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' }); }
  finally { barrier.release(); }
});
