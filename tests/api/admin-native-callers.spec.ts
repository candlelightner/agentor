import { test, expect } from '@playwright/test';
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { useConfig, useContainerManager, useDockerService, useAdministrativeWorkspaceRuntime, useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { useGroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { readAdministrativeRuntimeRecord, administrativeRuntimeOwner, adminNativeInstanceName } from '../../orchestrator/server/utils/admin-native-authority';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { requirePluginSelf, requireWorkerSelf } from '../../orchestrator/server/utils/worker-auth';
import { workerLifecycleGeneration, withOwnerWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const platformId = randomUUID(), owner = randomUUID(), stamp = new Date(0).toISOString();
const nativeIdentity = (record: AdministrativeWorkspaceRecord) => ({ version: 1 as const, name: adminNativeInstanceName(record), installationId: randomUUID(), nonce: randomUUID(),
  incarnation: randomUUID(), overlayVersion: '6' as const, overlaySha256: 'a'.repeat(64), storageReady: true as const, storageInitialized: true as const,
  image: { version: 1 as const, fingerprint: 'b'.repeat(64), sourceImageId: 'sha256:'+'c'.repeat(64), recipeId: 'd'.repeat(64),
    architecture: 'amd64' as const, converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const } });
const platform: AdministrativeWorkspaceRecord = { schemaVersion: 1 as const, id: platformId, kind: 'administrative' as const, trusted: true as const,
  status: 'running' as const, runtimeKind: 'incus-vm' as const, createdAt: stamp, updatedAt: stamp };
platform.nativeRuntime = nativeIdentity(platform);

let restoreSingletons: (() => Promise<void>) | undefined;
test.beforeAll(async () => {
  const dataDir = process.env.DATA_DIR!;
  expect(dataDir).toMatch(/^\/tmp\/agentor-incus-acceptance-/);
  expect(useConfig().dataDir).toBe(dataDir);
  const store = useAdminWorkspaceStore() as any, cm = useContainerManager() as any, docker = useDockerService();
  const path = join(dataDir,'admin/workspace.v1.json');
  const originalBytes = await readFile(path).catch(error => { if(error.code!=='ENOENT')throw error; return undefined; });
  const state = {record:store.record,loading:store.loading,unavailable:store.unavailable,pendingCommit:store.pendingCommit,runtime:store.runtime};
  const collaborators = {workerStore:cm.workerStore,resolveIncusCaller:cm.resolveIncusCaller,
    listContainers:docker.listContainers,listAdministrativeContainers:docker.listAdministrativeContainers};
  restoreSingletons = async () => {
    Object.assign(store,state); cm.workerStore=collaborators.workerStore; cm.resolveIncusCaller=collaborators.resolveIncusCaller;
    docker.listContainers=collaborators.listContainers; docker.listAdministrativeContainers=collaborators.listAdministrativeContainers;
    if(originalBytes) await writeFile(path,originalBytes,{mode:0o600}); else await unlink(path).catch(error => {if(error.code!=='ENOENT')throw error;});
  };
  // Reset only this verified temporary store; later module files must see their own first load.
  Object.assign(store,{record:undefined,loading:undefined,unavailable:false,pendingCommit:undefined});
  await mkdir(join(dataDir, 'admin'), { recursive: true });
  await writeFile(join(dataDir, 'admin/workspace.v1.json'), JSON.stringify(platform), { mode: 0o600 });
  await useAdminWorkspaceStore().init(); await useWorkerGroupStore().init();
  useAdminWorkspaceStore().setRuntimeAdapter({ async ensure() {}, async start() {}, async stop() {}, async rebuild() {} });
  // Every backend method that could reach Docker/Incus is replaced before use.
  useDockerService().listContainers = async () => [];
  useDockerService().listAdministrativeContainers = async () => [];
  useContainerManager().resolveIncusCaller = async () => null;
});
test.afterAll(async () => { await restoreSingletons?.(); });

async function fixture(kind: 'platform' | 'group' = 'platform') {
  const cm = useContainerManager(), groups = useWorkerGroupStore();
  let record: AdministrativeWorkspaceRecord = await readAdministrativeRuntimeRecord(platformId);
  if (kind === 'group') {
    const group = await groups.create(owner, 'Private native caller fixture'), id = randomUUID();
    record = { schemaVersion: 1, id, kind: 'group-administrative', trusted: true, ownerId: owner, groupId: group.id,
      status: 'running', runtimeKind: 'incus-vm', createdAt: stamp, updatedAt: stamp } as any;
    record.nativeRuntime = nativeIdentity(record);
    await groups.update(owner, group.id, { adminWorkspace: record } as any);
  }
  const identity = administrativeRuntimeOwner(record), native = useAdministrativeWorkspaceRuntime().native;
  const info: any = { id: record.id, userId: identity.userId, runtimeKind: 'incus-vm', administrativeKind: kind,
    containerId: 'incus:'+record.nativeRuntime!.incarnation, containerName: record.nativeRuntime!.name, status: 'running', displayName: kind };
  cm.registerExternal(info);
  // An ordinary shadow is deliberately unusable, even for projection reads.
  cm.setWorkerStore(new Proxy({} as WorkerStore, { get() { return () => { throw Error('Ordinary WorkerStore must not authorize admin use'); }; } }));
  const original = { assertRunning: native.assertRunning, resolveHost: native.resolveHost,
    execStream: native.client.execStream, getInstanceState: native.client.getInstanceState, listInstances: native.client.listInstances };
  const calls: string[][] = []; let probes = 0;
  const address = kind === 'platform' ? '10.88.0.3' : '10.89.0.3';
  native.assertRunning = async (captured, incarnation) => {
    probes++; expect(captured.id).toBe(record.id); expect(incarnation).toBe(record.nativeRuntime!.incarnation);
    return { status: 'Running', config: { 'limits.cpu': '2' }, devices: { eth0: { hwaddr: '02:00:00:00:00:01' } } } as any;
  };
  native.resolveHost = async () => ({ address, incarnation: record.nativeRuntime!.incarnation! });
  native.client.listInstances = async () => [{config:{'user.agentor.id':record.id,'volatile.uuid':record.nativeRuntime!.incarnation},devices:{eth0:{'ipv4.address':address}}}] as any;
  native.client.getInstanceState = async () => ({ status: 'Running', memory: { usage: 4, total: 8 } }) as any;
  native.client.execStream = async (_name, command) => {
    calls.push(command); const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    stdout.end('fixture-output'); stderr.end();
    return { stdin, stdout, stderr, result: Promise.resolve(0), operationId: randomUUID(), sendSignal() {}, close() { stdin.destroy(); stdout.destroy(); stderr.destroy(); } };
  };
  return { cm, native, info, record, calls, address, probes: () => probes,
    cleanup: async () => {
      Object.assign(native, { assertRunning: original.assertRunning, resolveHost: original.resolveHost });
      Object.assign(native.client, { execStream: original.execStream, getInstanceState: original.getInstanceState, listInstances: original.listInstances });
      cm.unregisterExternal(info.id);
      if (kind === 'group' && groups.get(owner, (record as any).groupId)) await groups.remove(owner, (record as any).groupId);
    } };
}

for (const kind of ['platform', 'group'] as const) {
  test(`${kind} native commands, backend, metrics and journal use dedicated authority despite an ordinary shadow`, async () => {
    const f = await fixture(kind);
    try {
      expect(f.cm.get(f.info.id)).toBe(f.info);
      expect(await f.cm.resolveWorkerHost(f.info.id)).toBe(f.address);
      const captured = await f.cm.workerCommands(f.info.id).execCapture(f.info.containerId, ['fixture']);
      expect(captured.stdout.toString()).toBe('fixture-output');
      expect(f.calls[0]![4]).toContain('runtime_role="'+(kind === 'group' ? 'group-admin' : 'platform-admin')+'"');
      expect((await f.cm.incusWorkerMetrics(f.info.id)).state.status).toBe('Running');
      const journal = await f.cm.openWorkerJournal(f.info.id, { tail: 15 });
      expect(journal.isCurrent()).toBe(true); expect(f.calls.at(-1)).toContain('--lines=15'); journal.close();
      expect(f.probes()).toBeGreaterThan(3);
    } finally { await f.cleanup(); }
  });
  test(`${kind} native plugin-self authenticates only the current private peer and cannot enter generic worker-self`, async () => {
    const f = await fixture(kind), event = { node: { req: { socket: { remoteAddress: f.address } } } } as any;
    try {
      const context = await requirePluginSelf(event);
      expect(context.authority).toMatchObject({ kind: kind === 'group' ? 'group-admin' : 'platform-admin', workspaceId: f.info.id });
      if (kind === 'group') expect(context.authority).toMatchObject({ ownerId: owner, groupId: (f.record as any).groupId });
      const probes = f.probes();
      await expect(requirePluginSelf({ node: { req: { socket: { remoteAddress: '10.255.255.1' } } } } as any)).rejects.toMatchObject({ statusCode: 401 });
      expect(f.probes()).toBe(probes);
      const resolve = f.cm.resolveIncusCaller; f.cm.resolveIncusCaller = async () => f.info;
      try { await expect(requireWorkerSelf(event)).rejects.toMatchObject({ statusCode: 401 }); }
      finally { f.cm.resolveIncusCaller = resolve; }
    } finally { await f.cleanup(); }
  });
  test(`${kind} healthy native command and journal handles survive status, script and identity reads but start and stop revoke them`, async () => {
    const f = await fixture(kind), store = kind === 'platform' ? useAdminWorkspaceStore() : useGroupAdminWorkspaceStore();
    const privateStore = store as any, original = { runtime: privateStore.runtime, identityMaterializer: privateStore.identityMaterializer };
    let journal: Awaited<ReturnType<typeof f.cm.openWorkerJournal>> | undefined, materialized = 0, starts = 0, stops = 0;
    try {
      const commands = f.cm.workerCommands(f.info.id);
      journal = await f.cm.openWorkerJournal(f.info.id, { tail: 5 });
      store.setRuntimeAdapter({ async ensure() { throw Error('Reads must not ensure compute'); }, async start() { starts++; }, async stop() { stops++; }, async rebuild() {} });
      const generation = workerLifecycleGeneration(f.info.id);
      const status = kind === 'platform' ? await useAdminWorkspaceStore().getStatus()
        : await useGroupAdminWorkspaceStore().getStatus((f.record as any).groupId);
      expect(status).toMatchObject({ id: f.info.id, status: 'running' });
      expect(status!.nativeRuntime).toBeUndefined();
      if (kind === 'platform') await useAdminWorkspaceStore().getStartupScript();
      expect(workerLifecycleGeneration(f.info.id)).toBe(generation);
      expect(journal.isCurrent()).toBe(true);
      store.setIdentityMaterializer(async record => {
        expect(record.id).toBe(f.info.id); materialized++;
        expect(journal!.isCurrent()).toBe(true);
      });
      if (kind === 'platform') await useAdminWorkspaceStore().refreshRunningIdentity();
      else await useGroupAdminWorkspaceStore().refreshRunningIdentity((f.record as any).groupId);
      expect(materialized).toBe(1); expect(journal.isCurrent()).toBe(true);
      expect((await commands.execCapture(f.info.containerId, ['fixture'])).stdout.toString()).toBe('fixture-output');
      store.setIdentityMaterializer(async () => {});
      if (kind === 'platform') await useAdminWorkspaceStore().setStatus('running');
      else await useGroupAdminWorkspaceStore().setStatus((f.record as any).groupId, 'running');
      expect(starts).toBe(1); expect(journal.isCurrent()).toBe(false);
      await expect(commands.execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority changed');
      const startedCommands = f.cm.workerCommands(f.info.id);
      expect((await startedCommands.execCapture(f.info.containerId, ['fixture'])).stdout.toString()).toBe('fixture-output');
      if (kind === 'platform') await useAdminWorkspaceStore().setStatus('stopped');
      else await useGroupAdminWorkspaceStore().setStatus((f.record as any).groupId, 'stopped');
      expect(stops).toBe(1); expect(workerLifecycleGeneration(f.info.id)).not.toBe(generation);
      await expect(startedCommands.execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority changed');
    } finally {
      journal?.close(); Object.assign(privateStore, original);
      if (kind === 'platform') await useAdminWorkspaceStore().setStatus('running');
      await f.cleanup();
    }
  });
  test(`${kind} captured commands reject a lifecycle fence before dispatch`, async () => {
    const f = await fixture(kind);
    try {
      const commands = f.cm.workerCommands(f.info.id);
      await withOwnerWorkerLifecycleMutation(f.info.userId, f.info.id, async () => {});
      await expect(commands.execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority changed');
      expect(f.calls).toEqual([]);
    } finally { await f.cleanup(); }
  });
}

test('dedicated status revocation denies stale commands and plugin-self without native or Docker fallback', async () => {
  const f = await fixture();
  try {
    const commands = f.cm.workerCommands(f.info.id);
    await useAdminWorkspaceStore().setStatus('stopped');
    await expect(commands.execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority changed');
    await expect(f.cm.resolveWorkerHost(f.info.id)).rejects.toThrow('authority changed');
    await expect(requirePluginSelf({ node: { req: { socket: { remoteAddress: f.address } } } } as any)).rejects.toMatchObject({ statusCode: 401 });
    expect(f.calls).toEqual([]);
  } finally { await useAdminWorkspaceStore().setStatus('running'); await f.cleanup(); }
});

test('native callback rejects same-name incarnation replacement during asynchronous admission', async () => {
  const f = await fixture();
  try {
    f.native.assertRunning = async () => { f.info.containerId = 'incus:'+randomUUID(); return {} as any; };
    await expect(f.cm.workerCommands(f.info.id).execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority changed');
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('deleted group authority rejects a captured group-admin command before native dispatch', async () => {
  const f = await fixture('group');
  try {
    const commands = f.cm.workerCommands(f.info.id);
    await useWorkerGroupStore().remove(owner, (f.record as any).groupId);
    await expect(commands.execCapture(f.info.containerId, ['fixture'])).rejects.toThrow('authority is unavailable');
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

for (const kind of ['platform', 'group'] as const) {
  test(`${kind} pending administrative operation blocks reads without settling its receipt`, async () => {
    const f = await fixture(kind), global = useAdminWorkspaceStore(), scoped = useGroupAdminWorkspaceStore();
    const transaction = (operation: Parameters<typeof global.withNativeRuntimeTransaction>[0]) => kind === 'platform'
      ? global.withNativeRuntimeTransaction(operation)
      : scoped.withNativeRuntimeTransaction((f.record as any).groupId, operation);
    try {
      await transaction(async (record, acknowledge) => {
        await acknowledge({runtimeKind:'incus-vm',nativeRuntime:{...record.nativeRuntime!,pending:{kind:'stop'}}});
      });
      const pending = await readAdministrativeRuntimeRecord(f.info.id);
      await expect(kind === 'platform' ? global.getStatus() : scoped.getStatus((f.record as any).groupId)).rejects.toMatchObject({ statusCode: 503 });
      if (kind === 'platform') await expect(global.getStartupScript()).rejects.toMatchObject({ statusCode: 503 });
      expect(await readAdministrativeRuntimeRecord(f.info.id)).toEqual(pending);
      await expect(f.cm.resolveWorkerHost(f.info.id)).rejects.toThrow('authority changed');
      expect(f.probes()).toBe(0);
    } finally {
      await transaction(async (record, acknowledge) => {
        await acknowledge({runtimeKind:'incus-vm',nativeRuntime:{...record.nativeRuntime!,pending:undefined}});
      });
      await f.cleanup();
    }
  });
}

test('quarantined dedicated authority cannot fall back to a registered runtime or ordinary shadow', async () => {
  const f = await fixture(), store = useAdminWorkspaceStore() as any;
  try {
    store.unavailable = true;
    await expect(store.getStatus()).rejects.toMatchObject({ statusCode: 503 });
    await expect(store.getStartupScript()).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.cm.resolveWorkerHost(f.info.id)).rejects.toMatchObject({statusCode:503});
    await expect(f.cm.workerCommands(f.info.id).execCapture(f.info.containerId,['fixture'])).rejects.toMatchObject({statusCode:503});
    expect(f.calls).toEqual([]); expect(f.probes()).toBe(0);
  } finally { store.unavailable=false; await f.cleanup(); }
});

test('native cutover immediately revokes a settled legacy admin projection, captured command and linked terminal', async () => {
  const f = await fixture(), store = useAdminWorkspaceStore(), docker = useDockerService(), identity = f.record.nativeRuntime!;
  const original = { execCapture: docker.execCapture, execAttachTmuxWindow: docker.execAttachTmuxWindow,
    killTmuxSession: docker.killTmuxSession, resizeExec: docker.resizeExec };
  let dockerCalls = 0; const stream = new PassThrough();
  docker.execCapture = async () => { dockerCalls++; return { stdout: Buffer.from('legacy'), stderr: Buffer.alloc(0), exitCode: 0 }; };
  docker.execAttachTmuxWindow = async () => ({ stream, exec: {id:'legacy-exec'}, tmuxSession:'linked' }) as any;
  docker.killTmuxSession = async () => { dockerCalls++; };
  docker.resizeExec = async () => {};
  try {
    await store.withNativeRuntimeTransaction(async (_record, acknowledge) => acknowledge({runtimeKind:'legacy-docker'}));
    f.info.runtimeKind='legacy-docker'; f.info.containerId='e'.repeat(64); f.info.containerName='retained-admin';
    expect(f.cm.get(f.info.id)?.status).toBe('running');
    await store.setStatus('stopped'); f.info.status='stopped';
    expect(f.cm.get(f.info.id)?.status).toBe('stopped');
    await store.setStatus('running'); f.info.status='running';
    const captured = f.cm.workerCommands(f.info.id), terminal = await f.cm.attachTerminal(f.info.id,0);
    expect((await captured.execCapture(f.info.containerId,['fixture'])).stdout.toString()).toBe('legacy');
    await store.withNativeRuntimeTransaction(async (_record, acknowledge) => acknowledge({runtimeKind:'incus-vm',nativeRuntime:identity}));
    expect(f.cm.get(f.info.id)?.status).toBe('unknown');
    expect(() => captured.execCapture(f.info.containerId,['fixture'])).toThrow('authority changed');
    await expect(f.cm.resolveWorkerHost(f.info.id)).rejects.toThrow('not running');
    await expect.poll(() => stream.writableEnded).toBe(true); terminal.close();
    expect(dockerCalls).toBe(1);
  } finally {
    await store.withNativeRuntimeTransaction(async (_record, acknowledge) => acknowledge({runtimeKind:'incus-vm',nativeRuntime:identity}));
    Object.assign(docker,original); await f.cleanup();
  }
});

test('captured native authority keeps primitive owner and role when a registry entry is mutated in place', async () => {
  const f = await fixture('group');
  try {
    const commands = f.cm.workerCommands(f.info.id);
    f.info.userId='foreign'; f.info.administrativeKind='platform';
    await expect(commands.execCapture(f.info.containerId,['fixture'])).rejects.toThrow('authority changed');
    expect(f.probes()).toBe(0); expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});
