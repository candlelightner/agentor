import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import type { Config } from '../../orchestrator/server/utils/config';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });

function options(id = randomUUID()): IncusWorkerOptions {
  return { id, userId: 'restore-test-owner', containerName: 'agentor-worker-' + id,
    start: false, recreationNonce: randomUUID(), dockerEnabled: true,
    userEnv: zeroUserEnvVars('restore-test-owner'), cpuLimit: 1, memoryLimit: '1GiB',
    environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '', exposeApis: {} },
    workerJson: { id, displayName: 'Isolated restore', repos: [], initScript: '', gitName: '', gitEmail: '' },
    capabilitiesJson: [], instructionsJson: [],
  };
}
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-canonical-restore-'));
  const config = { dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://native.invalid', incusProject: 'agentor', incusStoragePool: 'default',
    incusNetwork: 'primary', incusInternalGatewayUrl: 'http://gateway.invalid:3000',
    incusClientCertPath: '/provided/client.crt', incusClientKeyPath: '/provided/client.key', incusServerCertPath: '/provided/server.crt',
    incusWorkerImage: 'approved' } as Config;
  const volumes = new Map<string, any>(), events: string[] = [];
  let instance: any, conflict = false, execCode = 0;
  const image = { fingerprint: 'a'.repeat(64), type: 'virtual-machine', properties: {
    bootstrap_generation: '3', source_image_id: 'sha256:' + 'b'.repeat(64), recipe_id: 'c'.repeat(64),
    source_architecture: 'amd64', converter_version: 'v0.4.0' } };
  const missing = () => Object.assign(new Error('Not found'), { statusCode: 404 });
  const client: any = {
    endpoint: config.incusEndpoint,
    getReadiness: async () => ({ ready: true, serverVersion: '6.0.6' }),
    request: async () => ({ config: { restricted: 'true' } }),
    getImageAlias: async () => ({ target: image.fingerprint, type: image.type }),
    getImage: async () => image, listImages: async () => [image],
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes.has(name)) throw missing(); return structuredClone(volumes.get(name));
    },
    createCustomVolume: async (_pool: string, spec: any) => {
      events.push('volume-create');
      if (conflict) throw Object.assign(new Error('Conflict'), { statusCode: 409 });
      volumes.set(spec.name, { ...spec, type: 'custom', project: 'agentor', created_at: '2026-10-05T00:00:00Z', used_by: [] });
    },
    updateCustomVolume: async (_pool: string, name: string, config: any) => { volumes.get(name).config = config; },
    createInstance: async (spec: any) => {
      events.push('create');
      instance = { ...spec, status: 'Stopped', expanded_devices: spec.devices,
        config: { ...spec.config, 'volatile.uuid': randomUUID(), 'volatile.base_image': image.fingerprint } };
      for (const volume of volumes.values()) volume.used_by = ['/1.0/instances/' + spec.name + '?project=agentor'];
      return structuredClone(instance);
    },
    getInstance: async () => { if (!instance) throw missing(); return structuredClone(instance); },
    getInstanceState: async () => ({ status: instance.status }),
    startInstance: async () => { events.push('start'); instance.status = 'Running'; },
    stopInstance: async () => { events.push('stop'); instance.status = 'Stopped'; },
    updateInstanceDevices: async (_name: string, devices: any, _accepted: any, _expected: any, complete: any) => {
      events.push('promote'); instance.devices = devices; instance.expanded_devices = devices;
      if (complete) delete instance.config['user.agentor.restore'];
    },
    exec: async () => ({ returnCode: 0, stdout: '', stderr: '' }),
    execStream: async () => {
      events.push('extract');
      let resolve!: (value: number) => void;
      const result = new Promise<number>(yes => { resolve = yes; });
      const stdout = new PassThrough(), stderr = new PassThrough();
      const stdin = new Writable({ write(_chunk, _encoding, done) { done(); }, final(done) {
        stdout.end(); stderr.end(); resolve(execCode); done();
      } });
      return { stdin, stdout, stderr, result, close() {} };
    },
  };
  const runtime = new IncusWorkerRuntime(config, client);
  // These must never be consulted, even if ordinary worker settings enable them.
  (runtime as any).accountDevices = async () => { throw new Error('Account sharing is forbidden during extraction'); };
  (runtime as any).managedDevices = async () => { throw new Error('Managed sharing is forbidden during extraction'); };
  const opts = options();
  return { dataDir, config, volumes, events, runtime, client, opts, image,
    current: () => instance, conflict: () => { conflict = true; }, failExec: () => { execCode = 2; },
    cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}
async function rawArchive(dir: string, role: 'workspace' | 'agents') {
  const base = role === 'workspace' ? 'workspace' : '.agent-data', stage = join(dir, 'stage-' + role);
  await mkdir(join(stage, base), { recursive: true }); await writeFile(join(stage, base, 'data'), 'native bytes');
  const path = join(dir, role + '.tar');
  execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-cf', path, base]);
  return path;
}

test('native destination has only fresh private filesystem devices, no Docker/network/account startup', async () => {
  const f = await fixture(); try {
    const created = await f.runtime.createCanonicalRestore(f.opts);
    expect(created.profiles).toEqual([]);
    expect(Object.keys(created.devices).sort()).toEqual(['agents', 'root', 'workspace']);
    expect(created.devices.agents.path).toBe('/restore/.agent-data');
    expect(created.devices.workspace.path).toBe('/restore/workspace');
    expect(created.config['user.agentor.restore']).toBe('incomplete');
    expect(f.events).toEqual(['volume-create', 'volume-create', 'create']);
    await expect(f.runtime.start(f.opts, created.config['volatile.uuid'])).rejects.toThrow('incomplete');
    expect(f.events).not.toContain('start');
  } finally { await f.cleanup(); }
});

test('fresh restore refuses preexisting data and conflicts, never converges by adopting volumes', async () => {
  const f = await fixture(); try {
    f.volumes.set(f.opts.containerName + '-workspace', { config: {} });
    await expect(f.runtime.createCanonicalRestore(f.opts)).rejects.toThrow('absent destination');
    expect(f.events).toEqual([]);
    f.volumes.clear(); f.conflict();
    await expect(f.runtime.createCanonicalRestore(f.opts)).rejects.toMatchObject({ statusCode: 409 });
    expect(f.events).toEqual(['volume-create']);
  } finally { await f.cleanup(); }
});

test('descriptive native source cannot select a cached private custom OCI outside the configured image authority', async () => {
  const f = await fixture(); try {
    const foreign = { ...f.image, fingerprint: 'd'.repeat(64), properties: {
      ...f.image.properties, source_image_id: 'sha256:' + 'e'.repeat(64), recipe_id: 'f'.repeat(64) } };
    f.client.listImages = async () => [foreign, f.image];
    f.client.getImage = async (fingerprint: string) => fingerprint === foreign.fingerprint ? foreign : f.image;
    await expect(f.runtime.createCanonicalRestore(f.opts, { sourceImageId: foreign.properties.source_image_id,
      recipeId: foreign.properties.recipe_id, architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' }))
      .rejects.toMatchObject({ code: 'INCUS_RESTORE_IMAGE_NOT_AUTHORIZED' });
    expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
  } finally { await f.cleanup(); }
});

test('authorized immutable OCI may reconstruct a cached older bootstrap recipe without granting another OCI source', async () => {
  const f = await fixture(); try {
    const old = { ...f.image, fingerprint: 'd'.repeat(64), properties: { ...f.image.properties, recipe_id: 'e'.repeat(64) } };
    f.client.listImages = async () => [old, f.image];
    f.client.getImage = async (fingerprint: string) => fingerprint === old.fingerprint ? old : f.image;
    const create = f.client.createInstance;
    f.client.createInstance = async (spec: any) => { expect(spec.source.fingerprint).toBe(old.fingerprint); return create(spec); };
    await f.runtime.createCanonicalRestore(f.opts, { sourceImageId: old.properties.source_image_id,
      recipeId: old.properties.recipe_id, architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' });
    expect(f.events).toContain('create');
  } finally { await f.cleanup(); }
});

test('portable immutable source resolves only against real native image properties', async () => {
  const f = await fixture(); try {
    const source = { sourceImageId: 'sha256:' + 'b'.repeat(64), recipeId: 'c'.repeat(64), architecture: 'amd64' as const,
      converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const };
    await expect(f.runtime.createCanonicalRestore(f.opts, { ...source, recipeId: 'd'.repeat(64) })).rejects.toThrow('unavailable');
    expect(f.events).toEqual([]);
    expect((await f.runtime.createCanonicalRestore(f.opts, source)).config['volatile.base_image']).toBe(f.image.fingerprint);
  } finally { await f.cleanup(); }
});

test('image properties changed after catalog discovery reject before destination allocation', async () => {
  const f = await fixture(); try {
    const source = { sourceImageId: 'sha256:' + 'b'.repeat(64), recipeId: 'c'.repeat(64), architecture: 'amd64' as const,
      converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const };
    f.client.listImages = async () => [structuredClone(f.image)];
    f.client.getImage = async () => ({ ...f.image, properties: { ...f.image.properties, recipe_id: 'd'.repeat(64) } });
    await expect(f.runtime.createCanonicalRestore(f.opts, source)).rejects.toThrow('source changed');
    expect(f.events).toEqual([]);
  } finally { await f.cleanup(); }
});

test('extraction streams both raw roots, waits for guest exit, repeats authority and contains failures', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(); try {
      const created = await f.runtime.createCanonicalRestore(f.opts), workspace = await rawArchive(f.dataDir, 'workspace'), agents = await rawArchive(f.dataDir, 'agents');
      let checks = 0; if (fail) f.failExec();
      const result = f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, { workspace, agents }, () => { checks++; });
      if (fail) {
        await expect(result).rejects.toThrow('exit 2'); expect(f.current().status).toBe('Stopped');
        expect(f.events.filter(event => event === 'extract')).toHaveLength(1);
      } else {
        await result; expect(f.events.filter(event => event === 'extract')).toHaveLength(2);
        expect(checks).toBeGreaterThan(8); expect(f.current().status).toBe('Running');
      }
    } finally { await f.cleanup(); }
  }
});

test('foreign expanded devices, raw configuration, changed nonce/UUID and storage references fail before boot', async () => {
  for (const mutation of ['device', 'raw', 'nonce', 'uuid', 'reference']) {
    const f = await fixture(); try {
      const created = await f.runtime.createCanonicalRestore(f.opts), workspace = await rawArchive(f.dataDir, 'workspace');
      if (mutation === 'device') f.current().expanded_devices = { ...f.current().devices, foreign: { type: 'disk', source: '/host', path: '/host' } };
      if (mutation === 'raw') f.current().expanded_config = { 'raw.qemu': 'host access' };
      if (mutation === 'nonce') f.current().config['user.agentor.recreation'] = 'foreign';
      if (mutation === 'uuid') f.current().config['volatile.uuid'] = randomUUID();
      if (mutation === 'reference') f.volumes.get(f.opts.containerName + '-workspace').used_by = [
        'https://foreign.invalid/1.0/instances/' + f.opts.containerName + '?project=agentor'];
      await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, { workspace }, () => {})).rejects.toThrow();
      expect(f.events).not.toContain('start'); expect(f.events).not.toContain('extract');
    } finally { await f.cleanup(); }
  }
});

test('cancellation after first role stops exact compute and never extracts second role or clears quarantine', async () => {
  for (const stopFails of [false, true]) {
    const f = await fixture(); try {
      const created = await f.runtime.createCanonicalRestore(f.opts), controller = new AbortController();
      const workspace = await rawArchive(f.dataDir, 'workspace'), agents = await rawArchive(f.dataDir, 'agents');
      const stream = f.client.execStream;
      f.client.execStream = async (...args: any[]) => {
        const session = await stream(...args);
        session.result = session.result.then((code: number) => { controller.abort(new Error('cancelled after workspace')); return code; });
        return session;
      };
      if (stopFails) f.client.stopInstance = async () => { throw new Error('lost shutdown acknowledgement'); };
      await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, { workspace, agents }, () => {}, controller.signal))
        .rejects.toThrow(stopFails ? /shutdown is unconfirmed/ : /aborted|cancelled after workspace/);
      expect(f.events.filter(event => event === 'extract')).toHaveLength(1);
      expect(f.current().status).toBe(stopFails ? 'Running' : 'Stopped');
      expect(f.current().config['user.agentor.restore']).toBe('incomplete');
      await expect(f.runtime.start(f.opts, created.config['volatile.uuid'])).rejects.toThrow('incomplete');
    } finally { await f.cleanup(); }
  }
});

test('late private storage authority changes stop destination before extraction', async () => {
  const f = await fixture(); try {
    const created = await f.runtime.createCanonicalRestore(f.opts), workspace = await rawArchive(f.dataDir, 'workspace');
    await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, { workspace }, () => {
      if (f.events.includes('start')) f.volumes.get(f.opts.containerName + '-workspace').config['user.foreign'] = 'changed';
    })).rejects.toThrow('private storage changed');
    expect(f.events).not.toContain('extract'); expect(f.current().status).toBe('Stopped');
  } finally { await f.cleanup(); }
});

test('lost start result retains incomplete destination and never treats stopped read-back as terminal proof', async () => {
  const f = await fixture(); try {
    const created = await f.runtime.createCanonicalRestore(f.opts), workspace = await rawArchive(f.dataDir, 'workspace');
    f.client.startInstance = async () => { f.events.push('start-unknown'); throw new Error('lost start acknowledgement'); };
    await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, { workspace }, () => {}))
      .rejects.toThrow('destination remains quarantined');
    expect(f.events).not.toContain('extract'); expect(f.events).not.toContain('stop');
    expect(f.current().config['user.agentor.restore']).toBe('incomplete');
  } finally { await f.cleanup(); }
});

test('promotion requires settled private metadata, captured UUID and exact restore layout before grants or mutation', async () => {
  const f = await fixture(); try {
    const created = await f.runtime.createCanonicalRestore(f.opts);
    await expect(f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {})).rejects.toThrow('incomplete');
    expect(f.events).not.toContain('stop'); expect(f.events).not.toContain('promote');
    await expect(f.runtime.finishCanonicalRestore(f.opts, '', () => {})).rejects.toThrow('captured');
  } finally { await f.cleanup(); }
});

test('real native restore preserves canonical metadata through isolated extraction and approved activation', async () => {
  const activate = process.env.INCUS_CANONICAL_ACTIVATION_TEST === 'true';
  test.skip(process.env.INCUS_CANONICAL_RESTORE_TEST !== 'true' && !activate, 'Explicit serial disposable restore gate');
  test.setTimeout(1_200_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-canonical-restore-live-'));
  const config = { dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase9-host-mounts',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as Config;
  const opts = options(), runtime = new IncusWorkerRuntime(config), store = new WorkerStore(dataDir);
  await store.init();
  let marker: any = { nonce: opts.recreationNonce, initialCreate: true, importIncomplete: true }, submitted = false, cleaned = false;
  let currentIncarnation: string | undefined, complete = false;
  const expected: Record<string, any> = {}, payloads: { workspace?: string; agents?: string } = {};
  const inspectScript = String.raw`
import base64,json,os,stat,sys
p=sys.argv[1];s=os.lstat(p+'/data');r=os.lstat(p)
print(json.dumps(dict(bytes=base64.b64encode(open(p+'/data','rb').read()).decode(),
 uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),rootMode=stat.S_IMODE(r.st_mode),mtime=os.stat(p+'/data').st_mtime_ns,
 hard=os.stat(p+'/data').st_ino==os.stat(p+'/hard').st_ino,absolute=os.readlink(p+'/absolute'),relative=os.readlink(p+'/relative'),
 attrs={key:base64.b64encode(os.getxattr(p+'/data',key)).decode() for key in ('user.binary','system.posix_acl_access','security.capability')},
 defaultAcl=base64.b64encode(os.getxattr(p,'system.posix_acl_default')).decode())))
`;
  try {
    console.info('Exact canonical restore fixture', { dataDir, installation: await backupInstallationId(dataDir),
      id: opts.id, containerName: opts.containerName, nonce: marker.nonce });
    for (const role of ['workspace', 'agents'] as const) {
      const base = role === 'workspace' ? 'workspace' : '.agent-data', stage = join(dataDir, 'stage-' + role), root = join(stage, base);
      await mkdir(root, { recursive: true });
      execFileSync('sudo', ['python3', '-c', String.raw`
import os,struct,sys
p=sys.argv[1];os.chmod(p,0o751)
if os.path.basename(p)=='.agent-data':
 for name in ('.claude','.codex','.gemini','.agents','.vscode','.code-server','.kilo','.kilo/config','.kilo/shared-data','.kilo/state','.kilo/cache'):
  os.makedirs(p+'/'+name,exist_ok=True);os.chown(p+'/'+name,1000,1000);os.chmod(p+'/'+name,0o700)
open(p+'/data','wb').write(bytes([0,255,128,10,61,0]))
os.link(p+'/data',p+'/hard');os.symlink('/home/agent/.claude/.credentials.json',p+'/absolute');os.symlink('../../external/data',p+'/relative')
os.chown(p+'/data',12345,23456);os.chmod(p+'/data',0o640)
os.setxattr(p+'/data','user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,34567),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/data','system.posix_acl_access',acl)
default=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,7,0xffffffff),(2,5,34567),(4,5,0xffffffff),(16,5,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p,'system.posix_acl_default',default)
os.utime(p+'/data',ns=(1700000000123456789,1700000000987654321))
`, root]);
      execFileSync('sudo', ['setcap', 'cap_net_bind_service=ep', join(root, 'data')]);
      expected[role] = JSON.parse(execFileSync('sudo', ['python3', '-c', inspectScript, root], { encoding: 'utf8' }));
      const archive = join(dataDir, role + '.tar');
      await writeFile(archive, execFileSync('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls',
        '-C', stage, '-cf', '-', base]));
      payloads[role] = archive;
    }
    await store.upsert({ id: opts.id, userId: opts.userId, runtimeKind: 'incus-vm', status: 'active',
      displayName: 'Isolated canonical restore', desiredRuntimeStatus: 'stopped', incusRecreation: marker,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    submitted = true;
    const created = await runtime.createCanonicalRestore(opts);
    marker = { ...marker, replacementIncarnation: created.config['volatile.uuid'] };
    currentIncarnation = marker.replacementIncarnation;
    expect(marker.replacementIncarnation).toBeTruthy();
    await store.transitionIncusRecreation(opts.userId, opts.id, { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    const validate = () => {
      const record = store.get(opts.userId, opts.id);
      if (record?.runtimeKind !== 'incus-vm' || record.deletionPending ||
          JSON.stringify(record.incusRecreation) !== JSON.stringify(marker)) throw new Error('Lost durable restore marker');
    };
    await runtime.restoreCanonicalArchives(opts, marker.replacementIncarnation, payloads, validate);
    const native = await runtime.client.getInstance(opts.containerName);
    expect(Object.keys(native.expanded_devices ?? native.devices).sort()).toEqual(['agents', 'root', 'workspace']);
    for (const role of ['workspace', 'agents'] as const) {
      const root = role === 'workspace' ? '/restore/workspace' : '/restore/.agent-data';
      const result = await runtime.client.exec(opts.containerName, ['python3', '-c', inspectScript, root]);
      expect(result.returnCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expected[role]);
    }
    const inactive = await runtime.client.exec(opts.containerName, ['bash', '-ec',
      'test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; test "$(ls /sys/class/net | wc -l)" = 1']);
    expect(inactive.returnCode, inactive.stderr).toBe(0);
    await expect(runtime.start(opts, marker.replacementIncarnation)).rejects.toThrow('incomplete');
    if (activate) {
      const activation = { ...opts, dockerEnabled: false, environmentJson: { ...opts.environmentJson, dockerEnabled: false } };
      await runtime.finishCanonicalRestore(activation, currentIncarnation!, validate);
      const verify = async () => {
        for (const role of ['workspace', 'agents'] as const) {
          const root = role === 'workspace' ? '/workspace' : '/home/agent/.agent-data';
          const result = await runtime.client.exec(opts.containerName, ['python3', '-c', inspectScript, root]);
          expect(result.returnCode, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toEqual(expected[role]);
        }
        const service = await runtime.client.exec(opts.containerName, ['bash', '-ec',
          'systemctl is-active --quiet agentor-worker; runuser -u agent -- tmux has-session -t =main; curl -fsS http://127.0.0.1:6080/agentor.html >/dev/null; curl -fsS http://127.0.0.1:8443/healthz >/dev/null; test "$(stat -c %u:%g:%a /run/agentor/preserve-storage-ownership)" = 0:0:600']);
        expect(service.returnCode, service.stderr).toBe(0);
      };
      await verify();
      await store.transitionIncusRecreation(opts.userId, opts.id, { status: 'active', desiredRuntimeStatus: 'running', incusRecreation: undefined }, undefined, marker);
      complete = true;
      await runtime.stop(opts, currentIncarnation); await runtime.start(activation, currentIncarnation); await verify();
      const oldBoot = await runtime.client.exec(opts.containerName, ['cat', '/proc/sys/kernel/random/boot_id']);
      const reboot = await runtime.client.exec(opts.containerName, ['runuser', '-u', 'agent', '--', 'sudo', 'systemd-run',
        '--unit=agentor-restore-acceptance-reboot', '--on-active=1s', '/usr/sbin/reboot']);
      expect(reboot.returnCode, reboot.stderr).toBe(0);
      let rebooted = false; const rebootDeadline = Date.now() + 180_000;
      while (Date.now() < rebootDeadline) {
        try {
          const boot = await runtime.client.exec(opts.containerName, ['cat', '/proc/sys/kernel/random/boot_id']);
          if (boot.returnCode === 0 && boot.stdout.trim() !== oldBoot.stdout.trim()) { rebooted = true; break; }
        } catch { /* guest boot / agent unavailable */ }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      expect(rebooted).toBe(true);
      const ephemeral = await runtime.client.exec(opts.containerName, ['bash', '-ec',
        'test ! -e /run/agentor/preserve-storage-ownership; test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker']);
      expect(ephemeral.returnCode, ephemeral.stderr).toBe(0);
      await runtime.start(activation, currentIncarnation); await verify();
      const retained = await runtime.preflightRecreation(activation);
      await runtime.remove(opts, currentIncarnation); currentIncarnation = undefined;
      const rebuilt = await runtime.create({ ...activation, recreationNonce: undefined, start: false }, retained);
      currentIncarnation = rebuilt.config['volatile.uuid']; expect(currentIncarnation).toBeTruthy();
      await runtime.start(activation, currentIncarnation); await verify();
      console.info('Restored metadata retained through activation, VM restart, guest sudo reboot/reprovisioning and fresh disposable-root rebuild with worker/editor/desktop ready');
    } else {
      await runtime.stop(opts, marker.replacementIncarnation);
      await expect(runtime.restoreCanonicalArchives(opts, marker.replacementIncarnation, payloads, validate)).rejects.toThrow('extraction failed');
      expect((await runtime.client.getInstanceState(opts.containerName)).status).toBe('Stopped');
      console.info('Canonical metadata restored; nonempty retry contained');
    }
  } finally {
    if (submitted) {
      try {
        if (complete) {
          if (!currentIncarnation) throw new Error('Rebuild native identity is unconfirmed; retain fixture');
          await runtime.remove(opts, currentIncarnation);
        } else await runtime.rollbackRecreation(opts, marker);
        await runtime.removeStorage(opts); cleaned = true;
      }
      catch (error) { console.error('Restore fixture retained for exact recovery', { dataDir, id: opts.id, marker, error: String(error) }); }
    } else cleaned = true;
    if (cleaned) await rm(dataDir, { recursive: true, force: true });
  }
  expect(cleaned, 'Exact destination compute/storage cleanup must be verified').toBe(true);
});

test('real workspace-only native restore initializes only missing fresh agents root before supported service startup', async () => {
  test.skip(process.env.INCUS_CANONICAL_ACTIVATION_TEST !== 'true', 'Explicit serial disposable ownership gate');
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-empty-agents-restore-live-'));
  const config = { dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key', incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as Config;
  const opts = options(); opts.dockerEnabled = false; opts.environmentJson.dockerEnabled = false;
  const runtime = new IncusWorkerRuntime(config), store = new WorkerStore(dataDir); await store.init();
  let marker: any = { nonce: opts.recreationNonce, initialCreate: true, importIncomplete: true }, submitted = false, cleaned = false;
  try {
    console.info('Exact workspace-only restore fixture', { dataDir, installation: await backupInstallationId(dataDir), id: opts.id });
    const workspace = await rawArchive(dataDir, 'workspace');
    await store.upsert({ id: opts.id, userId: opts.userId, runtimeKind: 'incus-vm', status: 'active',
      desiredRuntimeStatus: 'stopped', displayName: 'Workspace-only restore', incusRecreation: marker } as any);
    submitted = true;
    const created = await runtime.createCanonicalRestore(opts); marker.replacementIncarnation = created.config['volatile.uuid'];
    await store.transitionIncusRecreation(opts.userId, opts.id, { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    const validate = () => {
      const current = store.get(opts.userId, opts.id);
      if (!current || current.deletionPending || JSON.stringify(current.incusRecreation) !== JSON.stringify(marker)) throw new Error('Workspace-only restore authority changed');
    };
    await runtime.restoreCanonicalArchives(opts, marker.replacementIncarnation, { workspace }, validate);
    const initialized = await runtime.client.exec(opts.containerName, ['bash', '-ec',
      'test "$(stat -c %u:%g:%a /restore/.agent-data)" = 1000:1000:700; test -z "$(ls -A /restore/.agent-data)"']);
    expect(initialized.returnCode, initialized.stderr).toBe(0);
    await runtime.finishCanonicalRestore(opts, marker.replacementIncarnation, validate);
    const ready = await runtime.client.exec(opts.containerName, ['bash', '-ec',
      'systemctl is-active --quiet agentor-worker; test "$(cat /workspace/data)" = "native bytes"; runuser -u agent -- touch /home/agent/.agent-data/writable; test "$(stat -c %u:%g /home/agent/.agent-data/writable)" = 1000:1000']);
    expect(ready.returnCode, ready.stderr).toBe(0);
  } finally {
    if (submitted) {
      try { await runtime.rollbackRecreation(opts, marker); await runtime.removeStorage(opts); cleaned = true; }
      catch (error) { console.error('Retained exact workspace-only destination', { dataDir, marker, error: String(error) }); }
    } else cleaned = true;
    if (cleaned) await rm(dataDir, { recursive: true, force: true });
  }
  expect(cleaned).toBe(true);
});
