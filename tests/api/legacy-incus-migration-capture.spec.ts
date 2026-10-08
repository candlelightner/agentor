import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { captureLegacyMigrationArchive, legacyMigrationMountIdentity, type LegacyMigrationCaptureOptions,
  type LegacyMigrationReaderOptions, type LegacyMigrationDockerClient } from '../../orchestrator/server/utils/legacy-incus-migration-capture';

async function fixture(role: LegacyMigrationCaptureOptions['role'] = 'workspace') {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-reader-'));
  const source = { containerId: 'a'.repeat(64), createdAt: '2026-10-08T00:00:00Z', imageId: 'sha256:' + 'b'.repeat(64) };
  const trustedImageId = 'sha256:' + 'c'.repeat(64), helperId = 'd'.repeat(64);
  const root = { workspace: 'workspace', agents: '.agent-data', docker: 'docker', managed: 'volume' }[role];
  await mkdir(join(dir, root), { mode: 0o700 });
  const bytes = Buffer.from([0, 255, 128, 10, 61, 0]); await writeFile(join(dir, root, 'data'), bytes, { mode: 0o640 });
  execFileSync('python3', ['-c', 'import os,sys; p=sys.argv[1]; os.link(p+"/data",p+"/hard");os.symlink("data",p+"/sym");os.setxattr(p+"/data","user.binary",bytes([0,255,128,10,61,0]));os.utime(p+"/data",ns=(1700000000123456789,1700000000987654321))', join(dir, root)]);
  const raw = execFileSync('tar', ['--sort=name', '--format=pax', '--numeric-owner', '--owner=12345', '--group=23456',
    '--acls', '--xattrs', '--xattrs-include=*', '-cpf', '-', '-C', dir, root]);
  const events: string[] = [], sourceInfo = { Id: source.containerId, Created: source.createdAt, Image: source.imageId,
    State: { Running: false, Paused: false, Restarting: false, Pid: 0, Status: 'exited' },
    Mounts: [{ Type: 'volume', Name: 'original-volume', Source: '/var/lib/docker/volumes/original-volume/_data', Destination: '/workspace', RW: true }] };
  let spec: LegacyMigrationReaderOptions | undefined, running = false, stopped = false, removed = false;
  let wrongHelper = false, failExec = false, failStop = false, failRemove = false, invalidRaw = false, definiteExecFailure = false, validateCount = 0, revokeAt = 0;
  const settlement = Promise.resolve();
  const detachedVolume = { Name: 'original-volume', Mountpoint: '/var/lib/docker/volumes/original-volume/_data',
    Driver: 'local', CreatedAt: '2026-10-08T00:00:00Z', Labels: { 'agentor.volume-owner': 'source-owner' }, Options: {} };
  let foreignReferences = false;
  let shuffleMounts = false, sourceReads = 0, helperReads = 0;
  const helperMounts = () => {
    const mounts = spec!.HostConfig!.Mounts!.map(item => ({ Type: item.Type, Source: item.Source,
      ...(item.Type === 'volume' ? { Name: item.Source } : {}), Destination: item.Target, RW: !item.ReadOnly }));
    return shuffleMounts && helperReads++ % 2 ? mounts.reverse() : mounts;
  };
  const helper = { id: helperId,
    inspect: async () => ({ Id: helperId, Created: '2026-10-08T01:00:00Z', Image: wrongHelper ? source.imageId : trustedImageId,
      Config: { User: spec!.User, Labels: spec!.Labels }, HostConfig: spec!.HostConfig,
      Mounts: helperMounts(),
      State: { Running: running, Pid: running ? 42 : 0, Status: stopped ? 'exited' : running ? 'running' : 'created' } }),
    start: async () => { events.push('start'); running = true; },
    stop: async () => { events.push('stop'); if (failStop) throw new Error('Unknown stop'); running = false; stopped = true; },
    remove: async () => { events.push('remove'); if (failRemove) throw new Error('Unknown remove'); removed = true; },
  };
  const client = { getImage: () => ({ inspect: async () => ({ Id: trustedImageId, Config: { Env: ['PATH=/usr/bin:/bin', 'NODE_VERSION=22'] } }) }),
    getContainer: (id: string) => { expect(id).toBe(sourceInfo.Id); return { inspect: async () => {
      const info = structuredClone(sourceInfo); if (shuffleMounts && sourceReads++ % 2) info.Mounts.reverse(); return info;
    } }; },
    getVolume: () => ({ inspect: async () => structuredClone(detachedVolume) }),
    listContainers: async () => foreignReferences ? [{ Id: 'e'.repeat(64) }] : spec ? [{ Id: helperId }] : [],
    createContainer: async (options: LegacyMigrationReaderOptions) => { spec = options; events.push('create'); return helper; } };
  const options: LegacyMigrationCaptureOptions = { docker: { execCapture: async (id, command, opts) => {
    expect(id).toBe(helperId); expect(command).toEqual(['/bin/sh', '-ec',
      "tar --version | grep -q 'GNU tar'; exec tar --sort=name --format=pax --numeric-owner --acls --xattrs --xattrs-include='*' -cpf /out/archive.tar -C /source " + root]);
    expect(opts).toMatchObject({ user: '0:0', timeoutMs: 45 * 60_000 }); events.push('exec');
    if (failExec) { const error = new Error('Unknown exec completion'); Object.defineProperty(error, operationSettlement, { value: settlement }); throw error; }
    await writeFile(join(spec!.HostConfig!.Mounts![1]!.Source!, 'archive.tar'), invalidRaw ? Buffer.from('invalid') : raw);
    return { exitCode: definiteExecFailure ? 2 : 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  } }, client: client as unknown as LegacyMigrationDockerClient, trustedImageId, source, role,
  mount: { Type: 'volume', Source: 'original-volume', Destination: '/workspace' }, outputPath: join(dir, 'capture.tar'),
  validate: async () => { events.push('validate'); if (++validateCount === revokeAt) throw new Error('Source authority changed'); } };
  return { dir, options, events, raw, sourceInfo, helperId, client, detachedVolume, settlement, spec: () => spec!, removed: () => removed,
    shuffle: () => { shuffleMounts = true; sourceInfo.Mounts.push({ Type: 'volume', Name: 'other-volume',
      Source: '/var/lib/docker/volumes/other-volume/_data', Destination: '/other', RW: false }); },
    fail: (mode: string) => { if (mode === 'helper') wrongHelper = true; if (mode === 'exec') failExec = true;
      if (mode === 'stop') failStop = true; if (mode === 'remove') failRemove = true; if (mode === 'archive') invalidRaw = true;
      if (mode === 'revoke') revokeAt = 4; if (mode === 'definite') definiteExecFailure = true;
      if (mode === 'references') foreignReferences = true; },
    cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('reordered Docker source and helper mounts preserve every identity field and still capture unchanged bytes', async () => {
  const f = await fixture();
  try {
    f.shuffle();
    const mounts = structuredClone(f.sourceInfo.Mounts);
    expect(legacyMigrationMountIdentity([...mounts].reverse() as Parameters<typeof legacyMigrationMountIdentity>[0]))
      .toEqual(legacyMigrationMountIdentity(mounts as Parameters<typeof legacyMigrationMountIdentity>[0]));
    expect(legacyMigrationMountIdentity([{ ...mounts[0]!, RW: false }, mounts[1]!] as Parameters<typeof legacyMigrationMountIdentity>[0]))
      .not.toEqual(legacyMigrationMountIdentity(mounts as Parameters<typeof legacyMigrationMountIdentity>[0]));
    await captureLegacyMigrationArchive(f.options);
    expect(await readFile(f.options.outputPath)).toEqual(f.raw); expect(f.removed()).toBe(true);
  } finally { await f.cleanup(); }
});

for (const role of ['workspace', 'agents', 'docker', 'managed'] as const) test(`legacy ${role} migration capture keeps unchanged GNU/PAX bytes with fixed trusted reader`, async () => {
  const f = await fixture(role); try {
    const original = structuredClone(f.sourceInfo);
    expect(await captureLegacyMigrationArchive(f.options)).toBe(f.options.outputPath);
    expect(await readFile(f.options.outputPath)).toEqual(f.raw);
    expect(f.sourceInfo).toEqual(original); expect(f.removed()).toBe(true);
    expect((await readdir(f.dir)).some(name => name.startsWith('.legacy-migration-capture-'))).toBe(false);
    expect(f.spec()).toMatchObject({ Image: f.options.trustedImageId, User: '0:0', Env: ['LC_ALL=C', 'LANG=C'],
      Entrypoint: ['/bin/sleep'], Cmd: ['infinity'], Healthcheck: { Test: ['NONE'] }, NetworkDisabled: true,
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
        CapAdd: ['DAC_READ_SEARCH', 'SYS_ADMIN'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' } } });
    expect(f.spec().HostConfig!.Mounts![0]).toMatchObject({ ReadOnly: true, VolumeOptions: { NoCopy: true } });
    expect(f.spec().HostConfig!.Mounts).toHaveLength(2); expect(f.events.filter(event => event === 'exec')).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('running, replaced and wrong-mount sources are rejected before helper creation', async () => {
  for (const wrong of ['running', 'identity', 'mount']) {
    const f = await fixture(); try {
      if (wrong === 'running') f.sourceInfo.State.Running = true;
      if (wrong === 'identity') f.sourceInfo.Created = 'changed';
      if (wrong === 'mount') f.options.mount.Source = 'foreign';
      await expect(captureLegacyMigrationArchive(f.options)).rejects.toThrow();
      expect(f.events).not.toContain('create'); expect(f.removed()).toBe(false);
    } finally { await f.cleanup(); }
  }
});

test('unsafe staging, output overwrite and mutable caller identity cannot grant new source authority', async () => {
  for (const wrong of ['symlink', 'overwrite', 'mutated']) {
    const f = await fixture(); try {
      if (wrong === 'symlink') { const linked = join(f.dir, 'linked'); await symlink(f.dir, linked); f.options.outputPath = join(linked, 'capture.tar'); }
      if (wrong === 'overwrite') await writeFile(f.options.outputPath, 'preserve');
      if (wrong === 'mutated') f.options.validate = async () => { f.options.mount.Source = 'foreign'; f.options.source.containerId = 'e'.repeat(64); };
      if (wrong === 'mutated') { await captureLegacyMigrationArchive(f.options); expect(f.spec().HostConfig!.Mounts![0]!.Source).toBe('original-volume'); }
      else { await expect(captureLegacyMigrationArchive(f.options)).rejects.toThrow(); expect(f.events).not.toContain('create'); }
      if (wrong === 'overwrite') expect(await readFile(f.options.outputPath, 'utf8')).toBe('preserve');
    } finally { await f.cleanup(); }
  }
});

test('unknown helper identity, exec, stop and removal retain exact scratch without retry and preserve settlement', async () => {
  for (const mode of ['helper', 'exec', 'stop', 'remove']) {
    const f = await fixture(); try {
      f.fail(mode);
      const error = await captureLegacyMigrationArchive(f.options).catch(error => error);
      expect(error).toMatchObject({ code: 'LEGACY_MIGRATION_CAPTURE_RETAINED', helperId: f.helperId });
      if (mode === 'exec') expect(error[operationSettlement]).toBe(f.settlement);
      expect(f.removed()).toBe(false); expect(f.events.filter(event => event === 'create')).toHaveLength(1);
      expect(f.events.filter(event => event === 'stop')).toHaveLength(mode === 'stop' || mode === 'remove' ? 1 : 0);
      expect((await readdir(f.dir)).filter(name => name.startsWith('.legacy-migration-capture-'))).toHaveLength(1);
    } finally { await f.cleanup(); }
  }
});

test('definite GNU failure, schema rejection and revoked authority clean only confirmed exact terminated reader', async () => {
  for (const mode of ['definite', 'archive', 'revoke']) {
    const f = await fixture(); try {
      f.fail(mode);
      const error = await captureLegacyMigrationArchive(f.options).catch(error => error);
      expect(error).toBeInstanceOf(Error); expect(error).not.toHaveProperty('code', 'LEGACY_MIGRATION_CAPTURE_RETAINED');
      expect(f.removed()).toBe(true); expect(f.events.filter(event => event === 'stop')).toHaveLength(1);
      expect((await readdir(f.dir)).some(name => name.startsWith('.legacy-migration-capture-'))).toBe(false);
    } finally { await f.cleanup(); }
  }
});

test('explicit retained-volume admission requires caller authorization, unchanged volume identity and no foreign references', async () => {
  for (const mode of ['accepted', 'no-flag', 'references', 'changed-volume']) {
    const f = await fixture('docker'); try {
      f.sourceInfo.Mounts = []; f.options.allowDetached = mode !== 'no-flag';
      if (mode === 'references') f.fail(mode);
      if (mode === 'changed-volume') { let validations = 0; f.options.validate = async () => { if (++validations === 2) f.detachedVolume.CreatedAt = 'replacement'; }; }
      if (mode === 'accepted') { await captureLegacyMigrationArchive(f.options); expect(await readFile(f.options.outputPath)).toEqual(f.raw); }
      else { await expect(captureLegacyMigrationArchive(f.options)).rejects.toThrow(); expect(f.events).not.toContain('create'); }
    } finally { await f.cleanup(); }
  }
});

test('credential-bearing trusted image and already cancelled capture allocate no helper', async () => {
  for (const mode of ['env', 'cancel']) {
    const f = await fixture(); try {
      if (mode === 'env') f.client.getImage = () => ({ inspect: async () => ({ Id: f.options.trustedImageId, Config: { Env: ['SECRET=never-emit'] } }) });
      else { const controller = new AbortController(); controller.abort(); f.options.signal = controller.signal; }
      await expect(captureLegacyMigrationArchive(f.options)).rejects.toThrow(); expect(f.events).not.toContain('create');
    } finally { await f.cleanup(); }
  }
});
