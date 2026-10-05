import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { HostMountStore } from '../../orchestrator/server/utils/host-mount-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { incusHostMountLayout, incusHostMountMetadata, assertIncusHostMountLayout,
  type IncusHostMountLayout } from '../../orchestrator/server/utils/incus-host-mount-runtime';
import type { Config } from '../../orchestrator/server/utils/config';
import type { IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { IncusInstance } from '../../orchestrator/server/utils/incus-client';
import type { MountConfig } from '../../orchestrator/shared/types';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-incus-host-layout-'));
  const owner = 'host-layout-owner', id = randomUUID();
  const workers = new WorkerStore(dataDir); await workers.init();
  const groups = new WorkerGroupStore(dataDir); await groups.loadUser(owner);
  const store = new HostMountStore(dataDir, () => '/srv/agentor-layout-data', groups, workers);
  await store.init();
  await workers.upsert({ id, userId: owner, runtimeKind: 'incus-vm', status: 'active',
    displayName: 'layout fixture', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  const path = await store.createPath({ name: 'Approved', sourcePath: '/srv/approved-layout-source' });
  const config = { dataDir, incusProject: 'agentor' } as Config;
  const options = { id, userId: owner, containerName: `agentor-worker-${id}`,
    storageManager: { dataHostPath: '/srv/agentor-layout-data' },
    mounts: [{ pathId: path.id, source: '/caller-forged-source', target: '/mnt/share' }] } as IncusWorkerOptions;
  const calls: Array<{ operation: string; mount: MountConfig }> = [];
  let sourceIdentity = 'a'.repeat(64);
  const host = Object.fromEntries(['ensure', 'inspect'].map(operation => [operation, async (mount: MountConfig) => {
    calls.push({ operation, mount: structuredClone(mount) });
    return { installation: 'fixture', project: 'agentor', pathId: mount.pathId!,
      sourcePath: mount.source, allowWrite: store.getPath(mount.pathId!)!.allowWrite, sourceIdentity };
  }])) as any;
  const grantWorker = async () => {
    await store.setEntitlement(owner, path.id, true);
    return store.createOwnerGrant(owner, { pathId: path.id, targetType: 'worker', targetId: id });
  };
  const resolve = (operation: 'ensure' | 'inspect' | 'reconstruct-preflight' = 'ensure', opts = options,
    instance?: IncusInstance) => incusHostMountLayout(config, opts, operation, host, instance);
  const record = () => workers.get(owner, id)!;
  return { dataDir, owner, id, workers, groups, store, path, config, options, calls, host, grantWorker, resolve, record,
    setSourceIdentity: (value: string) => { sourceIdentity = value; },
    cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

function native(layout: IncusHostMountLayout): IncusInstance {
  return { config: incusHostMountMetadata(layout), devices: structuredClone(layout.devices) } as IncusInstance;
}

test('layout requires both platform entitlement and worker assignment before host policy calls', async () => {
  const f = await fixture();
  try {
    await expect(f.resolve()).rejects.toThrow('not assigned'); expect(f.calls).toEqual([]);
    await f.store.setEntitlement(f.owner, f.path.id, true);
    await expect(f.resolve()).rejects.toThrow('not assigned'); expect(f.calls).toEqual([]);
    await f.store.createOwnerGrant(f.owner, { pathId: f.path.id, targetType: 'worker', targetId: f.id });
    const layout = await f.resolve();
    expect(f.calls).toEqual([{ operation: 'ensure', mount: {
      pathId: f.path.id, source: f.path.sourcePath, target: '/mnt/share', readOnly: true } }]);
    expect(Object.values(layout.devices)).toEqual([{ type: 'disk', source: f.path.sourcePath, path: '/mnt/share', readonly: 'true' }]);
    expect(layout.identities).toEqual([{ key: Object.keys(layout.devices)[0], pathId: f.path.id, sourceIdentity: 'a'.repeat(64) }]);
  } finally { await f.cleanup(); }
});

test('legacy raw source must resolve exactly from approved catalog; forged source with ID is overwritten', async () => {
  const f = await fixture();
  try {
    await f.grantWorker();
    const byId = await f.resolve('inspect');
    const bySource = await f.resolve('inspect', { ...f.options, mounts: [{ source: f.path.sourcePath, target: '/mnt/share' }] });
    expect(bySource).toEqual(byId);
    expect(f.calls.every(call => call.mount.source === f.path.sourcePath && call.mount.pathId === f.path.id)).toBe(true);
    f.calls.length = 0;
    await expect(f.resolve('ensure', { ...f.options, mounts: [{ source: '/srv/not-approved', target: '/mnt/share' }] }))
      .rejects.toThrow('not an approved catalog path');
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('read-only defaults and writable catalog approval remain authoritative before device construction', async () => {
  const f = await fixture();
  try {
    await f.grantWorker();
    await expect(f.resolve('ensure', { ...f.options, mounts: [{ ...f.options.mounts![0]!, readOnly: false }] }))
      .rejects.toThrow('read-only'); expect(f.calls).toEqual([]);
    await f.store.updatePath(f.path.id, { allowWrite: true });
    const layout = await f.resolve('ensure', { ...f.options, mounts: [{ ...f.options.mounts![0]!, readOnly: false }] });
    expect(Object.values(layout.devices)[0]!.readonly).toBe('false');
    expect(f.calls[0]!.mount.readOnly).toBe(false);
  } finally { await f.cleanup(); }
});

test('direct group conflicts and unproven provisional group hints fail before allowlisting', async () => {
  const f = await fixture();
  try {
    const first = await f.groups.create(f.owner, 'first'), second = await f.groups.create(f.owner, 'second');
    await f.store.setEntitlement(f.owner, f.path.id, true);
    await f.store.createOwnerGrant(f.owner, { pathId: f.path.id, targetType: 'group', targetId: first.id });
    const hinted = { ...f.options, hostMountGroupId: first.id };
    await expect(f.resolve('ensure', hinted)).rejects.toThrow('creation group authority'); expect(f.calls).toEqual([]);
    await f.workers.upsert({ ...f.record(), incusRecreation: { nonce: randomUUID(), initialCreate: true } });
    expect(Object.keys((await f.resolve('ensure', hinted)).devices)).toHaveLength(1);
    f.calls.length = 0;
    await f.groups.update(f.owner, second.id, { workerIds: [f.id] });
    await expect(f.resolve('ensure', hinted)).rejects.toThrow('creation group authority'); expect(f.calls).toEqual([]);
    await f.groups.setWorkerReferences(f.owner, f.id, [first.id, second.id]);
    await expect(f.resolve()).rejects.toThrow('ambiguous'); expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('group grants preserve direct membership semantics rather than inheriting parent assignment', async () => {
  const f = await fixture();
  try {
    const parent = await f.groups.create(f.owner, 'parent');
    const child = await f.groups.create(f.owner, 'child', parent.id);
    await f.groups.update(f.owner, child.id, { workerIds: [f.id] });
    await f.store.setEntitlement(f.owner, f.path.id, true);
    await f.store.createOwnerGrant(f.owner, { pathId: f.path.id, targetType: 'group', targetId: parent.id });
    await expect(f.resolve()).rejects.toThrow('not assigned'); expect(f.calls).toEqual([]);
    await f.store.createOwnerGrant(f.owner, { pathId: f.path.id, targetType: 'group', targetId: child.id });
    expect(Object.keys((await f.resolve()).devices)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('all protected and overlapping targets are rejected before any host policy mutation', async () => {
  const f = await fixture();
  try {
    await f.grantWorker();
    for (const target of ['/run/agentor', '/etc', '/home/agent', '/home/agent/.ssh', '/var/lib/docker',
      '/workspace', '/tmp', '/tmp/worker-events', '/tmp/worker-events/private']) {
      await expect(f.resolve('ensure', { ...f.options, mounts: [{ ...f.options.mounts![0]!, target }] })).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
    for (const targets of [['/mnt/share', '/mnt/share'], ['/mnt/share', '/mnt/share/nested']]) {
      await expect(f.resolve('ensure', { ...f.options, mounts: targets.map(target => ({ ...f.options.mounts![0]!, target })) }))
        .rejects.toThrow('overlap'); expect(f.calls).toEqual([]);
    }
    for (const managedTarget of ['/mnt/share', '/mnt', '/mnt/share/nested']) {
      await expect(f.resolve('ensure', { ...f.options, managedVolumes: [{ target: managedTarget }] as any }))
        .rejects.toThrow('overlap'); expect(f.calls).toEqual([]);
    }
    expect(Object.values((await f.resolve('ensure', { ...f.options, mounts: [{ ...f.options.mounts![0]!, target: '/workspace/share' }] })).devices)[0]!.path)
      .toBe('/workspace/share');
  } finally { await f.cleanup(); }
});

test('fresh grants and worker authority reject revoked, deleted or legacy state before host operations', async () => {
  const f = await fixture();
  try {
    const grant = await f.grantWorker(); await f.resolve(); f.calls.length = 0;
    await f.store.deleteGrant(f.owner, grant.id);
    await expect(f.resolve('inspect')).rejects.toThrow('not assigned'); expect(f.calls).toEqual([]);
    await f.store.createOwnerGrant(f.owner, { pathId: f.path.id, targetType: 'worker', targetId: f.id });
    const original = f.record();
    for (const patch of [{ hostMountsRevoked: true }, { deletionPending: true }, { runtimeKind: 'legacy-docker' as const }]) {
      await f.workers.upsert({ ...original, ...patch });
      await expect(f.resolve()).rejects.toThrow('authorized Incus WorkerRecord'); expect(f.calls).toEqual([]);
    }
    await f.workers.upsert({ ...original, status: 'archived' });
    await expect(f.resolve('inspect')).rejects.toThrow('authorized Incus WorkerRecord'); expect(f.calls).toEqual([]);
    // Archive/unarchive preflight still validates grants and host sources before
    // disposable compute replacement. Ensure alone never attaches a VM device.
    expect(Object.keys((await f.resolve('ensure')).devices)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('native layout pins source inode, device source, target, mode and exact reserved device identities', async () => {
  const f = await fixture();
  try {
    await f.grantWorker(); const expected = await f.resolve('ensure'), instance = native(expected);
    expect(() => assertIncusHostMountLayout(instance, expected)).not.toThrow();
    f.setSourceIdentity('b'.repeat(64)); const changedInode = await f.resolve('inspect');
    expect(() => assertIncusHostMountLayout(instance, changedInode)).toThrow('source identity changed');
    const key = Object.keys(expected.devices)[0]!;
    for (const patch of [{ source: '/srv/foreign' }, { path: '/mnt/other' }, { readonly: 'false' }, { raw: 'extra' }]) {
      const changed = native(expected); Object.assign(changed.devices[key]!, patch);
      expect(() => assertIncusHostMountLayout(changed, expected)).toThrow('policy changed');
    }
    const missing = native(expected); delete missing.devices[key];
    expect(() => assertIncusHostMountLayout(missing, expected)).toThrow('layout is foreign');
    const extra = native(expected); extra.devices.hmforeign = { ...expected.devices[key]! };
    expect(() => assertIncusHostMountLayout(extra, expected)).toThrow('layout is foreign');
    const expanded = native(expected); expanded.expanded_devices = { [key]: { ...expected.devices[key]!, readonly: 'false' } };
    expect(() => assertIncusHostMountLayout(expanded, expected)).toThrow('policy changed');
    expect(() => assertIncusHostMountLayout(instance, { devices: {}, identities: [] })).toThrow('source identity changed');
  } finally { await f.cleanup(); }
});

test('revoked exports require explicit reconstruction authority and surviving grants remain authoritative', async () => {
  const f = await fixture();
  try {
    await f.grantWorker();
    const revokedPath = await f.store.createPath({ name: 'Revoked', sourcePath: '/srv/revoked-layout-source' });
    await f.store.setEntitlement(f.owner, revokedPath.id, true);
    const revokedGrant = await f.store.createOwnerGrant(f.owner,
      { pathId: revokedPath.id, targetType: 'worker', targetId: f.id });
    const oldOptions = { ...f.options, mounts: [...f.options.mounts!,
      { pathId: revokedPath.id, source: revokedPath.sourcePath, target: '/mnt/revoked' }] };
    const original = native(await f.resolve('ensure', oldOptions));
    await f.store.deleteGrant(f.owner, revokedGrant.id);
    await f.workers.upsert({ ...f.record(), hostMountsRevoked: true, pendingRebuild: true, mounts: f.options.mounts });
    f.calls.length = 0;
    for (const operation of ['ensure', 'inspect'] as const)
      await expect(f.resolve(operation)).rejects.toThrow('authorized Incus WorkerRecord');
    expect(f.calls).toEqual([]);
    const retained = await f.resolve('reconstruct-preflight');
    expect(retained.identities.map(identity => identity.pathId)).toEqual([f.path.id]);
    expect(f.calls).toEqual([{ operation: 'ensure', mount: {
      pathId: f.path.id, source: f.path.sourcePath, target: '/mnt/share', readOnly: true } }]);
    expect(() => assertIncusHostMountLayout(original, retained)).toThrow('source identity changed');
    f.calls.length = 0;
    await expect(f.resolve('reconstruct-preflight', oldOptions)).rejects.toThrow('not assigned');
    expect(f.calls).toEqual([]);
    const nonce = randomUUID(), replacementIncarnation = randomUUID();
    const replacement = native(retained);
    Object.assign(replacement.config, { 'volatile.uuid': replacementIncarnation, 'user.agentor.recreation': nonce });
    await f.workers.upsert({ ...f.record(), incusRecreation: { nonce, originalIncarnation: 'old-fixture-incarnation' } });
    await expect(f.resolve('inspect', { ...f.options, recreationNonce: nonce }, replacement))
      .rejects.toThrow('captured replacement incarnation');
    expect(f.calls).toEqual([]);
    await f.workers.upsert({ ...f.record(), incusRecreation: {
      nonce, originalIncarnation: 'old-fixture-incarnation', replacementIncarnation } });
    for (const instance of [undefined, { config: {} },
      { config: { 'volatile.uuid': randomUUID(), 'user.agentor.recreation': nonce } },
      { config: { 'volatile.uuid': replacementIncarnation } },
      { config: { 'volatile.uuid': replacementIncarnation, 'user.agentor.recreation': randomUUID() } }]) {
      await expect(f.resolve('inspect', { ...f.options, recreationNonce: nonce }, instance as IncusInstance | undefined))
        .rejects.toThrow('captured replacement incarnation');
      expect(f.calls).toEqual([]);
    }
    for (const operation of ['ensure', 'inspect'] as const) {
      for (const recreationNonce of [undefined, randomUUID()]) {
        await expect(f.resolve(operation, { ...f.options, recreationNonce }, replacement)).rejects.toThrow('authorized Incus WorkerRecord');
        expect(f.calls).toEqual([]);
      }
      expect(await f.resolve(operation, { ...f.options, recreationNonce: nonce }, replacement)).toEqual(retained);
      expect(f.calls).toHaveLength(1); f.calls.length = 0;
      await expect(f.resolve(operation, { ...oldOptions, recreationNonce: nonce }, replacement)).rejects.toThrow('not assigned');
      expect(f.calls).toEqual([]);
    }
    await f.workers.upsert({ ...f.record(), incusRecreation: undefined });
    await expect(f.resolve('ensure', { ...f.options, recreationNonce: nonce })).rejects.toThrow('authorized Incus WorkerRecord');
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('workers without mounts retain compatibility without storage, grants or host credentials', async () => {
  const empty = await incusHostMountLayout({} as Config, { mounts: [] } as unknown as IncusWorkerOptions, 'inspect', {
    ensure: async () => { throw new Error('must not request host authority'); },
    inspect: async () => { throw new Error('must not request host authority'); },
  });
  expect(empty).toEqual({ devices: {}, identities: [] }); expect(incusHostMountMetadata(empty)).toEqual({});
  expect(() => assertIncusHostMountLayout({ config: {}, devices: {} } as IncusInstance, empty)).not.toThrow();
  const f = await fixture();
  try {
    await expect(f.resolve('ensure', { ...f.options, storageManager: undefined })).rejects.toThrow('authoritative platform storage');
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});
