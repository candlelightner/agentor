import { test, expect } from '@playwright/test';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { AdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { GroupAdminWorkspaceStore } from '../../orchestrator/server/utils/group-admin-workspace-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { isWorkerLifecycleMutationPending } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const ts = require('typescript');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-emergency-init-'));
  const stamp = new Date(0).toISOString();
  const record = { schemaVersion: 1, id: 'platform-emergency', kind: 'administrative', trusted: true,
    status: 'running', createdAt: stamp, updatedAt: stamp };
  await mkdir(join(directory, 'admin'));
  await writeFile(join(directory, 'admin/workspace.v1.json'), JSON.stringify(record));
  const platform = new AdminWorkspaceStore(directory), groupStore = new WorkerGroupStore(directory);
  await platform.init(); await groupStore.init();
  const group = await groupStore.create('emergency-owner', 'Emergency fixture');
  const groupRecord = { ...record, id: 'group-emergency', kind: 'group-administrative', groupId: group.id,
    ownerId: group.userId, services: ['terminal'] } as any;
  await groupStore.update(group.userId, group.id, { adminWorkspace: groupRecord });
  const groups = new GroupAdminWorkspaceStore(groupStore);
  return { platform, groups, group, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test('startup safety precedes emergency binding; delayed or failed normal initialization leaves stop available without enabling provisioning', async () => {
  const f = await fixture(), stops: string[] = [];
  let safe!: () => void, failNormal!: (error: Error) => void;
  const safety = new Promise<void>(resolve => { safe = resolve; });
  const normal = new Promise<void>((_resolve, reject) => { failNormal = reject; });
  let reachedNormal = false;
  const runtime = { stop: async (record: any, _ack: unknown, force: boolean) => { expect(force).toBe(true); stops.push(record.id); },
    observeStatus: async () => 'stopped' as const };
  const services = { useAdministrativeWorkspaceRuntime: () => runtime,
    useLogStore: () => ({ init: () => { reachedNormal = true; return normal; } }) };
  const source = await readFile(new URL('../../orchestrator/server/plugins/services.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('require', 'exports', 'defineNitroPlugin', compiled)((name: string) => {
    if (name === '../utils/services') return services;
    if (name === '../utils/instance-backup-manager') return { useInstanceBackupManager: () => ({ assertStartupSafe: () => safety }) };
    if (name === '../utils/admin-workspace-store') return { useAdminWorkspaceStore: () => f.platform };
    if (name === '../utils/group-admin-workspace-store') return { useGroupAdminWorkspaceStore: () => f.groups };
    return {};
  }, exports, (plugin: unknown) => plugin);
  const initialization = exports.default({});
  try {
    await expect(f.platform.setStatus('stopped', true)).rejects.toMatchObject({ statusCode: 503 });
    expect(reachedNormal).toBe(false); expect(stops).toEqual([]);
    safe(); await expect.poll(() => reachedNormal).toBe(true);
    for (const operation of [() => f.platform.ensure(), () => f.platform.setStatus('running'), () => f.platform.rebuild(),
      () => f.groups.ensure(f.group.id), () => f.groups.setStatus(f.group.id, 'running'), () => f.groups.rebuild(f.group.id)])
      await expect(operation()).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.platform.setStatus('stopped', true, 'wrong-id')).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.groups.setStatus(f.group.id, 'stopped', () => { throw Object.assign(Error('Forbidden'), { statusCode: 403 }); }, true)).rejects.toMatchObject({ statusCode: 403 });
    await expect(f.platform.setStatus('stopped', true, 'platform-emergency')).resolves.toMatchObject({ status: 'stopped' });
    failNormal(Error('Ordinary initialization unavailable'));
    await expect(initialization).rejects.toThrow('Ordinary initialization unavailable');
    await expect(f.groups.setStatus(f.group.id, 'stopped', undefined, true, 'group-emergency')).resolves.toMatchObject({ status: 'stopped' });
    expect(stops).toEqual(['platform-emergency', 'group-emergency']);
    await expect(f.platform.getStatus()).resolves.toMatchObject({ status: 'stopped' });
    await expect(f.groups.getStatus(f.group.id)).resolves.toMatchObject({ status: 'stopped' });
  } finally { safe(); failNormal(Error('fixture cleanup')); await initialization.catch(() => {}); await f.cleanup(); }
});

test('unbound admin status and failed emergency observation never report stale desired running as observed state', async () => {
  const f = await fixture();
  try {
    for (const read of [() => f.platform.getStatus(), () => f.groups.getStatus(f.group.id)])
      await expect(read()).rejects.toMatchObject({ statusCode: 503 });
    const runtime = { stop: async () => { throw Object.assign(Error('Runtime unavailable'), { statusCode: 503 }); },
      observeStatus: async (): Promise<'running'> => { throw Object.assign(Error('Runtime unavailable'), { statusCode: 503 }); } };
    f.platform.setEmergencyRuntimeAdapter(runtime); f.groups.setEmergencyRuntimeAdapter(runtime);
    for (const stop of [() => f.platform.setStatus('stopped', true), () => f.groups.setStatus(f.group.id, 'stopped', undefined, true)])
      await expect(stop()).rejects.toMatchObject({ statusCode: 503 });
    expect(f.platform.getRecord()?.status).toBe('running');
    expect(f.groups.findByWorkspaceId('group-emergency')?.status).toBe('running');
    for (const read of [() => f.platform.getStatus(), () => f.groups.getStatus(f.group.id)])
      await expect(read()).rejects.toMatchObject({ statusCode: 503 });
  } finally { await f.cleanup(); }
});

test('emergency timeout returns bounded feedback while both admin lifecycle fences remain held until the actual stop settles', async () => {
  const f = await fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const runtime = { stop: () => held, observeStatus: async () => 'stopped' as const };
  f.platform.setEmergencyRuntimeAdapter(runtime); f.groups.setEmergencyRuntimeAdapter(runtime);
  const originalTimeout = globalThis.setTimeout;
  // Exercise the production deadline without holding the module suite for 15 seconds.
  globalThis.setTimeout = ((callback: any, delay: number, ...args: any[]) => originalTimeout(callback, delay === 15_000 ? 50 : delay, ...args)) as any;
  try {
    const stopping = [f.platform.setStatus('stopped', true), f.groups.setStatus(f.group.id, 'stopped', undefined, true)];
    for (const result of stopping) await expect(result).rejects.toMatchObject({ statusCode: 504 });
    for (const id of ['platform-emergency', 'group-emergency']) expect(isWorkerLifecycleMutationPending(id)).toBe(true);
    await expect(f.platform.getStatus()).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.platform.setStatus('stopped', true)).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.groups.setStatus(f.group.id, 'stopped', undefined, true)).rejects.toMatchObject({ statusCode: 409 });
    release();
    await expect.poll(() => isWorkerLifecycleMutationPending('platform-emergency') || isWorkerLifecycleMutationPending('group-emergency')).toBe(false);
    await expect(f.platform.getStatus()).resolves.toMatchObject({ status: 'stopped' });
    await expect(f.groups.getStatus(f.group.id)).resolves.toMatchObject({ status: 'stopped' });
  } finally { globalThis.setTimeout = originalTimeout; release(); await f.cleanup(); }
});
