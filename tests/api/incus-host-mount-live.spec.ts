import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { Config } from '../../orchestrator/server/utils/config';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { HostMountStore } from '../../orchestrator/server/utils/host-mount-store';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { StorageManager } from '../../orchestrator/server/utils/storage';
import { UserCredentialManager } from '../../orchestrator/server/utils/user-credentials';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusHostMountClient } from '../../orchestrator/server/utils/incus-host-mount-client';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { useHostMountStore } from '../../orchestrator/server/utils/services';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

test('real production VM enforces granted host RO/RW exports against guest root', async () => {
  test.skip(process.env.INCUS_HOST_MOUNT_TEST !== 'true', 'Explicit serial disposable host gate');
  test.setTimeout(720_000);
  const run = promisify(execFile), access = ['-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
    '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes'];
  const destination = 'kata-test@172.19.0.1';
  const q = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const remote = async (command: string) => (await run('ssh', ['-p', '22375', ...access, destination, command],
    { timeout: 30_000 })).stdout.trim();
  const copy = async (sources: string[], target: string, recursive = false) => {
    await run('scp', ['-P', '22375', ...access, ...(recursive ? ['-r'] : []), ...sources,
      `${destination}:${target}`], { timeout: 30_000 });
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-host-mount-live-'));
  const installation = await backupInstallationId(dataDir), id = randomUUID(), userId = 'host-mount-gate';
  const stage = await remote('mktemp -d /var/tmp/agentor-host-mount-live.XXXXXXXX');
  expect(stage).toMatch(/^\/var\/tmp\/agentor-host-mount-live\.[A-Za-z0-9]+$/);
  const unit = `agentor-host-mount-test-${id}.service`;
  const config = { dataDir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443',
    incusProject: 'agentor', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusNetworkHostEndpoint: 'https://127.0.0.1:18444',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    containerPrefix: 'agentor-worker', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const storage = new StorageManager({} as any, config); storage.dataHostPath = `${stage}/data`;
  await new UserCredentialManager(storage).ensureUserDir(userId);
  await mkdir(join(dataDir, 'users', userId, 'kilo', 'config'), { recursive: true });
  await mkdir(join(dataDir, 'users', userId, 'kilo', 'data'), { recursive: true });
  const workers = new WorkerStore(dataDir), groups = new WorkerGroupStore(dataDir);
  await Promise.all([workers.init(), groups.init()]);
  const group = await groups.create(userId, 'Host mount fixture'), nonce = randomUUID();
  await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', displayName: 'host gate',
    incusRecreation: { nonce, initialCreate: true } } as any);
  const store = new HostMountStore(dataDir, () => storage.dataHostPath, groups, workers); await store.init();
  const ro = await store.createPath({ name: 'Read-only fixture', sourcePath: `${stage}/ro` });
  const rw = await store.createPath({ name: 'Writable fixture', sourcePath: `${stage}/rw`, allowWrite: true });
  for (const path of [ro, rw]) {
    await store.setEntitlement(userId, path.id, true);
    await store.createOwnerGrant(userId, { pathId: path.id, targetType: 'group', targetId: group.id });
  }
  const opts: IncusWorkerOptions = { id, userId, containerName: `agentor-worker-${id}`, storageManager: storage,
    start: false, dockerEnabled: false, userEnv: zeroUserEnvVars(userId), hostMountGroupId: group.id, recreationNonce: nonce,
    mounts: [{ pathId: ro.id, source: ro.sourcePath, target: '/mnt/host-ro', readOnly: true },
      { pathId: rw.id, source: rw.sourcePath, target: '/workspace/host-rw', readOnly: false }],
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    capabilitiesJson: [], instructionsJson: [], workerJson: { id, displayName: 'host gate', repos: [], initScript: '', gitName: '', gitEmail: '' } };
  const runtime = new IncusWorkerRuntime(config), host = new IncusHostMountClient(config);
  const execute = runtime.client.exec.bind(runtime.client), probeErrors = new Set<string>();
  runtime.client.exec = async (...args) => {
    try { return await execute(...args); }
    catch (error) {
      if (args[1].length === 1 && args[1][0] === 'true') {
        // Record readiness error classes without transport URLs, secrets or output.
        const observed = error as { name?: string; statusCode?: number; code?: string };
        const category = JSON.stringify({ name: observed.name, status: observed.statusCode, code: observed.code });
        if (!probeErrors.has(category)) { probeErrors.add(category); console.info('Host gate readiness error', category); }
      }
      throw error;
    }
  };
  const before = JSON.parse(await remote('sudo incus query /1.0/projects/agentor'));
  const accounts = ['credentials', 'kilo/config', 'kilo/data'].map(path => `${storage.getUserHostDir(userId)}/${path}`);
  let tunnel: ChildProcess | undefined, serviceStarted = false, submitted = false, incarnation: string | undefined;
  let cleaned = false;
  console.info('Exact host mount live fixture', { dataDir, stage, unit, installation, id });
  try {
    await remote(`mkdir -p ${q(stage + '/scripts')} ${q(stage + '/data')} ${q(ro.sourcePath)} ${q(rw.sourcePath)}`);
    await copy([fileURLToPath(new URL('../../scripts/agentor-incus-network-service.py', import.meta.url)),
      fileURLToPath(new URL('../../scripts/incus-managed-network-policy.py', import.meta.url)),
      fileURLToPath(new URL('../../scripts/incus-host-mount-policy.py', import.meta.url)),
      fileURLToPath(new URL('../../scripts/incus-host-mount-sources.py', import.meta.url))], `${stage}/scripts/`);
    await copy([dataDir + '/.'], stage + '/data/', true);
    await copy([config.incusClientCertPath], stage + '/client.crt');
    await copy([fileURLToPath(new URL('../helpers/restore-incus-host-mount-fixture.py', import.meta.url))], stage + '/restore.py');
    await remote(`sudo chown -R 1000:1000 ${q(stage + '/data/users/' + userId)}; sudo chmod 0755 ${q(stage)}; sudo chmod 0755 ${q(ro.sourcePath)} ${q(rw.sourcePath)}`);
    const metadata = await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`);
    const paths = [...before.config['restricted.devices.disk.paths'].split(','), ...accounts].join(',');
    await remote(`sudo incus project set agentor restricted.devices.disk.paths ${q(paths)}`);
    expect(await remote(`sudo systemctl show ${q(unit)} --property=LoadState --value`)).toBe('not-found');
    serviceStarted = true;
    await remote(`sudo systemd-run --no-block --collect --unit=${q(unit)} --property=RuntimeMaxSec=690 --property=TimeoutStopSec=10 /usr/bin/python3 ${q(stage + '/scripts/agentor-incus-network-service.py')} --host-mounts --data-dir ${q(stage + '/data')} --installation ${q(installation)} --project agentor --primary incusbr0 --bind 127.0.0.1 --port 18444 --server-cert /var/lib/incus/server.crt --server-key /var/lib/incus/server.key --client-cert ${q(stage + '/client.crt')}`);
    tunnel = spawn('ssh', ['-N', '-p', '22375', ...access, '-o', 'ExitOnForwardFailure=yes',
      '-L', '127.0.0.1:18444:127.0.0.1:18444', destination], { stdio: ['ignore', 'ignore', 'ignore'] });
    await expect.poll(async () => {
      try { await host.ensure(opts.mounts![0]!); return true; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await expect(host.ensure({ ...opts.mounts![0]!, readOnly: false })).rejects.toThrow('read-only');
    const unassignedId = randomUUID();
    await expect(runtime.create({ ...opts, id: unassignedId, containerName: `agentor-worker-${unassignedId}`,
      mounts: [opts.mounts![0]!] })).rejects.toThrow('WorkerRecord');
    submitted = true;
    const instance = await runtime.create(opts); incarnation = instance.config['volatile.uuid']; expect(incarnation).toBeTruthy();
    console.info('Host gate: captured created VM', incarnation);
    await groups.update(userId, group.id, { workerIds: [id] });
    await runtime.start(opts, incarnation);
    const exec = async (command: string[]) => {
      const result = await runtime.client.exec(opts.containerName, command);
      expect(result.returnCode, result.stdout + result.stderr).toBe(0); return result.stdout.trim();
    };
    await exec(['bash', '-ec', 'test "$(id -u)" = 0; ! touch /mnt/host-ro/root-write; mount -o remount,rw /mnt/host-ro 2>/dev/null || :; ! touch /mnt/host-ro/remounted-write; printf retained-host-data > /workspace/host-rw/value']);
    expect(await remote(`sudo cat ${q(rw.sourcePath + '/value')}`)).toBe('retained-host-data');
    expect(await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`)).toBe(metadata);
    console.info('Host gate: fresh services, root RO denial, RW bytes and source metadata verified');
    await runtime.stop(opts, incarnation); await runtime.start(opts, incarnation);
    expect(await exec(['cat', '/workspace/host-rw/value'])).toBe('retained-host-data');
    expect(await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`)).toBe(metadata);
    const boot = await exec(['cat', '/proc/sys/kernel/random/boot_id']);
    await exec(['systemd-run', '--on-active=2', `--unit=agentor-host-reboot-${id}`, 'systemctl', 'reboot']);
    await expect.poll(async () => {
      try {
        const observed = await runtime.client.exec(opts.containerName, ['bash', '-ec',
          'test ! -e /run/agentor/provisioned; cat /proc/sys/kernel/random/boot_id']);
        return observed.returnCode === 0 && observed.stdout.trim() !== boot;
      } catch { return false; }
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe(true);
    expect((await runtime.client.getInstance(opts.containerName)).config['volatile.uuid']).toBe(incarnation);
    await runtime.start(opts, incarnation);
    await exec(['test', '-f', '/run/agentor/provisioned']);
    expect(await exec(['cat', '/workspace/host-rw/value'])).toBe('retained-host-data');
    expect(await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`)).toBe(metadata);

    console.info('Host gate: same-incarnation guest reboot and ephemeral reprovisioning verified');
    await runtime.stop(opts, incarnation);
    const rwIdentity = await remote(`sudo stat -c '%d:%i' ${q(rw.sourcePath)}`);
    const swap = ['import os,sys', 'stage,expected=sys.argv[1:]', 'source=stage+"/rw"',
      'assert not os.path.lexists(stage+"/rw-original") and not os.path.islink(source)',
      'assert "%s:%s" % (os.stat(source).st_dev,os.stat(source).st_ino)==expected',
      'os.rename(source,stage+"/rw-original")', 'os.mkdir(source,0o755)'].join('\n');
    const restore = ['import os,sys', 'stage,expected=sys.argv[1:]', 'original=stage+"/rw-original"',
      'assert not os.path.islink(original) and not os.path.islink(stage+"/rw") and not os.path.lexists(stage+"/rw-replacement")',
      'assert "%s:%s" % (os.stat(original).st_dev,os.stat(original).st_ino)==expected',
      'assert os.listdir(stage+"/rw")==[]', 'os.rename(stage+"/rw",stage+"/rw-replacement")',
      'os.rename(original,stage+"/rw")'].join('\n');
    try {
      await remote(`sudo python3 -c ${q(swap)} ${q(stage)} ${q(rwIdentity)}`);
      await expect(runtime.start(opts, incarnation)).rejects.toThrow('source identity changed');
      expect((await runtime.client.getInstanceState(opts.containerName)).status).toBe('Stopped');
    } finally {
      // Keep both exact directories; never delete the canonical host bytes.
      await remote(`sudo python3 -c ${q(restore)} ${q(stage)} ${q(rwIdentity)}`);
    }
    expect(await remote(`sudo stat -c '%d:%i' ${q(rw.sourcePath)}`)).toBe(rwIdentity);
    console.info('Host gate: source replacement denied before VM start; original inode restored');
    await runtime.start(opts, incarnation);
    const current = await runtime.client.getInstance(opts.containerName);
    await expect(runtime.start({ ...opts, mounts: [{ ...opts.mounts![0]!, readOnly: false }, opts.mounts![1]!] }, incarnation)).rejects.toThrow('read-only');
    expect((await runtime.client.getInstance(opts.containerName)).devices).toEqual(current.devices);
    await workers.upsert({ ...workers.get(userId, id)!, mounts: opts.mounts, incusRecreation: undefined,
      desiredRuntimeStatus: 'running' });
    const manager = new ContainerManager(new Proxy({}, { get: () => () => { throw new Error('Docker fallback forbidden'); } }) as any, config);
    manager.setWorkerStore(workers); manager.setIncusRuntime(runtime);
    manager.registerExternal({ id, userId, runtimeKind: 'incus-vm', status: 'stopped',
      containerId: `incus:${incarnation}`, containerName: opts.containerName, mounts: opts.mounts,
      displayName: 'host gate', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as any);
    const sharedStore = useHostMountStore(), resolve = sharedStore.resolveMounts;
    sharedStore.resolveMounts = (owner, worker, mounts) => {
      if (owner !== userId || worker !== id) throw new Error('Foreign host fixture resolution');
      return store.resolveMounts(owner, worker, mounts, group.id);
    };
    try {
      await store.setEntitlement(userId, ro.id, false);
      expect((await runtime.client.getInstanceState(opts.containerName)).status).toBe('Running');
      const revoked = await manager.reconcileHostMountAccess(userId);
      expect(revoked.stoppedWorkerIds).toEqual([id]); expect(revoked.failures).toEqual([]);
      expect(workers.get(userId, id)).toMatchObject({ hostMountsRevoked: true, pendingRebuild: true, desiredRuntimeStatus: 'stopped' });
      expect((await runtime.client.getInstanceState(opts.containerName)).status).toBe('Stopped');
    } finally { sharedStore.resolveMounts = resolve; manager.unregisterExternal(id); }
    console.info('Host gate: cached-stopped revocation shut down the running native VM');
    expect(await remote(`sudo cat ${q(rw.sourcePath + '/value')}`)).toBe('retained-host-data');
    expect(await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`)).toBe(metadata);
    await expect(runtime.start(opts, incarnation)).rejects.toThrow('authorized Incus WorkerRecord');
    const surviving = workers.get(userId, id)!.mounts!;
    expect(surviving).toEqual([opts.mounts![1]!]);
    const existing = await runtime.preflightRecreation({ ...opts, mounts: surviving });
    const reconstructionNonce = randomUUID();
    await workers.upsert({ ...workers.get(userId, id)!, incusRecreation: { nonce: reconstructionNonce, originalIncarnation: incarnation } });
    await runtime.remove(opts, incarnation); submitted = false; incarnation = undefined;
    opts.mounts = surviving; opts.recreationNonce = reconstructionNonce;
    submitted = true;
    const replacement = await runtime.create(opts, existing); incarnation = replacement.config['volatile.uuid'];
    expect(incarnation).toBeTruthy(); expect(incarnation).not.toBe(current.config['volatile.uuid']);
    await workers.upsert({ ...workers.get(userId, id)!, incusRecreation: { nonce: reconstructionNonce, replacementIncarnation: incarnation } });
    await runtime.start(opts, incarnation);
    await exec(['bash', '-ec', '! mountpoint -q -- /mnt/host-ro; test -f /run/agentor/provisioned']);
    expect(await exec(['cat', '/workspace/host-rw/value'])).toBe('retained-host-data');
    expect(await remote(`sudo stat -c '%u:%g:%a' ${q(ro.sourcePath)} ${q(rw.sourcePath)}`)).toBe(metadata);
    await workers.upsert({ ...workers.get(userId, id)!, hostMountsRevoked: false, pendingRebuild: false,
      incusRecreation: undefined, desiredRuntimeStatus: 'running' });
    console.info('Host gate: captured reconstruction removed revoked RO export and retained RW data/modes');
    await runtime.remove(opts, incarnation); submitted = false; await runtime.removeStorage(opts);
    const latest = JSON.parse(await remote('sudo incus query /1.0/projects/agentor'));
    for (const [key, value] of Object.entries(before.config))
      if (key !== 'restricted.devices.disk.paths' && key !== 'user.agentor.host-mount-roots') expect(latest.config[key]).toBe(value);
    // Every submitted create/ensure is acknowledged; exact compute is removed.
    // Restore only fixture-owned fields, not unrelated project configuration.
    const fields = ['restricted.devices.disk.paths', 'user.agentor.host-mount-roots'];
    const originals = Object.fromEntries(fields.map(key => [key, before.config[key] ?? null]));
    const expected = { 'restricted.devices.disk.paths': [...new Set([...paths.split(','), ro.sourcePath, rw.sourcePath])].sort().join(','),
      'user.agentor.host-mount-roots': JSON.stringify({ installation, sources: [ro.sourcePath, rw.sourcePath].sort() }) };
    await remote(`sudo python3 ${q(stage + '/restore.py')} ${q(stage)} ${q(JSON.stringify(originals))} ${q(JSON.stringify(expected))}`);
    expect(JSON.parse(await remote('sudo incus query /1.0/projects/agentor')).config).toEqual(before.config);
    cleaned = true;
  } finally {
    try {
      if (!cleaned && submitted && incarnation) {
        try {
          const observed = await runtime.client.getInstance(opts.containerName);
          if (observed.config['volatile.uuid'] === incarnation &&
              await runtime.matchesWorkerIdentity(observed, id, userId)) {
            console.info('Host gate failure state', (await runtime.client.getInstanceState(opts.containerName)).status);
            // This synthetic fixture provisions no real account secrets.
            console.info('Host gate failure console', (await remote(`sudo incus console ${q(opts.containerName)} --project agentor --show-log`)).slice(-12_000));
          }
        } catch { console.warn('Host gate failure diagnostics unavailable; captured cleanup authority unchanged'); }
      }
      if (submitted && incarnation) { await runtime.remove(opts, incarnation); await runtime.removeStorage(opts); }
    } finally {
      try {
        if (serviceStarted) {
          const load = await remote(`sudo systemctl show ${q(unit)} --property=LoadState --value`);
          if (load !== 'not-found') {
            expect(await remote(`sudo systemctl show ${q(unit)} --property=ExecStart --value`)).toContain(stage + '/scripts/agentor-incus-network-service.py');
            await remote(`sudo systemctl stop ${q(unit)}`);
          }
        }
      } finally {
        tunnel?.kill('SIGTERM'); runtime.client.dispose();
        if (cleaned) await rm(dataDir, { recursive: true, force: true });
        else console.error('Host mount fixture authority retained; no guessed cleanup', { dataDir, stage, unit, incarnation, submitted });
      }
    }
  }
});
