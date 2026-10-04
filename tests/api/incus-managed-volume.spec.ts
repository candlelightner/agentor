import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import type { Config } from '../../orchestrator/server/utils/config';
import { useConfig, useContainerManager, useWorkerStore, usePersistentBackupPathManager } from '../../orchestrator/server/utils/services';
import { useBackupManager } from '../../orchestrator/server/utils/backup-manager';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';

(globalThis as any).useLogger ??= () => ({ info() {}, error() {}, warn() {}, debug() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).reassignWorkerMappings ??= async () => {};
(globalThis as any).cleanupWorkerMappings ??= async () => {};

test('real retained compute seeds an Incus filesystem staging disk before any disposable-root replacement', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable managed-storage primitive gate');
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-incus-volume-seed-'));
  const config = { dataDir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded', containerPrefix: 'agentor-worker',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const runtime = new IncusWorkerRuntime(config), client = runtime.client;
  const id = randomUUID();
  const owner = { id, userId: 'managed-volume-primitive', containerName: `${config.containerPrefix}-${id}` };
  const options = { ...owner, dockerEnabled: false, userEnv: zeroUserEnvVars(owner.userId),
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [], workerJson: { id, displayName: 'storage primitive', repos: [], initScript: '', gitName: '', gitEmail: '' } };
  const installation = await backupInstallationId(dataDir);
  const store = new ManagedVolumeStore(dataDir); await store.init();
  const source = '/opt/agentor-volume-seed-fixture';
  const record = await store.create(owner.userId, owner.id, source, undefined, 'incus-vm');
  const volumeId = record.id;
  const volumeName = `agentor-persist-${volumeId}`;
  const staging = `/run/agentor-volume-seed/${volumeId}`;
  const managed = new IncusManagedVolumeRuntime(config, runtime);
  let incarnation: string | undefined, volumeCreationAttempted = false, primaryFailure = false;
  const checked = async (command: string[], ...args: string[]) => {
    const result = await client.exec(owner.containerName, [...command, ...args]);
    expect(result.returnCode, result.stderr + result.stdout).toBe(0);
    return result.stdout;
  };
  try {
    const instance = await runtime.create(options); incarnation = instance.config['volatile.uuid'];
    expect(incarnation).toBeTruthy();
    await checked(['python3', '-c', [
      'import os, pathlib, sys, struct', 'p=pathlib.Path(sys.argv[1]); p.mkdir()',
      "(p/'bytes').write_bytes(bytes([0,255,10,13,128]))", "os.chown(p/'bytes',1000,1000); os.chmod(p/'bytes',0o640)",
      "os.link(p/'bytes',p/'hardlink'); os.symlink('bytes',p/'symlink')",
      "os.setxattr(p/'bytes','user.agentor-seed',b'metadata-preserved')",
      "acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])",
      "os.setxattr(p/'bytes','system.posix_acl_access',acl)",
      "os.utime(p/'bytes',ns=(1700000000000000000,1700000000123456789))",
    ].join('\n')], source);
    await checked(['bash', '-ec', 'cp /bin/true "$1/capability-exec"; setcap cap_net_bind_service=ep "$1/capability-exec"; getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'source-capability'], source);
    // Production adapter boots retained compute unprovisioned, seeds through
    // the agent and durably commits data authority before returning stopped.
    volumeCreationAttempted = true;
    await managed.seed(`incus:${incarnation}`, record, async () => {
      record.seeded = true; await store.save(record);
    });
    expect(store.get(owner.userId, volumeId)?.seeded).toBe(true);
    const retained = await client.getInstance(owner.containerName);
    expect(retained.config['volatile.uuid']).toBe(incarnation);
    expect(retained.status).toBe('Stopped');
    await client.startInstance(owner.containerName);
    await expect.poll(async () => {
      try { return (await client.exec(owner.containerName, ['true'])).returnCode; } catch { return -1; }
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    await checked(['bash', '-ec', 'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; mountpoint -q "$1"', 'seed-preflight'], staging);
    const verify = [
      'import os,pathlib,sys,struct', 'p=pathlib.Path(sys.argv[1]); a=p/"bytes"; b=p/"hardlink"',
      'assert a.read_bytes()==bytes([0,255,10,13,128])', 'assert os.stat(a).st_ino==os.stat(b).st_ino',
      'assert os.readlink(p/"symlink")=="bytes"', 'assert os.stat(a).st_uid==1000 and os.stat(a).st_gid==1000',
      'assert os.stat(a).st_mode & 0o777 == 0o640',
      'assert os.getxattr(a,"user.agentor-seed")==b"metadata-preserved"',
      "acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])",
      'assert os.getxattr(a,"system.posix_acl_access")==acl',
      'assert os.stat(a).st_mtime_ns==1700000000123456789',
    ].join('\n');
    await checked(['python3', '-c', verify], staging);
    await checked(['python3', '-c', verify], source); // Original root/data still intact.
    await checked(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'seeded-capability'], staging);
    await runtime.stop(owner, incarnation);
    const beforeDeclaration = await client.getInstance(owner.containerName);
    expect(beforeDeclaration.config['volatile.uuid']).toBe(incarnation);
    await client.updateInstanceDevices(owner.containerName, { ...beforeDeclaration.devices,
      [managed.deviceKey(record)]: managed.device(record) });
    await runtime.start(options, incarnation);
    await checked(['bash', '-ec', 'mountpoint -q "$1"; systemctl is-active --quiet agentor-worker', 'declared-volume'], source);
    await checked(['python3', '-c', verify], source);
    await checked(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'declared-capability'], source);
    const found = await client.getCustomVolume(config.incusStoragePool, volumeName);
    expect(found.config['user.agentor.volume-id']).toBe(volumeId);
    expect(found.used_by).toHaveLength(1);
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    const failures: string[] = [];
    try {
      if (incarnation) await runtime.remove(owner, incarnation);
      if (volumeCreationAttempted) {
        let volume;
        try { volume = await client.getCustomVolume(config.incusStoragePool, volumeName); }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
        if (volume) {
          expect(volume).toMatchObject({ name: volumeName, type: 'custom', content_type: 'filesystem', config: {
            'user.agentor.installation': installation, 'user.agentor.owner': owner.userId,
            'user.agentor.id': owner.id, 'user.agentor.volume-id': volumeId, 'user.agentor.target': source } });
          expect(volume.used_by ?? []).toEqual([]);
          await client.deleteCustomVolume(config.incusStoragePool, volumeName);
        }
      }
      await runtime.removeStorage(owner);
    } catch (error) { failures.push(String(error)); }
    if (!failures.length) await rm(dataDir, { recursive: true, force: true });
    else { console.error('Preserving exact failed storage fixture', owner.containerName, volumeName, dataDir, failures);
      if (!primaryFailure) throw new Error('Managed storage primitive cleanup failed'); }
  }
});

async function productionManagerFixture() {
  const config = useConfig();
  Object.assign(config, { incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded', containerPrefix: 'agentor-worker',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' });
  const manager = useContainerManager(), store = useWorkerStore(), volumes = useManagedVolumeManager();
  await store.init(); await volumes.init();
  const runtime = new IncusWorkerRuntime(config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  (manager as any).dockerService = new Proxy({}, { get: () => () => { throw new Error('Docker fallback must not occur'); } });
  (volumes.runtime as any).docker = new Proxy({}, { get: () => () => { throw new Error('Docker storage must not be called'); } });
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).resolveGitIdentity = async () => ({ gitName: '', gitEmail: '' });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: zeroUserEnvVars('managed-live-owner'), credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveEnvironmentConfig = () => ({ dockerEnabled: false,
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [] });
  return { config, manager, store, volumes, runtime };
}

test('real Incus filesystem hotplug capability preserves the running worker boot and service', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable filesystem hotplug diagnostic');
  test.setTimeout(300_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, v: any, failed = false;
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'filesystem hotplug diagnostic' });
    const incarnation = info.containerId.slice(6), managed = new IncusManagedVolumeRuntime(config, runtime);
    v = await volumes.store.create(info.userId, info.id, '/opt/hotplug-proof', undefined, 'incus-vm');
    await managed.ensureVolume(v);
    const key = managed.deviceKey(v), staging = `/run/agentor-volume-seed/${v.id}`;
    const before = await runtime.inspectGuestReadiness(info, incarnation);
    const servicePid = async () => (await runtime.client.exec(info.containerName, ['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker'])).stdout.trim();
    const pid = await servicePid();
    const instance = await runtime.client.getInstance(info.containerName);
    expect(instance.config['volatile.uuid']).toBe(incarnation);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices,
      [key]: { ...managed.device(v), path: staging } });
    const mounted = await runtime.client.exec(info.containerName, ['mountpoint', '-q', '--', staging]);
    console.info('Filesystem hotplug diagnostic:', { mounted: mounted.returnCode === 0, boot: (await runtime.inspectGuestReadiness(info, incarnation)).bootId === before.bootId, service: await servicePid() === pid });
    expect(mounted.returnCode, mounted.stdout + mounted.stderr).toBe(0);
    expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(before.bootId);
    expect(await servicePid()).toBe(pid);
    const attached = await runtime.client.getInstance(info.containerName);
    const devices = { ...attached.devices }; delete devices[key];
    await runtime.client.updateInstanceDevices(info.containerName, devices);
    expect((await managed.inspectVolume(v))?.used_by).toEqual([]);
    expect((await runtime.client.exec(info.containerName, ['bash', '-ec',
      'mkdir -p /opt/hotplug-proof; echo repeated-staging > /opt/hotplug-proof/sentinel'])).returnCode).toBe(0);
    for (let attempt = 0; attempt < 5; attempt++) {
      try { await managed.stageSelection(info.containerId, v); }
      catch (error) {
        console.error('Repeated hotplug failure', { attempt,
          step: (error as any).guestStep, returnCode: (error as any).guestExitCode });
        throw error;
      }
      expect((await managed.inspectVolume(v))?.used_by).toEqual([]);
      expect(v.seeded).toBe(false);
    }
    expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(before.bootId);
    expect(await servicePid()).toBe(pid);
    console.info('Repeated selection hotplug: five exact-owned provisional copies; unchanged boot/service PID');
  } catch (error) { failed = true; throw error; }
  finally {
    if (info) {
      try {
        const instance = await runtime.client.getInstance(info.containerName);
        expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
        await runtime.remove(info, instance.config['volatile.uuid']);
        if (v) { await volumes.incusRuntime.delete(v); await volumes.store.forget(v.userId, v.id); }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving filesystem hotplug diagnostic fixture', info.containerName, v?.id, error);
        if (!failed) throw error;
      }
    }
  }
});

test('real Incus live declaration reports pre-declaration bind handle behavior', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable live-mount declaration probe');
  test.setTimeout(300_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, v: any, failed = false;
  const target = '/opt/live-declaration-probe';
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(info.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'live mount declaration probe' });
    const incarnation = info.containerId.slice(6), managed = new IncusManagedVolumeRuntime(config, runtime);
    const before = await runtime.inspectGuestReadiness(info, incarnation);
    const pid = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker']);
    v = await volumes.store.create(info.userId, info.id, target, undefined, 'incus-vm');
    await managed.ensureVolume(v);
    const key = managed.deviceKey(v), staging = `/run/agentor-volume-seed/${v.id}`;
    let instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [key]: { ...managed.device(v), path: staging } });
    await exec(['timeout', '15', 'bash', '-ec',
      'until mountpoint -q -- "$1"; do sleep .1; done; mkdir -p -- "$2"; echo before-path-update > "$1/sentinel"; mount --bind "$1" "$2"',
      'live-declaration-prepare', staging, target]);
    // Observe old descriptors separately from the fresh canonical mount. A
    // version that preserves them is fine; live safety cannot assume it does.
    await exec(['bash', '-ec', 'nohup python3 -c "$1" "$2" >/run/agentor/live-declaration.log 2>&1 </dev/null &', 'hold-descriptor', String.raw`
import os, pathlib, sys, time
p=pathlib.Path(sys.argv[1]); f=open(p/'sentinel','r')
pathlib.Path('/run/agentor/live-declaration-ready').touch()
deadline=time.monotonic()+20
try:
    while time.monotonic()<deadline:
        f.seek(0)
        if f.read().strip()=='after-path-update':
            pathlib.Path('/run/agentor/live-declaration-result').write_text('observed');sys.exit(0)
        time.sleep(.1)
except OSError as error:
    print('Retired descriptor:',type(error).__name__,error.errno,flush=True)
pathlib.Path('/run/agentor/live-declaration-result').write_text('retired')
`, target]);
    await exec(['timeout', '15', 'bash', '-ec', 'until test -f /run/agentor/live-declaration-ready; do sleep .1; done']);
    instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [key]: managed.device(v) });
    await exec(['timeout', '15', 'bash', '-ec',
      'until mountpoint -q -- "$1"; do sleep .1; done; test "$(cat "$1/sentinel")" = before-path-update; echo after-path-update > "$1/sentinel"', 'live-declaration-write', target]);
    await exec(['timeout', '25', 'bash', '-ec', 'until test -f /run/agentor/live-declaration-result; do sleep .1; done']);
    const descriptor = await exec(['cat', '/run/agentor/live-declaration-result']);
    expect(['observed', 'retired']).toContain(descriptor);
    expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(before.bootId);
    expect(await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker'])).toBe(pid);
    expect(managed.matchesDevice((await runtime.client.getInstance(info.containerName)).devices[key], v)).toBe(true);
    console.info(`Live declaration: current data, boot and service PID retained; old bind descriptor ${descriptor}. Writers must remain frozen through declaration.`);
  } catch (error) { failed = true; throw error; }
  finally {
    if (info) {
      try {
        const instance = await runtime.client.getInstance(info.containerName);
        expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
        await runtime.remove(info, instance.config['volatile.uuid']);
        if (v) { await volumes.incusRuntime.delete(v); await volumes.store.forget(v.userId, v.id); }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving exact live-declaration fixture', info.containerName, v?.id, error);
        if (!failed) throw error;
      }
    }
  }
});

test('real Incus canonical hotplug works with guest writers frozen and independent watchdog thaw', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable guest-freezer capability probe');
  test.setTimeout(300_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, v: any, failed = false;
  const target = '/opt/frozen-declaration-probe';
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(info.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'guest freezer probe' });
    const incarnation = info.containerId.slice(6), managed = new IncusManagedVolumeRuntime(config, runtime);
    const before = await runtime.inspectGuestReadiness(info, incarnation);
    const pid = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker']);
    const agentPid = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'incus-agent']);
    expect(Number(agentPid)).toBeGreaterThan(1);
    const agentGroup = await exec(['cat', `/proc/${agentPid}/cgroup`]);
    await exec(['bash', '-ec', 'mkdir /sys/fs/cgroup/agentor-already-frozen-probe; echo 1 > /sys/fs/cgroup/agentor-already-frozen-probe/cgroup.freeze']);
    await exec(['bash', '-ec', 'nohup python3 -c "$1" >/run/agentor/freezer-writer.log 2>&1 </dev/null &', 'writer', String.raw`
import pathlib,time
p=pathlib.Path('/run/agentor/freezer-ticks'); count=0
while True:
    count+=1;p.write_text(str(count));time.sleep(.05)
`]);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -s /run/agentor/freezer-ticks; do sleep .1; done']);
    v = await volumes.store.create(info.userId, info.id, target, undefined, 'incus-vm');
    await managed.ensureVolume(v);
    const key = managed.deviceKey(v), staging = `/run/agentor-volume-seed/${v.id}`;
    let instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [key]: { ...managed.device(v), path: staging } });
    await exec(['timeout', '15', 'bash', '-ec',
      'until mountpoint -q -- "$1"; do sleep .1; done; echo frozen-data > "$1/sentinel"', 'prepare', staging]);
    await runtime.client.pushFile(info.containerName, '/run/agentor/freezer-probe.py',
      await readFile(new URL('../helpers/incus-live-freezer-probe.py', import.meta.url)), { mode: 0o600 });
    await exec(['bash', '-ec', 'nohup python3 /run/agentor/freezer-probe.py "$1" 45 >/run/agentor/freezer-probe.log 2>&1 </dev/null &', 'freeze', agentPid]);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/armed; do sleep .1; done']);
    await exec(['touch', '/run/agentor/freezer-probe/begin']);
    await exec(['timeout', '15', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/frozen; do sleep .1; done']);
    const tick = await exec(['cat', '/run/agentor/freezer-ticks']);
    instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [key]: managed.device(v) });
    await exec(['timeout', '15', 'bash', '-ec',
      'until mountpoint -q -- "$1"; do sleep .1; done; test "$(cat "$1/sentinel")" = frozen-data; test ! -e /run/agentor/freezer-probe/thawed', 'verify', target]);
    expect(await exec(['cat', '/run/agentor/freezer-ticks'])).toBe(tick);
    // Kill the controller: only the independently exempt watchdog can rescue
    // the frozen guest. Agent API/host operations must remain available.
    await exec(['bash', '-ec', 'kill -KILL "$(cat /run/agentor/freezer-probe/controller)"']);
    await exec(['timeout', '55', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/thawed; do sleep .1; done']);
    expect(await exec(['cat', '/run/agentor/freezer-probe/thawed'])).toBe('watchdog');
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/restored; do sleep .1; done']);
    expect(await exec(['cat', `/proc/${agentPid}/cgroup`])).toBe(agentGroup);
    expect(await exec(['cat', '/sys/fs/cgroup/agentor-already-frozen-probe/cgroup.freeze'])).toBe('1');
    await exec(['timeout', '10', 'bash', '-ec', 'until test "$(cat /run/agentor/freezer-ticks)" != "$1"; do sleep .1; done', 'thaw', tick]);
    expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(before.bootId);
    expect(await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker'])).toBe(pid);
    expect(managed.matchesDevice((await runtime.client.getInstance(info.containerName)).devices[key], v)).toBe(true);
    console.info('Frozen canonical declaration passed; normal writers stopped, agent hotplug/exec stayed available, SIGKILL watchdog rescue, same boot/service PID.');
  } catch (error) {
    failed = true;
    if (info) try { console.error('Freezer probe diagnostic:', await runtime.client.exec(info.containerName, ['bash', '-ec',
      'cat /run/agentor/freezer-probe.log; ls -l /run/agentor/freezer-probe; cat /sys/fs/cgroup/*/cgroup.events'])); } catch { /* exact fixture remains covered below */ }
    throw error;
  } finally {
    if (info) {
      try {
        // Incus host-side removal stays operational even if guest rescue fails.
        const instance = await runtime.client.getInstance(info.containerName);
        expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
        await runtime.remove(info, instance.config['volatile.uuid']);
        if (v) { await volumes.incusRuntime.delete(v); await volumes.store.forget(v.userId, v.id); }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving exact freezer fixture', info.containerName, v?.id, error);
        if (!failed) throw error;
      }
    }
  }
});

test('real Incus direct canonical hotplug copies pinned rootfs and contains failed cutover without thaw', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable pinned-directory capability probe');
  test.setTimeout(300_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, v: any, failed = false;
  const target = '/opt/pinned-source-probe';
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(info.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'pinned rootfs probe' });
    const incarnation = info.containerId.slice(6), managed = new IncusManagedVolumeRuntime(config, runtime);
    const before = await runtime.inspectGuestReadiness(info, incarnation);
    const pid = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker']);
    const agentPid = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'incus-agent']);
    const agentGroup = await exec(['cat', `/proc/${agentPid}/cgroup`]);
    await exec(['python3', '-c', String.raw`
import os,pathlib,sys
p=pathlib.Path(sys.argv[1]);p.mkdir();(p/'sentinel').write_bytes(bytes([0,255,10,128]))
os.chown(p/'sentinel',1000,1000);os.chmod(p/'sentinel',0o640)
os.setxattr(p/'sentinel','user.agentor-pinned',b'preserved')
os.utime(p/'sentinel',ns=(1700000000000000000,1700000000123456789))
os.link(p/'sentinel',p/'hardlink');os.symlink('sentinel',p/'symlink')
`, target]);
    v = await volumes.store.create(info.userId, info.id, target, undefined, 'incus-vm');
    await managed.ensureVolume(v);
    const key = managed.deviceKey(v);
    await runtime.client.pushFile(info.containerName, '/run/agentor/freezer-probe.py',
      await readFile(new URL('../helpers/incus-live-freezer-probe.py', import.meta.url)), { mode: 0o600 });
    await exec(['bash', '-ec', 'nohup python3 /run/agentor/freezer-probe.py "$1" 45 "$2" >/run/agentor/freezer-probe.log 2>&1 </dev/null &', 'freeze', agentPid, target]);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/armed; do sleep .1; done']);
    await exec(['touch', '/run/agentor/freezer-probe/begin']);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/source-pinned; do sleep .1; done']);
    const instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    let accepted = false, acceptedOperation: string | undefined;
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [key]: managed.device(v) }, async operation => {
      accepted = true; acceptedOperation = operation;
    });
    expect(accepted).toBe(true);
    if (acceptedOperation) expect(acceptedOperation).toMatch(/^\/1\.0\/operations\/[a-f0-9-]{36}$/);
    console.info('Direct mount accepted operation:', acceptedOperation ?? 'synchronous completion');
    await exec(['timeout', '10', 'bash', '-ec', 'until mountpoint -q -- "$1"; do sleep .1; done; test -z "$(ls -A "$1")"', 'mount', target]);
    await exec(['touch', '/run/agentor/freezer-probe/copy']);
    await exec(['timeout', '15', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/copied; do sleep .1; done; test ! -e /run/agentor/freezer-probe/thawed']);
    const verify = String.raw`
import os,pathlib,sys
p=pathlib.Path(sys.argv[1]);a=p/'sentinel'
assert a.read_bytes()==bytes([0,255,10,128])
assert os.stat(a).st_ino==os.stat(p/'hardlink').st_ino
assert os.readlink(p/'symlink')=='sentinel'
assert os.stat(a).st_uid==1000 and os.stat(a).st_gid==1000
assert os.stat(a).st_mode & 0o777 == 0o640
assert os.getxattr(a,'user.agentor-pinned')==b'preserved'
assert os.stat(a).st_mtime_ns==1700000000123456789
`;
    await exec(['python3', '-c', verify, target]);
    // Probe records no authority. A production path must persist seeded state
    // before release and retain an ambiguity record on every lost response.
    await exec(['touch', '/run/agentor/freezer-probe/release']);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/restored; do sleep .1; done']);
    expect(await exec(['cat', `/proc/${agentPid}/cgroup`])).toBe(agentGroup);
    expect((await runtime.inspectGuestReadiness(info, incarnation)).bootId).toBe(before.bootId);
    expect(await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker'])).toBe(pid);
    await exec(['bash', '-ec', 'mkdir /run/agentor/pinned-original-root; mount --bind / /run/agentor/pinned-original-root']);
    await exec(['python3', '-c', verify, `/run/agentor/pinned-original-root${target}`]);
    console.info('Direct canonical hotplug: pinned rootfs source stays readable; original and metadata retained; same boot/service PID; one attachment.');
    // Start a second, exact-owned TEST-ONLY freeze to prove failure containment.
    // The first controller/watchdog must have exited and restored the agent.
    await exec(['timeout', '10', 'bash', '-ec',
      'until rmdir /sys/fs/cgroup/agentor-freezer-probe 2>/dev/null; do sleep .1; done; test -f /run/agentor/freezer-probe/restored; rm -r -- /run/agentor/freezer-probe']);
    await exec(['bash', '-ec', 'nohup python3 /run/agentor/freezer-probe.py "$1" 15 "" poweroff >/run/agentor/freezer-poweroff.log 2>&1 </dev/null &', 'freeze', agentPid]);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/armed; do sleep .1; done']);
    await exec(['touch', '/run/agentor/freezer-probe/begin']);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f /run/agentor/freezer-probe/frozen; do sleep .1; done']);
    await exec(['bash', '-ec', 'kill -KILL "$(cat /run/agentor/freezer-probe/controller)"; test ! -e /run/agentor/freezer-probe/thawed']);
    await expect.poll(async () => (await runtime.client.getInstanceState(info.containerName)).status,
      { timeout: 45_000, intervals: [500, 1000] }).toBe('Stopped');
    expect(managed.matchesDevice((await managed.inspect(v.userId, v.workerId, info.containerId)).devices[key], v)).toBe(true);
    expect((await managed.inspectVolume(v))?.used_by).toHaveLength(1);
    console.info('Independent watchdog contained killed controller by sync + guest kernel poweroff, without thawing uncertain writers.');
    // Verify actual retained data after cold containment. This diagnostic boot
    // is deliberately unprovisioned, never a production authority decision.
    await runtime.client.startInstance(info.containerName);
    await expect.poll(async () => {
      try { return (await runtime.client.exec(info.containerName, ['true'])).returnCode; } catch { return -1; }
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    await exec(['bash', '-ec', 'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker']);
    await exec(['python3', '-c', verify, target]);
    await exec(['bash', '-ec', 'mkdir -p /run/agentor/pinned-original-root; mount --bind / /run/agentor/pinned-original-root']);
    await exec(['python3', '-c', verify, `/run/agentor/pinned-original-root${target}`]);
    console.info('Unprovisioned cold-recovery boot verified both original rootfs source and canonical volume metadata/data; worker/Docker stayed inactive.');
  } catch (error) {
    failed = true;
    if (info) try { console.error('Pinned source diagnostic:', await runtime.client.exec(info.containerName, ['bash', '-ec',
      'cat /run/agentor/freezer-probe.log; ls -l /run/agentor/freezer-probe'])); } catch { /* fixture cleanup below */ }
    throw error;
  } finally {
    if (info) {
      try {
        const instance = await runtime.client.getInstance(info.containerName);
        expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
        if (failed && (await runtime.client.getInstanceState(info.containerName)).status !== 'Stopped') {
          // Failed cold-stop capability must never strand this frozen fixture
          // while graceful stop waits on frozen PID1. Ownership proven above.
          await runtime.client.stopInstance(info.containerName, { force: true });
        }
        await runtime.remove(info, instance.config['volatile.uuid']);
        if (v) { await volumes.incusRuntime.delete(v); await volumes.store.forget(v.userId, v.id); }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving exact pinned-source fixture', info.containerName, v?.id, error);
        if (!failed) throw error;
      }
    }
  }
});

test('trusted production guest helper copies live metadata, rejects busy paths and cold-contains lost controller', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable production helper gate');
  test.setTimeout(600_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  const managed = new IncusManagedVolumeRuntime(config, runtime);
  let info: any, failed = false;
  const records: any[] = [];
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(info.containerName, command);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const begin = async (v: any, bootId: string, agent: string) => {
    const id = randomUUID(), path = `/run/agentor/live-volumes/${id}`;
    v.incusLive = { id, incarnation: info.containerId.slice(6), bootId, attachment: 'not-submitted' };
    await volumes.store.save(v);
    await exec(['bash', '-ec', 'install -d -m 700 -- "$1"', 'helper-state', path]);
    for (const name of ['volume-mount-helper.py', 'incus-volume-live-helper.py'])
      await runtime.client.pushFile(info.containerName, `${path}/${name}`,
        await readFile(new URL(`../../orchestrator/${name}`, import.meta.url)), { mode: 0o600 });
    await exec(['bash', '-ec',
      'umask 077; nohup python3 -I "$1/incus-volume-live-helper.py" "$2" new "$3" "$4" "$5" >"$1/log" 2>&1 </dev/null &',
      'start-helper', path, v.target, agent, bootId, id]);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -f "$1/armed"; do test ! -f "$1/error"; sleep .05; done', 'arm', path]);
    await exec(['touch', `${path}/begin`]);
    return path;
  };
  const wait = async (path: string, marker: string) => exec(['timeout', '15', 'bash', '-ec',
    'until test -f "$1/$2"; do test ! -f "$1/error"; sleep .05; done', 'wait-helper', path, marker]);
  const attach = async (v: any, path: string) => {
    await wait(path, 'ready');
    await exec(['touch', `${path}/request-attach`]);
    await wait(path, 'attach-armed');
    v.incusLive.attachment = 'unknown'; await volumes.store.save(v);
    const instance = await managed.inspect(v.userId, v.workerId, info.containerId);
    await runtime.client.updateInstanceDevices(info.containerName, { ...instance.devices, [managed.deviceKey(v)]: managed.device(v) }, async operation => {
      v.incusLive.attachment = operation ? 'accepted' : 'settled';
      v.incusLive.operation = operation; await volumes.store.save(v);
    });
    v.incusLive.attachment = 'settled'; await volumes.store.save(v);
    // Daemon operation completion is not guest mount convergence. The helper
    // deliberately requires authoritative guest observation before copy.
    await exec(['timeout', '15', 'bash', '-ec', 'until mountpoint -q -- "$1"; do sleep .05; done', 'canonical-mount-ready', v.target]);
    await exec(['touch', `${path}/mount-settled`]);
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'production helper gate' });
    const boot = (await runtime.inspectGuestReadiness(info, info.containerId.slice(6))).bootId!;
    const service = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker']);
    const agent = await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'incus-agent']);
    const agentGroup = await exec(['cat', `/proc/${agent}/cgroup`]);
    await exec(['bash', '-ec', 'mkdir /sys/fs/cgroup/helper-prior-frozen; echo 1 > /sys/fs/cgroup/helper-prior-frozen/cgroup.freeze']);
    const target = '/opt/production-helper-data';
    await exec(['python3', '-c', String.raw`
import os,pathlib,sys,struct
p=pathlib.Path(sys.argv[1]);p.mkdir();a=p/'bytes';a.write_bytes(bytes([0,255,10,128]))
os.chown(a,1000,1000);os.chmod(a,0o640);os.link(a,p/'hardlink');os.symlink('bytes',p/'symlink')
os.setxattr(a,'user.agentor-helper',b'preserved')
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(a,'system.posix_acl_access',acl);os.utime(a,ns=(1700000000000000000,1700000000123456789))
`, target]);
    await exec(['bash', '-ec', 'cp /bin/true "$1/capability-exec"; setcap cap_net_bind_service=ep "$1/capability-exec"', 'helper-capability', target]);
    const verify = String.raw`
import os,pathlib,sys,struct
p=pathlib.Path(sys.argv[1]);a=p/'bytes'
assert a.read_bytes()==bytes([0,255,10,128]);assert os.stat(a).st_ino==os.stat(p/'hardlink').st_ino
assert os.readlink(p/'symlink')=='bytes';assert os.stat(a).st_uid==1000 and os.stat(a).st_gid==1000
assert os.stat(a).st_mode & 0o777 == 0o640;assert os.getxattr(a,'user.agentor-helper')==b'preserved'
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*e) for e in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
assert os.getxattr(a,'system.posix_acl_access')==acl;assert os.stat(a).st_mtime_ns==1700000000123456789
`;
    const v = await volumes.store.create(info.userId, info.id, target, undefined, 'incus-vm'); records.push(v);
    await managed.ensureVolume(v);
    const path = await begin(v, boot, agent);
    await attach(v, path); await wait(path, 'copied');
    await exec(['python3', '-c', verify, target]);
    await exec(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q cap_net_bind_service=ep', 'verify-helper-capability', target]);
    expect(volumes.isRecoveryBlocked(info.id)).toBe(true);
    await expect(manager.workerCommands(info.id).execCapture(info.containerId, ['true'])).rejects.toThrow('live storage recovery is unresolved');
    v.seeded = true; await volumes.store.save(v); // Must precede writer release.
    await exec(['touch', `${path}/release`]); await wait(path, 'restored');
    delete v.incusLive; await volumes.store.save(v);
    expect(await exec(['cat', `/proc/${agent}/cgroup`])).toBe(agentGroup);
    expect(await exec(['cat', '/sys/fs/cgroup/helper-prior-frozen/cgroup.freeze'])).toBe('1');
    expect((await runtime.inspectGuestReadiness(info, info.containerId.slice(6))).bootId).toBe(boot);
    expect(await exec(['systemctl', 'show', '-p', 'MainPID', '--value', 'agentor-worker'])).toBe(service);
    console.info('Production helper success: unchanged boot/service PID, metadata copy and prior frozen group preserved.');
    // Busy FD rejection is before permission to attach and must safely thaw.
    const busyTarget = '/opt/production-helper-busy';
    await exec(['bash', '-ec', 'mkdir "$1"; echo busy >"$1/file"; nohup python3 -c "$2" "$1/file" >/run/helper-busy.log 2>&1 </dev/null &', 'busy', busyTarget,
      'import pathlib,sys,time; f=open(sys.argv[1]); pathlib.Path("/run/helper-busy-ready").touch(); time.sleep(300)']);
    await exec(['timeout', '10', 'bash', '-ec', 'until test -e /run/helper-busy-ready; do sleep .05; done']);
    const busy = await volumes.store.create(info.userId, info.id, busyTarget, undefined, 'incus-vm'); records.push(busy);
    await managed.ensureVolume(busy);
    const busyPath = await begin(busy, boot, agent);
    await exec(['timeout', '15', 'bash', '-ec', 'until test -e "$1/restored"; do sleep .05; done', 'busy-restored', busyPath]);
    expect(JSON.parse(await exec(['cat', `${busyPath}/error`]))).toMatchObject({ beforeAttachment: true });
    expect((await runtime.client.getInstance(info.containerName)).devices[managed.deviceKey(busy)]).toBeUndefined();
    delete busy.incusLive; await volumes.store.save(busy);
    expect(await exec(['cat', `/proc/${agent}/cgroup`])).toBe(agentGroup);
    console.info('Production helper busy rejection: no attachment, original agent cgroup restored.');
    // Lost controller after canonical attachment cannot thaw; the production
    // watcher uses its real 180s budget and bounded sync, then guest poweroff.
    const containedTarget = '/opt/production-helper-contained';
    await exec(['bash', '-ec', 'mkdir "$1"; echo original >"$1/sentinel"', 'contained-source', containedTarget]);
    const contained = await volumes.store.create(info.userId, info.id, containedTarget, undefined, 'incus-vm'); records.push(contained);
    await managed.ensureVolume(contained);
    const containedPath = await begin(contained, boot, agent);
    await attach(contained, containedPath); await wait(containedPath, 'copied');
    const armed = JSON.parse(await exec(['cat', `${containedPath}/armed`]));
    await exec(['kill', '-KILL', String(armed.controller)]);
    await expect.poll(async () => (await runtime.client.getInstanceState(info.containerName)).status,
      { timeout: 210_000, intervals: [1000, 3000] }).toBe('Stopped');
    expect(volumes.isRecoveryBlocked(info.id)).toBe(true);
    await runtime.client.startInstance(info.containerName);
    await expect.poll(async () => { try { return (await runtime.client.exec(info.containerName, ['true'])).returnCode; } catch { return -1; } },
      { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    await exec(['bash', '-ec', 'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; test "$(cat "$1/sentinel")" = original', 'cold-check', containedTarget]);
    await exec(['bash', '-ec', 'mkdir /run/helper-original; mount --bind / /run/helper-original; test "$(cat "/run/helper-original$1/sentinel")" = original', 'original-check', containedTarget]);
    await exec(['python3', '-c', verify, target]);
    await exec(['python3', '-c', verify, `/run/helper-original${target}`]);
    await exec(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q cap_net_bind_service=ep; getcap "/run/helper-original$1/capability-exec" | grep -q cap_net_bind_service=ep',
      'cold-helper-capability', target]);
    // TEST ONLY: settlement, exact identity and cold data are proven above;
    // remove the fixture intent, not a claim of production recovery authority.
    delete contained.incusLive; await volumes.store.save(contained);
    console.info('Production guest helper: same-boot metadata copy; pre-frozen state; busy rejection/restoration; killed-controller cold containment and both data copies verified.');
  } catch (error) {
    failed = true;
    if (info) try { console.error('Production-helper diagnostics:', await runtime.client.exec(info.containerName, ['bash', '-ec',
      'for d in /run/agentor/live-volumes/*; do echo "$d"; cat "$d/log"; test ! -f "$d/error" || cat "$d/error"; test ! -f "$d/watchdog-error" || cat "$d/watchdog-error"; ls -l "$d"; done'])); } catch { /* retained below */ }
    throw error;
  } finally {
    if (info) {
      if (failed) {
        // Failed proof retains all data and durable intent. Proven exact-owned
        // fixture may be force-contained, never resumed or silently deleted.
        const instance = await runtime.client.getInstance(info.containerName);
        if (await runtime.matchesWorkerIdentity(instance, info.id, info.userId) && instance.config['volatile.uuid'] === info.containerId.slice(6))
          await runtime.client.stopInstance(info.containerName, { force: true });
        console.error('Retained production-helper fixture', info.containerName, records.map(v => v.id));
      } else {
        await runtime.remove(info, info.containerId.slice(6));
        for (const v of records) { await managed.delete(v); await volumes.store.forget(v.userId, v.id); }
        await runtime.removeStorage(info); await store.delete(info.userId, info.id);
      }
    }
  }
});

test('real production backup selections hotplug without restart and refresh root data before storage recreation', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable production selection gate');
  test.setTimeout(900_000);
  const { manager, store, volumes, runtime } = await productionManagerFixture();
  const backup = useBackupManager(); backup.setPathPersistenceAdapter(usePersistentBackupPathManager());
  const target = '/opt/selected-integration';
  const selectionClient = volumes.incusRuntime.worker.client;
  const originalExec = selectionClient.exec;
  selectionClient.exec = async (name, command, options) => {
    const result = await originalExec.call(selectionClient, name, command, options);
    if (command[0] === 'timeout' && result.returnCode !== 0)
      console.error('Selection guest failure:', { step: command[2], timeout: command[1],
        returnCode: result.returnCode, stderr: result.stderr.slice(0, 2000) });
    return result;
  };
  let info: any, volumeId: string | undefined, failed = false;
  const check = async (script: string) => {
    const result = await runtime.client.exec(info.containerName, ['bash', '-ec', script, 'selection-check', target]);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const ready = async () => {
    await expect.poll(() => {
      const v = volumes.store.get(info.userId, volumeId!)!;
      if (v.state === 'failed') throw new Error(v.operation?.error || 'Selection persistence failed');
      return v.operation?.stage;
    }, { timeout: 300_000, intervals: [500, 1000] }).toBe('complete');
    info = manager.get(info.id)!;
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'selection integration',
      workerConfiguration: { secrets: [{ key: 'SELECTION_BOOT', value: 'applied' }] } });
    await check('mkdir -p "$1"; echo before-selection > "$1/sentinel"; echo removed-later > "$1/stale"; chown -R 1000:1000 "$1"; echo backup-file > /tmp/selection-file');
    const actor = { userId: info.userId, workerId: info.id }, originalHandle = info.containerId;
    const before = await runtime.inspectGuestReadiness(info, originalHandle.slice(6));
    const pid = await check('systemctl show -p MainPID --value agentor-worker');
    info.initScript = 'echo desired-init > /workspace/selection-pending'; info.pendingRebuild = true;
    await store.upsert((manager as any).containerInfoToWorkerRecord(info));
    await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'SELECTION_BOOT', value: 'pending' }]);
    await backup.setConfig(info.userId, { persistSelectedDirectories: true,
      selectedPathsByWorkspace: { [info.id]: [target, '/tmp/selection-file', '/etc'] } });
    const records = volumes.store.forWorker(info.userId, info.id);
    expect(records).toHaveLength(1); volumeId = records[0]!.id;
    expect(records[0]).toMatchObject({ target, seeded: false, attached: true, state: 'pending', operation: { stage: 'complete' } });
    expect((await volumes.incusRuntime.inspectVolume(records[0]!))?.used_by).toEqual([]);
    expect(info.containerId).toBe(originalHandle);
    expect((await runtime.inspectGuestReadiness(info, originalHandle.slice(6))).bootId).toBe(before.bootId);
    expect(await check('systemctl show -p MainPID --value agentor-worker')).toBe(pid);
    await check('! mountpoint -q "$1"; test "$(cat "$1/sentinel")" = before-selection; test ! -e /workspace/selection-pending');
    console.info('Selection gate: settings validated/copied, unchanged boot and service PID');
    await check('echo after-selection > "$1/sentinel"; echo new-write > "$1/new"; rm "$1/stale"');
    await volumes.apply(actor, volumeId, 'recreate'); await ready();
    await check('mountpoint -q "$1"; test "$(cat "$1/sentinel")" = after-selection; test "$(cat "$1/new")" = new-write; test ! -e "$1/stale"; test ! -e /workspace/selection-pending; source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "SELECTION_BOOT") | .value\')" = applied');
    expect(info.pendingRebuild).toBe(true);
    console.info('Selection gate: fresh root copy includes later writes/deletions; pending settings remain unapplied');
    await volumes.detach(actor, volumeId, true, true); await ready();
    await backup.setConfig(info.userId, { selectedPathsByWorkspace: { [info.id]: [target] } });
    expect(volumes.store.get(info.userId, volumeId)?.attached).toBe(false);
    info = await manager.rebuild(info.id);
    await check('! mountpoint -q "$1"; test ! -e "$1/sentinel"; test -e /workspace/selection-pending');
    console.info('Selection gate: stale backup selection does not reattach explicitly detached data');
    await backup.setConfig(info.userId, { selectedPathsByWorkspace: {} });
    await manager.remove(info.id);
    await volumes.delete(actor, volumeId, true);
  } catch (error) { failed = true; throw error; }
  finally {
    selectionClient.exec = originalExec;
    if (info) {
      try {
        const instance = await runtime.client.getInstance(info.containerName).catch(error => {
          if (error.statusCode !== 404) throw error;
        });
        if (instance) {
          expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
          await runtime.remove(info, instance.config['volatile.uuid']);
        }
        for (const v of volumes.store.forWorker(info.userId, info.id)) {
          await volumes.incusRuntime.delete(v); await volumes.store.forget(v.userId, v.id);
        }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving failed selection fixture', info.containerName, volumeId, error);
        if (!failed) throw error;
      }
    }
  }
});

test('real production manager applies Incus persistence without promoting pending configuration and retains detached data', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable managed-storage integration gate');
  test.setTimeout(900_000);
  const { config, manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, volumeId: string | undefined, failed = false;
  const target = '/opt/managed-integration';
  const check = async (script: string) => {
    const result = await runtime.client.exec(info.containerName, ['bash', '-ec', script, 'managed-check', target]);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
  };
  const ready = async () => {
    await expect.poll(async () => {
      const volume = volumes.store.get(info.userId, volumeId!)!;
      if (volume.state === 'failed') throw new Error(volume.operation?.error || 'Managed persistence failed');
      return volume.operation?.stage;
    }, { timeout: 300_000, intervals: [500, 1000] }).toBe('complete');
    info = manager.get(info.id)!;
  };
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'managed integration',
      workerConfiguration: { secrets: [{ key: 'MANAGED_BOOT', value: 'applied' }] } });
    await check('mkdir -p "$1"; echo retained-managed-data > "$1/sentinel"; chown -R 1000:1000 "$1"');
    const actor = { userId: info.userId, workerId: info.id };
    const volume = await volumes.add(actor, { target, mode: 'deferred' }); volumeId = volume.id;
    expect(volumes.store.get(info.userId, volumeId)?.storageRuntimeKind).toBe('incus-vm');
    info.initScript = 'echo pending-must-not-run > /workspace/managed-pending'; info.pendingRebuild = true;
    await store.upsert((manager as any).containerInfoToWorkerRecord(info));
    await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'MANAGED_BOOT', value: 'pending' }]);
    const original = info.containerId;
    await volumes.apply(actor, volume.id, 'recreate'); await ready();
    console.info('Managed-storage production gate: applied with original bootstrap');
    expect(info.containerId).not.toBe(original); expect(info.pendingRebuild).toBe(true);
    expect(store.get(info.userId, info.id)?.incusRecreation).toBeUndefined();
    await check('mountpoint -q "$1"; test "$(cat "$1/sentinel")" = retained-managed-data; test ! -e /workspace/managed-pending; source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "MANAGED_BOOT") | .value\')" = applied');
    expect((await useWorkerConfigStore().resolveValues(info.userId, info.id))[0]?.value).toBe('pending');
    await volumes.detach(actor, volume.id, true, true); await ready();
    console.info('Managed-storage production gate: detached with retained data');
    await check('! mountpoint -q "$1"; test ! -e "$1/sentinel"');
    expect((await runtime.client.getCustomVolume(config.incusStoragePool, volumes.store.get(info.userId, volumeId)!.dockerName)).used_by ?? []).toEqual([]);
    await volumes.reattach(actor, volume.id, 'recreate'); await ready();
    console.info('Managed-storage production gate: reattached');
    await check('mountpoint -q "$1"; test "$(cat "$1/sentinel")" = retained-managed-data');
    info = await manager.rebuild(info.id);
    console.info('Managed-storage production gate: rebuilt');
    await check('mountpoint -q "$1"; test "$(cat "$1/sentinel")" = retained-managed-data; test -e /workspace/managed-pending');
    expect((await useWorkerConfigStore().resolveAppliedValues(info.userId, info.id))[0]?.value).toBe('pending');
    await manager.archive(info.id);
    console.info('Managed-storage production gate: archived');
    expect((await runtime.client.getCustomVolume(config.incusStoragePool, volumes.store.get(info.userId, volumeId)!.dockerName)).used_by ?? []).toEqual([]);
    info = await manager.unarchive(info.userId, info.id);
    console.info('Managed-storage production gate: unarchived');
    await check('mountpoint -q "$1"; test "$(cat "$1/sentinel")" = retained-managed-data');
    await manager.remove(info.id);
    expect(volumes.store.get(info.userId, volumeId)).toMatchObject({ attached: false, seeded: true, state: 'detached' });
    expect(await runtime.client.getCustomVolume(config.incusStoragePool, volumes.store.get(info.userId, volumeId)!.dockerName)).toBeTruthy();
    await volumes.delete(actor, volume.id, true);
    expect(volumes.store.get(info.userId, volumeId)).toBeUndefined();
  } catch (error) { failed = true; throw error; }
  finally {
    if (info) {
      try {
        const current = await runtime.client.getInstance(info.containerName).catch(error => {
          if (error.statusCode !== 404) throw error;
        });
        if (current) {
          expect(await runtime.matchesWorkerIdentity(current, info.id, info.userId)).toBe(true);
          await runtime.remove(info, current.config['volatile.uuid']);
        }
        if (volumeId) {
          const record = volumes.store.get(info.userId, volumeId);
          if (record) {
            await volumes.incusRuntime.delete(record);
            await volumes.store.forget(record.userId, record.id);
          }
        }
        await runtime.removeStorage(info);
        if (store.get(info.userId, info.id)) await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving failed managed integration fixture', info.containerName, volumeId, error);
        if (!failed) throw error;
      }
    }
  }
});

test('real deferred Incus path survives restart and guest reboot without applying pending storage or configuration', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable deferred-storage reboot gate');
  test.setTimeout(600_000);
  const { manager, store, volumes, runtime } = await productionManagerFixture();
  let info: any, failed = false;
  try {
    info = await (manager as any).createForOwner({ userId: 'managed-live-owner', displayName: 'deferred reboot integration',
      workerConfiguration: { secrets: [{ key: 'DEFERRED_BOOT', value: 'applied' }] } });
    const actor = { userId: info.userId, workerId: info.id };
    const source = '/opt/deferred-integration';
    expect((await runtime.client.exec(info.containerName, ['bash', '-ec',
      'mkdir -p "$1"; echo source-retained > "$1/sentinel"', 'deferred-source', source])).returnCode).toBe(0);
    const volume = await volumes.add(actor, { target: source, mode: 'deferred' });
    const originalHandle = info.containerId, incarnation = originalHandle.slice(6);
    info.initScript = 'echo pending-init > /workspace/deferred-must-not-run'; info.pendingRebuild = true;
    await store.upsert((manager as any).containerInfoToWorkerRecord(info));
    await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'secret', key: 'DEFERRED_BOOT', value: 'pending' }]);
    await manager.restart(info.id);
    expect(info.containerId).toBe(originalHandle);
    expect(volumes.store.get(info.userId, volume.id)).toMatchObject({ seeded: false, attached: true, state: 'pending' });
    const boot = await runtime.inspectGuestReadiness(info, incarnation);
    expect(boot.provisioned && boot.serviceReady).toBe(true);
    await runtime.client.exec(info.containerName, ['sh', '-c', 'nohup sh -c "sleep 1; reboot" >/dev/null 2>&1 &']);
    let rebootId = '';
    await expect.poll(async () => {
      try {
        const observed = await runtime.inspectGuestReadiness(info, incarnation);
        if (observed.bootId !== boot.bootId) { rebootId = observed.bootId; return !observed.provisioned; }
      } catch { /* guest agent unavailable during reboot */ }
      return false;
    }, { timeout: 120_000, intervals: [1000, 2000] }).toBe(true);
    await manager.reconcileIncusWorkers();
    expect(await runtime.inspectGuestReadiness(info, incarnation)).toMatchObject({ bootId: rebootId, provisioned: true, serviceReady: true });
    expect(info).toMatchObject({ containerId: originalHandle, status: 'running', pendingRebuild: true });
    expect(volumes.store.get(info.userId, volume.id)).toMatchObject({ seeded: false, attached: true, state: 'pending' });
    await expect(runtime.client.getCustomVolume(useConfig().incusStoragePool, volumes.store.get(info.userId, volume.id)!.dockerName)).rejects.toMatchObject({ statusCode: 404 });
    const result = await runtime.client.exec(info.containerName, ['bash', '-ec',
      'test "$(cat "$1/sentinel")" = source-retained; ! mountpoint -q "$1"; test ! -e /workspace/deferred-must-not-run; source /run/agentor/worker.env; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "DEFERRED_BOOT") | .value\')" = applied', 'deferred-check', source]);
    expect(result.returnCode, result.stdout + result.stderr).toBe(0);
    await manager.remove(info.id);
    await volumes.delete(actor, volume.id, true);
  } catch (error) { failed = true; throw error; }
  finally {
    if (info && store.get(info.userId, info.id)) {
      try {
        const instance = await runtime.client.getInstance(info.containerName);
        expect(await runtime.matchesWorkerIdentity(instance, info.id, info.userId)).toBe(true);
        await runtime.remove(info, instance.config['volatile.uuid']);
        await runtime.removeStorage(info);
        await volumes.workerDeleted(info.userId, info.id);
        for (const v of volumes.store.forWorker(info.userId, info.id))
          await volumes.delete({ userId: info.userId, workerId: info.id }, v.id, true);
        await store.delete(info.userId, info.id);
      } catch (error) {
        console.error('Preserving deferred reboot fixture', info.containerName, error);
        if (!failed) throw error;
      }
    }
  }
});
