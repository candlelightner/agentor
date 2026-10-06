import { test, expect } from "@playwright/test";
import { IncusWorkerStorage } from "../../orchestrator/server/utils/incus-worker-storage";
import type { Config } from "../../orchestrator/server/utils/config";
import { IncusClient } from '../../orchestrator/server/utils/incus-client';
import { randomUUID } from 'node:crypto';

const owner = { id: "worker", userId: "owner", containerName: "agentor-worker-worker" };
const config = { containerPrefix: "agentor-worker", incusProject: "agentor", incusStoragePool: "pool",
  incusDockerVolumeSize: "4GiB" } as Config;

function fixture() {
  const volumes = new Map<string, any>();
  const writes: string[] = [];
  const client = {
    endpoint: "https://incus.invalid",
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes.has(name)) throw Object.assign(new Error("missing"), { statusCode: 404 });
      return structuredClone(volumes.get(name));
    },
    createCustomVolume: async (_pool: string, spec: any) => {
      writes.push(`create:${spec.name}`);
      volumes.set(spec.name, { ...spec, type: "custom", used_by: [] });
    },
    updateCustomVolume: async (_pool: string, name: string, value: any) => {
      writes.push(`update:${name}`); volumes.get(name).config = value;
    },
    deleteCustomVolume: async (_pool: string, name: string) => { writes.push(`delete:${name}`); volumes.delete(name); },
  };
  return { volumes, writes, client, storage: new IncusWorkerStorage(client as any, config, "installation") };
}

test("filesystem persistence is separate from disposable root and Docker capability", async () => {
  const { storage, volumes } = fixture();
  const devices = await storage.devices(owner, false);
  expect(devices.workspace).toEqual({ type: "disk", pool: "pool", source: `${owner.containerName}-workspace`, path: "/workspace" });
  expect(devices.agents.path).toBe("/home/agent/.agent-data");
  expect(devices.docker).toBeUndefined();
  expect(volumes.size).toBe(2);
});

test('Docker inverse allocates only fresh nonce-owned block storage and retains it even with Docker disabled', async () => {
  const f = fixture(), nonce = randomUUID();
  const devices = await f.storage.freshRestoreDevices(owner, nonce);
  expect(devices.docker).toEqual({ type: 'disk', pool: 'pool', source: owner.containerName + '-docker' });
  const block = f.volumes.get(owner.containerName + '-docker');
  expect(block.config).toMatchObject({ size: '4GiB', 'user.agentor.restore-nonce': nonce,
    'user.agentor.allow-initialization': 'true' });
  await expect(f.storage.markDockerRestored(owner, randomUUID())).rejects.toThrow('authority');
  const before = f.writes.length;
  await expect(f.storage.freshRestoreDevices(owner, nonce)).rejects.toThrow('absent');
  expect(f.writes).toHaveLength(before);
  await f.storage.markDockerRestored(owner, nonce);
  expect(block.config['user.agentor.allow-initialization']).toBe('false');
  expect(f.volumes.get(owner.containerName + '-workspace').config['user.agentor.docker-data']).toBe('true');
  expect((await f.storage.devices(owner, false, { docker: true })).docker).toEqual(devices.docker);
  await expect(f.storage.markDockerRestored(owner, nonce)).rejects.toThrow('authority');
});

test('fresh inverse preflight denies even detached Docker data and invalid nonce before any allocations', async () => {
  const f = fixture();
  await expect(f.storage.freshRestoreDevices(owner, 'arbitrary')).rejects.toThrow('nonce');
  expect(f.writes).toEqual([]);
  f.volumes.set(owner.containerName + '-docker', { name: owner.containerName + '-docker' });
  await expect(f.storage.freshRestoreDevices(owner, randomUUID())).rejects.toThrow('absent');
  expect(f.writes).toEqual([]);
});

test('restored ownership preservation is durable on both exact private roots and refuses malformed/partial metadata', async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, false);
  expect(await storage.preserveOwnership(owner)).toBe(false);
  await storage.markPreserveOwnership(owner);
  expect(await storage.preserveOwnership(owner)).toBe(true);
  const before = writes.length; await storage.markPreserveOwnership(owner); expect(writes).toHaveLength(before);
  const agents = volumes.get(owner.containerName + '-agents');
  for (const flag of [undefined, 'false', '', '1']) {
    if (flag === undefined) delete agents.config['user.agentor.preserve-ownership'];
    else agents.config['user.agentor.preserve-ownership'] = flag;
    await expect(storage.preserveOwnership(owner)).rejects.toThrow('malformed or incomplete');
  }
  agents.config['user.agentor.preserve-ownership'] = 'false'; writes.length = 0;
  await expect(storage.markPreserveOwnership(owner)).rejects.toThrow('malformed'); expect(writes).toEqual([]);
  agents.config['user.agentor.preserve-ownership'] = 'true'; agents.config['user.agentor.owner'] = 'foreign';
  await expect(storage.preserveOwnership(owner)).rejects.toThrow('ownership/type');
});

test('workspace-only preservation is durable without changing agents and never waives incomplete whole-import flags', async () => {
  const f = fixture(); await f.storage.devices(owner, false);
  const workspace = f.volumes.get(owner.containerName + '-workspace'), agents = f.volumes.get(owner.containerName + '-agents');
  const oldAgents = structuredClone(agents);
  workspace.config['user.agentor.workspace-preserve-ownership'] = 'true';
  expect(await f.storage.preserveOwnership(owner)).toBe(true); expect(agents).toEqual(oldAgents);
  workspace.config['user.agentor.preserve-ownership'] = 'true';
  await expect(f.storage.preserveOwnership(owner)).rejects.toThrow('malformed or incomplete');
  delete workspace.config['user.agentor.preserve-ownership'];
  workspace.config['user.agentor.workspace-preserve-ownership'] = 'false';
  await expect(f.storage.preserveOwnership(owner)).rejects.toThrow('workspace ownership metadata');
  workspace.config['user.agentor.workspace-preserve-ownership'] = 'true';
  agents.config['user.agentor.workspace-preserve-ownership'] = 'true';
  await expect(f.storage.preserveOwnership(owner)).rejects.toThrow('workspace ownership metadata');
});

test('workspace-only marker updates exactly one owned snapshot with ETag and requires exact fresh acknowledgement', async () => {
  for (const scenario of ['valid', 'reference-order', 'ack-order', 'etag', 'foreign', 'created', 'reference', 'duplicate', 'conflict', 'unknown', 'changed-ack'] as const) {
    const f = fixture(); await f.storage.devices(owner, false);
    const helper = 'abk-' + randomUUID(), workspace = f.volumes.get(owner.containerName + '-workspace');
    Object.assign(workspace, { project: 'agentor', created_at: new Date(0).toISOString(), description: '',
      used_by: [`/1.0/instances/${owner.containerName}?project=agentor`, `/1.0/instances/${helper}?project=agentor`] });
    const expected = structuredClone(workspace), agents = structuredClone(f.volumes.get(owner.containerName + '-agents'));
    let put = false;
    if (scenario === 'ack-order') {
      const read = f.client.getCustomVolume;
      f.client.getCustomVolume = async (pool, name) => {
        const value = await read(pool, name); if (put) value.used_by.reverse(); return value;
      };
    }
    (f.client as any).rawRequest = async (method: string, path: string, body: any, headers: any) => {
      expect(path).toBe(`/1.0/storage-pools/pool/volumes/custom/${workspace.name}`);
      if (method === 'GET') {
        if (scenario === 'foreign') workspace.config['user.agentor.owner'] = 'other';
        if (scenario === 'created') workspace.created_at = new Date().toISOString();
        if (scenario === 'reference') workspace.used_by[1] = '/1.0/instances/foreign?project=agentor';
        if (scenario === 'reference-order') workspace.used_by.reverse();
        if (scenario === 'duplicate') workspace.used_by.push(workspace.used_by[0]);
        return { statusCode: 200, headers: scenario === 'etag' ? {} : { etag: 'exact-volume-etag' },
          body: Buffer.from(JSON.stringify({ type: 'sync', metadata: workspace })) };
      }
      expect(method).toBe('PUT'); expect(headers).toEqual({ 'If-Match': 'exact-volume-etag' });
      expect(body).toEqual({ description: '', config: { ...expected.config, 'user.agentor.workspace-preserve-ownership': 'true' } });
      put = true;
      if (scenario === 'unknown') throw new Error('PUT acknowledgement lost');
      if (scenario === 'conflict') return { statusCode: 412, body: Buffer.from(JSON.stringify({ type: 'error' })) };
      workspace.config = body.config;
      if (scenario === 'changed-ack') workspace.config['user.agentor.owner'] = 'foreign';
      return { statusCode: 200, body: Buffer.from(JSON.stringify({ type: 'sync' })) };
    };
    if (scenario === 'valid' || scenario === 'reference-order' || scenario === 'ack-order') {
      const acknowledged = await f.storage.markWorkspacePreserveOwnership(owner, expected, helper);
      expect({ ...acknowledged, used_by: [...acknowledged.used_by].sort() })
        .toEqual({ ...expected, used_by: [...expected.used_by].sort(), config: { ...expected.config, 'user.agentor.workspace-preserve-ownership': 'true' } });
      expect(put).toBe(true);
    } else {
      await expect(f.storage.markWorkspacePreserveOwnership(owner, expected, helper)).rejects.toThrow();
      expect(put).toBe(['conflict', 'unknown', 'changed-ack'].includes(scenario));
    }
    expect(f.volumes.get(owner.containerName + '-agents')).toEqual(agents);
  }
});

test("Docker block storage remains on disable and is reused on re-enable", async () => {
  const { storage, volumes, writes } = fixture();
  const devices = await storage.devices(owner, true);
  const block = volumes.get(`${owner.containerName}-docker`);
  expect(block.content_type).toBe("block");
  expect(block.config.size).toBe("4GiB");
  expect(await storage.dockerInitializationAllowed(owner)).toBe(true);
  await storage.markDockerInitialized(owner);
  expect(await storage.dockerInitializationAllowed(owner)).toBe(false);
  expect((await storage.devices(owner, false)).docker).toEqual(devices.docker);
  expect((await storage.devices(owner, true)).docker).toEqual(devices.docker);
  expect(writes.filter((write) => write.startsWith('create:'))).toHaveLength(3);
  expect(writes.filter((write) => write === `update:${owner.containerName}-workspace`)).toHaveLength(1);
});

test("foreign volume ownership fails closed without creating or deleting data", async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, true);
  volumes.get(`${owner.containerName}-agents`).config["user.agentor.installation"] = "foreign";
  writes.length = 0;
  await expect(storage.devices(owner, true)).rejects.toThrow("ownership/type");
  await expect(storage.remove(owner)).rejects.toThrow("ownership/type");
  expect(writes).toEqual([]);
});

test("an active attachment on another instance or project cannot be shared", async () => {
  const { storage, volumes } = fixture();
  await storage.devices(owner, true);
  const block = volumes.get(`${owner.containerName}-docker`);
  for (const ref of ["/1.0/instances/foreign?project=agentor", `/1.0/instances/${owner.containerName}?project=foreign`]) {
    block.used_by = [ref];
    await expect(storage.devices(owner, true)).rejects.toThrow("another runtime");
  }
  block.used_by = [`/1.0/instances/${owner.containerName}?project=agentor`];
  await storage.devices(owner, true);
  await expect(storage.remove(owner)).rejects.toThrow("attached");
});

test('partial first-create preflight permits missing volumes but never allocates or replaces canonical data', async () => {
  for (const roles of [[], ['workspace'], ['workspace', 'agents'], ['docker']]) {
    const { storage, volumes, writes } = fixture();
    await storage.devices(owner, true);
    for (const name of volumes.keys()) if (!roles.some((role) => name.endsWith('-' + role))) volumes.delete(name);
    writes.length = 0;
    await storage.verifyPartialInitial(owner);
    if (!roles.includes('workspace') || !roles.includes('agents'))
      await expect(storage.verifyExisting(owner)).rejects.toThrow('missing');
    expect(writes).toEqual([]);
    expect(volumes.size).toBe(roles.length);
  }
});

test('partial initial storage rejects foreign/type/metadata ambiguity and every attachment without writes', async () => {
  for (const failure of ['owner', 'installation', 'type', 'source', 'docker-marker', 'same-attachment', 'foreign-attachment']) {
    const { storage, volumes, writes } = fixture();
    await storage.devices(owner, true);
    const workspace = volumes.get(`${owner.containerName}-workspace`);
    if (failure === 'owner') workspace.config['user.agentor.owner'] = 'foreign';
    if (failure === 'installation') workspace.config['user.agentor.installation'] = 'foreign';
    if (failure === 'type') workspace.content_type = 'block';
    if (failure === 'source') workspace.config['user.agentor.image-source'] = '{invalid';
    if (failure === 'docker-marker') workspace.config['user.agentor.docker-data'] = 'false';
    if (failure === 'same-attachment') workspace.used_by = [`/1.0/instances/${owner.containerName}?project=agentor`];
    if (failure === 'foreign-attachment') workspace.used_by = ['/1.0/instances/foreign?project=agentor'];
    writes.length = 0;
    await expect(storage.verifyPartialInitial(owner)).rejects.toThrow();
    expect(writes).toEqual([]);
  }
});

test('partial initial preflight propagates unavailable storage rather than treating it as missing', async () => {
  for (const statusCode of [503, undefined]) {
    const { storage, writes } = fixture();
    (storage as any).client.getCustomVolume = async () => { throw Object.assign(new Error('storage unavailable'), { statusCode }); };
    await expect(storage.verifyPartialInitial(owner)).rejects.toThrow('storage unavailable');
    expect(writes).toEqual([]);
  }
});

test("permanent deletion removes only detached core worker-owned volumes", async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, true);
  volumes.set("managed-shared", { name: "managed-shared" });
  await storage.remove(owner);
  expect([...volumes.keys()]).toEqual(["managed-shared"]);
  expect(writes.filter((op) => op.startsWith("delete:"))).toHaveLength(3);
  await storage.remove(owner);
});

test("mismatched worker names and filesystem/block types are rejected", async () => {
  const { storage, volumes } = fixture();
  await expect(storage.devices({ ...owner, containerName: "foreign" }, true)).rejects.toThrow("identity");
  await storage.devices(owner, true);
  volumes.get(`${owner.containerName}-docker`).content_type = "filesystem";
  await expect(storage.devices(owner, true)).rejects.toThrow("ownership/type");
});

test('Docker allocation is sticky across capability disable and disposable compute removal', async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, true);
  expect(volumes.get(`${owner.containerName}-workspace`).config['user.agentor.docker-data']).toBe('true');
  await storage.devices(owner, false);
  expect(await storage.verifyExisting(owner)).toEqual({ docker: true });
  // No compute/attached devices are required to remember retained data.
  volumes.delete(`${owner.containerName}-docker`);
  writes.length = 0;
  await expect(storage.verifyExisting(owner)).rejects.toThrow('Existing Incus docker volume is missing');
  await expect(storage.devices(owner, false, { docker: false })).rejects.toThrow('Existing Incus docker volume is missing');
  await expect(storage.devices(owner, true, { docker: false })).rejects.toThrow('Existing Incus docker volume is missing');
  await expect(storage.devices(owner, true)).rejects.toThrow('Existing Incus docker volume is missing');
  expect(writes).toEqual([]);
});

test('read-only preflight distinguishes never-allocated Docker and rejects corrupt retained-data metadata', async () => {
  const { storage, volumes, writes } = fixture();
  await storage.devices(owner, false);
  writes.length = 0;
  expect(await storage.verifyExisting(owner)).toEqual({ docker: false });
  expect(writes).toEqual([]);
  volumes.get(`${owner.containerName}-workspace`).config['user.agentor.docker-data'] = 'false';
  await expect(storage.verifyExisting(owner)).rejects.toThrow('metadata is ambiguous');
  await expect(storage.devices(owner, true, { docker: false })).rejects.toThrow('metadata is ambiguous');
  expect(writes).toEqual([]);
});

test('failure persisting Docker expectation blocks compute attachment and retries the same block volume', async () => {
  const { storage, volumes, writes } = fixture();
  const client = (storage as any).client;
  const update = client.updateCustomVolume;
  client.updateCustomVolume = async () => { throw new Error('injected metadata failure'); };
  await expect(storage.devices(owner, true)).rejects.toThrow('injected metadata failure');
  expect(volumes.has(`${owner.containerName}-docker`)).toBe(true);
  expect(volumes.get(`${owner.containerName}-workspace`).config['user.agentor.docker-data']).toBeUndefined();
  client.updateCustomVolume = update;
  writes.length = 0;
  expect((await storage.devices(owner, false, { docker: false })).docker.source).toBe(`${owner.containerName}-docker`);
  expect(volumes.get(`${owner.containerName}-workspace`).config['user.agentor.docker-data']).toBe('true');
  expect(writes.some((write) => write.startsWith('create:'))).toBe(false);
});

test('real Incus retains Docker expectation without compute and refuses empty replacement after data loss', async () => {
  test.skip(process.env.INCUS_RETENTION_TEST !== 'true', 'Explicit isolated disposable-volume acceptance');
  test.setTimeout(120_000);
  const id = randomUUID();
  const target = { id, userId: 'retention-test', containerName: `${config.containerPrefix}-${id}` };
  const installation = randomUUID();
  const live = { ...config, incusStoragePool: 'default', incusEndpoint: 'https://127.0.0.1:18443',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as Config;
  const client = IncusClient.fromConfig(live);
  const storage = new IncusWorkerStorage(client, live, installation);
  try {
    await storage.devices(target, true);
    const workspace = await client.getCustomVolume(live.incusStoragePool, `${target.containerName}-workspace`);
    expect(workspace.config['user.agentor.docker-data']).toBe('true');
    await storage.devices(target, false, { docker: true });
    // Re-instantiate the manager: expectation is daemon-persisted, not a
    // process cache or inference from an attached/running VM device.
    const reloaded = new IncusWorkerStorage(client, live, installation);
    expect(await reloaded.verifyExisting(target)).toEqual({ docker: true });
    const docker = await client.getCustomVolume(live.incusStoragePool, `${target.containerName}-docker`);
    expect(docker.config['user.agentor.installation']).toBe(installation);
    expect(docker.used_by ?? []).toEqual([]);
    // Intentionally destroy only this nonce-owned empty test volume.
    await client.deleteCustomVolume(live.incusStoragePool, docker.name);
    await expect(reloaded.verifyExisting(target)).rejects.toThrow('Existing Incus docker volume is missing');
    await expect(reloaded.devices(target, false, { docker: false })).rejects.toThrow('Existing Incus docker volume is missing');
    await expect(reloaded.devices(target, true, { docker: false })).rejects.toThrow('Existing Incus docker volume is missing');
    await expect(client.getCustomVolume(live.incusStoragePool, docker.name)).rejects.toMatchObject({ statusCode: 404 });
  } finally { await storage.remove(target); }
});
