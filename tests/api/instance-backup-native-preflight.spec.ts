import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { InstanceBackupStore } from '../../orchestrator/server/utils/instance-backup-store';
import { instanceVolumeArchiveName, validateInstanceManifest } from '../../orchestrator/server/utils/instance-backup-bundle';
import { IncusClient, IncusError, type IncusCustomVolume, type IncusInstance } from '../../orchestrator/server/utils/incus-client';
import { useConfig, useIncusClient, useStorageManager, useWorkerStore, useContainerManager,
  useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import type { InstanceBackupManifest, InstanceBackupVolumeManifest } from '../../orchestrator/server/utils/instance-backup-types';

const stamp = '2026-10-05T12:00:00.000Z';
const source = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
  architecture: 'amd64' as const, converterVersion: '0.4.0', bootstrapGeneration: '3' as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'instance-native-preflight-'));
  const restorers: Array<() => void> = [];
  function patch<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]) {
    const owned = Object.hasOwn(obj, key), before = obj[key]; obj[key] = value;
    restorers.push(() => { if (owned) obj[key] = before; else delete obj[key]; });
  }
  const oldRecoveryMode = process.env.AGENTOR_INSTANCE_RECOVERY_MODE;
  process.env.AGENTOR_INSTANCE_RECOVERY_MODE = 'true';
  restorers.push(() => { if (oldRecoveryMode === undefined) delete process.env.AGENTOR_INSTANCE_RECOVERY_MODE;
    else process.env.AGENTOR_INSTANCE_RECOVERY_MODE = oldRecoveryMode; });
  const config = useConfig(), client = useIncusClient();
  patch(config, 'containerPrefix', 'preflight-worker'); patch(config, 'incusEnabled', true);
  patch(config, 'incusEndpoint', 'https://configured-incus.invalid:8443');
  patch(config, 'incusProject', 'configured-project'); patch(client, 'project', config.incusProject);
  patch(config, 'incusStoragePool', 'configured-pool'); patch(config, 'incusNetwork', 'configured-network');
  patch(config, 'incusClientCertPath', '/operator/tls/client.crt');
  patch(config, 'incusClientKeyPath', '/operator/tls/client.key');
  patch(config, 'incusServerCertPath', '/operator/tls/server.crt');
  patch(config, 'incusInternalGatewayUrl', 'http://configured-gateway.invalid:3000');
  patch(useStorageManager(), 'init', async () => {}); patch(useStorageManager(), 'mode', 'directory');
  patch(useWorkerStore(), 'list', () => []); patch(useContainerManager(), 'list', () => []);
  patch(useWorkerGroupStore(), 'list', () => []); patch(useAdminWorkspaceStore(), 'getRecord', () => undefined);
  const workerId = randomUUID(), name = config.containerPrefix + '-' + workerId;
  const managedId = randomUUID(), managedName = 'agentor-persist-' + managedId;
  const calls: string[] = [], presentVolumes = new Set<string>(), presentInstances = new Set<string>();
  const state = { dockerNames: [] as string[], lookupError: undefined as Error | undefined,
    trusted: true, restricted: true, pool: true, network: true, returnedProject: config.incusProject };
  patch(client, 'getReadiness', async () => {
    calls.push('ready'); return { ready: state.trusted, auth: state.trusted ? 'trusted' : 'untrusted',
      project: state.returnedProject, serverVersion: '6.0.6', driver: 'qemu' };
  });
  patch(client, 'request', async <T>(_method: string, path: string): Promise<T> => {
    calls.push(path);
    if (path === '/1.0/projects/' + encodeURIComponent(config.incusProject))
      return { name: config.incusProject, config: { restricted: String(state.restricted),
        'features.storage.volumes': 'true', 'restricted.devices.nic': 'managed',
        'restricted.networks.access': config.incusNetwork }, used_by: [] } as T;
    if (path === '/1.0/storage-pools/' + encodeURIComponent(config.incusStoragePool)) {
      if (!state.pool) throw new IncusError('Missing configured pool', 404);
      return { name: config.incusStoragePool, driver: 'dir', config: {} } as T;
    }
    throw new Error('Unexpected native preflight request: ' + path);
  });
  patch(client, 'getNetwork', async requested => {
    calls.push('network:' + requested); expect(requested).toBe(config.incusNetwork);
    if (!state.network) throw new IncusError('Missing configured network', 404);
    return { name: requested, type: 'bridge', managed: true, config: { 'ipv4.address': 'auto', 'ipv6.address': 'none' } };
  });
  patch(client, 'getInstance', async requested => {
    calls.push('instance:' + requested); expect(requested).toBe(name);
    if (state.lookupError) throw state.lookupError;
    if (!presentInstances.has(requested)) throw new IncusError('Absent exact compute', 404);
    return { name: requested, description: '', status: 'Stopped', status_code: 102, type: 'virtual-machine',
      architecture: 'x86_64', ephemeral: false, profiles: [], config: {}, devices: {} } satisfies IncusInstance;
  });
  patch(client, 'getCustomVolume', async (pool, requested) => {
    calls.push('volume:' + requested); expect(pool).toBe(config.incusStoragePool);
    expect([name + '-workspace', name + '-agents', name + '-docker', managedName]).toContain(requested);
    if (state.lookupError) throw state.lookupError;
    if (!presentVolumes.has(requested)) throw new IncusError('Absent exact storage', 404);
    return { name: requested, type: 'custom', content_type: 'filesystem', description: '', config: {},
      used_by: [], created_at: stamp, project: config.incusProject } satisfies IncusCustomVolume;
  });
  const store = new InstanceBackupStore(root); await store.init();
  const docker = { listVolumes: async () => { calls.push('docker-volumes');
    return { Volumes: state.dockerNames.map(Name => ({ Name })) }; } };
  const manager = new InstanceBackupManager({ dataDir: root, store, docker: docker as never });
  const core = (): InstanceBackupVolumeManifest => ({ name: name + '-workspace', ownerId: 'source-owner', workerId,
    kind: 'worker-workspace', archive: instanceVolumeArchiveName(name + '-workspace'), sha256: 'c'.repeat(64), size: 100,
    runtime: { kind: 'incus-vm', role: 'workspace', source, dockerData: false } });
  const managed = (): InstanceBackupVolumeManifest => ({ name: managedName, ownerId: 'deleted-owner', workerId,
    kind: 'persistent-path', archive: instanceVolumeArchiveName(managedName), sha256: 'c'.repeat(64), size: 100,
    runtime: { kind: 'incus-vm', role: 'managed', managedVolumeId: managedId, target: '/srv/retained' } });
  const legacy = (): InstanceBackupVolumeManifest => ({ name: 'preflight-legacy-workspace', ownerId: 'legacy-owner',
    workerId: randomUUID(), kind: 'worker-workspace', archive: instanceVolumeArchiveName('preflight-legacy-workspace'),
    sha256: 'c'.repeat(64), size: 100 });
  async function artifact(volumes: InstanceBackupVolumeManifest[] = [core()], formatVersion: 1 | 2 = 2) {
    const id = randomUUID();
    const manifest: InstanceBackupManifest = validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion,
      backupId: id, sourceInstallationId: 'authenticated-source', createdByUserId: 'source-admin', createdAt: stamp,
      agentorVersion: 'test', storage: { mode: 'directory', containerPrefix: config.containerPrefix },
      options: { includeWorkers: true, includeAgentData: false, includeDockerVolumes: true, includeLogs: false,
        includeLocalBackups: false }, dataArchive: { archive: 'data.tar.gz', sha256: 'd'.repeat(64), size: 100 },
      volumes, plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false },
      images: { definitions: 0, immutableDigests: [], layersIncluded: false }, excludedDataPaths: [] });
    await store.saveArtifact({ schemaVersion: 1, id, userId: 'destination-admin', provider: 'local',
      providerObjectId: id, createdAt: stamp, size: 100, sha256: 'e'.repeat(64), keyFingerprint: 'sha256:' + 'f'.repeat(64),
      sourceInstallationId: manifest.sourceInstallationId, formatVersion, integrityStatus: 'verified', provenance: 'local', manifest });
    return id;
  }
  return { config, client, manager, calls, state, name, managedName, presentInstances, presentVolumes, core, managed,
    legacy, artifact, patch, cleanup: async () => { manager.stop(); for (const restore of restorers.reverse()) restore();
      await rm(root, { recursive: true, force: true }); } };
}

test('historical v1 restore remains Docker-only and honors retained legacy destination conflicts', async () => {
  const f = await fixture(); try {
    f.state.dockerNames = [f.legacy().name]; f.patch(f.config, 'incusEnabled', false);
    const result = await f.manager.restorePreflight('destination-admin', await f.artifact([f.legacy()], 1), { restoreDockerVolumes: true });
    expect(result.ready).toBe(false); expect(result.volumeConflicts).toEqual(f.state.dockerNames);
    expect(f.calls).toEqual(['docker-volumes']);
  } finally { await f.cleanup(); }
});

test('v2 rejects omission of canonical native data before runtime probes', async () => {
  const f = await fixture(); try {
    await expect(f.manager.restorePreflight('destination-admin', await f.artifact(), { restoreDockerVolumes: false }))
      .rejects.toMatchObject({ code: 'INSTANCE_RESTORE_NATIVE_DATA_REQUIRED', statusCode: 409 });
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('native admission uses configured restricted readiness and absent exact compute plus all hidden core roles', async () => {
  const f = await fixture(); try {
    const result = await f.manager.restorePreflight('destination-admin', await f.artifact(), { restoreDockerVolumes: true });
    expect(result.ready).toBe(true); expect(result.volumeConflicts).toEqual([]);
    expect(f.calls).toContain('ready'); expect(f.calls).toContain('/1.0/projects/' + f.config.incusProject);
    expect(f.calls).toContain('/1.0/storage-pools/' + f.config.incusStoragePool);
    expect(f.calls).toContain('network:' + f.config.incusNetwork);
    expect(f.calls).toContain('instance:' + f.name);
    for (const role of ['workspace', 'agents', 'docker']) expect(f.calls).toContain('volume:' + f.name + '-' + role);
  } finally { await f.cleanup(); }
});

test('present native VM or hidden core destination prevents restore even with omitted agents and absent Docker data', async () => {
  for (const kind of ['compute', 'workspace', 'agents', 'docker']) {
    const f = await fixture(); try {
      if (kind === 'compute') f.presentInstances.add(f.name); else f.presentVolumes.add(f.name + '-' + kind);
      const result = await f.manager.restorePreflight('destination-admin', await f.artifact(), { restoreDockerVolumes: true });
      expect(result.ready).toBe(false); expect(result.blockers.length).toBeGreaterThan(0);
      if (kind !== 'compute') expect(result.volumeConflicts).toContain(f.name + '-' + kind);
    } finally { await f.cleanup(); }
  }
});

test('retained deleted-owner managed data still checks its exact helper compute and all native destinations', async () => {
  const f = await fixture(); try {
    f.presentVolumes.add(f.managedName);
    const result = await f.manager.restorePreflight('destination-admin', await f.artifact([f.managed()]), { restoreDockerVolumes: true });
    expect(result.ready).toBe(false); expect(result.volumeConflicts).toContain(f.managedName);
    expect(f.calls).toContain('instance:' + f.name);
    for (const role of ['workspace', 'agents', 'docker']) expect(f.calls).toContain('volume:' + f.name + '-' + role);
  } finally { await f.cleanup(); }
});

test('only typed native 404 proves absence; permission, transport and plain forged404 errors fail closed', async () => {
  for (const error of [new IncusError('Denied', 403), new IncusError('Failed', 500),
    new Error('Transport deadline'), Object.assign(new Error('Not authoritative Incus404'), { statusCode: 404 })]) {
    const f = await fixture(); try {
      f.state.lookupError = error;
      const result = await f.manager.restorePreflight('destination-admin', await f.artifact(), { restoreDockerVolumes: true });
      expect(result.ready).toBe(false); expect(result.blockers.length).toBeGreaterThan(0);
    } finally { await f.cleanup(); }
  }
});

test('same-name retained Docker sources cannot conflict with native descriptors while actual legacy destinations still do', async () => {
  const f = await fixture(); try {
    f.state.dockerNames = [f.core().name, f.managedName];
    const id = await f.artifact([f.core(), { ...f.managed(), ownerId: f.core().ownerId }, f.legacy()]);
    expect((await f.manager.restorePreflight('destination-admin', id, { restoreDockerVolumes: true })).ready).toBe(true);
    f.state.dockerNames.push(f.legacy().name);
    const result = await f.manager.restorePreflight('destination-admin', id, { restoreDockerVolumes: true });
    expect(result.ready).toBe(false); expect(result.volumeConflicts).toEqual([f.legacy().name]);
  } finally { await f.cleanup(); }
});

test('native descriptors cannot assign one worker to ambiguous source owners', async () => {
  const f = await fixture(); try {
    const result = await f.manager.restorePreflight('destination-admin', await f.artifact([f.core(), f.managed()]),
      { restoreDockerVolumes: true });
    expect(result.ready).toBe(false); expect(result.blockers.length).toBeGreaterThan(0);
    expect(f.calls.some(call => call.startsWith('instance:') || call.startsWith('volume:'))).toBe(false);
  } finally { await f.cleanup(); }
});

test('disabled or unsafe configured native readiness cannot pass public restore admission', async () => {
  for (const mode of ['disabled', 'http', 'missing-key', 'untrusted', 'wrong-project', 'unrestricted', 'pool', 'network']) {
    const f = await fixture(); try {
      if (mode === 'disabled') f.patch(f.config, 'incusEnabled', false);
      if (mode === 'http') f.patch(f.config, 'incusEndpoint', 'http://configured-incus.invalid');
      if (mode === 'missing-key') f.patch(f.config, 'incusClientKeyPath', '');
      if (mode === 'untrusted') f.state.trusted = false;
      if (mode === 'wrong-project') f.state.returnedProject = 'foreign-project';
      if (mode === 'unrestricted') f.state.restricted = false;
      if (mode === 'pool') f.state.pool = false;
      if (mode === 'network') f.state.network = false;
      const result = await f.manager.restorePreflight('destination-admin', await f.artifact(), { restoreDockerVolumes: true });
      expect(result.ready, mode).toBe(false); expect(result.blockers.length, mode).toBeGreaterThan(0);
    } finally { await f.cleanup(); }
  }
});

test('real restricted Incus readonly admission verifies native destinations without VM allocation', async () => {
  test.skip(process.env.INCUS_INSTANCE_PREFLIGHT_TEST !== 'true', 'Approved disposable readonly Incus gate');
  const f = await fixture(); try {
    const actual = { ...f.config, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
      incusStoragePool: 'default', incusNetwork: 'incusbr0',
      incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
      incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
      incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
    for (const key of ['incusEndpoint', 'incusProject', 'incusStoragePool', 'incusNetwork',
      'incusClientCertPath', 'incusClientKeyPath', 'incusServerCertPath'] as const) f.patch(f.config, key, actual[key]);
    const native = IncusClient.fromConfig(actual);
    // Existing singleton dispatch; real readonly methods only. This gate
    // neither creates fixtures on the host nor admits staged source payloads.
    f.patch(f.client, 'getReadiness', native.getReadiness.bind(native));
    f.patch(f.client, 'request', native.request.bind(native));
    f.patch(f.client, 'getNetwork', native.getNetwork.bind(native));
    f.patch(f.client, 'getInstance', native.getInstance.bind(native));
    f.patch(f.client, 'getCustomVolume', native.getCustomVolume.bind(native));
    const result = await f.manager.restorePreflight('destination-admin', await f.artifact());
    expect(result.blockers).toEqual([]); expect(result.ready).toBe(true); expect(result.volumeConflicts).toEqual([]);
  } finally { await f.cleanup(); }
});
