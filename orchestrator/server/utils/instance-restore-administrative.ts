import Docker from 'dockerode';
import { fileURLToPath } from 'node:url';
import { resolveAdministrativeNativeBase } from './admin-native-image';
import { withOperationDeadline } from './operation-deadline';
import { remapAdministrativeOwnerMetadata } from './admin-owner-metadata-remap';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Config } from './config';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner, adminNativeInstanceName, validateAdminNativeState } from './admin-native-identity';
import { administrativeNativeOverlaySha256 } from './incus-admin-overlay';
import { IncusAdminWorkspaceStorage } from './incus-admin-workspace-storage';
import { IncusClient, IncusError, type IncusCustomVolume } from './incus-client';

import { WorkerGroupStore } from './worker-group-store';
import { ManagedVolumeStore, assertIncusLiveResolved, type StoredManagedVolume } from './managed-volume-store';
import { validateInstanceManifest } from './instance-backup-bundle';
import type { InstanceBackupVolumeManifest } from './instance-backup-types';
import { snapshotIncusWorkerBackupRuntime, type WorkerBackupRuntimeSource } from './worker-backup-runtime';
import { administrativeWorkspaceResourceNames } from './admin-workspace-resources';
import { readBackupInstallationId } from './backup-installation';
import { incusManagedRestoreDevices } from './incus-managed-volume-runtime';
import { restoreAdministrativeArchives } from './incus-admin-restore';

const durable = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const safe = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
async function globalRecord(dataDir: string): Promise<AdministrativeWorkspaceRecord | undefined> {
  let file;
  try { file = await open(join(dataDir, 'admin', 'workspace.v1.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Invalid staged administrative record');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

/** Fresh dedicated readers: no ensure/create, ordinary shadows or app singleton. */
export async function readInstanceAdministrativeRecords(dataDir: string): Promise<AdministrativeWorkspaceRecord[]> {
  const records: AdministrativeWorkspaceRecord[] = [], global = await globalRecord(dataDir);
  if (global !== undefined) records.push(global);
  const groups = new WorkerGroupStore(dataDir);
  const owners = await readdir(join(dataDir, 'users')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const owner of owners) {
    if (!safe(owner)) throw new Error('Invalid staged administrative owner partition');
    await groups.loadUser(owner); // Explicit strict read: quarantine is not absence.
  }
  for (const group of groups.list()) if (group.adminWorkspace) {
    const record = group.adminWorkspace as AdministrativeWorkspaceRecord;
    const owner = administrativeRuntimeOwner(record);
    if (owner.kind !== 'group-administrative' || owner.userId !== group.userId || owner.groupId !== group.id)
      throw new Error('Staged administrative group authority differs');
    records.push(record);
  }
  const ids = new Set<string>();
  for (const record of records) {
    administrativeRuntimeOwner(record); validateAdminNativeState(record);
    if (!['running', 'stopped'].includes(record.status) || ids.has(record.id)) throw new Error('Invalid or duplicate staged administrative record');
    ids.add(record.id);
  }
  if (global && global.kind !== 'administrative') throw new Error('Invalid staged global administrative authority');
  return records;
}

export interface InstanceAdministrativeRestoreGroup {
  record: AdministrativeWorkspaceRecord;
  core: { workspace: InstanceBackupVolumeManifest; agents?: InstanceBackupVolumeManifest };
  managed: Array<{ record: StoredManagedVolume; descriptor: InstanceBackupVolumeManifest }>;
  legacySourceWrapper: boolean;
  source?: WorkerBackupRuntimeSource;
}

/** Joins only dedicated trusted records. Historical Docker admin bytes become
 * fresh native storage; descriptive native UUIDs/nonces never grant authority. */
export function planInstanceAdministrativeRestore(manifestValue: unknown, records: AdministrativeWorkspaceRecord[],
  managed: StoredManagedVolume[], restoreFilesystemData = true): InstanceAdministrativeRestoreGroup[] {
  const manifest = validateInstanceManifest(manifestValue), result: InstanceAdministrativeRestoreGroup[] = [], consumed = new Set<string>();
  const ids = new Set<string>();
  for (const record of records) {
    const owner = administrativeRuntimeOwner(record); validateAdminNativeState(record);
    if (ids.has(record.id) || record.status !== 'stopped' || record.nativeRuntime?.pending || record.nativeRuntime?.deleting || record.nativeRuntime?.selectedOperation ||
        record.nativeMigration && record.nativeMigration.phase !== 'retained') throw new Error('Resolve administrative lifecycle before instance restore');
    ids.add(record.id);
    const native = record.runtimeKind === 'incus-vm';
    if (native && (!record.nativeRuntime?.incarnation || !record.nativeRuntime.storageReady || !record.nativeRuntime.storageInitialized))
      throw new Error('Staged administrative canonical storage is incomplete');
    const legacy = administrativeWorkspaceResourceNames(record);
    const logical = native ? { workspace: record.nativeRuntime!.name + '-workspace', agents: record.nativeRuntime!.name + '-agents' }
      : { workspace: legacy.workspaceVolume, agents: legacy.agentsVolume };
    const core: Partial<InstanceAdministrativeRestoreGroup['core']> = {};
    for (const role of ['workspace', 'agents'] as const) {
      const descriptor = manifest.volumes.find(volume => volume.name === logical[role]);
      if (!descriptor) continue;
      const runtime = descriptor.runtime;
      if (descriptor.kind !== (role === 'workspace' ? 'admin-workspace' : 'admin-agent-data') ||
          (native ? !runtime || !('administrative' in runtime) || runtime.administrative.workspaceId !== record.id ||
            runtime.administrative.kind !== record.kind || runtime.administrative.groupId !== owner.groupId ||
            runtime.role !== role || descriptor.ownerId !== owner.userId || descriptor.workerId !== owner.id
            : runtime !== undefined || descriptor.workerId !== undefined || descriptor.ownerId !== (owner.groupId ? owner.userId : undefined) ||
              descriptor.groupId !== owner.groupId)) throw new Error('Administrative canonical descriptor has no exact dedicated authority');
      core[role] = descriptor; consumed.add(descriptor.name);
    }
    if (!restoreFilesystemData || !manifest.options.includeDockerVolumes || !manifest.options.includeWorkers || !core.workspace ||
        manifest.options.includeAgentData && !core.agents) throw new Error('Administrative canonical data is missing from the instance backup');
    const selected = managed.filter(volume => volume.workerId === owner.id);
    const entries: InstanceAdministrativeRestoreGroup['managed'] = [];
    for (const volume of selected) {
      assertIncusLiveResolved(volume);
      if (volume.userId === owner.userId && volume.storageRuntimeKind === 'incus-vm' && !volume.attached && !volume.seeded &&
          ['pending', 'detached'].includes(volume.state) && !volume.operation && !volume.incusLive && !volume.liveContainerId) continue;
      if (!native || volume.userId !== owner.userId || volume.storageRuntimeKind !== 'incus-vm' || !volume.seeded ||
          volume.state !== (volume.attached ? 'ready' : 'detached') || volume.incusLive || volume.liveContainerId ||
          volume.previousRestartPolicy || volume.operation && volume.operation.stage !== 'complete')
        throw new Error('Administrative selected storage is incomplete or has legacy authority');
      const descriptor = manifest.volumes.find(item => item.name === volume.dockerName), runtime = descriptor?.runtime;
      if (!descriptor || !runtime || !('administrative' in runtime) || runtime.role !== 'managed' ||
          runtime.administrative.workspaceId !== owner.id || runtime.administrative.kind !== owner.kind || runtime.administrative.groupId !== owner.groupId ||
          descriptor.ownerId !== owner.userId || runtime.managedVolumeId !== volume.id || runtime.target !== volume.target)
        throw new Error('Administrative selected data is missing or mismatched');
      entries.push({ record: structuredClone(volume), descriptor }); consumed.add(descriptor.name);
    }
    if (native && !isDeepStrictEqual([...(record.nativeRuntime!.selectedVolumeIds ?? [])].sort(), selected.filter(v => v.attached).map(v => v.id).sort()))
      throw new Error('Administrative selected references differ from staged storage');
    const layout = entries.map(item => ({ ...item.record, operation: undefined }));
    incusManagedRestoreDevices({ id: owner.id, userId: owner.userId }, '', layout.filter(v => v.attached), layout.filter(v => !v.attached));
    const source = core.workspace.runtime && 'source' in core.workspace.runtime ? core.workspace.runtime.source : undefined;
    if (core.agents?.runtime && 'source' in core.agents.runtime && !isDeepStrictEqual(source, core.agents.runtime.source))
      throw new Error('Administrative canonical immutable sources disagree');
    if (source && !isDeepStrictEqual(source, snapshotIncusWorkerBackupRuntime(record.nativeRuntime!.image).source))
      throw new Error('Administrative canonical source differs from its dedicated record');
    result.push({ record: structuredClone(record), core: core as InstanceAdministrativeRestoreGroup['core'], managed: entries,
      legacySourceWrapper: !native, source });
  }
  if (manifest.volumes.some(volume => (volume.kind === 'admin-workspace' || volume.kind === 'admin-agent-data' ||
      volume.runtime && 'administrative' in volume.runtime) && !consumed.has(volume.name)))
    throw new Error('Administrative descriptor has no unique dedicated trusted record');
  return result;
}

async function writeRecord(dataDir: string, before: AdministrativeWorkspaceRecord, next: AdministrativeWorkspaceRecord): Promise<void> {
  administrativeRuntimeOwner(next); validateAdminNativeState(next);
  if (before.kind === 'administrative') {
    if (!isDeepStrictEqual(await globalRecord(dataDir), before)) throw new Error('Administrative restore record authority changed');
    const path = join(dataDir, 'admin', 'workspace.v1.json'), temp = path + '.restore-' + randomUUID();
    await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 }); await rename(temp, path);
  } else {
    const owner = administrativeRuntimeOwner(before), groups = new WorkerGroupStore(dataDir); await groups.loadUser(owner.userId);
    const group = groups.get(owner.userId, owner.groupId!);
    if (!isDeepStrictEqual(group?.adminWorkspace, before)) throw new Error('Administrative group restore authority changed');
    await groups.update(owner.userId, owner.groupId!, { adminWorkspace: structuredClone(next) });
  }
}

export interface InstanceAdministrativeRestoreReceipt {
  record?: AdministrativeWorkspaceRecord;
  original?: AdministrativeWorkspaceRecord;
  managed: StoredManagedVolume[];
  volumes: Map<string, IncusCustomVolume>;
  unsettled: boolean;
}

/** Fresh image is authorized only by current operator configuration. Portable
 * image fingerprints, old native nonces and network metadata are ignored. */
export async function preflightInstanceAdministrativeRestore(config: Config, group: InstanceAdministrativeRestoreGroup,
  fresh: { nonce: string; managed: StoredManagedVolume[] }, client = IncusClient.fromConfig(config),
  resolveImage = async () => {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const source = await withOperationDeadline<Docker.ImageInspectInfo>(async signal => (docker.getImage(config.workerImagePrefix + config.workerImage) as any)
      .inspect({ abortSignal: signal }), 8_000, 'Approved administrative OCI image inspection');
    return resolveAdministrativeNativeBase(config, client, source.Id, fileURLToPath(new URL('../incus-bootstrap', import.meta.url)));
  }) {
  if (!config.incusEnabled || !config.incusEndpoint.startsWith('https://') || !config.incusStoragePool ||
      !config.incusProject || config.incusProject === 'default' || !config.incusClientCertPath || !config.incusClientKeyPath || !config.incusServerCertPath)
    throw new Error('Administrative native restore requires restricted configured Incus mTLS');
  const readiness = await client.getReadiness();
  if (!readiness.ready || readiness.auth !== 'trusted' || readiness.project !== config.incusProject)
    throw new Error('Administrative native restore destination is unavailable');
  const project = await client.request<{ config: Record<string,string> }>('GET', '/1.0/projects/' + encodeURIComponent(config.incusProject));
  if (project.config.restricted !== 'true' || project.config['features.storage.volumes'] !== 'true')
    throw new Error('Administrative native restore requires restricted private storage');
  const image = await resolveImage();
  // Canonical bytes restore onto the current approved disposable base. The
  // historical image describes provenance, never image execution authority.
  const record: AdministrativeWorkspaceRecord = { ...structuredClone(group.record), status: 'stopped' as const, runtimeKind: 'incus-vm' as const,
    nativeMigration: undefined, nativeRuntime: { version: 1 as const, name: adminNativeInstanceName(group.record),
      installationId: await readBackupInstallationId(config.dataDir), nonce: fresh.nonce, image, overlayVersion: '6' as const,
      overlaySha256: administrativeNativeOverlaySha256(group.record), selectedVolumeIds: fresh.managed.filter(v => v.attached).map(v => v.id),
      pending: { kind: 'create' as const } } };
  validateAdminNativeState(record);
  if ([group.record.nativeRuntime?.nonce, group.record.nativeRuntime?.incarnation, group.record.nativeMigration?.nonce].includes(fresh.nonce))
    throw new Error('Administrative restore cannot reuse source private authority');
  const absent = async (load: () => Promise<unknown>) => {
    try { await load(); } catch (error) { if (error instanceof IncusError && error.statusCode === 404) return; throw error; }
    throw new Error('Administrative restore destination already exists');
  };
  await absent(() => client.getInstance(record.nativeRuntime!.name));
  if (fresh.managed.length !== group.managed.length || fresh.managed.some((v, i) =>
      group.managed.some(item => item.record.id === v.id) || v.userId !== administrativeRuntimeOwner(record).userId || v.workerId !== record.id ||
      v.dockerName !== 'agentor-persist-' + v.id || v.target !== group.managed[i]!.record.target ||
      v.attached !== group.managed[i]!.record.attached || v.seeded || v.state !== 'pending' || v.operation))
    throw new Error('Administrative restore requires fresh exact selected identities');
  incusManagedRestoreDevices({ id: record.id, userId: administrativeRuntimeOwner(record).userId }, config.incusStoragePool,
    fresh.managed.filter(v => v.attached), fresh.managed.filter(v => !v.attached));
  const storage = new IncusAdminWorkspaceStorage(config, client, async () => { const store = new ManagedVolumeStore(config.dataDir); await store.init(); return store; });
  for (const name of [...Object.values(storage.names(record.nativeRuntime!)), ...fresh.managed.map(v => v.dockerName)])
    await absent(() => client.getCustomVolume(config.incusStoragePool, name));
  return record;
}

export function freshInstanceAdministrativeRestore(group: InstanceAdministrativeRestoreGroup) {
  const owner = administrativeRuntimeOwner(group.record), stamp = new Date().toISOString();
  return { nonce: randomUUID(), managed: group.managed.map(({ record }) => {
    const id = randomUUID();
    return { ...structuredClone(record), id, userId: owner.userId, workerId: owner.id, dockerName: 'agentor-persist-' + id,
      operation: undefined, seeded: false, state: 'pending' as const, createdAt: stamp, updatedAt: stamp };
  }) };
}

export async function applyInstanceAdministrativeRestore(input: { config: Config; group: InstanceAdministrativeRestoreGroup;
  fresh: ReturnType<typeof freshInstanceAdministrativeRestore>; archives: ReadonlyMap<string, string>;
  receipt: InstanceAdministrativeRestoreReceipt; validateJob: () => Promise<void>;
  client?: IncusClient; resolveImage?: () => Promise<import('./incus-worker-image').IncusWorkerImageIdentity>;
  restore?: typeof restoreAdministrativeArchives }) {
  const { config, group, fresh, archives, receipt, validateJob } = input, client = input.client ?? IncusClient.fromConfig(config);
  if (receipt.record || receipt.unsettled || receipt.volumes.size) throw new Error('Administrative restore cannot be replayed');
  await validateJob();
  const record = durable(await preflightInstanceAdministrativeRestore(config, group, fresh, client, input.resolveImage)), owner = administrativeRuntimeOwner(record);
  receipt.original = structuredClone(group.record);
  await writeRecord(config.dataDir, group.record, record); receipt.record = structuredClone(record);
  const managed = new ManagedVolumeStore(config.dataDir); await managed.init();
  for (let i = 0; i < group.managed.length; i++) {
    const old = group.managed[i]!.record;
    if (!isDeepStrictEqual(managed.get(old.userId, old.id), old)) throw new Error('Administrative selected restore record changed');
    await managed.save(fresh.managed[i]!); await managed.forget(old.userId, old.id);
  }
  receipt.managed = durable(managed.forWorker(owner.userId, owner.id));
  const validate = async () => {
    await validateJob();
    const records = await readInstanceAdministrativeRecords(config.dataDir), store = new ManagedVolumeStore(config.dataDir); await store.init();
    if (!isDeepStrictEqual(records.find(v => v.id === owner.id), receipt.record) ||
        !isDeepStrictEqual(store.forWorker(owner.userId, owner.id).sort((a,b) => a.id.localeCompare(b.id)), [...receipt.managed].sort((a,b) => a.id.localeCompare(b.id))))
      throw new Error('Administrative installed restore authority changed');
  };
  const storage = new IncusAdminWorkspaceStorage(config, client, async () => { const store = new ManagedVolumeStore(config.dataDir); await store.init(); return store; }), native = record.nativeRuntime!;
  const specs = [...(['workspace', 'agents'] as const).map(role => ({ name: storage.names(native)[role], config: storage.metadata(record, native, role) })),
    ...fresh.managed.map(v => ({ name: v.dockerName, config: { 'user.agentor.installation': native.installationId,
      'user.agentor.owner': owner.userId, 'user.agentor.id': owner.id, 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target } }))];
  for (const spec of specs) {
    await validate(); receipt.unsettled = true;
    await client.createCustomVolume(config.incusStoragePool, { ...spec, content_type: 'filesystem' });
    const created = await client.getCustomVolume(config.incusStoragePool, spec.name);
    if (created.name !== spec.name || created.project !== config.incusProject || created.type !== 'custom' || created.content_type !== 'filesystem' ||
        !Number.isFinite(Date.parse(created.created_at)) || !Array.isArray(created.used_by) || created.used_by.length ||
        Object.entries(spec.config).some(([key,value]) => created.config[key] !== value)) throw new Error('Administrative storage create acknowledgement differs');
    receipt.volumes.set(spec.name, structuredClone(created)); receipt.unsettled = false;
  }
  const payload = (descriptor?: InstanceBackupVolumeManifest) => {
    const path = descriptor && archives.get(descriptor.name);
    if (descriptor && !path) throw new Error('Administrative verified restore payload is missing'); return path;
  };
  receipt.unsettled = true;
  await (input.restore ?? restoreAdministrativeArchives)(config, client, { ...record, nativeRuntime: { ...native, pending: undefined } }, {
    workspace: payload(group.core.workspace)!, agents: payload(group.core.agents), legacySourceWrapper: group.legacySourceWrapper || undefined,
    managed: fresh.managed.map((record, i) => ({ record, archivePath: payload(group.managed[i]!.descriptor)! })) }, validate);
  receipt.unsettled = false;
  for (const record of fresh.managed) await managed.save({ ...record, seeded: true, state: record.attached ? 'ready' : 'detached' });
  receipt.managed = durable(managed.forWorker(owner.userId, owner.id));
  await validate();
  const initialized = { ...record, nativeRuntime: { ...native, storageReady: true as const, storageInitialized: true as const } };
  await writeRecord(config.dataDir, receipt.record!, initialized); receipt.record = structuredClone(initialized);
  await remapAdministrativeOwnerMetadata(config.dataDir, receipt.record, join(config.dataDir, 'admin', 'native-owner-remap-' + fresh.nonce), validate);
}

/** Clear only the whole-job fence after terminal success; admin intent remains
 * stopped and no source UUID, compute, NIC or management credential is adopted. */
export async function completeInstanceAdministrativeRestore(config: Config, receipt: InstanceAdministrativeRestoreReceipt) {
  if (!receipt.record || receipt.unsettled || !receipt.record.nativeRuntime?.storageInitialized)
    throw new Error('Administrative native restore is unsettled');
  const record = durable({ ...receipt.record, nativeRuntime: { ...receipt.record.nativeRuntime, pending: undefined } });
  await writeRecord(config.dataDir, receipt.record, record); receipt.record = structuredClone(record);
}

/** Known exact acknowledgements only; ambiguity retains installed fences and
 * DATA rollback. Never adopt a same-named resource to manufacture deletion. */
export async function rollbackInstanceAdministrativeRestore(config: Config, receipt: InstanceAdministrativeRestoreReceipt,
  validateJob: () => Promise<void>, client = IncusClient.fromConfig(config)) {
  if (!receipt.record) return;
  if (receipt.unsettled) throw new Error('Unsettled administrative restore retains installed data and authority');
  for (const [name, baseline] of [...receipt.volumes].reverse()) {
    await validateJob();
    const records = await readInstanceAdministrativeRecords(config.dataDir);
    if (!isDeepStrictEqual(records.find(v => v.id === receipt.record!.id), receipt.record)) throw new Error('Administrative rollback authority changed');
    const current = await client.getCustomVolume(config.incusStoragePool, name);
    if (!isDeepStrictEqual(current, baseline)) throw new Error('Administrative rollback storage authority changed');
    receipt.unsettled = true;
    await client.deleteCustomVolume(config.incusStoragePool, name);
    try { await client.getCustomVolume(config.incusStoragePool, name); throw new Error('Administrative rollback deletion unconfirmed'); }
    catch (error) { if (!(error instanceof IncusError) || error.statusCode !== 404) throw error; }
    receipt.unsettled = false; receipt.volumes.delete(name);
  }
}

export async function refenceInstanceAdministrativeRestore(config: Config, receipt: InstanceAdministrativeRestoreReceipt) {
  if (!receipt.record) return;
  const record = durable({ ...receipt.record, nativeRuntime: { ...receipt.record.nativeRuntime!, pending: { kind: 'create' as const } } });
  await writeRecord(config.dataDir, receipt.record, record); receipt.record = structuredClone(record);
}
