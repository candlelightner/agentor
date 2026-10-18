import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusOfflineArchiveHelper, assertOfflineArchiveHelpersSettled } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { prepareIncusCanonicalRestorePayload } from '../../orchestrator/server/utils/incus-canonical-restore';
import { sha256File } from '../../orchestrator/server/utils/instance-backup-bundle';

const run = promisify(execFile);

/** Approved disposable endpoint only. This is a fixed writer capability gate,
 * not public original-backup integration or another archive/copy mechanism. */
test('real fixed workspace helper writes only the canonical workspace while original VM stays stopped', async () => {
  const stage = process.env.INCUS_ORIGINAL_WORKSPACE_STAGE_TEST === 'true';
  test.skip(process.env.INCUS_ORIGINAL_WORKSPACE_TEST !== 'true' && !stage, 'Explicit serial approved original-workspace capability gate');
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-original-workspace-'));
  const id = randomUUID(), userId = randomUUID();
  const config = { ...loadConfig(), dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const owner = { id, userId, containerName: config.containerPrefix + '-' + id };
  const opts = { ...owner, start: true, dockerEnabled: true, cpuLimit: 2, memoryLimit: '2GiB',
    userEnv: zeroUserEnvVars(userId), capabilitiesJson: [], instructionsJson: [],
    environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: 'Fixed workspace writer fixture', repos: [], initScript: '', gitName: '', gitEmail: '' },
  } satisfies IncusWorkerOptions;
  const runtime = new IncusWorkerRuntime(config), installation = await backupInstallationId(dataDir);
  // Dummy fixture only: retain bounded fixed-command diagnostics when an
  // authoritative cleanup fence supersedes the callback's original failure.
  // Never log command bodies, runtime environment, or worker stream content
  // in production; this fixture has no account/secret grants.
  const execStream = runtime.client.execStream.bind(runtime.client);
  runtime.client.execStream = async (...args: Parameters<typeof execStream>) => {
    const session = await execStream(...args);
    let diagnostic = '';
    session.stderr.on('data', chunk => {
      if (diagnostic.length < 4096) diagnostic += chunk.toString().slice(0, 4096 - diagnostic.length);
    });
    void session.result.then(code => {
      if (code) console.error('Dummy workspace fixed command failed', { executable: args[1][0], code, diagnostic });
    }).catch(() => {});
    return session;
  };
  const helper = new IncusOfflineArchiveHelper(config, runtime.client, installation);
  const names = ['workspace', 'agents', 'docker'].map(role => owner.containerName + '-' + role);
  const marker = 'original-marker-' + id;
  let allocated = false, operationSettled = true, writerSettled = true, verified = false, cleaned = false;
  let incarnation: string | undefined, helperName: string | undefined;
  const execute = async (name: string, command: string[]) => {
    const result = await runtime.client.exec(name, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    console.info('Exact fixed workspace writer fixture', { dataDir, installation, stage, ...owner });
    const archive = join(dataDir, 'workspace.tar.gz'); let archiveHash: string | undefined;
    if (stage) {
      // Same fixed-root GNU/PAX schema and canonical payload validator as
      // accepted native restores; prove cheap metadata admission before a VM.
      const input = join(dataDir, 'input'), raw = join(dataDir, 'raw-check');
      await mkdir(input); await mkdir(raw, { mode: 0o700 });
      await run('sudo', ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1]+'/workspace';os.mkdir(p)
f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]));os.link(f,p+'/hard')
os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]))
os.utime(f,ns=(1700000000123456789,1700000000987654321))
os.chown(p,12345,23456);os.chmod(p,0o751);os.setxattr(p,'user.root',bytes([0,255,128,10,61,0]))
os.utime(p,ns=(1700000000123456789,1700000000123456789))
`, input]);
      await run('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', input, '-czf', archive, 'workspace']);
      await run('sudo', ['chown', `${process.getuid!()}:${process.getgid!()}`, archive]);
      const admitted = await prepareIncusCanonicalRestorePayload(archive, 'workspace', raw);
      expect(admitted.entries).toBe(3); expect(admitted.expandedBytes).toBe(6); archiveHash = await sha256File(archive);
      // Only the disposable authoring directory is returned to the test user
      // for cleanup; numeric metadata remains fixed inside the admitted gzip.
      await run('sudo', ['chown', `${process.getuid!()}:${process.getgid!()}`, join(input, 'workspace')]);
    }
    await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
    for (const name of names)
      await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
    allocated = true; operationSettled = false;
    const created = await runtime.create(opts); incarnation = created.config['volatile.uuid'];
    if (!incarnation) throw new Error('Original workspace source creation omitted exact incarnation');
    operationSettled = true;
    await execute(owner.containerName, ['python3', '-c',
      'import os,sys; m=sys.argv[1]; ' +
      '[(open(p+"/"+m,"wb").write(v)) for p,v in [("/workspace",b"original-workspace"),("/home/agent/.agent-data",b"original-agents"),("/root",b"original-root"),("/var/lib/docker",b"original-docker")]]', marker]);
    if (stage) await execute(owner.containerName, ['python3', '-c', 'import sys;open("/workspace/old-only-"+sys.argv[1],"wb").write(b"must disappear")', id]);
    operationSettled = false; await runtime.stop(owner, incarnation); operationSettled = true;
    const original = await runtime.client.getInstance(owner.containerName);
    expect(original.status).toBe('Stopped'); expect(original.config['volatile.uuid']).toBe(incarnation);
    expect(await runtime.matchesWorkerIdentity(original, id, userId)).toBe(true);
    const volumes = await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    const assertSource = async (activeHelper?: string) => {
      const current = await runtime.client.getInstance(owner.containerName);
      expect(current).toEqual(original); // No source boot, device or metadata mutation by the writer.
      expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true);
      for (const [index, name] of names.entries()) {
        const actual = await runtime.client.getCustomVolume(config.incusStoragePool, name), expected = structuredClone(volumes[index]!);
        if (index === 0 && activeHelper)
          expected.used_by.push('/1.0/instances/' + activeHelper + '?project=' + config.incusProject);
        expect({ ...actual, used_by: actual.used_by.toSorted() }).toEqual({ ...expected, used_by: expected.used_by.toSorted() });
      }
    };
    writerSettled = false;
    const expectedVolumes = structuredClone(volumes);
    if (stage) {
      let validations = 0;
      await runtime.replaceOriginalWorkspace(owner, incarnation, archive, async () => {
        validations++; expect(await runtime.client.getInstance(owner.containerName)).toEqual(original);
        for (const index of [1, 2]) expect(await runtime.client.getCustomVolume(config.incusStoragePool, names[index]!)).toEqual(volumes[index]);
      });
      expect(validations).toBeGreaterThan(1); expect(await sha256File(archive)).toBe(archiveHash);
      expectedVolumes[0]!.config['user.agentor.workspace-preserve-ownership'] = 'true';
      expect(await runtime.client.getInstance(owner.containerName)).toEqual(original);
      expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(expectedVolumes);
      for (const index of [0, 1]) expect(expectedVolumes[index]!.config['user.agentor.preserve-ownership']).toBe(volumes[index]!.config['user.agentor.preserve-ownership']);
    } else {
    await helper.withGuest(owner, { workspaceRestore: true }, assertSource, undefined, async (name, assertHelper) => {
      helperName = name; await assertHelper(); await assertSource(name);
      const guest = await runtime.client.getInstance(name);
      expect(guest.name).not.toBe(owner.containerName); expect(guest.profiles).toEqual([]);
      expect(guest.config['user.agentor.helper']).toBe('workspace-replace');
      expect(guest.config['user.agentor.installation']).toBe(installation);
      expect(guest.config['user.agentor.worker']).toBe(id); expect(guest.config['user.agentor.owner']).toBe(userId);
      expect(guest.config['volatile.base_image']).toBe(guest.config['user.agentor.image']);
      expect(Object.keys(guest.devices).sort()).toEqual(['root', 'workspace']);
      expect(guest.devices.workspace).toEqual({ type: 'disk', pool: config.incusStoragePool,
        source: names[0], path: '/target', readonly: 'false' });
      expect(Object.values(guest.devices).some(device => device.type === 'nic')).toBe(false);
      await execute(name, ['bash', '-ec',
        'test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env; ' +
        '! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; ' +
        'test ! -e /home/agent/.agent-data/"$1"; test ! -e /root/"$1"; test ! -e /var/lib/docker/"$1"', 'bash', marker]);
      await execute(name, ['python3', '-c',
        'import os,sys; p="/target/"+sys.argv[1]; assert open(p,"rb").read()==b"original-workspace"; ' +
        'f=open(p,"wb"); f.write(b"replaced-workspace"); f.flush(); os.fsync(f.fileno()); f.close(); ' +
        'd=os.open("/target",os.O_RDONLY|os.O_DIRECTORY); os.fsync(d); os.close(d)', marker]);
      await assertHelper(); await assertSource(name);
    });
    }
    writerSettled = true;
    if (!stage) await assertSource();
    await assertOfflineArchiveHelpersSettled(dataDir);
    await helper.assertWorkspaceReplacementSettled(owner);
    expect(await readdir(join(dataDir, 'incus-backup-helpers'))).toEqual([]);
    if (!stage) {
      if (!helperName) throw new Error('Acknowledged workspace helper identity missing');
      await expect(runtime.client.getInstance(helperName)).rejects.toMatchObject({ statusCode: 404 });
    }
    // Honest same-incarnation source restart validates bytes. No copied
    // filesystem, extra inspection guest or rootfs-preservation shortcut.
    operationSettled = false; await runtime.start(opts, incarnation); operationSettled = true;
    await execute(owner.containerName, ['python3', '-c',
      'import sys; m=sys.argv[1]; ' +
      (stage ? 'assert not __import__("os").path.lexists("/workspace/"+m); ' : 'assert open("/workspace/"+m,"rb").read()==b"replaced-workspace"; ') +
      'assert open("/home/agent/.agent-data/"+m,"rb").read()==b"original-agents"; ' +
      'assert open("/root/"+m,"rb").read()==b"original-root"; ' +
      'assert open("/var/lib/docker/"+m,"rb").read()==b"original-docker"', marker]);
    if (stage) await execute(owner.containerName, ['python3', '-c', String.raw`
import os,stat,sys
p='/workspace';f=p+'/data';s=os.stat(f);r=os.stat(p)
assert open(f,'rb').read()==bytes([0,255,128,10,61,0])
assert (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_mtime_ns)==(12345,23456,0o640,1700000000987654321)
assert s.st_ino==os.stat(p+'/hard').st_ino and os.getxattr(f,'user.binary')==bytes([0,255,128,10,61,0])
assert (r.st_uid,r.st_gid,stat.S_IMODE(r.st_mode),r.st_mtime_ns)==(12345,23456,0o751,1700000000123456789)
assert os.getxattr(p,'user.root')==bytes([0,255,128,10,61,0])
assert not os.path.lexists(p+'/old-only-'+sys.argv[1])
assert not any(n.startswith('.agentor-restore-') for n in os.listdir(p))
`, id]);
    operationSettled = false; await runtime.stop(owner, incarnation); operationSettled = true;
    const restarted = await runtime.client.getInstance(owner.containerName);
    expect(restarted.status).toBe('Stopped'); expect(restarted.config['volatile.uuid']).toBe(incarnation);
    expect(restarted.devices).toEqual(original.devices); expect(restarted.profiles).toEqual(original.profiles);
    // Tap/boot volatile state may legitimately change during the validation
    // reboot; source authority and immutable-image identity must not.
    const authority = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('volatile.')));
    expect(authority(restarted.config)).toEqual(authority(original.config));
    expect(restarted.config['volatile.base_image']).toBe(original.config['volatile.base_image']);
    expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(expectedVolumes);
    verified = true;
    console.info('Fixed workspace writer verified: pinned networkless helper, stopped source UUID/devices, canonical workspace changed, root/agents/Docker markers unchanged, acknowledged helper/receipt cleanup');
  } catch (error) {
    const causes: string[] = [];
    for (let current: unknown = error; current instanceof Error && causes.length < 4; current = current.cause)
      causes.push(current.message.slice(0, 1024));
    console.error('Dummy workspace failure chain', causes);
    throw error;
  } finally {
    if (allocated && verified && operationSettled && writerSettled && incarnation) {
      const current = await runtime.client.getInstance(owner.containerName);
      expect(current.config['volatile.uuid']).toBe(incarnation); expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true);
      await assertOfflineArchiveHelpersSettled(dataDir);
      await runtime.remove(owner, incarnation); await runtime.removeStorage(owner); cleaned = true;
    } else if (!allocated) cleaned = true;
    if (cleaned) await rm(dataDir, { recursive: true, force: true });
    else console.error('Exact unconfirmed original-workspace fixture retained', { dataDir, installation, ...owner, incarnation, helperName });
    if (verified) expect(cleaned, 'Exact acknowledged fixture cleanup must complete').toBe(true);
  }
});
