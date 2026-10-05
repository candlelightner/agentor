import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import type { Config } from '../../orchestrator/server/utils/config';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import { snapshotIncusWorkerBackupRuntime } from '../../orchestrator/server/utils/worker-backup-runtime';
import { WORKER_EXPORT_VERSION, BUNDLE_FILES, writeManifest, packBundle } from '../../orchestrator/server/utils/worker-export';
import { migrateAuth, getAuthDb } from '../../orchestrator/server/utils/auth';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { writePortableManagedVolumePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';
import { useConfig, useWorkerStore, reassignWorkerMappings, cleanupWorkerMappings } from '../../orchestrator/server/utils/services';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

async function fixture(run: (f: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-native-import-'));
  const config = { dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusWorkerImage: 'approved' } as Config;
  const manager = new ContainerManager(new Proxy({}, { get: () => () => { throw new Error('Docker fallback forbidden'); } }) as any, config);
  const store = new WorkerStore(dataDir); await store.init(); manager.setWorkerStore(store);
  (manager as any).assertOwnerExists = async () => {};
  const id = randomUUID(), userId = 'native-import-owner', now = new Date().toISOString(), uuid = randomUUID();
  const info = { id, userId, containerName: 'agentor-worker-' + id, containerId: 'agentor-worker-' + id,
    runtimeKind: 'incus-vm', displayName: 'native import', imageName: 'approved', imageId: '', status: 'creating',
    desiredRuntimeStatus: 'stopped', createdAt: now, updatedAt: now, pendingRebuild: false };
  const manifest = { runtime: { version: 1, kind: 'incus-vm', source: { sourceImageId: 'sha256:' + 'a'.repeat(64),
    recipeId: 'b'.repeat(64), architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' } },
    missingSecrets: ['API_KEY'], portMappings: [], domainMappings: [] };
  const calls: string[] = [];
  let failure: string | undefined, checks = 0;
  const assertIncomplete = () => {
    const record = store.get(userId, id)!;
    expect(record).toMatchObject({ runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'stopped',
      incusRecreation: { initialCreate: true, importIncomplete: true } });
    expect(record.deletionPending).not.toBe(true);
    return record.incusRecreation!;
  };
  (manager as any).resolveAuthorizedHostMounts = async () => { calls.push('current-grants'); return []; };
  (manager as any).incusOptionsForWorker = async () => ({ ...info, environmentJson: { dockerEnabled: false },
    workerJson: { id, repos: [], displayName: info.displayName, initScript: '' }, userEnv: zeroUserEnvVars(userId),
    workerConfig: [], capabilitiesJson: [], instructionsJson: [] });
  (manager as any).recreateImportedMappings = async () => {
    assertIncomplete(); calls.push('mappings'); if (failure === 'mappings') throw new Error('Injected mappings failure');
  };
  (manager as any).reconcileManagedNetworksForWorker = async () => {
    expect(store.get(userId, id)?.incusRecreation).toBeUndefined(); calls.push('networks');
  };
  (manager as any).resolveEnvironmentConfig = () => ({ dockerEnabled: false });
  const configStore = useWorkerConfigStore(), priorMarkApplied = configStore.markApplied;
  configStore.markApplied = async () => {
    assertIncomplete(); calls.push('applied'); if (failure === 'applied') throw new Error('Injected applied failure');
  };
  const runtime = {
    createCanonicalRestore: async (opts: any, source: any) => {
      const marker = assertIncomplete(); expect(opts).toMatchObject({ start: false, recreationNonce: marker.nonce });
      calls.push('create'); if (failure === 'create') throw new Error('Lost native create response');
      return { config: { 'volatile.uuid': uuid, 'user.agentor.recreation': marker.nonce, 'volatile.base_image': 'c'.repeat(64) }, source };
    },
    matchesWorkerIdentity: async () => true,
    restoreCanonicalArchives: async (_opts: any, incarnation: string, payloads: any, validate: () => Promise<void>) => {
      assertIncomplete(); expect(incarnation).toBe(uuid); expect(payloads).toEqual({ workspace: '/private/validated.tar' });
      await validate(); calls.push('extract'); if (failure === 'extract') throw new Error('Injected extraction failure');
    },
    finishCanonicalRestore: async (_opts: any, incarnation: string, validate: () => Promise<void>) => {
      assertIncomplete(); expect(incarnation).toBe(uuid); await validate(); calls.push('health');
      if (failure === 'health') throw new Error('Injected health failure');
    },
    rollbackRecreation: async (_owner: any, marker: any) => {
      expect(marker).toMatchObject({ initialCreate: true, importIncomplete: true, replacementIncarnation: uuid });
      calls.push('exact-rollback'); return { status: 'archived' };
    },
  };
  manager.setIncusRuntime(runtime as any);
  try {
    await run({ manager, store, info, calls, runtime, assertIncomplete,
      fail: (at: string) => { failure = at; },
      import: (override?: any, principal?: () => Promise<void>, managed?: any[]) => (manager as any).importNativeCanonicalWorker(
        info, { workspace: '/private/validated.tar' }, manifest, undefined, override,
        principal ?? (async () => { checks++; }), managed), checks: () => checks });
  } finally {
    configStore.markApplied = priorMarkApplied;
    const volumes = useManagedVolumeManager(); await volumes.init();
    for (const volume of volumes.store.forWorker(userId, id)) await volumes.store.forget(userId, volume.id);
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('native importer retains initial incomplete authority through health, configuration and mappings', async () => {
  await fixture(async f => {
    const imported = await f.import();
    expect(imported).toMatchObject({ status: 'running', containerId: expect.stringMatching(/^incus:/), missingSecrets: ['API_KEY'] });
    expect(f.store.get(f.info.userId, f.info.id)).toMatchObject({ runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running' });
    expect(f.store.get(f.info.userId, f.info.id).incusRecreation).toBeUndefined();
    expect(f.calls).toEqual(['current-grants', 'create', 'extract', 'health', 'applied', 'mappings', 'networks']);
    expect(f.checks()).toBeGreaterThan(5);
  });
});

test('native managed importer publishes scoped pending records before allocation and seeded authority only after ALL extraction proofs', async () => {
  await fixture(async f => {
    const volumes = useManagedVolumeManager(); await volumes.init();
    const pending = () => volumes.store.forWorker(f.info.userId, f.info.id);
    const create = f.runtime.createCanonicalRestore, extract = f.runtime.restoreCanonicalArchives, finish = f.runtime.finishCanonicalRestore;
    f.runtime.createCanonicalRestore = async (opts: any, source: any) => {
      expect(pending()).toHaveLength(2);
      expect(opts.managedVolumes).toEqual(pending());
      for (const record of pending()) expect(record).toMatchObject({ storageRuntimeKind: 'incus-vm', seeded: false, state: 'pending', attached: true });
      return create(opts, source);
    };
    f.runtime.restoreCanonicalArchives = async (...args: any[]) => {
      const [opts, , , validate, , payloads] = args;
      expect(payloads.map((item: any) => item.volume)).toEqual(opts.managedVolumes);
      expect(payloads.map((item: any) => item.archivePath)).toEqual(['/private/one.tar', '/private/two.tar']);
      await validate(); for (const record of pending()) expect(record.seeded).toBe(false);
      return extract(...args);
    };
    f.runtime.finishCanonicalRestore = async (...args: any[]) => {
      expect(args[0].managedVolumes).toEqual(pending());
      for (const record of pending()) expect(record).toMatchObject({ seeded: true, state: 'ready' });
      return finish(...args);
    };
    await f.import(undefined, undefined, [
      { entry: { target: '/srv/one', name: 'One', archive: 'volumes/0.tar' }, archivePath: '/private/one.tar' },
      { entry: { target: '/srv/two', name: 'Two', archive: 'volumes/1.tar' }, archivePath: '/private/two.tar' },
    ]);
    expect(f.store.get(f.info.userId, f.info.id).incusRecreation).toBeUndefined();
  });
});

test('managed extraction failure or durable record drift leaves non-authoritative data behind deletion quarantine', async () => {
  for (const kind of ['extract', 'drift']) await fixture(async f => {
    const volumes = useManagedVolumeManager(); await volumes.init();
    if (kind === 'extract') f.fail('extract');
    else {
      const extract = f.runtime.restoreCanonicalArchives;
      f.runtime.restoreCanonicalArchives = async (...args: any[]) => {
        await extract(...args);
        const record = volumes.store.forWorker(f.info.userId, f.info.id)[0]!;
        await volumes.store.save({ ...record, name: 'Externally changed record' });
      };
    }
    await expect(f.import(undefined, undefined, [{ entry: { target: '/srv/data', name: 'Data', archive: 'volumes/0.tar' },
      archivePath: '/private/data.tar' }])).rejects.toThrow();
    expect(volumes.store.forWorker(f.info.userId, f.info.id)[0]).toMatchObject({ seeded: false, state: 'pending' });
    expect(f.store.get(f.info.userId, f.info.id)).toMatchObject({ status: 'archived', deletionPending: true });
    expect(f.calls).not.toContain('health'); expect(f.calls).toContain('exact-rollback');
  });
});

for (const at of ['extract', 'health', 'applied', 'mappings']) test(`native importer ${at} failure contains exact compute and fences partial data against unarchive`, async () => {
  await fixture(async f => {
    f.fail(at); await expect(f.import()).rejects.toThrow(`Injected ${at === 'extract' ? 'extraction' : at} failure`);
    expect(f.calls).toContain('exact-rollback'); expect(f.calls).not.toContain('networks');
    expect(f.store.get(f.info.userId, f.info.id)).toMatchObject({ status: 'archived', deletionPending: true, desiredRuntimeStatus: 'stopped' });
    expect(f.store.get(f.info.userId, f.info.id).incusRecreation).toBeUndefined();
    await expect(f.manager.unarchive(f.info.userId, f.info.id)).rejects.toMatchObject({ statusCode: 409 });
  });
});

test('native importer lost create response retains nonce quarantine, never adopts by name or falls back', async () => {
  await fixture(async f => {
    f.fail('create'); await expect(f.import()).rejects.toMatchObject({ code: 'WORKER_CREATE_CONTAINER_RETAINED' });
    f.assertIncomplete(); expect(f.calls).not.toContain('exact-rollback'); expect(f.calls).not.toContain('extract');
    expect(f.manager.get(f.info.id).status).toBe('error');
  });
});

test('native importer revocation before native create retains deletion-pending handle with exact no-attempt proof', async () => {
  await fixture(async f => {
    await expect(f.import(undefined, async () => { throw new Error('Restore authority revoked'); })).rejects.toThrow('Restore authority revoked');
    expect(f.calls).toEqual([]);
    expect(f.store.get(f.info.userId, f.info.id)).toMatchObject({ status: 'archived', deletionPending: true });
  });
});

test('native import exact UUID remains rollback authority if UUID publication fails', async () => {
  await fixture(async f => {
    f.store.transitionIncusRecreation = async () => { throw new Error('Injected UUID persistence failure'); };
    await expect(f.import()).rejects.toMatchObject({ code: 'WORKER_CREATE_ROLLBACK_INCOMPLETE' });
    expect(f.calls).toContain('exact-rollback'); expect(f.calls).not.toContain('extract');
    expect(f.store.get(f.info.userId, f.info.id).incusRecreation).toMatchObject({ initialCreate: true, importIncomplete: true });
  });
});

test('native source descriptor is descriptive image reconstruction, ignored only for explicit image recovery', async () => {
  for (const override of [undefined, { mode: 'workspace-only' }]) await fixture(async f => {
    const create = f.runtime.createCanonicalRestore;
    f.runtime.createCanonicalRestore = async (opts: any, source: any) => {
      expect(source === undefined).toBe(override !== undefined);
      return create(opts, source);
    };
    await f.import(override);
  });
});

test('native import cannot silently substitute default network/environment policy on missing or failed reconstruction', async () => {
  await fixture(async f => {
    await expect((f.manager as any).resolveImportEnvironment(f.info.userId, { id: 'missing', builtIn: true }, true))
      .rejects.toMatchObject({ code: 'INCUS_IMPORT_ENVIRONMENT_UNAVAILABLE' });
    f.manager.setEnvironmentStore({ getById: () => undefined, list: () => [],
      create: async () => { throw new Error('Environment write failed'); } } as any);
    for (const env of [{ id: 'missing', builtIn: true }, { name: 'missing', builtIn: false }])
      await expect((f.manager as any).resolveImportEnvironment(f.info.userId, env, true))
        .rejects.toMatchObject({ code: 'INCUS_IMPORT_ENVIRONMENT_UNAVAILABLE' });
    expect(await (f.manager as any).resolveImportEnvironment(f.info.userId, { name: 'old', builtIn: false }))
      .toMatchObject({ created: false }); // Historical legacy behavior retained.
    expect(f.calls).toEqual([]);
  });
});

test('a forged built-in descriptor cannot select another owner custom environment in either runtime', async () => {
  await fixture(async f => {
    f.manager.setEnvironmentStore({ getById: () => ({ id: 'foreign-custom', builtIn: false, userId: 'other-owner',
      envVars: 'PRIVATE_VALUE=must-not-be-exposed' }) } as any);
    for (const strict of [false, true])
      await expect((f.manager as any).resolveImportEnvironment(f.info.userId,
        { id: 'foreign-custom', name: 'forged', builtIn: true }, strict))
        .rejects.toMatchObject({ code: 'IMPORT_ENVIRONMENT_NOT_AUTHORIZED' });
    expect(f.calls).toEqual([]);
  });
});

test('real shared portable/native backup importer restores byte-faithful canonical data and healthy fresh VM without Docker', async () => {
  const managedImport = process.env.INCUS_MANAGED_IMPORT_TEST === 'true';
  test.skip(process.env.INCUS_WORKER_IMPORT_TEST !== 'true' && !managedImport, 'Explicit serial disposable production importer gate');
  test.setTimeout(1_200_000);
  await migrateAuth();
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-native-import-live-')), userId = randomUUID();
  // Real lifecycle/storage services share the same isolated DATA_DIR registry;
  // a separate WorkerStore would be unknown to selection/rebuild admission.
  const config = useConfig();
  Object.assign(config, { containerPrefix: 'agentor-worker', incusEnabled: true, baseDomains: [],
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const store = useWorkerStore(); await store.init();
  const runtime = new IncusWorkerRuntime(config), manager = new ContainerManager(new Proxy({}, {
    get: () => () => { throw new Error('Production native import called Docker'); },
  }) as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const managed = useManagedVolumeManager(); await managed.init();
  const priorManagedRuntime = (managed as any).incus;
  (managed as any).incus = new IncusManagedVolumeRuntime(config, runtime);
  const priorReassign = (globalThis as any).reassignWorkerMappings;
  (globalThis as any).reassignWorkerMappings = reassignWorkerMappings;
  const priorCleanup = (globalThis as any).cleanupWorkerMappings;
  (globalThis as any).cleanupWorkerMappings = cleanupWorkerMappings;
  const now = new Date().toISOString(), db = getAuthDb();
  db.prepare('INSERT INTO user (id,name,email,emailVerified,role,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(userId, 'Native import fixture', userId + '@fixture.invalid', 0, 'user', now, now);
  const environment = { id: 'native-import-gate', name: 'Native import gate', builtIn: true, userId: null,
    cpuLimit: 1, memoryLimit: '1GiB', networkMode: 'full', allowedDomains: [], includePackageManagerDomains: false,
    dockerEnabled: false, envVars: 'IMPORT_ENV=actual-native-import', setupScript: '',
    exposeApis: { portMappings: false, domainMappings: false, usage: false },
    enabledCapabilityIds: null, enabledInstructionIds: null, createdAt: now, updatedAt: now };
  manager.setEnvironmentStore({ getById: (id: string) => id === environment.id ? environment : undefined } as any);
  let cleaned = false;
  try {
    console.info('Exact production native import fixture', { dataDir: config.dataDir, scratch: dataDir, userId,
      installation: await backupInstallationId(config.dataDir) });
    const staging = join(dataDir, 'source'), workspace = join(staging, 'workspace'); await mkdir(workspace, { recursive: true });
    execFileSync('sudo', ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];open(p+'/bytes','wb').write(bytes([0,255,128,10,61,0]))
os.chown(p+'/bytes',12345,23456);os.chmod(p+'/bytes',0o640)
os.setxattr(p+'/bytes','user.binary',bytes([0,255,128,10,61,0]))
os.utime(p+'/bytes',ns=(1791198000000000123,1791198000000000123))
os.link(p+'/bytes',p+'/hard');os.symlink('/not-a-host-grant/data',p+'/inert')
`, workspace]);
    const payload = join(dataDir, BUNDLE_FILES.workspace);
    execFileSync('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', staging, '-czf', payload, 'workspace']);
    const target = '/srv/imported-managed-data', managedPayload = join(dataDir, BUNDLE_FILES.managedVolumes);
    const managedEntry = { target, name: 'Imported native data', archive: 'volumes/0.tar' };
    const inspect = String.raw`
import base64,json,os,stat,sys
p=sys.argv[1];s=os.lstat(p+'/bytes')
print(json.dumps(dict(bytes=base64.b64encode(open(p+'/bytes','rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
 mode=stat.S_IMODE(s.st_mode),mtime=str(s.st_mtime_ns),hard=s.st_ino==os.stat(p+'/hard').st_ino,
 attrs={key:base64.b64encode(os.getxattr(p+'/bytes',key)).decode() for key in ('user.binary','system.posix_acl_access','security.capability')},
 defaultAcl=base64.b64encode(os.getxattr(p,'system.posix_acl_default')).decode(),inert=os.readlink(p+'/inert'))))
`;
    let expectedManaged: any;
    if (managedImport) {
      const managedStage = join(dataDir, 'managed-source'), root = join(managedStage, 'volume');
      await mkdir(managedStage);
      execFileSync('sudo', ['cp', '-a', workspace, root]);
      execFileSync('sudo', ['python3', '-c', 'import os,sys;os.unlink(sys.argv[1]+"/inert");os.symlink(sys.argv[2]+"/bytes",sys.argv[1]+"/inert")', root, target]);
      execFileSync('sudo', ['python3', '-c', String.raw`
import os,struct,sys
p=sys.argv[1]
def acl(entries):
 return struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in entries)
os.setxattr(p+'/bytes','system.posix_acl_access',acl([(1,6,0xffffffff),(2,4,34567),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)]))
os.setxattr(p,'system.posix_acl_default',acl([(1,7,0xffffffff),(2,5,34567),(4,5,0xffffffff),(16,5,0xffffffff),(32,0,0xffffffff)]))
`, root]);
      execFileSync('sudo', ['setcap', 'cap_net_bind_service=ep', join(root, 'bytes')]);
      expectedManaged = JSON.parse(execFileSync('sudo', ['python3', '-c', inspect, root], { encoding: 'utf8' }));
      const raw = join(dataDir, 'managed-raw.tar');
      await writeFile(raw, execFileSync('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*',
        '--acls', '-C', managedStage, '-cf', '-', 'volume']));
      await writePortableManagedVolumePayload([{ entry: managedEntry, archivePath: raw }], managedPayload);
    }
    const alias = await runtime.client.getImageAlias(config.incusWorkerImage);
    const descriptor = snapshotIncusWorkerBackupRuntime(incusImageIdentity(await runtime.client.getImage(alias.target)));
    const manifest = join(dataDir, 'manifest.json'), bundle = join(dataDir, 'bundle.tar');
    const write = async (runtimeMetadata: any) => {
      await writeManifest({ version: managedImport ? 6 : WORKER_EXPORT_VERSION, exportedAt: now,
        source: { id: 'descriptive-only', containerName: 'never-adopt', displayName: 'source', imageName: 'descriptive-only' },
        worker: { displayName: 'Native import', repos: [], mounts: [], initScript: '' },
        environment, contents: { rootfs: false, workspace: true, agents: false, ...(managedImport ? { managedVolumes: true } : {}) },
        ...(managedImport ? { managedVolumes: [managedEntry] } : {}),
        portMappings: [], domainMappings: [], missingSecrets: ['EXCLUDED_SECRET'], runtime: runtimeMetadata } as any, manifest);
      await pipeline(packBundle([{ name: BUNDLE_FILES.manifest, path: manifest }, { name: BUNDLE_FILES.workspace, path: payload },
        ...(managedImport ? [{ name: BUNDLE_FILES.managedVolumes, path: managedPayload }] : [])]),
        createWriteStream(bundle, { mode: 0o600 }));
    };
    // Run serially; each exact completed fixture is removed before the next.
    for (const origin of ['portable-forged-legacy', 'native-local-backup']) {
      await write(origin === 'native-local-backup' ? descriptor : { version: 1, kind: 'legacy-docker', privileged: true });
      const imported = origin === 'native-local-backup'
        ? await manager.importWorkerFromBackup(userId, bundle, { provenance: 'local' })
        : await manager.importWorker(userId, bundle);
      console.info('Imported exact worker', { origin, id: imported.id, containerId: imported.containerId, containerName: imported.containerName });
      expect(imported).toMatchObject({ runtimeKind: 'incus-vm', status: 'running', missingSecrets: ['EXCLUDED_SECRET'] });
      expect(imported.id).not.toBe('descriptive-only'); expect(imported.containerName).not.toBe('never-adopt');
      const record = store.get(userId, imported.id)!;
      expect(record.incusRecreation).toBeUndefined(); expect(record.deletionPending).not.toBe(true);
      expect(await useWorkerConfigStore().resolveAppliedBootstrap(userId, imported.id)).toMatchObject({ version: 1 });
      const result = await runtime.client.exec(imported.containerName, ['/usr/bin/python3', '-c', String.raw`
import base64,json,os,stat
p='/workspace/bytes';s=os.lstat(p)
print(json.dumps(dict(bytes=base64.b64encode(open(p,'rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
 mode=stat.S_IMODE(s.st_mode),mtime=str(s.st_mtime_ns),hard=s.st_ino==os.stat('/workspace/hard').st_ino,
 attr=list(os.getxattr(p,'user.binary')),inert=os.readlink('/workspace/inert'))))
`]);
      expect(result.returnCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ bytes: Buffer.from([0,255,128,10,61,0]).toString('base64'),
        uid: 12345, gid: 23456, mode: 0o640, mtime: '1791198000000000123', hard: true,
        attr: [0,255,128,10,61,0], inert: '/not-a-host-grant/data' });
      const services = await runtime.client.exec(imported.containerName, ['bash', '-ec',
        'test -f /run/agentor/preserve-storage-ownership; systemctl is-active --quiet agentor-worker; curl -fsS http://127.0.0.1:8443/healthz; curl -fsS http://127.0.0.1:6080/agentor.html >/dev/null; runuser -u agent -- touch /home/agent/.agent-data/import-writable']);
      expect(services.returnCode, services.stderr).toBe(0);
      if (managedImport) {
        const records = managed.store.forWorker(userId, imported.id);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ storageRuntimeKind: 'incus-vm', seeded: true, state: 'ready', attached: true, target });
        const verifyManaged = async () => {
          const result = await runtime.client.exec(imported.containerName, ['python3', '-c', inspect, target]);
          expect(result.returnCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expectedManaged);
          const instance = await runtime.client.getInstance(imported.containerName);
          const key = 'm' + records[0]!.id.replaceAll('-', '').slice(0, 6);
          expect(instance.devices[key]).toEqual({ type: 'disk', pool: 'default', source: records[0]!.dockerName, path: target });
          const current = managed.store.forWorker(userId, imported.id);
          // markDeclared refreshes the audit timestamp on rebuild. Every
          // storage identity/grant/seed/state field must remain unchanged.
          const authority = (items: typeof records) => items.map(({ updatedAt, ...record }) => record);
          expect(authority(current)).toEqual(authority(records));
          expect(Date.parse(current[0]!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(records[0]!.updatedAt));
        };
        await verifyManaged();
        await manager.restart(imported.id); await verifyManaged();
        const before = manager.get(imported.id)!.containerId;
        await manager.rebuild(imported.id); Object.assign(imported, manager.get(imported.id));
        expect(imported.containerId).not.toBe(before); await verifyManaged();
        console.info('Managed metadata and authoritative record retained through production import, restart and fresh-root rebuild', { origin, id: imported.id });
      }
      await runtime.remove(imported, imported.containerId.slice('incus:'.length));
      await runtime.removeStorage(imported);
      for (const volume of managed.store.forWorker(userId, imported.id)) {
        await managed.incusRuntime.delete(volume); await managed.store.forget(userId, volume.id);
      }
      await useWorkerConfigStore().remove(userId, imported.id); await store.delete(userId, imported.id);
      manager.unregisterExternal(imported.id);
    }
    cleaned = true;
  } finally {
    // Retained records are exact durable cleanup authority, not a name guess.
    for (const record of store.listForUser(userId)) {
      const owner = { id: record.id, userId, containerName: 'agentor-worker-' + record.id };
      const info = manager.get(record.id);
      try {
        if (record.incusRecreation) await runtime.rollbackRecreation(owner, record.incusRecreation);
        else if (info?.containerId.startsWith('incus:')) await runtime.remove(owner, info.containerId.slice(6));
        else throw new Error('Fixture has no captured cleanup authority');
        await runtime.removeStorage(owner); await useWorkerConfigStore().remove(userId, record.id);
        for (const volume of managed.store.forWorker(userId, record.id)) {
          await managed.incusRuntime.delete(volume); await managed.store.forget(userId, volume.id);
        }
        await store.delete(userId, record.id); manager.unregisterExternal(record.id);
      } catch (error) { console.error('Retain exact import fixture for diagnosis', { dataDir, record, error }); }
    }
    if (!store.listForUser(userId).length) {
      db.prepare('DELETE FROM user WHERE id=?').run(userId);
      await rm(dataDir, { recursive: true, force: true });
    } else console.error('Retain synthetic import owner and registry', { dataDir: config.dataDir, scratch: dataDir, userId, cleaned });
    (managed as any).incus = priorManagedRuntime;
    (globalThis as any).reassignWorkerMappings = priorReassign;
    (globalThis as any).cleanupWorkerMappings = priorCleanup;
  }
});
