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
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { INCUS_PERSISTENCE_TARGET_CHECK } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { INCUS_SELECTED_RESTORE_SCRIPT } from '../../orchestrator/server/utils/incus-selected-restore';
import { INCUS_DOCKER_RESTORE_SCRIPT } from '../../orchestrator/server/utils/incus-docker-restore';
import { INCUS_CANONICAL_RESTORE_SCRIPT } from '../../orchestrator/server/utils/incus-canonical-restore';
import { HostMountStore } from '../../orchestrator/server/utils/host-mount-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { IncusHostMountClient } from '../../orchestrator/server/utils/incus-host-mount-client';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';

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
  const inputs: Array<{ command: string[]; chunks: Buffer[] }> = [];
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
      for (const volume of volumes.values()) volume.used_by = Object.values(devices).some((device: any) => device.source === volume.name)
        ? ['/1.0/instances/' + instance.name + '?project=agentor'] : [];
      if (complete) {
        delete instance.config['user.agentor.restore'];
        if (complete.hostMountMetadata) instance.config['user.agentor.host-mounts'] = complete.hostMountMetadata;
        else delete instance.config['user.agentor.host-mounts'];
      }
    },
    exec: async () => ({ returnCode: 0, stdout: '', stderr: '' }),
    execStream: async (_name: string, command: string[]) => {
      events.push('extract');
      const input = { command, chunks: [] as Buffer[] }; inputs.push(input);
      let resolve!: (value: number) => void;
      const result = new Promise<number>(yes => { resolve = yes; });
      const stdout = new PassThrough(), stderr = new PassThrough();
      const stdin = new Writable({ write(chunk, _encoding, done) { input.chunks.push(Buffer.from(chunk)); done(); }, final(done) {
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
  return { dataDir, config, volumes, events, inputs, runtime, client, opts, image,
    current: () => instance, conflict: () => { conflict = true; }, failExec: () => { execCode = 2; },
    cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}

test('selected inverse uses one bounded validated-name prefix followed by unchanged tar in the existing isolated layout', async () => {
  const f = await fixture(); try {
    const archivePath = await rawArchive(f.dataDir, 'workspace'), instance = await f.runtime.createCanonicalRestore(f.opts);
    await f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
      [{ path: '/srv/workspace', archivePath }]);
    expect(f.inputs).toHaveLength(1); expect(f.inputs[0]!.command).toEqual(['/usr/bin/python3', '-c', INCUS_SELECTED_RESTORE_SCRIPT]);
    const bytes = Buffer.concat(f.inputs[0]!.chunks), size = bytes.readUInt32BE();
    expect(JSON.parse(bytes.subarray(4, 4 + size).toString())).toEqual({ destination: '/srv/workspace', wrapper: 'workspace',
      members: [{ name: 'workspace', type: 'directory' }, { name: 'workspace/data', type: 'file' }],
      mounts: ['/restore/workspace', '/restore/.agent-data'] });
    expect(bytes.subarray(4 + size)).toEqual(await (await import('node:fs/promises')).readFile(archivePath));
    expect(f.events).not.toContain('promote');
  } finally { await f.cleanup(); }
});

test('selected failed/truncated extraction stops exact destination and retains incomplete import authority', async () => {
  const f = await fixture(); try {
    const archivePath = await rawArchive(f.dataDir, 'workspace'), instance = await f.runtime.createCanonicalRestore(f.opts);
    f.failExec();
    await expect(f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
      [{ path: '/srv/workspace', archivePath }])).rejects.toThrow('selected extraction failed');
    expect(f.events).toContain('stop'); expect(f.current().status).toBe('Stopped');
    expect(f.current().config['user.agentor.restore']).toBe('incomplete'); expect(f.events).not.toContain('promote');
  } finally { await f.cleanup(); }
});
async function rawArchive(dir: string, role: 'workspace' | 'agents') {
  const base = role === 'workspace' ? 'workspace' : '.agent-data', stage = join(dir, 'stage-' + role);
  await mkdir(join(stage, base), { recursive: true }); await writeFile(join(stage, base, 'data'), 'native bytes');
  const path = join(dir, role + '.tar');
  execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-cf', path, base]);
  return path;
}

test('canonical create normalizes legacy memory and rejects invalid limits before native allocation', async () => {
  const f = await fixture();
  try {
    for (const memoryLimit of ['invalid', '9007199254740992b']) {
      await expect(f.runtime.preflightCanonicalRestore({ ...f.opts, memoryLimit })).rejects.toThrow(/memory limit/);
      await expect(f.runtime.createCanonicalRestore({ ...f.opts, memoryLimit })).rejects.toThrow(/memory limit/);
      expect(f.events).toEqual([]);
    }
    f.opts.memoryLimit = '1024m';
    const instance = await f.runtime.createCanonicalRestore(f.opts);
    expect(instance.config['limits.memory']).toBe('1073741824');
  } finally { await f.cleanup(); }
});

test('account parent initialization is inside isolated canonical authority and precedes stopped promotion', async () => {
  const f = await fixture(); try {
    const instance = await f.runtime.createCanonicalRestore(f.opts);
    await f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {});
    f.opts.storageManager = {} as NonNullable<IncusWorkerOptions['storageManager']>;
    (f.runtime as any).accountDevices = async () => ({});
    (f.runtime as any).managedDevices = async () => ({});
    f.client.exec = async (_name: string, command: string[]) => {
      if (command.at(-1) === 'account-parents') {
        expect(command).toEqual(['/usr/bin/python3', '-c', INCUS_CANONICAL_RESTORE_SCRIPT, 'agents', 'account-parents']);
        expect(f.current().status).toBe('Running'); expect(f.current().devices.agents.path).toBe('/restore/.agent-data');
        expect(f.current().config['user.agentor.restore']).toBe('incomplete');
        f.events.push('account-parents');
      }
      return { returnCode: 0, stdout: '', stderr: '' };
    };
    await f.runtime.finishCanonicalRestore(f.opts, instance.config['volatile.uuid']!, () => {}, 'stopped');
    expect(f.events.indexOf('account-parents')).toBeLessThan(f.events.indexOf('stop'));
    expect(f.events.indexOf('account-parents')).toBeLessThan(f.events.indexOf('promote'));
  } finally { await f.cleanup(); }
});

async function managedPayload(f: Awaited<ReturnType<typeof fixture>>, target = '/srv/restored-data') {
  const store = new ManagedVolumeStore(f.dataDir); await store.init();
  const volume = await store.create(f.opts.userId, f.opts.id, target, 'Restored data', 'incus-vm');
  f.opts.managedVolumes = [volume];
  const stage = join(f.dataDir, 'managed-stage'); await mkdir(join(stage, 'volume'), { recursive: true });
  await writeFile(join(stage, 'volume', 'bytes'), Buffer.from([0, 255, 128]));
  const archivePath = join(f.dataDir, 'managed.tar');
  execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-cf', archivePath, 'volume']);
  return { volume, archivePath };
}

function restoreSource(f: Awaited<ReturnType<typeof fixture>>) {
  const p = f.image.properties;
  return { sourceImageId: p.source_image_id, recipeId: p.recipe_id, architecture: 'amd64' as const,
    converterVersion: p.converter_version, bootstrapGeneration: '3' as const };
}

test('read-only restore preflight proves absent compute, all three core roles and attached/detached data without mutation', async () => {
  const f = await fixture(); try {
    const { volume } = await managedPayload(f), id = randomUUID();
    const detached = { ...volume, id, dockerName: 'agentor-persist-' + id, attached: false };
    const before = structuredClone({ opts: f.opts, detached }), reads: string[] = [];
    const getVolume = f.client.getCustomVolume;
    f.client.getCustomVolume = async (pool: string, name: string) => {
      expect(pool).toBe(f.config.incusStoragePool); reads.push(name); return getVolume(pool, name);
    };
    const expected = ['workspace', 'agents', 'docker'].map(role => f.opts.containerName + '-' + role)
      .concat(volume.dockerName, detached.dockerName);
    for (const source of [undefined, restoreSource(f)]) {
      reads.length = 0;
      await f.runtime.preflightCanonicalRestore(f.opts, source, [detached]);
      expect(reads).toEqual(expected); expect(f.current()).toBeUndefined();
      expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
      expect({ opts: f.opts, detached }).toEqual(before);
    }
    // Disabled Docker still cannot overwrite previously retained block data.
    f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
    reads.length = 0; await f.runtime.preflightCanonicalRestore(f.opts, undefined, [detached]);
    expect(reads).toEqual(expected); expect(f.events).toEqual([]);
  } finally { await f.cleanup(); }
});

test('read-only preflight refuses existing owned or foreign compute/core/managed storage without allocation', async () => {
  for (const ownership of ['owned', 'foreign']) {
    for (const role of ['compute', 'workspace', 'agents', 'docker', 'attached', 'detached']) {
      const f = await fixture(); try {
        const { volume } = await managedPayload(f), id = randomUUID();
        const detached = { ...volume, id, dockerName: 'agentor-persist-' + id, attached: false };
        const config = { 'user.agentor.owner': ownership === 'owned' ? f.opts.userId : 'another-owner' };
        if (role === 'compute') f.client.getInstance = async () => ({ name: f.opts.containerName, config });
        else {
          const name = role === 'attached' ? volume.dockerName : role === 'detached' ? detached.dockerName
            : f.opts.containerName + '-' + role;
          f.volumes.set(name, { name, config });
        }
        const before = structuredClone([...f.volumes]);
        await expect(f.runtime.preflightCanonicalRestore(f.opts, undefined, [detached]))
          .rejects.toThrow(role === 'compute' ? 'absent destination compute' : 'absent destination storage');
        expect(f.events).toEqual([]); expect([...f.volumes]).toEqual(before);
      } finally { await f.cleanup(); }
    }
  }
});

test('preflight native transport and non404 responses fail closed instead of treating destinations as absent', async () => {
  for (const endpoint of ['compute', 'storage']) for (const statusCode of [undefined, 403, 500]) {
    const f = await fixture(); try {
      const failure = Object.assign(new Error('Native authority unavailable'), { statusCode });
      f.client[endpoint === 'compute' ? 'getInstance' : 'getCustomVolume'] = async () => { throw failure; };
      await expect(f.runtime.preflightCanonicalRestore(f.opts)).rejects.toBe(failure);
      expect(f.events).toEqual([]); expect(f.current()).toBeUndefined(); expect(f.volumes.size).toBe(0);
    } finally { await f.cleanup(); }
  }
});

test('preflight and create enforce the same default and explicit immutable-source availability/authorization', async () => {
  for (const failure of ['readiness', 'default-missing', 'default-invalid', 'explicit-missing', 'explicit-foreign', 'explicit-invalid']) {
    const f = await fixture(); try {
      let source = failure.startsWith('explicit') ? restoreSource(f) : undefined;
      if (failure === 'readiness') f.client.getReadiness = async () => ({ ready: false, serverVersion: '6.0.6' });
      if (failure === 'default-missing') f.client.getImageAlias = async () => { throw Object.assign(new Error('Image unavailable'), { statusCode: 404 }); };
      if (failure === 'default-invalid') f.image.properties.bootstrap_generation = 'invalid';
      if (failure === 'explicit-missing') f.client.listImages = async () => [];
      if (failure === 'explicit-foreign') source = { ...source!, sourceImageId: 'sha256:' + 'd'.repeat(64) };
      if (failure === 'explicit-invalid') source = { ...source!, recipeId: 'mutable-tag' };
      await expect(f.runtime.preflightCanonicalRestore(f.opts, source)).rejects.toThrow();
      await expect(f.runtime.createCanonicalRestore(f.opts, source)).rejects.toThrow();
      expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0); expect(f.current()).toBeUndefined();
    } finally { await f.cleanup(); }
  }
  const f = await fixture(); try {
    const source = { ...restoreSource(f), recipeId: 'd'.repeat(64) };
    const older = { ...f.image, fingerprint: 'e'.repeat(64), properties: { ...f.image.properties, recipe_id: source.recipeId } };
    f.client.listImages = async () => [older];
    f.client.getImage = async (fingerprint: string) => fingerprint === older.fingerprint ? older : f.image;
    await f.runtime.preflightCanonicalRestore(f.opts, source);
    expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
    // An available older recipe for the same authorized OCI image remains descriptive.
    f.client.listImages = async () => [];
    await expect(f.runtime.createCanonicalRestore(f.opts, source)).rejects.toThrow('unavailable');
    expect(f.events).toEqual([]);
  } finally { await f.cleanup(); }
});

test('preflight rejects mismatched compute names and invalid worker IDs before any native reads', async () => {
  for (const identity of ['mismatched-name', '', '../unsafe', 'bad/id']) {
    const f = await fixture(); try {
      if (identity === 'mismatched-name') f.opts.containerName = 'agentor-worker-' + randomUUID();
      else { f.opts.id = identity; f.opts.containerName = 'agentor-worker-' + identity; }
      let reads = 0;
      for (const name of Object.keys(f.client)) if (typeof f.client[name] === 'function') {
        f.client[name] = async () => { reads++; throw new Error('Unexpected native read for invalid identity'); };
      }
      await expect(f.runtime.preflightCanonicalRestore(f.opts)).rejects.toThrow(/identity|name|worker/i);
      expect(reads).toBe(0); expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
    } finally { await f.cleanup(); }
  }
});

test('preflight freshly resolves selected recipes and rejects deletion or changed fingerprint/source before destination admission', async () => {
  for (const drift of ['deleted', 'fingerprint', 'recipe', 'oci-source']) {
    const f = await fixture(); try {
      const source = { ...restoreSource(f), recipeId: 'd'.repeat(64) };
      const listed = { ...f.image, fingerprint: 'e'.repeat(64), properties: { ...f.image.properties, recipe_id: source.recipeId } };
      let selectedReads = 0, destinationReads = 0;
      f.client.listImages = async () => [structuredClone(listed)];
      f.client.getImage = async (fingerprint: string) => {
        if (fingerprint !== listed.fingerprint) return f.image;
        selectedReads++;
        if (drift === 'deleted') throw Object.assign(new Error('Selected image was deleted'), { statusCode: 404 });
        if (drift === 'fingerprint') return { ...listed, fingerprint: 'f'.repeat(64) };
        return { ...listed, properties: { ...listed.properties,
          ...(drift === 'recipe' ? { recipe_id: 'f'.repeat(64) } : { source_image_id: 'sha256:' + 'f'.repeat(64) }) } };
      };
      f.client.getInstance = f.client.getCustomVolume = async () => { destinationReads++; throw new Error('Unexpected destination read'); };
      await expect(f.runtime.preflightCanonicalRestore(f.opts, source)).rejects.toThrow(/deleted|changed/i);
      expect(selectedReads).toBe(1); expect(destinationReads).toBe(0);
      expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0); expect(f.current()).toBeUndefined();
    } finally { await f.cleanup(); }
  }
});

test('preflight rejects invalid nonce/start and managed layout before destination reads or allocation', async () => {
  for (const failure of ['nonce', 'start', 'workspace', 'restore', 'collision', 'attached-overlap']) {
    const f = await fixture(); try {
      const { volume } = await managedPayload(f);
      if (failure === 'nonce') delete f.opts.recreationNonce;
      if (failure === 'start') f.opts.start = true;
      if (failure === 'workspace') volume.target = '/workspace/private';
      if (failure === 'restore') volume.target = '/restore/private';
      if (failure === 'collision' || failure === 'attached-overlap') {
        const id = failure === 'collision' ? volume.id.slice(0, 8) + '-1111-2222-3333-444444444444' : randomUUID();
        f.opts.managedVolumes!.push({ ...volume, id, dockerName: 'agentor-persist-' + id,
          target: failure === 'collision' ? '/srv/another' : volume.target + '/child' });
      }
      let destinationReads = 0;
      f.client.getInstance = f.client.getCustomVolume = async () => { destinationReads++; throw new Error('Unexpected destination read'); };
      await expect(f.runtime.preflightCanonicalRestore(f.opts)).rejects.toThrow();
      expect(destinationReads).toBe(0); expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
    } finally { await f.cleanup(); }
  }
});

test('managed inverse uses fresh ordinary volumes at fixed UUID paths and streams unchanged payload after canonical roots', async () => {
  const f = await fixture(); try {
    const managed = await managedPayload(f), created = await f.runtime.createCanonicalRestore(f.opts);
    const key = 'm' + managed.volume.id.replaceAll('-', '').slice(0, 6);
    expect(created.devices[key]).toEqual({ type: 'disk', pool: 'default', source: managed.volume.dockerName,
      path: `/restore/managed/${managed.volume.id}/volume` });
    expect(Object.keys(created.devices).sort()).toEqual(['agents', key, 'root', 'workspace'].sort());
    expect(f.events).toEqual(['volume-create', 'volume-create', 'volume-create', 'create']);
    await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined, [managed]);
    expect(f.events.filter(x => x === 'extract')).toHaveLength(1);
    expect(managed.volume.seeded).toBe(false);
    await expect(f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}))
      .rejects.toThrow('committed');
    expect(f.events).not.toContain('promote');
  } finally { await f.cleanup(); }
});

test('explicit detached inverse uses the same isolated extractor without changing detached records or inventing workers', async () => {
  const f = await fixture(); try {
    f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
    const original = await managedPayload(f);
    f.opts.managedVolumes = [];
    const volume = { ...original.volume, attached: false, retainedAfterAccountDeletion: true };
    const snapshot = structuredClone(volume), detached = { volume, archivePath: original.archivePath };
    const created = await f.runtime.createCanonicalRestore(f.opts, undefined, false, [volume]);
    expect(created.devices['m' + volume.id.replaceAll('-', '').slice(0, 6)]?.path).toBe(`/restore/managed/${volume.id}/volume`);
    expect(created.devices.eth0).toBeUndefined();
    const records = new WorkerStore(f.dataDir); await records.init(); expect(records.list()).toEqual([]);
    let checks = 0;
    await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {
      checks++; expect(volume).toEqual(snapshot);
    }, undefined, [], [], [detached]);
    expect(checks).toBeGreaterThan(5);
    expect(f.inputs).toHaveLength(1);
    expect(f.inputs[0]!.command.at(-1)).toBe('managed:' + volume.id);
    expect(Buffer.concat(f.inputs[0]!.chunks)).toEqual(await (await import('node:fs/promises')).readFile(original.archivePath));
    expect(volume).toEqual(snapshot); expect(f.events).not.toContain('promote');
    await expect(f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}, 'stopped', [volume]))
      .rejects.toThrow('committed');
    expect(records.list()).toEqual([]);
  } finally { await f.cleanup(); }
});

test('mixed inverse keeps historical target overlap separate and removes detached references only after acknowledged promotion', async () => {
  const f = await fixture(); try {
    f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
    const attached = await managedPayload(f);
    const id = randomUUID(), detached = { ...attached.volume, id, dockerName: 'agentor-persist-' + id,
      attached: false, retainedAfterAccountDeletion: true };
    const created = await f.runtime.createCanonicalRestore(f.opts, undefined, false, [detached]);
    await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined,
      [attached], [], [{ volume: detached, archivePath: attached.archivePath }]);
    const name = detached.dockerName, baseline = structuredClone(f.volumes.get(name));
    f.opts.managedVolumes = [{ ...attached.volume, seeded: true, state: 'ready' }];
    (f.runtime as any).accountDevices = async () => ({});
    (f.runtime as any).managedDevices = (IncusWorkerRuntime.prototype as any).managedDevices.bind(f.runtime);
    (f.runtime as any).start = async () => { throw new Error('Stopped restore must never activate'); };
    await f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}, 'stopped',
      [{ ...detached, seeded: true, state: 'detached' }]);
    expect(f.current().status).toBe('Stopped');
    expect(f.current().devices['m' + attached.volume.id.replaceAll('-', '').slice(0, 6)]?.path).toBe(attached.volume.target);
    expect(f.current().devices['m' + detached.id.replaceAll('-', '').slice(0, 6)]).toBeUndefined();
    expect(f.volumes.get(name)).toEqual({ ...baseline, used_by: [] });
    expect(detached.attached).toBe(false); expect(detached.seeded).toBe(false);
  } finally { await f.cleanup(); }
});

test('detached inverse rejects implicit admission, foreign identity, duplicate/private-key collisions and combined quota before allocation', async () => {
  for (const violation of ['implicit', 'attached', 'foreign-owner', 'foreign-worker', 'duplicate', 'short-key', 'quota',
    'null-operation', 'null-live', 'null-seeded'] as const) {
    const f = await fixture(); try {
      const original = await managedPayload(f);
      const id = randomUUID();
      const detached = { ...original.volume, id, dockerName: 'agentor-persist-' + id, attached: false };
      let list = [detached];
      if (violation === 'implicit') { f.opts.managedVolumes = [detached]; list = []; }
      if (violation === 'attached') detached.attached = true;
      if (violation === 'foreign-owner') detached.userId = 'foreign-owner';
      if (violation === 'foreign-worker') detached.workerId = randomUUID();
      if (violation === 'null-operation') (detached as any).operation = null;
      if (violation === 'null-live') (detached as any).incusLive = null;
      if (violation === 'null-seeded') (detached as any).seeded = null;
      if (violation === 'duplicate') list = [detached, { ...detached }];
      if (violation === 'short-key') {
        const collision = id.slice(0, 8) + '-1111-2222-3333-444444444444';
        list.push({ ...detached, id: collision, dockerName: 'agentor-persist-' + collision });
      }
      if (violation === 'quota') list = Array.from({ length: 32 }, () => {
        const next = randomUUID(); return { ...detached, id: next, dockerName: 'agentor-persist-' + next };
      });
      await expect(f.runtime.createCanonicalRestore(f.opts, undefined, false, list)).rejects.toThrow();
      expect(f.events).toEqual([]);
    } finally { await f.cleanup(); }
  }
});

test('detached stream failure or durable-record drift stops exact incomplete compute without data publication', async () => {
  for (const failure of ['stream', 'record']) {
    const f = await fixture(); try {
      const original = await managedPayload(f); f.opts.managedVolumes = [];
      const volume = { ...original.volume, attached: false };
      const created = await f.runtime.createCanonicalRestore(f.opts, undefined, false, [volume]);
      let changed = false;
      if (failure === 'stream') f.failExec();
      else {
        const stream = f.client.execStream;
        f.client.execStream = async (...args: any[]) => { const result = await stream(...args); changed = true; return result; };
      }
      await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {
        if (changed) throw new Error('Detached durable record changed');
      }, undefined, [], [], [{ volume, archivePath: original.archivePath }])).rejects.toThrow();
      expect(f.current().status).toBe('Stopped'); expect(f.current().config['user.agentor.restore']).toBe('incomplete');
      expect(volume.attached).toBe(false); expect(volume.seeded).toBe(false); expect(f.events).not.toContain('promote');
    } finally { await f.cleanup(); }
  }
});

test('detached promotion rejects changed data identity, remaining references and unknown acknowledgements', async () => {
  for (const failure of ['config', 'creation', 'reference', 'unknown']) {
    const f = await fixture(); try {
      f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
      const original = await managedPayload(f); f.opts.managedVolumes = [];
      const volume = { ...original.volume, attached: false };
      const created = await f.runtime.createCanonicalRestore(f.opts, undefined, false, [volume]);
      await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined, [], [],
        [{ volume, archivePath: original.archivePath }]);
      (f.runtime as any).accountDevices = async () => ({});
      (f.runtime as any).managedDevices = async () => ({});
      (f.runtime as any).start = async () => { throw new Error('Stopped restore must never activate'); };
      const promote = f.client.updateInstanceDevices;
      f.client.updateInstanceDevices = async (...args: any[]) => {
        await promote(...args);
        const native = f.volumes.get(volume.dockerName);
        if (failure === 'config') native.config['user.extra'] = 'changed';
        if (failure === 'creation') native.created_at = '2026-10-06T00:00:00Z';
        if (failure === 'reference') native.used_by = ['/1.0/instances/' + f.opts.containerName + '?project=agentor'];
        if (failure === 'unknown') throw new Error('Unknown native promotion acknowledgement');
      };
      await expect(f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}, 'stopped',
        [{ ...volume, seeded: true, state: 'detached' }])).rejects.toThrow();
      expect(f.current().status).toBe('Stopped');
      expect(f.current().config['user.agentor.recreation']).toBe(f.opts.recreationNonce);
      expect(f.events).not.toContain('activated');
    } finally { await f.cleanup(); }
  }
});

test('managed inverse rejects duplicate short keys and restore-path overlap before any storage allocation', async () => {
  for (const kind of ['collision', 'restore-target']) {
    const f = await fixture(); try {
      const { volume } = await managedPayload(f);
      if (kind === 'collision') {
        const id = volume.id.slice(0, 8) + '-1111-2222-3333-444444444444';
        f.opts.managedVolumes!.push({ ...volume, id, dockerName: 'agentor-persist-' + id, target: '/srv/other-data' });
      } else f.opts.managedVolumes![0] = { ...volume, target: '/restore/subtree' };
      await expect(f.runtime.createCanonicalRestore(f.opts)).rejects.toThrow();
      expect(f.events).toEqual([]);
    } finally { await f.cleanup(); }
  }
});

test('managed extraction rejects hidden local layout drift, mismatched payload plans and foreign native storage references before boot', async () => {
  for (const kind of ['local-device', 'payload', 'reference']) {
    const f = await fixture(); try {
      const managed = await managedPayload(f), created = await f.runtime.createCanonicalRestore(f.opts);
      if (kind === 'local-device') f.current().devices = { ...f.current().devices, hidden: { type: 'nic', network: 'foreign' } };
      if (kind === 'reference') f.volumes.get(managed.volume.dockerName).used_by = [
        `/1.0/instances/${f.opts.containerName}?project=agentor&project=agentor`];
      await expect(f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined,
        kind === 'payload' ? [{ ...managed, volume: { ...managed.volume, target: '/srv/different' } }] : [managed])).rejects.toThrow();
      expect(f.events).not.toContain('start'); expect(f.events).not.toContain('extract');
    } finally { await f.cleanup(); }
  }
});

test('managed promotion probes actual operational target ancestors before grants and fences both layouts and native data authority', async () => {
  for (const kind of ['success', 'symlink', 'local-device', 'volume-drift']) {
    const f = await fixture(); try {
      const managed = await managedPayload(f), created = await f.runtime.createCanonicalRestore(f.opts);
      await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined, [managed]);
      f.opts.managedVolumes = [{ ...managed.volume, seeded: true, state: 'ready' }];
      (f.runtime as any).accountDevices = async () => { f.events.push('grants'); return {}; };
      (f.runtime as any).managedDevices = (IncusWorkerRuntime.prototype as any).managedDevices.bind(f.runtime);
      (f.runtime as any).start = async () => { f.events.push('activated'); };
      const exec = f.client.exec;
      f.client.exec = async (...args: any[]) => {
        if (args[1].includes(INCUS_PERSISTENCE_TARGET_CHECK)) {
          f.events.push('target-probe'); expect(args[1].at(-2)).toBe('/srv/restored-data');
          if (kind === 'symlink') return { returnCode: 1, stdout: '', stderr: 'target is symlink' };
          if (kind === 'volume-drift') f.volumes.get(managed.volume.dockerName).config['user.foreign'] = 'changed';
        }
        return exec(...args);
      };
      if (kind === 'local-device') f.current().devices = { ...f.current().devices, hidden: { type: 'disk', path: '/foreign', source: '/host' } };
      const finished = f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {});
      if (kind === 'success') {
        await finished;
        expect(f.events.indexOf('target-probe')).toBeLessThan(f.events.indexOf('grants'));
        expect(f.current().devices['m' + managed.volume.id.replaceAll('-', '').slice(0, 6)].path).toBe('/srv/restored-data');
        expect(f.events).toContain('activated');
      } else {
        await expect(finished).rejects.toThrow();
        expect(f.events).not.toContain('promote'); expect(f.events).not.toContain('grants');
      }
    } finally { await f.cleanup(); }
  }
});

test('Docker raw inverse uses fresh isolated block before ordinary paths and preserves disabled capability storage at promotion', async () => {
  const f = await fixture(); try {
    const stage = join(f.dataDir, 'docker-source'); await mkdir(join(stage, 'docker'), { recursive: true });
    await writeFile(join(stage, 'docker', 'data'), 'Docker logical state');
    const archivePath = join(f.dataDir, 'docker.tar');
    execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archivePath, 'docker']);
    f.opts.environmentJson.dockerEnabled = false; f.opts.dockerEnabled = false;
    const instance = await f.runtime.createCanonicalRestore(f.opts, undefined, true);
    expect(Object.keys(instance.devices).sort()).toEqual(['agents', 'docker', 'root', 'workspace']);
    const block = f.volumes.get(f.opts.containerName + '-docker');
    expect(block.content_type).toBe('block'); expect(block.config['user.agentor.restore-nonce']).toBe(f.opts.recreationNonce);
    await f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
      [{ path: '/var/lib/docker', archivePath }]);
    expect(f.inputs.map(input => input.command)).toEqual([['/usr/bin/python3', '-c', INCUS_DOCKER_RESTORE_SCRIPT]]);
    expect(block.config['user.agentor.allow-initialization']).toBe('false');
    expect(f.volumes.get(f.opts.containerName + '-workspace').config['user.agentor.docker-data']).toBe('true');
    (f.runtime as any).accountDevices = async () => ({});
    (f.runtime as any).managedDevices = async () => ({});
    (f.runtime as any).start = async () => { f.events.push('activated'); };
    await f.runtime.finishCanonicalRestore(f.opts, instance.config['volatile.uuid']!, () => {});
    expect(f.current().devices.docker).toEqual(instance.devices.docker);
    expect(f.events).toContain('activated');
  } finally { await f.cleanup(); }
});

test('Docker inverse refuses foreign nonce, missing payload or initialized destinations before starting compute', async () => {
  for (const scenario of ['nonce', 'initialized', 'payload-missing', 'duplicate'] as const) {
    const f = await fixture(); try {
      const stage = join(f.dataDir, 'docker-source'); await mkdir(join(stage, 'docker'), { recursive: true });
      const archivePath = join(f.dataDir, 'docker.tar'); execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archivePath, 'docker']);
      const instance = await f.runtime.createCanonicalRestore(f.opts, undefined, true);
      const block = f.volumes.get(f.opts.containerName + '-docker');
      if (scenario === 'nonce') block.config['user.agentor.restore-nonce'] = randomUUID();
      if (scenario === 'initialized') block.config['user.agentor.allow-initialization'] = 'false';
      const item = { path: '/var/lib/docker', archivePath };
      await expect(f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
        scenario === 'payload-missing' ? [] : scenario === 'duplicate' ? [item, item] : [item])).rejects.toThrow();
      expect(f.events).not.toContain('start'); expect(f.events).not.toContain('extract');
    } finally { await f.cleanup(); }
  }
});

test('stopped restore completion retains canonical and Docker data without provisioning or service activation', async () => {
  for (const docker of [false, true]) {
    const f = await fixture(); try {
      const selected: Array<{ path: string; archivePath: string }> = [];
      if (docker) {
        const stage = join(f.dataDir, 'docker-source'); await mkdir(join(stage, 'docker'), { recursive: true });
        const archivePath = join(f.dataDir, 'docker.tar');
        execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archivePath, 'docker']);
        selected.push({ path: '/var/lib/docker', archivePath });
      } else { f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false; }
      const created = await f.runtime.createCanonicalRestore(f.opts, undefined, docker);
      await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {}, undefined, [], selected);
      (f.runtime as any).accountDevices = async () => ({});
      (f.runtime as any).managedDevices = async () => ({});
      (f.runtime as any).start = async () => { throw new Error('Stopped restore must never activate'); };
      const priorStarts = f.events.filter(event => event === 'start').length;
      await f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}, 'stopped');
      expect(f.current().status).toBe('Stopped');
      expect(f.current().config['user.agentor.restore']).toBeUndefined();
      expect(f.current().config['user.agentor.recreation']).toBe(f.opts.recreationNonce);
      expect(f.current().devices.workspace.path).toBe('/workspace');
      expect(f.current().devices.agents.path).toBe('/home/agent/.agent-data');
      expect(f.current().devices.eth0['security.ipv4_filtering']).toBe('true');
      expect(f.current().devices.eth0['security.mac_filtering']).toBe('true');
      expect(f.events.filter(event => event === 'start')).toHaveLength(priorStarts);
      expect(!!f.current().devices.docker).toBe(docker);
      if (docker) expect(f.volumes.get(f.opts.containerName + '-docker').config['user.agentor.allow-initialization']).toBe('false');
    } finally { await f.cleanup(); }
  }
});

test('stopped restore proves final local/expanded layout and durable authority without inferring an unknown promotion', async () => {
  for (const drift of ['local', 'expanded', 'profile', 'raw', 'unknown-put', 'record'] as const) {
    const f = await fixture(); try {
      f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
      const created = await f.runtime.createCanonicalRestore(f.opts);
      await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {});
      (f.runtime as any).accountDevices = async () => ({});
      (f.runtime as any).managedDevices = async () => ({});
      (f.runtime as any).start = async () => { throw new Error('Stopped restore must never activate'); };
      const promote = f.client.updateInstanceDevices;
      f.client.updateInstanceDevices = async (...args: any[]) => {
        await promote(...args);
        if (drift === 'local') f.current().devices = { ...f.current().devices, foreign: { type: 'disk', source: '/host', path: '/foreign' } };
        if (drift === 'expanded') f.current().expanded_devices = { ...f.current().devices, foreign: { type: 'nic', network: 'foreign' } };
        if (drift === 'profile') f.current().profiles = ['foreign'];
        if (drift === 'raw') f.current().expanded_config = { 'raw.qemu': 'foreign' };
        if (drift === 'unknown-put') throw new Error('Unknown native PUT acknowledgement');
      };
      const validate = () => {
        if (drift === 'record' && f.events.includes('promote')) throw new Error('Durable restore authority changed');
      };
      await expect(f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, validate, 'stopped')).rejects.toThrow();
      expect(f.current().status).toBe('Stopped');
      expect(f.current().config['user.agentor.recreation']).toBe(f.opts.recreationNonce);
      expect(f.events).not.toContain('activated');
    } finally { await f.cleanup(); }
  }
});

test('invalid restore activation is rejected before native reads or mutations', async () => {
  const f = await fixture(); try {
    f.client.getReadiness = async () => { throw new Error('Invalid mode must not inspect native runtime'); };
    await expect(f.runtime.finishCanonicalRestore(f.opts, randomUUID(), () => {}, 'invalid' as any))
      .rejects.toThrow('Invalid canonical restore activation');
    expect(f.events).toEqual([]);
  } finally { await f.cleanup(); }
});

test('stopped completion rechecks host assignment and source identity after awaited native promotion', async () => {
  const original = { ensure: IncusHostMountClient.prototype.ensure, inspect: IncusHostMountClient.prototype.inspect };
  for (const change of ['unchanged', 'revoked', 'source-replaced'] as const) {
    const f = await fixture(); try {
      f.opts.dockerEnabled = false; f.opts.environmentJson.dockerEnabled = false;
      const workers = new WorkerStore(f.dataDir), groups = new WorkerGroupStore(f.dataDir);
      f.config.incusNetworkHostEndpoint = 'https://host-policy.invalid';
      const host = new HostMountStore(f.dataDir, () => '/srv/agentor-stopped-restore-data', groups, workers);
      await host.init();
      const created = await f.runtime.createCanonicalRestore(f.opts);
      await f.runtime.restoreCanonicalArchives(f.opts, created.config['volatile.uuid']!, {}, () => {});
      await workers.upsert({ id: f.opts.id, userId: f.opts.userId, runtimeKind: 'incus-vm', status: 'active',
        displayName: 'Stopped host grant test', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        incusRecreation: { nonce: f.opts.recreationNonce!, replacementIncarnation: created.config['volatile.uuid'],
          initialCreate: true, importIncomplete: true } });
      const path = await host.createPath({ name: 'Approved stopped share', sourcePath: '/srv/approved-stopped-share' });
      await host.setEntitlement(f.opts.userId, path.id, true);
      const grant = await host.createOwnerGrant(f.opts.userId, { pathId: path.id, targetType: 'worker', targetId: f.opts.id });
      f.opts.storageManager = { dataHostPath: '/srv/agentor-stopped-restore-data' } as IncusWorkerOptions['storageManager'];
      f.opts.mounts = [{ pathId: path.id, source: '/caller-forged', target: '/mnt/approved' }];
      let sourceIdentity = 'a'.repeat(64);
      const observation = async () => ({ installation: 'test', project: 'agentor', pathId: path.id,
        sourcePath: path.sourcePath, allowWrite: false, sourceIdentity });
      IncusHostMountClient.prototype.ensure = observation;
      IncusHostMountClient.prototype.inspect = observation;
      (f.runtime as any).accountDevices = async () => ({});
      (f.runtime as any).managedDevices = async () => ({});
      (f.runtime as any).start = async () => { throw new Error('Stopped restore must never activate'); };
      const promote = f.client.updateInstanceDevices;
      f.client.updateInstanceDevices = async (...args: any[]) => {
        await promote(...args);
        if (change === 'revoked') await host.deleteGrant(f.opts.userId, grant.id);
        if (change === 'source-replaced') sourceIdentity = 'b'.repeat(64);
      };
      const completed = f.runtime.finishCanonicalRestore(f.opts, created.config['volatile.uuid']!, () => {}, 'stopped');
      if (change === 'unchanged') await completed;
      else await expect(completed).rejects.toThrow(change === 'revoked' ? 'not assigned' : 'host authority changed');
      expect(f.current().status).toBe('Stopped');
      expect(f.current().config['user.agentor.recreation']).toBe(f.opts.recreationNonce);
      expect(f.events).not.toContain('activated');
    } finally {
      IncusHostMountClient.prototype.ensure = original.ensure;
      IncusHostMountClient.prototype.inspect = original.inspect;
      await f.cleanup();
    }
  }
});

test('failed Docker extraction stops exact incomplete compute without promoting storage initialization or retained-data authority', async () => {
  const f = await fixture(); try {
    const stage = join(f.dataDir, 'docker-source'); await mkdir(join(stage, 'docker'), { recursive: true });
    const archivePath = join(f.dataDir, 'docker.tar'); execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archivePath, 'docker']);
    const instance = await f.runtime.createCanonicalRestore(f.opts, undefined, true); f.failExec();
    await expect(f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
      [{ path: '/var/lib/docker', archivePath }])).rejects.toThrow('Docker extraction failed');
    expect(f.current().status).toBe('Stopped'); expect(f.current().config['user.agentor.restore']).toBe('incomplete');
    expect(f.volumes.get(f.opts.containerName + '-docker').config['user.agentor.allow-initialization']).toBe('true');
    expect(f.volumes.get(f.opts.containerName + '-workspace').config['user.agentor.docker-data']).toBeUndefined();
    expect(f.events).not.toContain('promote');
  } finally { await f.cleanup(); }
});

test('Docker restore promotion rejects incomplete metadata and foreign storage references before granting network or shares', async () => {
  for (const scenario of ['nonce', 'uninitialized', 'retained', 'reference', 'expanded-layout', 'created-at'] as const) {
    const f = await fixture(); try {
      const stage = join(f.dataDir, 'docker-source'); await mkdir(join(stage, 'docker'), { recursive: true });
      const archivePath = join(f.dataDir, 'docker.tar'); execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archivePath, 'docker']);
      const instance = await f.runtime.createCanonicalRestore(f.opts, undefined, true);
      await f.runtime.restoreCanonicalArchives(f.opts, instance.config['volatile.uuid']!, {}, () => {}, undefined, [],
        [{ path: '/var/lib/docker', archivePath }]);
      const block = f.volumes.get(f.opts.containerName + '-docker');
      if (scenario === 'nonce') block.config['user.agentor.restore-nonce'] = randomUUID();
      if (scenario === 'uninitialized') block.config['user.agentor.allow-initialization'] = 'true';
      if (scenario === 'retained') delete f.volumes.get(f.opts.containerName + '-workspace').config['user.agentor.docker-data'];
      if (scenario === 'reference') block.used_by = ['/1.0/instances/' + f.opts.containerName + '?project=foreign'];
      if (scenario === 'created-at') block.created_at = 'unknown';
      if (scenario === 'expanded-layout') {
        f.current().expanded_devices = { ...f.current().devices, hidden: { type: 'nic', network: 'foreign' } };
      }
      (f.runtime as any).accountDevices = async () => { f.events.push('grants'); return {}; };
      await expect(f.runtime.finishCanonicalRestore(f.opts, instance.config['volatile.uuid']!, () => {})).rejects.toThrow();
      expect(f.events).not.toContain('grants'); expect(f.events).not.toContain('promote');
      expect(f.current().config['user.agentor.restore']).toBe('incomplete');
    } finally { await f.cleanup(); }
  }
});

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

test('custom canonical restore uses only private authorized source resolution and never the default image', async () => {
  const f = await fixture(); try {
    const identity = incusImageIdentity(f.image), definitionId = randomUUID();
    const opts = { ...f.opts, image: identity.sourceImageId,
      imageSelection: { definitionId, version: 'v1', digest: identity.sourceImageId } };
    const source = { sourceImageId: identity.sourceImageId, recipeId: 'd'.repeat(64), architecture: 'amd64' as const,
      converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const };
    let revoked = false, resolutions = 0;
    f.runtime.setImageResolver(async (actual, stored, described) => {
      expect(actual.imageSelection).toEqual(opts.imageSelection); expect(stored).toBeUndefined(); expect(described).toEqual(source);
      if (revoked) throw new Error('Custom restore permission revoked');
      resolutions++; return identity;
    });
    f.client.getImageAlias = async () => { throw new Error('Custom restore cannot use the default alias'); };
    await expect(f.runtime.preflightCanonicalRestore(opts, { ...source, sourceImageId: 'sha256:' + 'e'.repeat(64) }))
      .rejects.toMatchObject({ code: 'INCUS_RESTORE_IMAGE_NOT_AUTHORIZED' });
    expect(resolutions).toBe(0); expect(f.events).toEqual([]);
    await f.runtime.preflightCanonicalRestore(opts, source);
    expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
    revoked = true;
    await expect(f.runtime.createCanonicalRestore(opts, source)).rejects.toThrow('permission revoked');
    expect(f.events).toEqual([]); expect(f.volumes.size).toBe(0);
    revoked = false;
    const created = await f.runtime.createCanonicalRestore(opts, source);
    expect(created.config['volatile.base_image']).toBe(identity.fingerprint);
    expect(resolutions).toBe(2);
  } finally { await f.cleanup(); }
});

test('historical custom canonical create and promotion keep the same private source through normal activation', async () => {
  const f = await fixture(); try {
    f.image.properties.recipe_id = 'd'.repeat(64);
    const image = incusImageIdentity(f.image), source = { sourceImageId: image.sourceImageId, recipeId: image.recipeId,
      architecture: image.architecture, converterVersion: image.converterVersion, bootstrapGeneration: image.bootstrapGeneration };
    const opts = { ...f.opts, dockerEnabled: false, environmentJson: { ...f.opts.environmentJson, dockerEnabled: false },
      image: image.sourceImageId, imageSelection: { definitionId: randomUUID(), version: 'v1', digest: image.sourceImageId } };
    let resolutions = 0;
    f.runtime.setImageResolver(async (_actual, stored, described) => {
      expect(described).toEqual(source); if (stored) expect(stored).toEqual(image);
      resolutions++; return image;
    });
    f.client.getImageAlias = async () => { throw new Error('Historical custom source cannot use the default alias'); };
    const instance = await f.runtime.createCanonicalRestore(opts, source);
    await f.runtime.restoreCanonicalArchives(opts, instance.config['volatile.uuid']!, {
      workspace: await rawArchive(f.dataDir, 'workspace'), agents: await rawArchive(f.dataDir, 'agents') }, () => {});
    (f.runtime as any).accountDevices = async () => ({});
    (f.runtime as any).managedDevices = async () => ({});
    f.client.pushFile = async () => { f.events.push('provision'); };
    await f.runtime.finishCanonicalRestore(opts, instance.config['volatile.uuid']!, () => {});
    expect(resolutions).toBe(2); expect(f.events).toContain('provision'); expect(f.current().status).toBe('Running');
    expect((await f.runtime.preflightRecreation(opts)).fingerprint).toBe(image.fingerprint);
    expect(resolutions).toBe(3);
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
