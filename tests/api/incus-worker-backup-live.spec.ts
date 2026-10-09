import { test, expect } from '@playwright/test';
import { mkdir, readFile, lstat, readlink, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { extractBundle } from '../../orchestrator/server/utils/worker-export';
import { useConfig, useWorkerStore, usePortMappingStore, useDomainMappingStore } from '../../orchestrator/server/utils/services';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { assertOfflineArchiveHelpersSettled } from '../../orchestrator/server/utils/incus-offline-archive-helper';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
// Match Nuxt's automatic bindings while using the actual isolated stores.
(globalThis as any).usePortMappingStore ??= usePortMappingStore;
(globalThis as any).useDomainMappingStore ??= useDomainMappingStore;
(globalThis as any).useWorkerConfigStore ??= useWorkerConfigStore;

test('real production running, stopped and archived native export preserves canonical metadata without changing source compute', async () => {
  test.skip(process.env.INCUS_BACKUP_CAPTURE_TEST !== 'true', 'Explicit serial disposable native backup gate');
  test.setTimeout(600_000);
  // Core export also fences the global managed-storage registry. Share its
  // actual config/store; never erase the explicit service DATA_DIR on cleanup.
  const config = useConfig();
  Object.assign(config, { containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusNetwork: 'incusbr0',
    incusStoragePool: 'default', incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase9-host-mounts',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' });
  const id = randomUUID(), owner = { id, userId: 'native-backup-' + randomUUID(), containerName: 'agentor-worker-' + id };
  const dataDir = join(config.dataDir, 'native-backup-proof-' + id);
  await mkdir(dataDir, { mode: 0o700 });
  const store = useWorkerStore(); await store.init(); await useManagedVolumeManager().init();
  await assertOfflineArchiveHelpersSettled(config.dataDir);
  const runtime = new IncusWorkerRuntime(config);
  const docker = new Proxy({}, { get: () => () => { throw new Error('Native export must not use Docker'); } });
  const manager = new ContainerManager(docker as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const environment = { id: 'backup-gate', name: 'Backup gate', envVars: '', dockerEnabled: false,
    networkMode: 'full', allowedDomains: [], setupScript: '',
    exposeApis: { portMappings: false, domainMappings: false, usage: false }, cpuLimit: 1, memoryLimit: '1g' };
  manager.setEnvironmentStore({ getById: () => environment } as any);
  let submitted = false, incarnation: string | undefined, cleaned = false, failure: unknown;
  try {
    await store.upsert({ id, userId: owner.userId, status: 'active', runtimeKind: 'incus-vm',
      displayName: 'Native archive gate', desiredRuntimeStatus: 'running' } as any);
    console.info('Exact native backup fixture', { dataDir, serviceDataDir: config.dataDir, installation: await backupInstallationId(config.dataDir), ...owner });
    submitted = true;
    const instance = await runtime.create({ ...owner, start: true, dockerEnabled: false,
      userEnv: zeroUserEnvVars(owner.userId), environmentJson: environment, capabilitiesJson: [], instructionsJson: [],
      workerJson: { id, displayName: 'Native archive gate', repos: [], initScript: '', gitName: '', gitEmail: '' } });
    incarnation = instance.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    manager.registerExternal({ ...owner, containerId: 'incus:' + incarnation, runtimeKind: 'incus-vm',
      status: 'running', environmentId: environment.id, displayName: 'Native archive gate',
      imageName: config.incusWorkerImage, imageId: instance.config['image.source_image_id'],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const exec = async (command: string[]) => {
      const result = await runtime.client.exec(owner.containerName, command);
      expect(result.returnCode, result.stderr).toBe(0); return result.stdout;
    };
    await exec(['/usr/bin/python3', '-c', `import os
os.makedirs('/workspace/nested [share]*',exist_ok=True)
with open('/workspace/canonical.bin','wb') as target: target.write(bytes([0,255,128,10])*32768)
os.chmod('/workspace/canonical.bin',0o640)
os.chown('/workspace/canonical.bin',12345,23456)
os.setxattr('/workspace/canonical.bin','user.agentor_binary',bytes([0,255,128,10]))
os.link('/workspace/canonical.bin','/workspace/canonical-hardlink')
os.symlink('canonical.bin','/workspace/canonical-symlink')
for directory in ['.codex','.kilo/config','.kilo/shared-data']:
 os.makedirs('/home/agent/.agent-data/'+directory,exist_ok=True)
for path in ['.codex/auth.json','.kilo/config/secret.json','.kilo/shared-data/secret.json']:
 with open('/home/agent/.agent-data/'+path,'w') as target: target.write('dummy-secret-MUST-NOT-ENTER')
with open('/home/agent/.agent-data/.codex/sessions','w') as target: target.write('persistent-agent-session')
os.setxattr('/home/agent/.agent-data/.codex/sessions','user.agentor_binary',bytes([255,0,129,1]))
os.makedirs('/home/agent/.agent-data/guest-bind',exist_ok=True)
`]);
    await exec(['mount', '-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', '/workspace/nested [share]*']);
    await exec(['mount', '--bind', '/home/agent/.agent-data/.kilo/config', '/home/agent/.agent-data/guest-bind']);
    await exec(['/usr/bin/python3', '-c', "open('/workspace/nested [share]*/outside','w').write('nested-MUST-NOT-ENTER')"]);
    const boot = await exec(['cat', '/proc/sys/kernel/random/boot_id']);
    const servicePid = await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service']);
    await expect(manager.exportWorker(id, { includeRootfs: true })).rejects.toMatchObject({ code: 'INCUS_DISPOSABLE_ROOTFS' });
    const bundle = join(dataDir, 'captured.tar'), result = await manager.exportWorker(id, { includeRootfs: false });
    await pipeline(result.stream, createWriteStream(bundle, { mode: 0o600 }));
    const extracted = await extractBundle(bundle, join(dataDir, 'extracted'));
    expect(extracted.manifest.runtime?.kind).toBe('incus-vm');
    expect(extracted.manifest.contents.rootfs).toBe(false);
    expect(JSON.stringify(extracted.manifest.runtime)).not.toContain('fingerprint');
    const run = promisify(execFile), restored = join(dataDir, 'inspected'); await mkdir(restored);
    await run('/usr/bin/tar', ['--xattrs', '--xattrs-include=*', '--no-same-owner', '-xzpf', extracted.workspacePath!, '-C', restored]);
    expect(await readFile(join(restored, 'workspace/canonical.bin')))
      .toEqual(Buffer.from(Array.from({ length: 32768 }, () => [0,255,128,10]).flat()));
    expect((await lstat(join(restored, 'workspace/canonical.bin'))).ino)
      .toBe((await lstat(join(restored, 'workspace/canonical-hardlink'))).ino);
    expect(await readlink(join(restored, 'workspace/canonical-symlink'))).toBe('canonical.bin');
    const metadata = await run('python3', ['-c', `import json,os,sys,tarfile
with tarfile.open(sys.argv[1],'r:gz') as archive:
 entry=archive.getmember('workspace/canonical.bin')
 print(json.dumps({'uid':entry.uid,'gid':entry.gid,'mode':entry.mode,'names':archive.getnames(),
 'xattr':list(os.getxattr(sys.argv[2],'user.agentor_binary'))}))`, extracted.workspacePath!, join(restored, 'workspace/canonical.bin')]);
    const observed = JSON.parse(metadata.stdout);
    expect(observed).toMatchObject({ uid: 12345, gid: 23456, mode: 0o640, xattr: [0,255,128,10] });
    expect(observed.names.some((name: string) => name.includes('nested [share]*'))).toBe(false);
    const agents = await run('/usr/bin/tar', ['-xzOf', extracted.agentsPath!, '.agent-data/.codex/sessions']);
    expect(agents.stdout).toBe('persistent-agent-session');
    const listing = await run('/usr/bin/tar', ['-tzf', extracted.agentsPath!]);
    expect(listing.stdout).not.toContain('/auth.json');
    expect(listing.stdout).not.toContain('.kilo/config'); expect(listing.stdout).not.toContain('.kilo/shared-data');
    expect(listing.stdout).not.toContain('guest-bind');
    await run('/usr/bin/tar', ['--xattrs', '--xattrs-include=*', '--no-same-owner', '-xzpf', extracted.agentsPath!, '-C', restored]);
    const agentAttribute = await run('python3', ['-c',
      "import os,sys,json; print(json.dumps(list(os.getxattr(sys.argv[1],'user.agentor_binary'))))",
      join(restored, '.agent-data/.codex/sessions')]);
    expect(JSON.parse(agentAttribute.stdout)).toEqual([255,0,129,1]);
    expect(await exec(['cat', '/proc/sys/kernel/random/boot_id'])).toBe(boot);
    expect(await exec(['systemctl', 'show', '--property=MainPID', '--value', 'agentor-worker.service'])).toBe(servicePid);
    expect(store.get(owner.userId, id)).toMatchObject({ runtimeKind: 'incus-vm', desiredRuntimeStatus: 'running' });
    const info = manager.get(id)!;
    await runtime.stop(owner, incarnation); info.status = 'stopped';
    await store.upsert({ ...store.get(owner.userId, id)!, desiredRuntimeStatus: 'stopped' });
    const original = await runtime.client.getInstance(owner.containerName);
    expect(original.status).toBe('Stopped'); expect(original.config['volatile.uuid']).toBe(incarnation);
    const canonical = async () => Promise.all(['workspace', 'agents'].map(role =>
      runtime.client.getCustomVolume(config.incusStoragePool, owner.containerName + '-' + role)));
    let baseline = await canonical();
    const nativeExec = runtime.client.execStream.bind(runtime.client), seenHelpers = new Set<string>();
    runtime.client.execStream = async (name, command, options) => {
      if (name !== owner.containerName && command[0] === '/usr/bin/python3') {
        const helper = await runtime.client.getInstance(name);
        expect(helper.config['user.agentor.worker']).toBe(id);
        expect(helper.profiles).toEqual([]);
        expect(Object.values(helper.expanded_devices ?? helper.devices).some(device => device.type === 'nic')).toBe(false);
        for (const role of ['workspace', 'agents']) expect(helper.devices[role]).toMatchObject({
          source: owner.containerName + '-' + role, pool: config.incusStoragePool, readonly: 'true' });
        const isolation = await runtime.client.exec(name, ['bash', '-ec',
          'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; findmnt -n -o OPTIONS --mountpoint /workspace; findmnt -n -o OPTIONS --mountpoint /home/agent/.agent-data']);
        expect(isolation.returnCode, isolation.stderr).toBe(0);
        expect(isolation.stdout.trim().split('\n').every(line => line.split(',').includes('ro'))).toBe(true);
        if (store.get(owner.userId, id)?.status === 'active') {
          const current = await runtime.client.getInstance(owner.containerName);
          expect(current.status).toBe('Stopped'); expect(current.config['volatile.uuid']).toBe(incarnation);
          expect(current.devices).toEqual(original.devices);
        } else await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
        const during = await canonical();
        for (const [index, volume] of during.entries()) {
          expect(volume.config).toEqual(baseline[index]!.config);
          expect(volume.created_at).toBe(baseline[index]!.created_at);
          expect(volume.used_by.length).toBe(baseline[index]!.used_by.length + 1);
        }
        seenHelpers.add(name);
      }
      return nativeExec(name, command, options);
    };
    for (const mode of ['stopped', 'archived']) {
      if (mode === 'archived') {
        await runtime.remove(owner, incarnation); manager.unregisterExternal(id);
        await store.upsert({ ...store.get(owner.userId, id)!, status: 'archived', desiredRuntimeStatus: 'stopped' });
        baseline = await canonical();
      }
      const target = join(dataDir, mode + '.tar'), captured = await manager.exportWorker(id, { includeRootfs: false });
      await pipeline(captured.stream, createWriteStream(target, { mode: 0o600 }));
      const offline = await extractBundle(target, join(dataDir, mode + '-bundle'));
      expect(offline.manifest.runtime).toEqual(extracted.manifest.runtime);
      const inspectDir = join(dataDir, mode + '-inspect'); await mkdir(inspectDir);
      await run('/usr/bin/tar', ['--xattrs', '--xattrs-include=*', '--no-same-owner', '-xzpf', offline.workspacePath!, '-C', inspectDir]);
      expect(await readFile(join(inspectDir, 'workspace/canonical.bin'))).toEqual(await readFile(join(restored, 'workspace/canonical.bin')));
      expect((await lstat(join(inspectDir, 'workspace/canonical.bin'))).ino)
        .toBe((await lstat(join(inspectDir, 'workspace/canonical-hardlink'))).ino);
      expect(await readlink(join(inspectDir, 'workspace/canonical-symlink'))).toBe('canonical.bin');
      const attr = await run('python3', ['-c',
        "import os,sys,json; print(json.dumps(list(os.getxattr(sys.argv[1],'user.agentor_binary'))))", join(inspectDir, 'workspace/canonical.bin')]);
      expect(JSON.parse(attr.stdout)).toEqual([0,255,128,10]);
      const listing = await run('/usr/bin/tar', ['-tzf', offline.agentsPath!]);
      expect(listing.stdout).not.toContain('/auth.json'); expect(listing.stdout).not.toContain('.kilo/config');
      expect(listing.stdout).not.toContain('.kilo/shared-data');
      expect((await run('/usr/bin/tar', ['-xzOf', offline.agentsPath!, '.agent-data/.codex/sessions'])).stdout)
        .toBe('persistent-agent-session');
      expect(await canonical()).toEqual(baseline);
      expect(await readdir(join(config.dataDir, 'incus-backup-helpers'))).toEqual([]);
      if (mode === 'stopped') {
        const current = await runtime.client.getInstance(owner.containerName);
        expect(current.status).toBe('Stopped'); expect(current.devices).toEqual(original.devices);
        expect(current.config['volatile.uuid']).toBe(incarnation);
      }
    }
    expect(seenHelpers.size).toBe(2);
    await assertOfflineArchiveHelpersSettled(config.dataDir);
    await runtime.remove(owner, incarnation); await runtime.removeStorage(owner);
    await store.delete(owner.userId, id); manager.unregisterExternal(id); cleaned = true;
    console.info('Production running/stopped/archived canonical exports, binary metadata, readonly networkless helpers and unchanged source authority verified');
  } catch (error) { failure = error; console.error('Native backup capture gate failed', error); throw error; }
  finally {
    let cleanupError: unknown;
    try {
      if (!failure && submitted && !cleaned && incarnation) {
        await assertOfflineArchiveHelpersSettled(config.dataDir);
        await runtime.remove(owner, incarnation); await runtime.removeStorage(owner);
        await store.delete(owner.userId, id); manager.unregisterExternal(id); cleaned = true;
      }
    } catch (error) {
      cleanupError = error;
      console.error('Captured native backup fixture cleanup failed; diagnostic authority retained', error);
    } finally {
      runtime.client.dispose();
      if (!cleaned && submitted) console.error('Native backup fixture and helper authority retained for identity recovery', {
        dataDir, serviceDataDir: config.dataDir, incarnation, ...owner });
    }
    if (cleanupError && !failure) throw cleanupError;
  }
});
