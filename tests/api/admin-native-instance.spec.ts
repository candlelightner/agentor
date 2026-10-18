import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminNativeInstanceName, administrativeRuntimeOwner } from '../../orchestrator/server/utils/admin-native-identity';
import { administrativeWorkspaceResourceNames } from '../../orchestrator/server/utils/admin-workspace-resources';
import { administrativeNativeOverlaySha256 } from '../../orchestrator/server/utils/incus-admin-overlay';
import { validateInstanceManifest, instanceVolumeArchiveName } from '../../orchestrator/server/utils/instance-backup-bundle';
import { planInstanceAdministrativeRestore, freshInstanceAdministrativeRestore, readInstanceAdministrativeRecords,
  preflightInstanceAdministrativeRestore } from '../../orchestrator/server/utils/instance-restore-administrative';
import { persistentPathVolumeName } from '../../orchestrator/server/utils/persistent-backup-paths';
import { IncusError } from '../../orchestrator/server/utils/incus-client';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import type { InstanceBackupManifest, InstanceBackupVolumeManifest } from '../../orchestrator/server/utils/instance-backup-types';
import { ManagedVolumeStore, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import type { Config } from '../../orchestrator/server/utils/config';

const stamp = '2026-10-18T00:00:00.000Z';
const source = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64), architecture: 'amd64' as const,
  bootstrapGeneration: '3' as const, converterVersion: 'v0.4.0' };
function record(group = false, native = true): AdministrativeWorkspaceRecord {
  const record: AdministrativeWorkspaceRecord = { schemaVersion: 1, id: randomUUID(), kind: group ? 'group-administrative' : 'administrative',
    trusted: true, status: 'stopped', ownerId: 'account-owner', createdAt: stamp, updatedAt: stamp,
    ...(group ? { groupId: 'legacy_group' } : {}) };
  if (native) {
    record.runtimeKind = 'incus-vm'; record.nativeRuntime = { version: 1, name: adminNativeInstanceName(record), nonce: randomUUID(),
      installationId: randomUUID(), incarnation: randomUUID(), overlayVersion: '6', overlaySha256: administrativeNativeOverlaySha256(record),
      storageReady: true, storageInitialized: true, image: { version: 1, ...source, fingerprint: 'c'.repeat(64) } };
  }
  return record;
}
function core(record: AdministrativeWorkspaceRecord, role: 'workspace' | 'agents'): InstanceBackupVolumeManifest {
  const owner = administrativeRuntimeOwner(record), legacy = administrativeWorkspaceResourceNames(record);
  const name = record.nativeRuntime ? record.nativeRuntime.name + '-' + role : role === 'workspace' ? legacy.workspaceVolume : legacy.agentsVolume;
  return { name, kind: role === 'workspace' ? 'admin-workspace' : 'admin-agent-data', archive: instanceVolumeArchiveName(name), sha256: 'd'.repeat(64), size: 100,
    ...(record.nativeRuntime ? { ownerId: owner.userId, workerId: record.id, runtime: { kind: 'incus-vm' as const, role, source,
      administrative: { kind: record.kind, workspaceId: record.id, ...(owner.groupId ? { groupId: owner.groupId } : {}) } } } : owner.groupId ? { ownerId: owner.userId } : {}),
    ...(owner.groupId ? { groupId: owner.groupId } : {}) };
}
function selected(record: AdministrativeWorkspaceRecord, attached = true): StoredManagedVolume {
  const id = randomUUID(), owner = administrativeRuntimeOwner(record);
  return { id, dockerName: 'agentor-persist-' + id, userId: owner.userId, workerId: record.id, target: '/srv/' + id,
    name: 'Selected data', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm', attached, seeded: true,
    state: attached ? 'ready' : 'detached', createdAt: stamp, updatedAt: stamp };
}
function managedDescriptor(record: AdministrativeWorkspaceRecord, volume: StoredManagedVolume): InstanceBackupVolumeManifest {
  const owner = administrativeRuntimeOwner(record);
  if (record.runtimeKind !== 'incus-vm') return { name: volume.dockerName, kind: 'persistent-path', ownerId: volume.userId, workerId: record.id,
    archive: instanceVolumeArchiveName(volume.dockerName), sha256: 'd'.repeat(64), size: 100 };
  return { name: volume.dockerName, kind: 'persistent-path', ownerId: owner.userId, workerId: owner.id,
    ...(owner.groupId ? { groupId: owner.groupId } : {}), archive: instanceVolumeArchiveName(volume.dockerName), sha256: 'd'.repeat(64), size: 100,
    runtime: { kind: 'incus-vm', role: 'managed', target: volume.target, managedVolumeId: volume.id,
      administrative: { kind: record.kind, workspaceId: record.id, ...(owner.groupId ? { groupId: owner.groupId } : {}) } } };
}
function manifest(volumes: InstanceBackupVolumeManifest[], version: 1 | 2 = 2): InstanceBackupManifest {
  return validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: version, backupId: 'admin-instance-fixture',
    sourceInstallationId: randomUUID(), createdByUserId: 'creator', createdAt: stamp, agentorVersion: 'test',
    storage: { mode: 'volume', containerPrefix: 'agentor-worker' }, options: { includeWorkers: true, includeAgentData: true,
      includeDockerVolumes: true, includeLogs: false, includeLocalBackups: false }, dataArchive: { archive: 'data.tar.gz', sha256: 'e'.repeat(64), size: 100 },
    volumes, plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
    hostMounts: { configuredPaths: [], contentsIncluded: false }, images: { definitions: 0, immutableDigests: [], layersIncluded: false }, excludedDataPaths: [] });
}

for (const group of [false, true]) for (const native of [false, true]) test(`dedicated ${group ? 'group' : 'global'} ${native ? 'tagged native' : 'historical Docker'} canonical data plans native recovery without WorkerStore authority`, () => {
  const r = record(group, native), m = manifest([core(r, 'workspace'), core(r, 'agents')], native ? 2 : 1);
  const before = structuredClone({ r, m }), plans = planInstanceAdministrativeRestore(m, [r], []);
  expect(plans).toHaveLength(1); expect(plans[0]!.legacySourceWrapper).toBe(!native); expect(plans[0]!.record).toEqual(r);
  expect({ r, m }).toEqual(before); plans[0]!.record.status = 'running'; expect(r.status).toBe('stopped');
});

test('native admin selected payloads include attached and detached data while fresh IDs reference attached only', () => {
  const r = record(), attached = selected(r), detached = selected(r, false); r.nativeRuntime!.selectedVolumeIds = [attached.id];
  const m = manifest([core(r, 'workspace'), core(r, 'agents'), managedDescriptor(r, attached), managedDescriptor(r, detached)]);
  const plan = planInstanceAdministrativeRestore(m, [r], [attached, detached])[0]!, fresh = freshInstanceAdministrativeRestore(plan);
  expect(fresh.nonce).not.toBe(r.nativeRuntime!.nonce); expect(fresh.managed.map(v => v.id)).not.toEqual([attached.id, detached.id]);
  expect(fresh.managed.map(v => [v.attached, v.seeded, v.state])).toEqual([[true, false, 'pending'], [false, false, 'pending']]);
  expect(plan.managed).toHaveLength(2); expect(attached.seeded).toBe(true);
});

for (const variant of ['old-uuid', 'private-nic', 'credentials', 'wrong-owner', 'wrong-kind', 'extra-tag-field', 'ordinary-role'] as const)
  test(`strict administrative portable schema rejects ${variant}`, () => {
    const r = record(), descriptor: any = core(r, 'workspace');
    if (variant === 'old-uuid') descriptor.runtime.incarnation = randomUUID();
    if (variant === 'private-nic') descriptor.runtime.address = '10.0.0.2';
    if (variant === 'credentials') descriptor.runtime.token = 'opaque';
    if (variant === 'wrong-owner') descriptor.ownerId = 'foreign';
    if (variant === 'wrong-kind') descriptor.runtime.administrative.kind = 'ordinary';
    if (variant === 'extra-tag-field') descriptor.runtime.administrative.trusted = true;
    if (variant === 'ordinary-role') descriptor.kind = 'worker-workspace';
    expect(() => manifest([descriptor])).toThrow('manifest');
  });

test('missing/forged/unfinished admin authority and omitted filesystem data fail before restore allocation', () => {
  const r = record(), m = manifest([core(r, 'workspace'), core(r, 'agents')]);
  for (const records of [[], [r, r], [{ ...r, trusted: false }], [{ ...r, status: 'running' }],
    [{ ...r, nativeRuntime: { ...r.nativeRuntime, pending: { kind: 'create' } } }]])
    expect(() => planInstanceAdministrativeRestore(m, records as any, [])).toThrow();
  expect(() => planInstanceAdministrativeRestore(m, [r], [], false)).toThrow('data');
  expect(() => planInstanceAdministrativeRestore({ ...m, volumes: m.volumes.slice(0,1) }, [r], [])).toThrow('missing');
  const v = selected(r); r.nativeRuntime!.selectedVolumeIds = [v.id];
  expect(() => planInstanceAdministrativeRestore(m, [r], [v])).toThrow('missing');
});

test('dedicated readers reject malformed global files and damaged owner groups without silently treating them absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-instance-read-'));
  try {
    await mkdir(join(root, 'admin'));
    for (const value of [null, false, {}, { ...record(), kind: 'ordinary' }]) {
      await writeFile(join(root, 'admin', 'workspace.v1.json'), JSON.stringify(value));
      await expect(readInstanceAdministrativeRecords(root)).rejects.toThrow();
    }
    const global = record(); await writeFile(join(root, 'admin', 'workspace.v1.json'), JSON.stringify(global));
    expect(await readInstanceAdministrativeRecords(root)).toEqual([global]);
    await mkdir(join(root, 'users', 'damaged'), { recursive: true }); await writeFile(join(root, 'users', 'damaged', 'worker-groups.json'), '{"wrong":true}');
    await expect(readInstanceAdministrativeRecords(root)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight produces fresh stopped native authority from only current approved image and refuses physical conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-instance-preflight-'));
  try {
    const installation = await backupInstallationId(root), r = record(), plan = planInstanceAdministrativeRestore(manifest([core(r,'workspace'),core(r,'agents')]), [r], [])[0]!;
    const fresh = freshInstanceAdministrativeRestore(plan), reads: string[] = [];
    const config = { dataDir: root, incusEnabled: true, incusEndpoint: 'https://fixture.invalid', incusProject: 'private',
      incusStoragePool: 'pool', incusClientCertPath: '/mock/cert', incusClientKeyPath: '/mock/key', incusServerCertPath: '/mock/server' } as Config;
    let conflict = false;
    const client: any = { getReadiness: async () => ({ ready: true, auth: 'trusted', project: 'private' }), request: async () => ({ config: { restricted: 'true', 'features.storage.volumes': 'true' } }),
      getInstance: async (name: string) => { reads.push(name); if (conflict) return {}; throw new IncusError('absent',404); },
      getCustomVolume: async (_pool: string, name: string) => { reads.push(name); throw new IncusError('absent',404); } };
    const currentImage = { ...r.nativeRuntime!.image, sourceImageId: 'sha256:' + 'f'.repeat(64), fingerprint: 'e'.repeat(64) };
    const next = await preflightInstanceAdministrativeRestore(config, plan, fresh, client, async () => currentImage);
    expect(next.status).toBe('stopped'); expect(next.runtimeKind).toBe('incus-vm'); expect(next.nativeRuntime!.incarnation).toBeUndefined();
    expect(next.nativeRuntime!.installationId).toBe(installation); expect(next.nativeRuntime!.nonce).toBe(fresh.nonce);
    expect(next.nativeRuntime!.image).toEqual(currentImage); expect(next.nativeRuntime!.nonce).not.toBe(r.nativeRuntime!.nonce);
    expect(reads).toHaveLength(3); conflict = true;
    await expect(preflightInstanceAdministrativeRestore(config, plan, fresh, client, async () => currentImage)).rejects.toThrow('already exists');
    expect(await readFile(join(root, 'backup-installation-id'), 'utf8')).toContain(installation);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { applyInstanceAdministrativeRestore, completeInstanceAdministrativeRestore, rollbackInstanceAdministrativeRestore,
  type InstanceAdministrativeRestoreReceipt } from '../../orchestrator/server/utils/instance-restore-administrative';

async function applyFixture(legacy: boolean, options: { group?: boolean; selected?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-instance-apply-'));
  await backupInstallationId(root); await mkdir(join(root, 'admin'), { recursive: true });
  const r = record(!!options.group, !legacy), groups = new WorkerGroupStore(root);
  let groupId: string | undefined;
  if (options.group) { const created = await groups.create('account-owner', 'Administrative restore fixture'); groupId = created.id; (r as any).groupId = groupId; }
  const managed = new ManagedVolumeStore(root);
  if (options.selected) {
    for (const attached of [true, false]) {
      const volume = selected(r, attached);
      if (legacy) Object.assign(volume, { userId: r.ownerId!, storageRuntimeKind: 'legacy-docker',
        ...(!attached ? { purpose: 'legacy-backup-path', dockerName: persistentPathVolumeName(r.id, volume.target) } : {}) });
      if (legacy && !attached) delete volume.storageRuntimeKind; // Historical adoptLegacy omitted the Docker selector.
      await managed.save(volume);
    }
  }
  const selectedRecords = managed.forWorker(legacy ? r.ownerId! : administrativeRuntimeOwner(r).userId, r.id);
  if (r.nativeRuntime) r.nativeRuntime.selectedVolumeIds = selectedRecords.filter(v => v.attached).map(v => v.id);
  if (groupId) await groups.update('account-owner', groupId, { adminWorkspace: r });
  else await writeFile(join(root, 'admin', 'workspace.v1.json'), JSON.stringify(r));
  const group = planInstanceAdministrativeRestore(manifest([core(r,'workspace'),core(r,'agents'), ...selectedRecords.map(v => managedDescriptor(r,v))], legacy ? 1 : 2), [r], selectedRecords)[0]!;
  const fresh = freshInstanceAdministrativeRestore(group), volumes = new Map<string, any>(), events: string[] = [];
  const currentImage = { version: 1 as const, ...source, fingerprint: 'e'.repeat(64) };
  const config = { dataDir: root, incusEnabled: true, incusEndpoint: 'https://fixture.invalid', incusProject: 'private',
    incusStoragePool: 'pool', incusClientCertPath: '/fixture/cert', incusClientKeyPath: '/fixture/key', incusServerCertPath: '/fixture/server' } as Config;
  let extractFails = false, deletionUnknown = false;
  const client: any = { getReadiness: async () => ({ ready: true, auth: 'trusted', project: 'private' }),
    request: async () => ({ config: { restricted: 'true', 'features.storage.volumes': 'true' } }),
    getInstance: async () => { throw new IncusError('absent',404); },
    getCustomVolume: async (_pool: string, name: string) => { const volume = volumes.get(name); if (!volume) throw new IncusError('absent',404); return structuredClone(volume); },
    createCustomVolume: async (_pool: string, spec: any) => { events.push('allocate-volume'); volumes.set(spec.name, {
      ...structuredClone(spec), config: Object.fromEntries(Object.entries(spec.config).filter(([, value]) => value !== '')), type: 'custom', project: 'private', used_by: [], created_at: stamp }); },
    deleteCustomVolume: async (_pool: string, name: string) => { events.push('remove-volume'); volumes.delete(name); if (deletionUnknown) throw Error('lost deletion acknowledgement'); },
    createInstance: async () => { throw Error('No admin compute during filesystem recovery'); },
    startInstance: async () => { throw Error('No service or credential provisioning during filesystem recovery'); } };
  const receipt: InstanceAdministrativeRestoreReceipt = { managed: [], volumes: new Map(), unsettled: false };
  const archives = new Map(group.core.agents ? [[group.core.workspace.name,'verified-workspace.raw'],[group.core.agents.name,'verified-agents.raw']] : []);
  for (const [i, item] of group.managed.entries()) archives.set(item.descriptor.name, 'verified-managed-' + i + '.raw');
  const run = () => applyInstanceAdministrativeRestore({ config, group, fresh, archives, receipt, client, resolveImage: async () => currentImage,
    validateJob: async () => {}, restore: async (_config, _client, captured, payloads, validate) => {
      events.push('extract'); await validate(); const persisted = (await readInstanceAdministrativeRecords(root))[0]!;
      expect(persisted.runtimeKind).toBe('incus-vm'); expect(persisted.status).toBe('stopped');
      expect(persisted.nativeRuntime!.pending).toEqual({ kind: 'create' }); expect(persisted.nativeRuntime!.incarnation).toBeUndefined();
      expect(captured.nativeRuntime!.pending).toBeUndefined(); expect(payloads.legacySourceWrapper).toBe(legacy || undefined);
      expect(payloads.workspace).toBe('verified-workspace.raw'); expect(payloads.agents).toBe('verified-agents.raw');
      expect(payloads.managed.map(v => v.record.id)).toEqual(fresh.managed.map(v => v.id));
      expect(persisted.nativeRuntime!.selectedVolumeIds).toEqual(fresh.managed.filter(v => v.attached).map(v => v.id));
      if (extractFails) throw Error('unsettled writer'); await validate();
    } });
  return { root, r, config, client, receipt, fresh, currentImage, volumes, events, run,
    failExtract: () => { extractFails = true; }, failDelete: () => { deletionUnknown = true; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const legacy of [false, true]) test(`controlled apply installs ${legacy ? 'historical Docker' : 'native'} admin canonical data with fresh stopped authority and no compute`, async () => {
  const f = await applyFixture(legacy); try {
    await f.run(); expect(f.events).toEqual(['allocate-volume','allocate-volume','extract']);
    const installed = (await readInstanceAdministrativeRecords(f.root))[0]!;
    expect(installed.nativeRuntime!.storageReady).toBe(true); expect(installed.nativeRuntime!.storageInitialized).toBe(true);
    expect(installed.nativeRuntime!.nonce).toBe(f.fresh.nonce); expect(installed.nativeRuntime!.incarnation).toBeUndefined();
    expect(installed.nativeRuntime!.nonce).not.toBe(f.r.nativeRuntime?.nonce); expect(installed.nativeRuntime!.image).toEqual(f.currentImage);
    expect(installed.nativeRuntime!.pending).toEqual({ kind: 'create' });
    await completeInstanceAdministrativeRestore(f.config, f.receipt);
    const terminal = (await readInstanceAdministrativeRecords(f.root))[0]!;
    expect(terminal.nativeRuntime!.pending).toBeUndefined(); expect(terminal.status).toBe('stopped'); expect(terminal.nativeRuntime!.incarnation).toBeUndefined();
    expect([...f.volumes.values()].every(volume => volume.config['user.agentor.admin-storage-nonce'] === f.fresh.nonce)).toBe(true);
  } finally { await f.cleanup(); }
});

test('unknown writer and deletion results retain dedicated recovery fences and never replay cleanup', async () => {
  for (const variant of ['writer','delete']) {
    const f = await applyFixture(false); try {
      if (variant === 'writer') { f.failExtract(); await expect(f.run()).rejects.toThrow('unsettled writer'); }
      else { await f.run(); f.failDelete(); await expect(rollbackInstanceAdministrativeRestore(f.config, f.receipt, async () => {}, f.client)).rejects.toThrow('lost deletion'); }
      expect(f.receipt.unsettled).toBe(true); const before = [...f.events];
      await expect(rollbackInstanceAdministrativeRestore(f.config, f.receipt, async () => {}, f.client)).rejects.toThrow('Unsettled');
      expect(f.events).toEqual(before); expect((await readInstanceAdministrativeRecords(f.root))[0]!.nativeRuntime!.pending).toEqual({ kind: 'create' });
      await expect(completeInstanceAdministrativeRestore(f.config, f.receipt)).rejects.toThrow('unsettled');
    } finally { await f.cleanup(); }
  }
});

test('known settled rollback deletes only exact acknowledged fresh admin storage and preserves the dedicated fence until DATA rollback', async () => {
  const f = await applyFixture(false); try {
    await f.run(); await rollbackInstanceAdministrativeRestore(f.config, f.receipt, async () => {}, f.client);
    expect(f.volumes.size).toBe(0); expect(f.receipt.volumes.size).toBe(0);
    expect(f.events.filter(event => event === 'remove-volume')).toHaveLength(2);
    expect((await readInstanceAdministrativeRecords(f.root))[0]!.nativeRuntime!.pending).toEqual({ kind: 'create' });
  } finally { await f.cleanup(); }
});

import { IncusAdminWorkspaceStorage } from '../../orchestrator/server/utils/incus-admin-workspace-storage';
for (const group of [false,true]) for (const legacy of [false,true]) test(`controlled ${group ? 'group' : 'global'} ${legacy ? 'historical' : 'native'} apply restores fresh selected IDs and preserves detached data outside active references`, async () => {
  const f = await applyFixture(legacy, { group, selected: true }); try {
    await f.run(); expect(f.volumes.size).toBe(4);
    await completeInstanceAdministrativeRestore(f.config, f.receipt);
    const r = (await readInstanceAdministrativeRecords(f.root))[0]!, owner = administrativeRuntimeOwner(r);
    const store = new ManagedVolumeStore(f.root); await store.init();
    const selected = store.forWorker(owner.userId, owner.id); expect(selected).toHaveLength(2);
    expect(selected.every(v => v.seeded)).toBe(true); expect(selected.map(v => v.state).sort()).toEqual(['detached','ready']);
    expect(r.nativeRuntime!.selectedVolumeIds).toEqual(selected.filter(v => v.attached).map(v => v.id));
    const storage = new IncusAdminWorkspaceStorage(f.config, f.client, async () => store);
    const devices = await storage.devices(r, r.nativeRuntime!, false);
    const sources = Object.values(devices).map(device => device.source);
    expect(sources).toContain(selected.find(v => v.attached)!.dockerName);
    expect(sources).not.toContain(selected.find(v => !v.attached)!.dockerName);
    expect(r.status).toBe('stopped'); expect(r.nativeRuntime!.incarnation).toBeUndefined();
  } finally { await f.cleanup(); }
});


for (const group of [false,true]) test(`historical ${group ? 'group' : 'global'} selected roles require exact old owner, records and known legacy naming`, () => {
  const r = record(group,false), volume = { ...selected(r), userId: r.ownerId!, storageRuntimeKind: 'legacy-docker' as const };
  const descriptor = managedDescriptor(r, volume), m = manifest([core(r,'workspace'),core(r,'agents'),descriptor],1);
  expect(planInstanceAdministrativeRestore(m,[r],[volume])[0]!.managed[0]!.record).toEqual(volume);
  for (const broken of [{...volume,userId:'foreign'}, {...volume,dockerName:'agentor-persist-foreign'}, {...volume,liveContainerId:'foreign'},
      {...volume,operation:{id:randomUUID(),mode:'deferred',stage:'queued'}}, {...volume,storageRuntimeKind:'incus-vm'}])
    expect(() => planInstanceAdministrativeRestore(m,[r],[broken as any])).toThrow();
  for (const changed of [{...descriptor,ownerId:'foreign'}, {...descriptor,workerId:randomUUID()}, {...descriptor,groupId:'invented'}])
    expect(() => planInstanceAdministrativeRestore(manifest([core(r,'workspace'),core(r,'agents'),changed],1),[r],[volume])).toThrow();
  expect(() => planInstanceAdministrativeRestore(m,[r],[])).toThrow('no unique');
  expect(() => planInstanceAdministrativeRestore(m,[r],[volume,volume])).toThrow();
  expect(() => planInstanceAdministrativeRestore(m,[r],[{...volume,target:'/etc'}])).toThrow();
  if(!group) expect(() => planInstanceAdministrativeRestore(m,[{...r,ownerId:undefined}],[volume])).toThrow('recorded owner');
  expect(() => planInstanceAdministrativeRestore({...m,volumes:m.volumes.slice(0,2)},[r],[volume])).toThrow('missing');
});
