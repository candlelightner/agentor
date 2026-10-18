import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import { adminNativeInstanceName } from '../../orchestrator/server/utils/admin-native-authority';
import { administrativeNativeOverlaySha256 } from '../../orchestrator/server/utils/incus-admin-workspace-runtime';
import { IncusAdminBackup, administrativeArchiveHelperOwner, assertAdministrativeSnapshotSettled } from '../../orchestrator/server/utils/incus-admin-backup';
import { IncusAdminWorkspaceStorage } from '../../orchestrator/server/utils/incus-admin-workspace-storage';
import { INCUS_CANONICAL_ARCHIVE_SCRIPT } from '../../orchestrator/server/utils/incus-canonical-archive';

function fixture(group = false, id: string = randomUUID()) {
  const stamp = new Date(0).toISOString();
  const record: AdministrativeWorkspaceRecord = { schemaVersion: 1, id, trusted: true,
    kind: group ? 'group-administrative' : 'administrative', status: 'stopped', runtimeKind: 'incus-vm',
    ...(group ? { groupId: 'legacy_group', ownerId: 'owner' } : {}), createdAt: stamp, updatedAt: stamp };
  record.nativeRuntime = { version: 1, name: adminNativeInstanceName(record), installationId: randomUUID(), nonce: randomUUID(),
    incarnation: randomUUID(), overlayVersion: '6', overlaySha256: administrativeNativeOverlaySha256(record),
    storageReady: true, storageInitialized: true,
    image: { version: 1, fingerprint: '1'.repeat(64), sourceImageId: 'sha256:'+'2'.repeat(64), recipeId: '3'.repeat(64),
      architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' } };
  const name = record.nativeRuntime.name, endpoint = 'https://incus.invalid', config: any = { incusProject: 'agentor', incusStoragePool: 'pool' };
  const ref = (name: string) => `/1.0/instances/${name}?project=agentor`;
  const instance: any = { name, type: 'virtual-machine', status: 'Stopped', profiles: [],
    config: { 'volatile.uuid': record.nativeRuntime.incarnation }, devices: {} };
  const volumes: Record<string, any> = Object.fromEntries(['workspace','agents'].map(role => [role, { name: `${name}-${role}`,
    type: 'custom', content_type: 'filesystem', project: 'agentor', created_at: stamp,
    config: { 'user.agentor.admin-storage-nonce': record.nativeRuntime!.nonce }, used_by: [ref(name)] }]));
  const selected: any[] = [];
  let fresh = structuredClone(record), helperCalls = 0, execCalls = 0, closeCalls = 0;
  let mutate: (() => void) | undefined, code = 0, helperAttached = false;
  const runtime: any = {
    validateAuthority: async (captured: any) => { expect(captured).toEqual(fresh); },
    assertOwned: async () => { expect(helperAttached).toBe(false); return structuredClone(instance); },
    storage: { inspect: async (_record: any, _identity: any, role: string) => structuredClone(volumes[role]),
      store: async () => ({ forWorker: () => selected.map(item => structuredClone(item.record)) }) },
    inspectSelectedStorage: async () => selected.filter(item => item.record.attached).map(item => structuredClone(item)),
    client: { endpoint, getInstance: async () => structuredClone(instance),
      getCustomVolume: async (_pool: string, name: string) => structuredClone(Object.values(volumes).find((v: any) => v.name === name)),
      execStream: async (target: string, command: string[], options: any) => {
        execCalls++;
        expect(target).toBe('abk-fixture');
        expect(command.slice(0,3)).toEqual(['/usr/bin/python3','-c',INCUS_CANONICAL_ARCHIVE_SCRIPT]);
        expect(command[5]).toBe('offline');
        expect(JSON.parse(command[4]!)).toEqual(command[3] === 'managed' ? [] : ['/workspace/account']);
        expect(options).toMatchObject({ user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } });
        return { stdin: new PassThrough(), stdout: Readable.from([Buffer.from(command[3]!+' bytes')]), stderr: Readable.from([]),
          result: Promise.resolve().then(() => { mutate?.(); return code; }), close() { closeCalls++; } };
      } },
  };
  const detachedStorage = new IncusAdminWorkspaceStorage(config, runtime.client, async () => runtime.storage.store());
  runtime.storage.inspectDetachedSelectedVolume = detachedStorage.inspectDetachedSelectedVolume.bind(detachedStorage);
  const helper: any = { withGuest: async (owner: any, sources: any, assertSource: any, _signal: any, capture: any) => {
    helperCalls++;
    expect(owner).toEqual(administrativeArchiveHelperOwner(record));
    expect(owner.id).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    expect(owner.userId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
    const attached = sources.managed ? [Object.values(volumes).find((v: any) => v.name === sources.managed)] : [volumes.workspace, volumes.agents];
    if (!sources.managed) expect(sources).toEqual({ workspace: volumes.workspace.name, agents: volumes.agents.name });
    await assertSource();
    helperAttached = true;
    for (const volume of attached as any[]) volume.used_by.push(ref('abk-fixture'));
    try { await assertSource('abk-fixture'); return await capture('abk-fixture', async () => {}); }
    finally {
      helperAttached = false;
      for (const volume of attached as any[]) volume.used_by = volume.used_by.filter((r: string) => r !== ref('abk-fixture'));
    }
  } };
  return { record, instance, volumes, selected, runtime, config, backup: new IncusAdminBackup(config, runtime, helper),
    mutate: (f: () => void) => { mutate = f; }, setFresh: (r: any) => { fresh = r; }, setCode: (n: number) => { code = n; },
    counts: () => ({ helperCalls, execCalls, closeCalls }) };
}

for (const group of [false, true]) test(`dedicated ${group ? 'group' : 'platform'} canonical capture retains source and uses readonly helper`, async () => {
  const f = fixture(group), directory = await mkdtemp(join(tmpdir(),'admin-backup-'));
  try {
    const paths = { workspace: join(directory,'workspace.gz'), agents: join(directory,'agents.gz') };
    const before = structuredClone({ instance: f.instance, volumes: f.volumes });
    const result = await f.backup.capture(f.record, paths, { exclusions: ['/workspace/account'] });
    for (const role of ['workspace','agents'] as const) {
      expect(gunzipSync(await readFile(paths[role])).toString()).toBe(role+' bytes');
      expect(result.bytes[role]).toBeGreaterThan(0);
    }
    expect(result.image).toEqual(f.record.nativeRuntime!.image);
    expect(result.overlaySha256).toBe(f.record.nativeRuntime!.overlaySha256);
    expect({ instance: f.instance, volumes: f.volumes }).toEqual(before);
    expect(f.counts()).toEqual({ helperCalls: 1, execCalls: 2, closeCalls: 2 });
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('bounded historical admin IDs get stable domain-separated helper IDs without widening worker admission', () => {
  for (const id of ['legacy_admin','A'.repeat(128)]) {
    const platform = fixture(false,id), group = fixture(true,id);
    const owner = administrativeArchiveHelperOwner(platform.record);
    expect(administrativeArchiveHelperOwner(structuredClone(platform.record))).toEqual(owner);
    expect(owner.id).not.toBe(administrativeArchiveHelperOwner(group.record).id);
    expect(owner.id).not.toBe(id);
    expect(owner.containerName).toBe(adminNativeInstanceName(platform.record));
  }
});

for (const condition of ['pending','deleting','selected-operation','migration','uninitialized','missing-storage','missing-incarnation','invalid-kind'] as const)
  test(`instance snapshot refuses administrative ${condition}`, () => {
    const f = fixture();
    if (condition === 'deleting') f.record.nativeRuntime!.deleting = true;
    if (condition === 'pending') f.record.nativeRuntime!.pending = { kind: 'create' };
    if (condition === 'selected-operation') {
      const id = randomUUID(); f.record.nativeRuntime!.selectedVolumeIds = [id];
      f.record.nativeRuntime!.selectedOperation = { volumeId: id, operationId: randomUUID(),
        incarnation: f.record.nativeRuntime!.incarnation!, kind: 'snapshot' };
    }
    if (condition === 'migration') f.record.nativeMigration = { version: 1, nonce: randomUUID(), phase: 'captured',
      source: { containerId: 'a'.repeat(64), imageId: 'sha256:'+'b'.repeat(64), createdAt: new Date(0).toISOString() } };
    if (condition === 'uninitialized') delete f.record.nativeRuntime!.storageInitialized;
    if (condition === 'missing-storage') delete f.record.nativeRuntime!.storageReady;
    if (condition === 'missing-incarnation') delete f.record.nativeRuntime!.incarnation;
    if (condition === 'invalid-kind') (f.record as any).kind = 'ordinary';
    expect(() => assertAdministrativeSnapshotSettled(f.record)).toThrow();
  });

test('settled legacy administrative records remain compatible', () => {
  const f = fixture(); delete f.record.runtimeKind; delete f.record.nativeRuntime;
  expect(() => assertAdministrativeSnapshotSettled(f.record)).not.toThrow();
});

for (const condition of ['running-intent','running-compute','missing-volume','foreign-project','unbound-reference','missing-created-time'] as const)
  test(`capture refuses ${condition} before helper creation`, async () => {
    const f = fixture();
    if (condition === 'running-intent') f.record.status = 'running';
    if (condition === 'running-compute') f.instance.status = 'Running';
    if (condition === 'missing-volume') delete f.volumes.workspace;
    if (condition === 'foreign-project') f.volumes.workspace.project = 'other';
    if (condition === 'unbound-reference') f.volumes.workspace.used_by = [];
    if (condition === 'missing-created-time') delete f.volumes.workspace.created_at;
    f.setFresh(structuredClone(f.record));
    await expect(f.backup.capture(f.record, { workspace: '/unused' }, { exclusions: [] })).rejects.toThrow();
    expect(f.counts().helperCalls).toBe(0);
  });

for (const condition of ['record-replaced','vm-replaced','volume-replaced','foreign-reference','duplicate-reference','device-drift','exec-failure'] as const)
  test(`capture rejects ${condition} at final authority proof and closes stream`, async () => {
    const f = fixture(), directory = await mkdtemp(join(tmpdir(),'admin-backup-drift-'));
    try {
      f.mutate(() => {
        if (condition === 'record-replaced') f.setFresh({ ...f.record, status: 'running' });
        if (condition === 'vm-replaced') f.instance.config['volatile.uuid'] = randomUUID();
        if (condition === 'volume-replaced') f.volumes.workspace.created_at = new Date(1000).toISOString();
        if (condition === 'foreign-reference') f.volumes.workspace.used_by.push('https://foreign.invalid/1.0/instances/same?project=agentor');
        if (condition === 'duplicate-reference') f.volumes.workspace.used_by.push(f.volumes.workspace.used_by[0]);
        if (condition === 'device-drift') f.instance.devices.extra = { type: 'disk', path: '/host' };
      });
      if (condition === 'exec-failure') f.setCode(1);
      await expect(f.backup.capture(f.record, { workspace: join(directory,'archive.gz') }, { exclusions: ['/workspace/account'] })).rejects.toThrow();
      expect(f.counts().closeCalls).toBe(1);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });

test('cancelled capture does not allocate helper or execute commands', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  await expect(f.backup.capture(f.record, { workspace: '/unused' }, { exclusions: [], signal: controller.signal })).rejects.toThrow();
  expect(f.counts()).toEqual({ helperCalls: 0, execCalls: 0, closeCalls: 0 });
});

test('ambiguous archive output roles fail before source inspection', async () => {
  const f = fixture();
  for (const outputs of [{}, { workspace: '/same', agents: '/same' }, { workspace: '' }, { docker: '/unused' }])
    await expect(f.backup.capture(f.record, outputs, { exclusions: [] })).rejects.toThrow();
  expect(f.counts().helperCalls).toBe(0);
});

for (const group of [false,true]) for (const attached of [false,true]) test(`administrative ${group ? 'group' : 'global'} capture retains ${attached ? 'attached' : 'detached'} selected bytes without changing active references`, async () => {
  const f = fixture(group), directory = await mkdtemp(join(tmpdir(), 'admin-selected-backup-'));
  try {
    const id = randomUUID(), owner = group ? 'owner' : '__agentor_admin__';
    const record: any = { id, userId: owner, workerId: f.record.id, target: '/srv/selected', name: 'Selected',
      dockerName: 'agentor-persist-' + id, purpose: 'persistent-path', storageRuntimeKind: 'incus-vm', seeded: true,
      attached, state: attached ? 'ready' : 'detached', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
    const volume = { name: record.dockerName, project: 'agentor', type: 'custom', content_type: 'filesystem', created_at: record.createdAt,
      used_by: attached ? ['/1.0/instances/' + f.instance.name + '?project=agentor'] : [],
      config: { 'user.agentor.installation': f.record.nativeRuntime!.installationId, 'user.agentor.owner': owner,
        'user.agentor.id': f.record.id, 'user.agentor.volume-id': id, 'user.agentor.target': record.target } };
    f.selected.push({ record, volume }); f.volumes.selected = volume;
    const before = structuredClone({ record: f.record, volume });
    const output = join(directory, 'selected.gz');
    expect(await f.backup.captureSelected(f.record, id, output)).toEqual(record);
    expect(gunzipSync(await readFile(output)).toString()).toBe('managed bytes');
    expect({ record: f.record, volume }).toEqual(before); expect(f.counts().helperCalls).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('detached administrative storage with foreign metadata, references or provisional data cannot be silently omitted', async () => {
  for (const condition of ['owner','reference','unseeded']) {
    const f = fixture(), id = randomUUID();
    const record: any = { id, userId: '__agentor_admin__', workerId: f.record.id, dockerName: 'agentor-persist-' + id,
      name: 'Detached', target: '/srv/detached', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
      attached: false, seeded: condition !== 'unseeded', state: 'detached' };
    const volume: any = { name: record.dockerName, project: 'agentor', type: 'custom', content_type: 'filesystem', created_at: new Date(0).toISOString(),
      used_by: condition === 'reference' ? ['/1.0/instances/foreign?project=agentor'] : [], config: {
        'user.agentor.installation': f.record.nativeRuntime!.installationId, 'user.agentor.owner': condition === 'owner' ? 'foreign' : '__agentor_admin__',
        'user.agentor.id': f.record.id, 'user.agentor.volume-id': id, 'user.agentor.target': record.target } };
    f.selected.push({ record, volume }); f.volumes.selected = volume;
    await expect(f.backup.inspectSelected(f.record)).rejects.toThrow(); expect(f.counts().helperCalls).toBe(0);
  }
});


test('administrative producer refuses selected history beyond the existing restore bound before publishing an unusable snapshot', async () => {
  const f = fixture();
  for (let index = 0; index < 33; index++) f.selected.push({ record: { attached: true }, volume: {} });
  await expect(f.backup.inspectSelected(f.record)).rejects.toThrow('volume limit');
  expect(f.counts().helperCalls).toBe(0);
});


for (const revoked of [false,true]) test(`explicit portable live selected capture ${revoked ? 'rejects late state revocation' : 'preserves known bytes'} without changing the stopped default`, async () => {
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'admin-selected-live-backup-'));
  try {
    f.record.status = 'running'; f.instance.status = 'Running'; f.setFresh(structuredClone(f.record));
    const id = randomUUID(), owner = '__agentor_admin__', record: any = { id, userId: owner, workerId: f.record.id, target: '/srv/live',
      dockerName: 'agentor-persist-' + id, purpose: 'persistent-path', storageRuntimeKind: 'incus-vm', seeded: true, attached: true, state: 'ready' };
    const volume = { name: record.dockerName, project: 'agentor', type: 'custom', content_type: 'filesystem', created_at: new Date(0).toISOString(),
      used_by: ['/1.0/instances/' + f.instance.name + '?project=agentor'], config: {
        'user.agentor.installation': f.record.nativeRuntime!.installationId, 'user.agentor.owner': owner,
        'user.agentor.id': f.record.id, 'user.agentor.volume-id': id, 'user.agentor.target': record.target } };
    f.selected.push({ record, volume }); f.volumes.selected = volume;
    await expect(f.backup.captureSelected(f.record, id, join(directory, 'default.gz'))).rejects.toThrow('stopped');
    expect(f.counts().helperCalls).toBe(0);
    if (revoked) f.mutate(() => { f.instance.status = 'Stopped'; });
    const output = join(directory, 'live.gz'), capture = f.backup.captureSelected(f.record, id, output, undefined, { allowRunning: true });
    if (revoked) await expect(capture).rejects.toThrow('compute changed');
    else { expect(await capture).toEqual(record); expect(gunzipSync(await readFile(output)).toString()).toBe('managed bytes'); }
    expect(f.counts().helperCalls).toBe(1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const drift of [false, true]) test(`stopped portable seeded leaf ${drift ? 'refuses durable source drift' : 'retains known bytes'} beside a pending selection while instance capture stays strict`, async () => {
  const { ManagedVolumeStore } = await import('../../orchestrator/server/utils/managed-volume-store');
  const { IncusAdminWorkspaceStorage } = await import('../../orchestrator/server/utils/incus-admin-workspace-storage');
  const f = fixture(), directory = await mkdtemp(join(tmpdir(), 'admin-selected-pending-'));
  try {
    const store = new ManagedVolumeStore(directory); await store.init();
    const seeded = await store.create('__agentor_admin__', f.record.id, '/opt/seeded', undefined, 'incus-vm');
    await store.save({ ...seeded, seeded: true, state: 'ready' });
    const pending = await store.create('__agentor_admin__', f.record.id, '/opt/pending', undefined, 'incus-vm');
    const pendingBefore = structuredClone(store.get('__agentor_admin__', pending.id));
    f.record.nativeRuntime!.selectedVolumeIds = [seeded.id, pending.id]; f.setFresh(structuredClone(f.record));
    const storage = new IncusAdminWorkspaceStorage(f.config, f.runtime.client, async () => store);
    Object.assign(f.runtime.storage, { selectedRecords: storage.selectedRecords.bind(storage), inspectSelectedVolume: storage.inspectSelectedVolume.bind(storage) });
    f.runtime.inspectSelectedStorage = storage.inspectSelected.bind(storage);
    f.volumes.selected = { name: seeded.dockerName, project: 'agentor', type: 'custom', content_type: 'filesystem', created_at: new Date(0).toISOString(),
      used_by: ['/1.0/instances/' + f.instance.name + '?project=agentor'], config: {
        'user.agentor.installation': f.record.nativeRuntime!.installationId, 'user.agentor.owner': '__agentor_admin__',
        'user.agentor.id': f.record.id, 'user.agentor.volume-id': seeded.id, 'user.agentor.target': seeded.target } };
    await expect(f.backup.captureSelected(f.record, seeded.id, join(directory, 'instance.gz'))).rejects.toThrow('Apply administrative selected directories');
    await expect(f.backup.capturePortableSelected(f.record, pending.id, join(directory, 'pending.gz'))).rejects.toThrow('ready seeded');
    expect(f.counts().helperCalls).toBe(0);
    if (drift) {
      const execStream = f.runtime.client.execStream;
      f.runtime.client.execStream = async (...args: any[]) => {
        await store.save({ ...store.get('__agentor_admin__', seeded.id)!, name: 'Changed during capture' });
        return execStream(...args);
      };
    }
    const output = join(directory, 'portable.gz'), capture = f.backup.capturePortableSelected(f.record, seeded.id, output);
    if (drift) await expect(capture).rejects.toThrow('portable selected record changed');
    else {
      expect((await capture).id).toBe(seeded.id);
      expect(gunzipSync(await readFile(output)).toString()).toBe('managed bytes');
    }
    expect(f.counts()).toEqual({ helperCalls: 1, execCalls: 1, closeCalls: 1 });
    expect(store.get('__agentor_admin__', pending.id)).toEqual(pendingBefore);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
