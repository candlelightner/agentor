import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { ManagedVolumeRuntime } from '../../orchestrator/server/utils/managed-volume-runtime';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { randomUUID } from 'node:crypto';
import { MANAGED_KILO_PARENT, MANAGED_KILO_LINK, MANAGED_KILO_PARENT_CHECK } from '../../orchestrator/server/utils/managed-volume-kilo-parent';
import { ManagedVolumeStore, validatePersistenceTarget, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { prepareLegacyManagedMigration } from '../../orchestrator/server/utils/legacy-incus-managed-migration';
import { persistentPathVolumeName } from '../../orchestrator/server/utils/persistent-backup-paths';
import { validatePortableManagedVolumeArchive, writePortableManagedVolumePayload, validateAndExtractPortableManagedVolumePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';
import { planPortableManagedVolumeImport, planPortableManagedVolumeCapture } from '../../orchestrator/server/utils/portable-managed-volume-plan';
import { portableManagedVolumeImportConflicts, PortableManagedVolumeRuntime } from '../../orchestrator/server/utils/portable-managed-volume-runtime';
import { IncusManagedVolumeRuntime, incusManagedRestoreDevices } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';

const entry = { target: MANAGED_KILO_PARENT, name: 'Historical XDG data', archive: 'volumes/0.tar' };
function source(): StoredManagedVolume {
  const workerId = randomUUID();
  return { id: randomUUID(), userId: randomUUID(), workerId, target: MANAGED_KILO_PARENT, name: entry.name,
    dockerName: persistentPathVolumeName(workerId, MANAGED_KILO_PARENT), purpose: 'legacy-backup-path',
    seeded: true, attached: true, state: 'ready', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
}
async function archive(dir: string, members: Array<[string, string, string?]>) {
  const path = join(dir, randomUUID() + '.tar');
  execFileSync('python3', ['-c', `import io,json,sys,tarfile
with tarfile.open(sys.argv[1],'w',format=tarfile.USTAR_FORMAT) as t:
 for name,kind,*value in json.loads(sys.argv[2]):
  i=tarfile.TarInfo(name);i.type={'d':tarfile.DIRTYPE,'s':tarfile.SYMTYPE,'f':tarfile.REGTYPE,'h':tarfile.LNKTYPE}[kind]
  if kind in ('s','h'):i.linkname=value[0]
  data=b'data' if kind=='f' else b'';i.size=len(data);t.addfile(i,io.BytesIO(data))`, path, JSON.stringify(members)]);
  return path;
}
const validMembers = (): Array<[string, string, string?]> => [['volume/', 'd'], ['volume/kilo', 's', MANAGED_KILO_LINK], ['volume/FreeCAD/', 'd'], ['volume/FreeCAD/settings', 'f']];

test('historical XDG parent normalizes only destination identity, survives durable reload and preserves source records', async () => {
  const original = source(), before = structuredClone(original), owner = { id: original.workerId, userId: original.userId };
  const [native] = prepareLegacyManagedMigration(owner, [original]);
  expect(original).toEqual(before); expect(native!.target).toBe(MANAGED_KILO_PARENT);
  expect(native!.id).toBe(original.id); expect(native!.createdAt).toBe(original.createdAt);
  expect(Object.values(incusManagedRestoreDevices(owner, 'pool', [native!]))[0]).toMatchObject({ source: 'agentor-persist-' + original.id });
  const dir = await mkdtemp(join(tmpdir(), 'kilo-parent-store-'));
  try {
    const store = new ManagedVolumeStore(dir); await store.init(); await store.save(native!);
    const reload = new ManagedVolumeStore(dir); await reload.init();
    expect(reload.get(original.userId, original.id)).toMatchObject({ target: MANAGED_KILO_PARENT, purpose: 'persistent-path' });
    await expect(store.create(original.userId, original.workerId, MANAGED_KILO_PARENT)).rejects.toThrow('protected');
    for (const target of ['/home/agent/.local', '/home/agent/.local/share/kilo', '/home/agent/.local/share/kilo/db', '/home/agent']) {
      expect(() => validatePersistenceTarget(target)).toThrow();
      expect(() => prepareLegacyManagedMigration(owner, [{ ...original, target, dockerName: persistentPathVolumeName(owner.id, target) }])).toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('only exact parent archive admits canonical Kilo link; missing, real directory, other link and both-order descendants fail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-parent-archive-'));
  try {
    const valid = await archive(dir, validMembers());
    await validatePortableManagedVolumeArchive(valid, { target: MANAGED_KILO_PARENT });
    await expect(validatePortableManagedVolumeArchive(valid, { target: '/opt/data' })).rejects.toThrow('symlink');
    const cases: Array<Array<[string, string, string?]>> = [
      [['volume/', 'd']], [['volume/', 'd'], ['volume/kilo/', 'd']],
      [['volume/', 'd'], ['volume/kilo', 'f']],
      [['volume/', 'd'], ['volume/kilo', 's', '/home/agent/.agent-data/.kilo/other']],
      [['volume/', 'd'], ['volume/kilo', 's', '../../.agent-data/.kilo/shared-data']],
      [...validMembers(), ['volume/kilo/db', 'f']],
      [['volume/kilo/db', 'f'], ...validMembers()],
      [...validMembers(), ['volume/other', 's', MANAGED_KILO_LINK]],
      [...validMembers(), ['volume/hard', 'h', 'volume/kilo']],
    ];
    for (const members of cases) await expect(validatePortableManagedVolumeArchive(await archive(dir, members), { target: MANAGED_KILO_PARENT })).rejects.toThrow();
    const store = new ManagedVolumeStore(join(dir, 'store')); await store.init();
    for (const members of cases) await expect(store.create('owner', 'worker', MANAGED_KILO_PARENT, 'XDG', 'incus-vm', await archive(dir, members))).rejects.toThrow();
    expect(store.list()).toEqual([]);
    const record = await store.create('owner', 'worker', MANAGED_KILO_PARENT, 'XDG', 'incus-vm', valid);
    expect(record).toMatchObject({ target: MANAGED_KILO_PARENT, seeded: false, state: 'pending' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('unchanged GNU/PAX parent survives portable payload, cross-child hardlinks, metadata and canonical link without following it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-parent-gnu-'));
  try {
    const root = join(dir, 'volume'); await mkdir(root);
    execFileSync('python3', ['-c', `import os,sys
p=sys.argv[1]
for n in ('FreeCAD','claude','code-server'):os.mkdir(p+'/'+n)
with open(p+'/FreeCAD/binary','wb') as f:f.write(bytes([0,255,128,10])*1024)
os.link(p+'/FreeCAD/binary',p+'/claude/hard');os.symlink(sys.argv[2],p+'/kilo')
os.setxattr(p+'/FreeCAD/binary','user.fixture',bytes([0,255,128]))
for path in (p,p+'/FreeCAD',p+'/claude',p+'/code-server',p+'/FreeCAD/binary'):
 os.chown(path,12345,23456);os.chmod(path,0o751 if os.path.isdir(path) else 0o640);os.utime(path,ns=(1700000000123456789,1700000000987654321))
os.chown(p+'/kilo',1000,1000,follow_symlinks=False);os.utime(p+'/kilo',ns=(1700000000123456789,1700000000987654321),follow_symlinks=False)`, root, MANAGED_KILO_LINK]);
    const raw = join(dir, 'source.tar'); execFileSync('tar', ['--sort=name', '--format=pax', '--numeric-owner', '--acls', '--xattrs', '--xattrs-include=*', '-cpf', raw, '-C', dir, 'volume']);
    const bytes = await readFile(raw), payload = join(dir, 'payload.tar.gz');
    await writePortableManagedVolumePayload([{ entry, archivePath: raw }], payload);
    const stage = join(dir, 'stage'); await mkdir(stage);
    const [extracted] = await validateAndExtractPortableManagedVolumePayload(payload, [entry], stage);
    expect(await readFile(extracted!.archivePath)).toEqual(bytes);
    const target = join(dir, 'restored'); await mkdir(target);
    execFileSync('tar', ['--numeric-owner', '--acls', '--xattrs', '--xattrs-include=*', '-xpf', extracted!.archivePath, '-C', target]);
    execFileSync('python3', ['-c', `import hashlib,os,stat,sys
source,target=sys.argv[1:]
for name in ('','/FreeCAD','/claude','/code-server','/FreeCAD/binary','/claude/hard','/kilo'):
 a,b=source+name,target+name;x,y=os.lstat(a),os.lstat(b)
 assert (x.st_uid,x.st_gid,stat.S_IMODE(x.st_mode),x.st_mtime_ns)==(y.st_uid,y.st_gid,stat.S_IMODE(y.st_mode),y.st_mtime_ns)
 if stat.S_ISREG(x.st_mode):assert open(a,'rb').read()==open(b,'rb').read()
assert os.readlink(target+'/kilo')==os.readlink(source+'/kilo')
assert os.lstat(target+'/FreeCAD/binary').st_ino==os.lstat(target+'/claude/hard').st_ino
assert os.getxattr(target+'/FreeCAD/binary','user.fixture')==bytes([0,255,128])`, root, join(target, 'volume')]);
    expect(planPortableManagedVolumeCapture([{ ...source(), purpose: 'persistent-path', dockerName: 'agentor-persist-' + randomUUID(),
      volumeId: randomUUID(), backend: 'incus-vm', nativeAuthorityVerified: true, physicalExists: true,
      mountSourceVerified: true, mountDestinationVerified: true, operationDrift: false, recoveryDrift: false }]).items[0]!.entry).toEqual(entry);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('portable conflict exception covers only protected canonical Kilo leaf, never grants, selected paths or wider parents', () => {
  const input = { operationId: randomUUID(), userId: 'owner', workerId: randomUUID(), entries: [entry], conflicts: portableManagedVolumeImportConflicts({}) };
  expect(planPortableManagedVolumeImport(input)).toHaveLength(1);
  for (const key of ['hostGrantPaths', 'destinationMountPaths', 'selectedBackupPaths', 'agentDataPaths'] as const)
    expect(() => planPortableManagedVolumeImport({ ...input, conflicts: { ...input.conflicts, [key]: [MANAGED_KILO_PARENT + '/kilo'] } })).toThrow('overlaps');
  for (const target of ['/home/agent/.local', MANAGED_KILO_PARENT + '/kilo', MANAGED_KILO_PARENT + '/kilo/db'])
    expect(() => planPortableManagedVolumeImport({ ...input, entries: [{ ...entry, target }] })).toThrow('overlaps');
});

test('actual guest no-follow leaf check rejects real Kilo data, missing or changed link and symlink ancestors without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-parent-guest-')), root = join(dir, 'parent');
  try {
    await mkdir(root); const run = () => execFileSync('python3', ['-c', MANAGED_KILO_PARENT_CHECK, root], { stdio: 'pipe' });
    expect(run).toThrow(); await mkdir(join(root, 'kilo')); expect(run).toThrow();
    await rm(join(root, 'kilo'), { recursive: true }); await symlink('/different', join(root, 'kilo')); expect(run).toThrow();
    await rm(join(root, 'kilo')); await symlink(MANAGED_KILO_LINK, join(root, 'kilo')); expect(run).not.toThrow();
    await symlink(root, join(dir, 'alias'));
    expect(() => execFileSync('python3', ['-c', MANAGED_KILO_PARENT_CHECK, join(dir, 'alias')], { stdio: 'pipe' })).toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function nativeFixture(run: (f: any) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'kilo-parent-native-'));
  const original = source(), [v] = prepareLegacyManagedMigration({ id: original.workerId, userId: original.userId }, [original]);
  v!.seeded = true; v!.state = 'ready';
  const config = { dataDir, containerPrefix: 'worker', incusStoragePool: 'pool', incusProject: 'agentor', incusEndpoint: 'https://native.invalid' } as Config;
  const volume = { name: v!.dockerName, project: config.incusProject, type: 'custom', content_type: 'filesystem', created_at: '2026-10-01T00:00:00Z', used_by: [] as string[],
    config: { 'user.agentor.installation': await backupInstallationId(dataDir), 'user.agentor.owner': v!.userId,
      'user.agentor.id': v!.workerId, 'user.agentor.volume-id': v!.id, 'user.agentor.target': v!.target } };
  const calls: string[] = [], client = { endpoint: config.incusEndpoint, getCustomVolume: async () => structuredClone(volume),
    exec: async (_name: string, command: string[]) => { calls.push('read-leaf'); expect(command.slice(-2)).toEqual([MANAGED_KILO_PARENT_CHECK, '/volume']); return { returnCode: 0 }; } };
  const prior = IncusOfflineArchiveHelper.prototype.withGuest;
  IncusOfflineArchiveHelper.prototype.withGuest = async function(owner, sources, validate, _signal, action) {
    expect(sources).toEqual({ managed: v!.dockerName }); expect(owner.id).toBe(v!.workerId); await validate(); calls.push('helper');
    const name = 'abk-' + randomUUID(); volume.used_by.push(`/1.0/instances/${name}?project=agentor`);
    try { await validate(name); return await action(name, async () => { await validate(name); }); }
    finally { volume.used_by = []; await validate(); calls.push('cleanup'); }
  };
  try { await run({ v: v!, config, volume, calls, client, runtime: new IncusManagedVolumeRuntime(config, new IncusWorkerRuntime(config, client as any)) }); }
  finally { IncusOfflineArchiveHelper.prototype.withGuest = prior; await rm(dataDir, { recursive: true, force: true }); }
}

test('native retained parent pre-mount check uses only acknowledged readonly helper and catches changed source authority', async () => {
  await nativeFixture(async f => {
    await f.runtime.verifyKiloParent(f.v); expect(f.calls).toEqual(['helper', 'read-leaf', 'cleanup']);
    f.client.exec = async () => { f.volume.config['user.agentor.target'] = '/foreign'; return { returnCode: 0 }; };
    await expect(f.runtime.verifyKiloParent(f.v)).rejects.toThrow('changed');
  });
});

test('native failed leaf proof preserves exact volume and awaits helper cleanup', async () => {
  await nativeFixture(async f => {
    const before = structuredClone(f.volume); f.client.exec = async () => ({ returnCode: 1 });
    await expect(f.runtime.verifyKiloParent(f.v)).rejects.toThrow('canonical Kilo');
    expect(f.volume).toEqual(before); expect(f.calls).toEqual(['helper', 'cleanup']);
  });
});


async function dockerFixture(run: (f: any) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'kilo-parent-docker-')), v = { ...source(), purpose: 'persistent-path' as const };
  v.dockerName = 'agentor-persist-' + v.id;
  const raw = await readFile(await archive(dir, [['kilo', 's', MANAGED_KILO_LINK]]));
  let spec: any, present = false, checks = 0, starts = 0;
  const controls = { raw, createUnknown: false, removeUnknown: false };
  const helper = { id: 'd'.repeat(64),
    inspect: async () => {
      if (!present) throw Object.assign(new Error('absent'), { statusCode: 404 });
      return { Id: helper.id, Name: '/' + spec.name, Config: { Labels: spec.Labels } };
    },
    start: async () => { starts++; throw new Error('Probe must never start'); },
    infoArchive: async () => { throw new Error('Resolved HEAD metadata cannot prove literal links'); },
    getArchive: async () => Readable.from([controls.raw]),
    remove: async () => { if (controls.removeUnknown) throw new Error('Unknown cleanup'); present = false; },
  };
  const volume = { Name: v.dockerName, Driver: 'local', Options: {}, CreatedAt: '2026-10-01T00:00:00Z',
    Mountpoint: '/var/lib/docker/volumes/' + v.dockerName + '/_data',
    Labels: { 'agentor.volume-id': v.id, 'agentor.owner-id': v.userId, 'agentor.worker-id': v.workerId } };
  const docker = { createContainer: async (value: any) => {
    spec = value; present = true;
    if (controls.createUnknown) {
      const error = new Error('Lost create acknowledgement'); Object.defineProperty(error, operationSettlement, { value: Promise.resolve() }); throw error;
    }
    return helper;
  }, getContainer: () => helper, getVolume: () => ({ inspect: async () => structuredClone(volume) }) };
  const runtime = new PortableManagedVolumeRuntime(dir, docker as any, { trustedImage: async () => 'sha256:' + 'a'.repeat(64) });
  try { await run({ dir, v, controls, runtime, docker, volume, verify: () => runtime.verifyKiloParent(v, async () => { checks++; }),
    spec: () => spec, present: () => present, checks: () => checks, starts: () => starts }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

test('Docker parent proof uses a never-started readonly no-copy probe, exact literal leaf and acknowledged cleanup', async () => {
  await dockerFixture(async f => {
    await f.verify(); expect(f.present()).toBe(false); expect(f.starts()).toBe(0); expect(f.checks()).toBe(3);
    expect(f.spec()).toMatchObject({ NetworkDisabled: true, Entrypoint: ['/bin/true'], Env: [],
      HostConfig: { ReadonlyRootfs: true, CapDrop: ['ALL'], NetworkMode: 'none',
        Mounts: [{ Type: 'volume', Source: f.v.dockerName, Target: '/volume', ReadOnly: true, VolumeOptions: { NoCopy: true } }] } });
    const managed = new ManagedVolumeRuntime(f.docker, f.dir); managed.trustedImage = async () => 'sha256:' + 'a'.repeat(64);
    await managed.ensureVolume(f.v); expect(f.present()).toBe(false); expect(f.starts()).toBe(0);
    const target = f.volume.Mountpoint;
    f.volume.CreatedAt = '';
    await expect(managed.ensureVolume(f.v)).rejects.toThrow('incarnation'); expect(f.volume.Mountpoint).toBe(target);
  });
});

test('Docker normalized link metadata cannot admit aliases, real/missing Kilo data or extra archive writes', async () => {
  await dockerFixture(async f => {
    for (const members of [[['kilo', 's', '../../home/agent/.agent-data/.kilo/shared-data']],
      [['kilo', 'd']], [], [['kilo', 's', MANAGED_KILO_LINK], ['kilo/db', 'f']]]) {
      f.controls.raw = await readFile(await archive(f.dir, members as Array<[string, string, string?]>));
      await expect(f.verify()).rejects.toThrow(); expect(f.present()).toBe(false); expect(f.starts()).toBe(0);
    }
  });
});

test('Docker probe settles a lost create acknowledgement and retains unknown cleanup without touching source data', async () => {
  await dockerFixture(async f => {
    const before = structuredClone(f.volume); f.controls.createUnknown = true;
    await expect(f.verify()).rejects.toThrow('Lost create'); expect(f.present()).toBe(false);
    f.controls.createUnknown = false; f.controls.removeUnknown = true;
    await expect(f.verify()).rejects.toThrow('Unknown cleanup'); expect(f.present()).toBe(true);
    expect(f.volume).toEqual(before); expect(f.starts()).toBe(0);
  });
});

test('actual ordinary Docker restart verifies parent bytes before desired-state, policy or entrypoint mutation', async () => {
  const volumes = useManagedVolumeManager(), v = { ...source(), purpose: 'persistent-path' as const };
  const original = { init: volumes.init, forWorker: volumes.store.forWorker, mounts: volumes.mounts };
  let checked = 0, mutated = 0;
  const manager = new ContainerManager(new Proxy({}, { get: () => () => { mutated++; throw new Error('Unexpected Docker mutation'); } }) as any, {} as Config);
  manager.registerExternal({ id: v.workerId, userId: v.userId, runtimeKind: 'legacy-docker', containerId: 'a'.repeat(64), status: 'stopped' } as any);
  volumes.init = async () => {}; volumes.store.forWorker = () => [v];
  volumes.mounts = async () => { checked++; throw new Error('canonical Kilo fixture failure'); };
  (manager as any).persistDesiredRuntimeStatus = async () => { mutated++; };
  try {
    await expect((manager as any).restartUnlocked(v.workerId, true)).rejects.toThrow('canonical Kilo fixture failure');
    expect(checked).toBe(1); expect(mutated).toBe(0);
  } finally { volumes.init = original.init; volumes.store.forWorker = original.forWorker; volumes.mounts = original.mounts; }
});
