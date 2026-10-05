import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { IncusWorkerRuntime, serializeIncusWorkerEnv, INCUS_GUEST_READINESS_SCRIPT, INCUS_MAIN_SESSION_PROBE, type IncusWorkerOptions } from "../../orchestrator/server/utils/incus-worker-runtime";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import { cleanupWorkerMappings } from "../../orchestrator/server/utils/services";
import { zeroUserEnvVars } from "../../orchestrator/server/utils/user-env-store";
import type { Config } from "../../orchestrator/server/utils/config";
import { withOwnerLifecycleMutation } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";
import { StorageManager } from "../../orchestrator/server/utils/storage";
import { useWorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';
import { incusImageIdentity, sameIncusImageSource, validateIncusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import { IncusWorkerStorage } from '../../orchestrator/server/utils/incus-worker-storage';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { HostMountStore } from '../../orchestrator/server/utils/host-mount-store';
import { WorkerGroupStore } from '../../orchestrator/server/utils/worker-group-store';
import { IncusHostMountClient } from '../../orchestrator/server/utils/incus-host-mount-client';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });
(globalThis as any).cleanupWorkerMappings ??= cleanupWorkerMappings;

const config = {
  incusEnabled: true, incusEndpoint: "https://127.0.0.1:18443", incusProject: "agentor",
  incusClientCertPath: "/workspace/agentor-incus-tls/client.crt",
  incusClientKeyPath: "/workspace/agentor-incus-tls/client.key",
  incusServerCertPath: "/workspace/agentor-incus-tls/server.crt",
  incusWorkerImage: process.env.INCUS_TEST_IMAGE || "agentor-worker-takeover",
  incusNetwork: "incusbr0", incusStoragePool: "default",
  incusDockerVolumeSize: "4GiB",
  incusInternalGatewayUrl: "http://10.159.68.1:3000", containerPrefix: "agentor-worker",
  workerImagePrefix: "", workerImage: "agentor-worker:latest",
} as Config;

test.beforeAll(async () => { config.dataDir = await mkdtemp(join(tmpdir(), "agentor-incus-runtime-test-")); });
test.afterAll(async () => { await rm(config.dataDir, { recursive: true, force: true }); });

function options(): IncusWorkerOptions {
  return {
    userId: "test-user", id: "test-worker", containerName: "agentor-worker-test-worker", dockerEnabled: false,
    userEnv: zeroUserEnvVars("test-user"),
    environmentJson: { networkMode: "full", allowedDomains: [], dockerEnabled: false,
      setupScript: "", envVars: "", exposeApis: { portMappings: true, domainMappings: true, usage: true } },
    capabilitiesJson: [], instructionsJson: [],
    workerJson: { id: "test-worker", displayName: "Incus test", repos: [], initScript: "", gitName: "", gitEmail: "" },
  };
}

test('declared managed disks require guest mountpoints before configuration or worker service startup', async () => {
  const fake = fakeClient(), runtime = new IncusWorkerRuntime(config, fake.client as any);
  const store = new ManagedVolumeStore(config.dataDir); await store.init();
  const opts = options();
  const v = await store.create(opts.userId, opts.id, '/opt/required-data', undefined, 'incus-vm');
  v.seeded = true;
  await fake.client.createCustomVolume(config.incusStoragePool, { name: v.dockerName, content_type: 'filesystem', config: {
    'user.agentor.installation': await backupInstallationId(config.dataDir), 'user.agentor.owner': v.userId,
    'user.agentor.id': v.workerId, 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target } });
  const managed = new IncusManagedVolumeRuntime(config, runtime);
  const instance = await runtime.create({ ...opts, start: false, managedVolumes: [v] });
  expect(instance.devices[managed.deviceKey(v)]).toEqual(managed.device(v));
  fake.events.length = 0;
  const exec = fake.client.exec;
  fake.client.exec = async (...args: any[]) => args[1].includes(v.target)
    ? { returnCode: 1, stdout: '', stderr: 'not mounted' } : exec(...args);
  await expect(runtime.start({ ...opts, managedVolumes: [v] })).rejects.toThrow('bootstrap command failed');
  expect(fake.events.some(event => event.operation === 'file')).toBe(false);
  expect(fake.events.some(event => event.operation === 'exec' && event.args[1]?.includes('start'))).toBe(false);
});

function fakeClient() {
  const events: Array<{ operation: string; args: any[] }> = [];
  let status = "Stopped";
  let instance: any;
  const volumes = new Map<string, any>();
  const record = (operation: string, value: any) => async (...args: any[]) => {
    events.push({ operation, args }); return value;
  };
  const client = {
    getReadiness: record("ready", { ready: true, serverVersion: "6.0.6" }), request: record("project", { config: { restricted: "true" } }),
    getImageAlias: record("image", { target: 'a'.repeat(64), type: "virtual-machine" }),
    getImage: record("image-info", { fingerprint: 'a'.repeat(64), type: 'virtual-machine', properties: {
      bootstrap_generation: "3", source_image_id: 'sha256:' + 'b'.repeat(64), recipe_id: 'c'.repeat(64),
      source_architecture: 'amd64', converter_version: 'v0.4.0' } }),
    listImages: record('images', []),
    endpoint: config.incusEndpoint,
    getCustomVolume: async (_pool: string, name: string) => {
      if (!volumes.has(name)) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      return volumes.get(name);
    },
    createCustomVolume: async (_pool: string, spec: any) => {
      events.push({ operation: "volume-create", args: [spec] });
      volumes.set(spec.name, { ...spec, type: "custom", used_by: [] });
    },
    updateCustomVolume: async (_pool: string, name: string, config: any) => {
      events.push({ operation: "volume-update", args: [name, config] });
      volumes.get(name).config = config;
    },
    deleteCustomVolume: async (_pool: string, name: string) => { volumes.delete(name); },
    updateInstanceDevices: async (_name: string, devices: any) => { instance.devices = devices; },
    createInstance: async (spec: any) => { events.push({ operation: "create", args: [spec] });
      instance = { ...spec, config: { ...spec.config, 'volatile.uuid': 'original-uuid', 'volatile.base_image': spec.source.fingerprint } };
      return instance; },
    getInstance: async (...args: any[]) => { events.push({ operation: "instance", args }); return instance; },
    getInstanceState: async (...args: any[]) => { events.push({ operation: "state", args }); return { status }; },
    startInstance: async (...args: any[]) => { events.push({ operation: "start", args }); status = "Running"; },
    stopInstance: record("stop", undefined), deleteInstance: record("remove", undefined),
    exec: record("exec", { returnCode: 0, stdout: "", stderr: "" }), pushFile: record("file", undefined),
  };
  return { client, events };
}

async function hostMountStartupFixture(hasMount = true) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-incus-host-startup-'));
  const scoped = { ...config, dataDir, incusNetworkHostEndpoint: 'https://host-policy.invalid' };
  const fake = fakeClient(), runtime = new IncusWorkerRuntime(scoped, fake.client as any);
  const id = randomUUID(), userId = 'host-startup-owner';
  const opts = { ...options(), id, userId, containerName: `${config.containerPrefix}-${id}` };
  opts.workerJson = { ...opts.workerJson, id };
  const workers = new WorkerStore(dataDir); await workers.init();
  const groups = new WorkerGroupStore(dataDir); await groups.loadUser(userId);
  const store = new HostMountStore(dataDir, () => '/srv/agentor-startup-data', groups, workers); await store.init();
  await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', displayName: 'startup fixture',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() });
  const path = await store.createPath({ name: 'Startup share', sourcePath: '/srv/approved-startup-share' });
  await store.setEntitlement(userId, path.id, true);
  await store.createOwnerGrant(userId, { pathId: path.id, targetType: 'worker', targetId: id });
  if (hasMount) {
    opts.mounts = [{ pathId: path.id, source: '/ignored-caller-source', target: '/workspace/approved-share' }];
    opts.storageManager = { dataHostPath: '/srv/agentor-startup-data' } as StorageManager;
    // This fixture targets the host ownership-repair guard, not account shares.
    (runtime as any).accountDevices = async () => ({});
  }
  const installation = await backupInstallationId(dataDir);
  const originalEnsure = IncusHostMountClient.prototype.ensure, originalInspect = IncusHostMountClient.prototype.inspect;
  for (const operation of ['ensure', 'inspect'] as const) {
    IncusHostMountClient.prototype[operation] = async mount => {
      expect(mount).toEqual({ pathId: path.id, source: path.sourcePath, target: '/workspace/approved-share', readOnly: true });
      fake.events.push({ operation: `host-${operation}`, args: [mount] });
      return { installation, project: scoped.incusProject, pathId: path.id, sourcePath: path.sourcePath,
        allowWrite: false, sourceIdentity: 'a'.repeat(64) };
    };
  }
  return { ...fake, runtime, opts, cleanup: async () => {
    IncusHostMountClient.prototype.ensure = originalEnsure;
    IncusHostMountClient.prototype.inspect = originalInspect;
    await rm(dataDir, { recursive: true, force: true });
  } };
}

function ownershipGuardEvent(event: { operation: string; args: any[] }): boolean {
  return event.operation === 'exec' && event.args[1]?.[0] === 'grep' &&
    event.args[1]?.[3] === 'prune+=( -o -path "$literal" )' &&
    event.args[1]?.[4] === '/usr/lib/agentor/agentor-private-storage.sh';
}

test('old host-mount guest image is rejected before ownership repair or worker-service startup', async () => {
  const f = await hostMountStartupFixture();
  try {
    await f.runtime.create({ ...f.opts, start: false });
    f.events.length = 0;
    const exec = f.client.exec;
    f.client.exec = async (...args: any[]) => {
      const result = await exec(...args);
      return ownershipGuardEvent({ operation: 'exec', args }) ? { ...result, returnCode: 1 } : result;
    };
    await expect(f.runtime.start(f.opts)).rejects.toThrow('rebuild the configured worker OCI image');
    expect(f.events.filter(ownershipGuardEvent)).toHaveLength(1);
    expect(f.events.some(event => event.operation === 'exec' && event.args[1]?.[0] === 'systemctl' &&
      event.args[1]?.[1] === 'start')).toBe(false);
    expect(f.events.some(event => event.operation === 'exec' && event.args[1]?.[0] === '/usr/lib/agentor/agentor-private-storage.sh')).toBe(false);
    expect(f.events.some(event => event.operation === 'file')).toBe(false);
  } finally { await f.cleanup(); }
});

test('modern host-mount guest guard precedes mount verification, provisioning and ownership-repair service', async () => {
  const f = await hostMountStartupFixture();
  try {
    await f.runtime.create({ ...f.opts, start: false });
    f.events.length = 0;
    await f.runtime.start(f.opts);
    const guard = f.events.findIndex(ownershipGuardEvent);
    const bootstrap = f.events.findIndex(event => event.operation === 'exec' &&
      event.args[1]?.[2]?.includes('bootstrap-generation'));
    const mount = f.events.findIndex(event => event.operation === 'exec' &&
      JSON.stringify(event.args[1]) === JSON.stringify(['timeout', '15', 'mountpoint', '-q', '--', '/workspace/approved-share']));
    const stopService = f.events.findIndex(event => event.operation === 'exec' &&
      JSON.stringify(event.args[1]) === JSON.stringify(['systemctl', 'stop', 'agentor-worker.service']));
    const marker = f.events.findIndex(event => event.operation === 'file' && event.args[1] === '/run/agentor/provisioned');
    const startService = f.events.findIndex(event => event.operation === 'exec' &&
      JSON.stringify(event.args[1]) === JSON.stringify(['systemctl', 'start', 'agentor-worker.service']));
    expect(bootstrap).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(bootstrap);
    expect(mount).toBeGreaterThan(guard);
    expect(stopService).toBeGreaterThan(mount);
    expect(marker).toBeGreaterThan(stopService);
    // The service's ExecStartPre performs ownership repair; no start precedes
    // the image capability probe and freshly provisioned configuration.
    expect(startService).toBeGreaterThan(marker);
    expect(f.events.filter(ownershipGuardEvent)).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('workers without host mounts do not require the new guest ownership-prune signature', async () => {
  const f = await hostMountStartupFixture(false);
  try {
    await f.runtime.create({ ...f.opts, start: false });
    f.events.length = 0;
    const exec = f.client.exec;
    f.client.exec = async (...args: any[]) => {
      const result = await exec(...args);
      return ownershipGuardEvent({ operation: 'exec', args }) ? { ...result, returnCode: 1 } : result;
    };
    await f.runtime.start(f.opts);
    expect(f.events.filter(ownershipGuardEvent)).toEqual([]);
    expect(f.events.some(event => event.operation.startsWith('host-'))).toBe(false);
    expect(f.events.some(event => event.operation === 'exec' &&
      JSON.stringify(event.args[1]) === JSON.stringify(['systemctl', 'start', 'agentor-worker.service']))).toBe(true);
  } finally { await f.cleanup(); }
});

test('restored ownership requires supported guest bootstrap before provisioning or service startup', async () => {
  for (const supported of [false, true]) {
    const { client, events } = fakeClient(), runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    const created = await runtime.create({ ...opts, start: false });
    const storage = new IncusWorkerStorage(client as any, config, await backupInstallationId(config.dataDir));
    await storage.markPreserveOwnership(opts);
    events.length = 0;
    const exec = client.exec;
    client.exec = async (...args: any[]) => args[1][0] === 'grep' && args[1].includes('ownership_marker=/run/agentor/preserve-storage-ownership')
      ? { returnCode: supported ? 0 : 1, stdout: '', stderr: '' } : exec(...args);
    if (!supported) {
      await expect(runtime.start(opts, created.config['volatile.uuid'])).rejects.toThrow('metadata-preserving');
      expect(events.some(e => e.operation === 'file')).toBe(false);
      expect(events.some(e => e.operation === 'exec' && JSON.stringify(e.args[1]) === JSON.stringify(['systemctl', 'start', 'agentor-worker.service']))).toBe(false);
    } else {
      await runtime.start(opts, created.config['volatile.uuid']);
      const marker = events.findIndex(e => e.operation === 'file' && e.args[1] === '/run/agentor/preserve-storage-ownership');
      expect(events[marker]!.args.slice(2)).toEqual(['agentor-preserve-storage-ownership-v1\n', { mode: 0o600, uid: 0, gid: 0 }]);
      expect(marker).toBeLessThan(events.findIndex(e => e.operation === 'file' && e.args[1] === '/run/agentor/provisioned'));
      expect(events.some(e => e.operation === 'exec' && e.args[1].includes('/run/agentor/preserve-storage-ownership') && e.args[1][0] === 'rm')).toBe(true);
    }
  }
});

test("VM creation enforces isolation and provisions files before service start", async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  opts.workerConfig = [{ kind: "secret", key: "TOKEN", value: "do-not-log" },
    { kind: "secretFile", key: "settings", fileName: "nested/token", value: "private-file" }];
  await runtime.create(opts);
  const spec = events.find((event) => event.operation === "create")!.args[0];
  expect(spec.type).toBe("virtual-machine");
  expect(spec.profiles).toEqual([]);
  expect(spec.config["security.secureboot"]).toBe("false");
  expect(spec.devices.eth0["security.mac_filtering"]).toBe("true");
  expect(spec.devices.eth0["security.ipv4_filtering"]).toBe("true");
  expect(JSON.stringify(spec)).not.toContain("do-not-log");
  const envFile = events.find((event) => event.operation === "file" && event.args[1] === "/run/agentor/worker.env")!;
  expect(envFile.args[3]).toEqual({ mode: 0o640, uid: 0, gid: 1000 });
  const startService = events.findIndex((event) => event.operation === "exec" && event.args[1][0] === "systemctl" && event.args[1][1] === "start");
  expect(events.indexOf(envFile)).toBeLessThan(startService);
  expect(events.findIndex((event) => event.operation === "file" && event.args[1].endsWith("nested/token"))).toBeLessThan(startService);
  expect(JSON.stringify(events.filter((event) => event.operation === "exec"))).not.toContain("do-not-log");
  expect(spec.config["user.agentor.installation"]).toMatch(/^[a-f0-9-]{36}$/);
  const marker = events.findIndex((event) => event.operation === "file" && event.args[1] === "/run/agentor/provisioned");
  expect(marker).toBeLessThan(startService);
  expect(events.findIndex((event) => event.operation === "file" && event.args[1] === "/home/agent/.ssh/authorized_keys")).toBeLessThan(marker);
  expect(events.findIndex((event) => event.operation === "file" && event.args[1].endsWith("nested/token"))).toBeLessThan(events.indexOf(envFile));
});

test("real native Docker and core data survive reboot, disposable root replacement and capability toggles", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(600_000);
  const id = randomUUID();
  const opts = { ...options(), id, containerName: `${config.containerPrefix}-${id}`, memoryLimit: "2GiB", cpuLimit: 2 };
  opts.workerJson = { ...opts.workerJson, id };
  opts.dockerEnabled = opts.environmentJson.dockerEnabled = true;
  const runtime = new IncusWorkerRuntime(config);
  const name = opts.containerName;
  async function checked(script: string): Promise<string> {
    const result = await runtime.client.exec(name, ["bash", "-ec", script]);
    expect(result.returnCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout;
  }
  async function persistentData(): Promise<void> {
    await checked([
      'test "$(cat /workspace/persistence-fixture)" = workspace',
      'test "$(cat /home/agent/.agent-data/persistence-fixture)" = agents',
      'test "$(docker run --rm -v acceptance-data:/data alpine:latest cat /data/fixture)" = docker-data',
      'docker image inspect agentor-acceptance-build:latest >/dev/null',
      'docker container inspect acceptance-stopped >/dev/null',
    ].join("; "));
  }
  try {
    await runtime.create({ ...opts, start: false });
    await runtime.client.startInstance(name);
    await expect.poll(async () => {
      try { return (await runtime.client.exec(name, ["true"])).returnCode; } catch { return -1; }
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    await runtime.client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
    await runtime.client.pushFile(name, "/run/agentor/docker-storage.json", JSON.stringify({
      serial: "incus_docker", volume: `${name}-docker`, initialize: false,
    }), { uid: 0, gid: 0, mode: 0o600 });
    const refused = await runtime.client.exec(name, ["/usr/lib/agentor/agentor-docker-storage.sh"]);
    expect(refused.returnCode).not.toBe(0);
    expect(refused.stderr).toContain("Initialization not authorized");
    await runtime.start(opts);
    const layout = await checked('lsblk -o NAME,SERIAL,FSTYPE; findmnt -n -o SOURCE,FSTYPE --target /var/lib/docker; docker info --format "{{.Driver}}"');
    expect(layout).toContain("incus_docker");
    expect(layout).toContain("ext4");
    expect(layout).toContain("overlay2");
    await checked('echo workspace > /workspace/persistence-fixture; echo agents > /home/agent/.agent-data/persistence-fixture; docker pull alpine:latest; docker run --rm -v acceptance-data:/data alpine:latest sh -ec "echo docker-data > /data/fixture"; docker create --name acceptance-stopped alpine:latest true');
    await checked('mkdir -p /workspace/docker-build; printf "FROM alpine:latest\\nRUN echo built > /built\\n" > /workspace/docker-build/Dockerfile; docker build -t agentor-acceptance-build:latest /workspace/docker-build; docker run --rm agentor-acceptance-build:latest test -f /built');
    await runtime.client.pushFile(name, "/workspace/compose.yaml", 'services:\n  smoke:\n    image: alpine:latest\n    command: ["sh", "-c", "echo compose-ok"]\n');
    expect(await checked('docker compose -f /workspace/compose.yaml run --rm smoke')).toContain("compose-ok");
    expect(await checked('docker run --rm --privileged alpine:latest sh -ec "test -c /dev/kmsg; echo guest-local-privilege"')).toContain("guest-local-privilege");
    await runtime.stop(name);
    await runtime.start(opts);
    await persistentData();
    // Replace only derived compute, not canonical custom volumes.
    await runtime.remove(name);
    await runtime.create(opts);
    await persistentData();
    await runtime.stop(name);
    opts.dockerEnabled = opts.environmentJson.dockerEnabled = false;
    await runtime.start(opts);
    await checked('! systemctl is-active --quiet docker; test "$(systemctl is-enabled docker)" = masked');
    expect((await runtime.client.getCustomVolume(config.incusStoragePool, `${name}-docker`)).content_type).toBe("block");
    await runtime.stop(name);
    opts.dockerEnabled = opts.environmentJson.dockerEnabled = true;
    await runtime.start(opts);
    await persistentData();
  } finally {
    await runtime.remove(name);
    await runtime.removeStorage(opts);
  }
});

test("foreign installation is never adopted, started, stopped or deleted", async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  const spec = await client.getInstance(opts.containerName);
  spec.config["user.agentor.installation"] = "foreign-installation";
  events.length = 0;
  expect(await runtime.matchesWorkerIdentity(spec, opts.id)).toBe(false);
  await expect(runtime.start(opts)).rejects.toThrow("installation/worker identity");
  await expect(runtime.stop(opts.containerName)).rejects.toThrow("installation/worker identity");
  await expect(runtime.remove(opts.containerName)).rejects.toThrow("installation/worker identity");
  expect(events.some((event) => ["start", "stop", "remove", "file", "exec"].includes(event.operation))).toBe(false);
});

test("start rejects host mounts without platform storage before any mutation", async () => {
  const { client, events } = fakeClient();
  await expect(new IncusWorkerRuntime(config, client as any).start({ ...options(), mounts: [{}] as any })).rejects.toThrow("authoritative platform storage");
  expect(events).toEqual([]);
});

test("stale image fails before allocating persistent state", async () => {
  const { client, events } = fakeClient();
  client.getImage = async () => ({ properties: { bootstrap_generation: "1" } });
  await expect(new IncusWorkerRuntime(config, client as any).create(options())).rejects.toThrow("safe storage bootstrap");
  expect(events.some((event) => event.operation === "volume-create" || event.operation === "create")).toBe(false);
});

test("unpatched or unverifiable Incus fails before image/storage mutations", async () => {
  for (const serverVersion of ["6.0", "6.0.0", "6.0.4", "6.1.0", "6.9", "5.21.3", "", "unknown"]) {
    const { client, events } = fakeClient();
    client.getReadiness = async () => ({ ready: true, serverVersion });
    await expect(new IncusWorkerRuntime(config, client as any).create(options())).rejects.toThrow("require patched Incus");
    expect(events.some((event) => ["image", "volume-create", "create"].includes(event.operation))).toBe(false);
  }
  for (const serverVersion of ["6.0.5", "6.0.6", "6.0.6-zabbly", "6.10", "6.20", "7.0", "7.0.0"]) {
    const { client, events } = fakeClient();
    client.getReadiness = async () => ({ ready: true, serverVersion });
    await new IncusWorkerRuntime(config, client as any).create(options());
    expect(events.find((event) => event.operation === "create")!.args[0].config["raw.idmap"]).toBeUndefined();
  }
});

test("start never replaces missing canonical storage with empty volumes", async () => {
  for (const role of ["workspace", "agents", "docker"]) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any);
    const opts = options();
    opts.dockerEnabled = opts.environmentJson.dockerEnabled = true;
    await runtime.create({ ...opts, start: false });
    const original = client.getCustomVolume;
    client.getCustomVolume = async (pool: string, name: string) => {
      if (name === `${opts.containerName}-${role}`) throw Object.assign(new Error("Missing"), { statusCode: 404 });
      return original(pool, name);
    };
    events.length = 0;
    await expect(runtime.start(opts)).rejects.toThrow(`Existing Incus ${role} volume is missing`);
    expect(events.some((event) => ["volume-create", "start", "file", "exec"].includes(event.operation))).toBe(false);
  }
});

test('recreation preflight is read-only, pins the image and rechecks canonical data at creation', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  events.length = 0;
  const existing = await runtime.preflightRecreation(opts);
  expect(existing).toEqual({ fingerprint: 'a'.repeat(64), docker: false });
  expect(events.some((event) => ['volume-create', 'create', 'start', 'file', 'exec'].includes(event.operation))).toBe(false);
  client.getImageAlias = async () => { throw new Error('mutable alias moved'); };
  await runtime.create({ ...opts, start: false }, existing);
  expect(events.find((e) => e.operation === 'create')!.args[0].source.fingerprint).toBe('a'.repeat(64));
  const getVolume = client.getCustomVolume;
  client.getCustomVolume = async (pool, name) => {
    if (name.endsWith('-agents')) throw Object.assign(new Error('missing'), { statusCode: 404 });
    return getVolume(pool, name);
  };
  events.length = 0;
  await expect(runtime.create({ ...opts, start: false }, existing)).rejects.toThrow('Existing Incus agents volume is missing');
  expect(events.some((e) => ['volume-create', 'create', 'start'].includes(e.operation))).toBe(false);
});

test('recreation preflight rejects missing required Docker, wrong ownership/type or foreign attachment without writes', async () => {
  for (const failure of ['missing-docker', 'owner', 'type', 'attachment']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any);
    const opts = options();
    await runtime.create({ ...opts, start: false });
    const getVolume = client.getCustomVolume;
    client.getCustomVolume = async (pool, name) => {
      const volume = structuredClone(await getVolume(pool, name));
      if (name.endsWith('-agents')) {
        if (failure === 'owner') volume.config['user.agentor.owner'] = 'foreign';
        if (failure === 'type') volume.content_type = 'block';
        if (failure === 'attachment') volume.used_by = ['/1.0/instances/foreign?project=agentor'];
      }
      return volume;
    };
    events.length = 0;
    await expect(runtime.preflightRecreation(opts, failure === 'missing-docker')).rejects.toThrow();
    expect(events.some((e) => ['volume-create', 'create', 'start', 'stop', 'remove', 'file', 'exec'].includes(e.operation))).toBe(false);
  }
});

test('lifecycle mutations require matching account and original incarnation', async () => {
  for (const action of ['start', 'stop', 'remove'] as const) {
    for (const mismatch of ['owner', 'incarnation']) {
      const { client, events } = fakeClient();
      const runtime = new IncusWorkerRuntime(config, client as any);
      const opts = options();
      await runtime.create({ ...opts, start: false });
      const instance = await client.getInstance(opts.containerName);
      instance.config['volatile.uuid'] = 'original-uuid';
      if (mismatch === 'owner') instance.config['user.agentor.owner'] = 'foreign';
      events.length = 0;
      await expect(runtime[action](opts, mismatch === 'incarnation' ? 'stale-uuid' : 'original-uuid')).rejects.toThrow();
      expect(events.some((e) => ['volume-create', 'start', 'stop', 'remove', 'file', 'exec'].includes(e.operation))).toBe(false);
    }
  }
});

test('interrupted recreation retains original or deletes only nonce-owned replacement without data/config writes', async () => {
  for (const mode of ['original', 'replacement', 'lost-response']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    const instance = await runtime.create({ ...opts, start: false, recreationNonce: 'operation-nonce' });
    events.length = 0;
    const result = await runtime.rollbackRecreation(opts, { nonce: 'operation-nonce',
      originalIncarnation: mode === 'original' ? 'original-uuid' : 'prior-uuid',
      replacementIncarnation: mode === 'replacement' ? instance.config['volatile.uuid'] : undefined });
    expect(result.status).toBe(mode === 'original' ? 'active' : 'archived');
    expect(events.filter((e) => e.operation === 'remove')).toHaveLength(mode === 'original' ? 0 : 1);
    expect(events.some((e) => ['create', 'start', 'file', 'exec', 'volume-create', 'volume-update'].includes(e.operation))).toBe(false);
  }
});

test('interrupted recreation quarantines wrong owner, UUID, nonce, malformed marker and unavailable lookup', async () => {
  for (const failure of ['owner', 'uuid', 'nonce', 'malformed', 'contradictory', 'lookup']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    const instance = await runtime.create({ ...opts, start: false, recreationNonce: 'operation-nonce' });
    const marker = { nonce: 'operation-nonce', originalIncarnation: 'prior-uuid', replacementIncarnation: 'original-uuid' };
    if (failure === 'owner') instance.config['user.agentor.owner'] = 'foreign';
    if (failure === 'uuid') marker.replacementIncarnation = 'unexpected-uuid';
    if (failure === 'nonce') instance.config['user.agentor.recreation'] = 'foreign-nonce';
    if (failure === 'malformed') marker.nonce = '';
    if (failure === 'contradictory') marker.originalIncarnation = marker.replacementIncarnation;
    if (failure === 'lookup') client.getInstance = async () => { throw Object.assign(new Error('API unavailable'), { statusCode: 503 }); };
    events.length = 0;
    await expect(runtime.rollbackRecreation(opts, marker)).rejects.toThrow();
    expect(events.some((e) => ['stop', 'remove', 'create', 'start', 'file', 'exec', 'volume-create', 'volume-update'].includes(e.operation))).toBe(false);
  }
});

test('absent interrupted compute requires canonical volumes and source metadata without allocating replacements', async () => {
  for (const failure of ['none', 'agents', 'source']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    await runtime.create({ ...opts, start: false });
    client.getInstance = async () => { throw Object.assign(new Error('missing compute'), { statusCode: 404 }); };
    const get = client.getCustomVolume;
    client.getCustomVolume = async (pool, name) => {
      if (failure === 'agents' && name.endsWith('-agents')) throw Object.assign(new Error('missing data'), { statusCode: 404 });
      const volume = structuredClone(await get(pool, name));
      if (failure === 'source') delete volume.config['user.agentor.image-source'];
      return volume;
    };
    events.length = 0;
    const rollback = runtime.rollbackRecreation(opts, { nonce: 'operation-nonce', originalIncarnation: 'prior-uuid' });
    if (failure === 'none') await expect(rollback).resolves.toEqual({ status: 'archived' });
    else await expect(rollback).rejects.toThrow();
    expect(events.some((e) => ['stop', 'remove', 'create', 'start', 'volume-create', 'volume-update'].includes(e.operation))).toBe(false);
  }
});

test('only explicit initial-create recovery can archive authoritative missing compute with incomplete storage', async () => {
  for (const roles of [[], ['workspace'], ['workspace', 'agents']]) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    await runtime.create({ ...opts, start: false });
    client.getInstance = async () => { throw Object.assign(new Error('missing compute'), { statusCode: 404 }); };
    const get = client.getCustomVolume;
    client.getCustomVolume = async (pool, name) => {
      if (!roles.some((role) => name.endsWith('-' + role))) throw Object.assign(new Error('missing volume'), { statusCode: 404 });
      const volume = structuredClone(await get(pool, name));
      delete volume.config['user.agentor.image-source'];
      return volume;
    };
    events.length = 0;
    await expect(runtime.rollbackRecreation(opts, { nonce: 'initial-nonce', initialCreate: true })).resolves.toEqual({ status: 'archived' });
    await expect(runtime.rollbackRecreation(opts, { nonce: 'historical-nonce' })).rejects.toThrow();
    await expect(runtime.preflightRecreation(opts)).rejects.toThrow();
    expect(events.some((e) => ['stop', 'remove', 'create', 'start', 'volume-create', 'volume-update'].includes(e.operation))).toBe(false);
  }
});

test('initial-create discriminator rejects nonliteral/contradictory markers before any runtime lookup', async () => {
  for (const marker of [
    { nonce: 'nonce', initialCreate: false }, { nonce: 'nonce', initialCreate: 'true' },
    { nonce: 'nonce', initialCreate: null }, { nonce: 'nonce', initialCreate: true, originalIncarnation: 'old' },
  ]) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any);
    await expect(runtime.rollbackRecreation(options(), marker as any)).rejects.toThrow('marker is invalid');
    expect(events).toEqual([]);
  }
});

test('initial-create marker does not waive unavailable lookup or replacement nonce/UUID fencing', async () => {
  for (const failure of ['lookup', 'nonce', 'uuid']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    const instance = await runtime.create({ ...opts, start: false, recreationNonce: 'initial-nonce' });
    if (failure === 'lookup') client.getInstance = async () => { throw Object.assign(new Error('API unavailable'), { statusCode: 503 }); };
    if (failure === 'nonce') instance.config['user.agentor.recreation'] = 'wrong';
    events.length = 0;
    await expect(runtime.rollbackRecreation(opts, { nonce: 'initial-nonce', initialCreate: true,
      replacementIncarnation: failure === 'uuid' ? 'wrong' : 'original-uuid' })).rejects.toThrow();
    expect(events.some((e) => ['stop', 'remove', 'create', 'start', 'volume-create', 'volume-update'].includes(e.operation))).toBe(false);
  }
});

test('replacement nonce, UUID and owner are rechecked after stop before interrupted-recreation deletion', async () => {
  for (const key of ['user.agentor.recreation', 'volatile.uuid', 'user.agentor.owner']) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
    const instance = await runtime.create({ ...opts, start: false, recreationNonce: 'operation-nonce' });
    client.getInstanceState = async () => ({ status: 'Running' });
    client.stopInstance = async () => { instance.config[key] = 'changed'; };
    events.length = 0;
    await expect(runtime.rollbackRecreation(opts, { nonce: 'operation-nonce' })).rejects.toThrow();
    expect(events.some((e) => e.operation === 'remove')).toBe(false);
  }
});

test('guest readiness reads positive boot/config/service facts without lifecycle or storage writes', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
  const instance = await runtime.create({ ...opts, start: false }); instance.status = 'Running';
  for (const flags of ['1 1', '0 0', '1 0']) {
    client.exec = async () => ({ returnCode: 0, stdout: `12345678-1234-1234-1234-123456789abc ${flags}\n`, stderr: '' });
    events.length = 0;
    expect(await runtime.inspectGuestReadiness(opts, 'original-uuid')).toMatchObject({
      provisioned: flags[0] === '1', serviceReady: flags[2] === '1' });
    expect(events.some((event) => ['start', 'stop', 'file', 'volume-create', 'volume-update'].includes(event.operation))).toBe(false);
  }
  client.exec = async () => ({ returnCode: 124, stdout: '', stderr: '' });
  await expect(runtime.inspectGuestReadiness(opts, 'original-uuid')).rejects.toThrow('could not be verified');
  client.exec = async () => ({ returnCode: 0, stdout: 'not-authoritative', stderr: '' });
  await expect(runtime.inspectGuestReadiness(opts, 'original-uuid')).rejects.toThrow('response is invalid');
  await expect(runtime.inspectGuestReadiness(opts, 'other-uuid')).rejects.toThrow('incarnation changed');
});

test('actual readiness shell distinguishes absent services/main from command/transport failures', () => {
  const prefix = String.raw`
cat() { printf '12345678-1234-1234-1234-123456789abc\n'; }
test() { case "$*" in *'/run/'*|*'/tmp/'*) return 0;; *) builtin test "$@";; esac; }
grep() { if [[ "$*" == *provisioned* ]]; then return "$PROBE_MARKER_EXIT"; fi; return "$PROBE_EVENT_EXIT"; }
systemctl() { return "$PROBE_SERVICE_EXIT"; }
runuser() { return "$PROBE_USER_EXIT"; }
`;
  for (const [marker, service, user, event, expected] of [
    [0, 0, 0, 0, '1 1'], [1, 0, 0, 0, '0 0'], [0, 3, 0, 0, '1 0'], [0, 4, 0, 0, '1 0'],
    [0, 0, 42, 0, '1 0'], [0, 0, 0, 1, '1 0'],
    [2, 0, 0, 0, 'error'], [0, 1, 0, 0, 'error'], [0, 0, 1, 0, 'error'], [0, 0, 0, 2, 'error'],
  ] as const) {
    const run = () => execFileSync('bash', ['-c', prefix + INCUS_GUEST_READINESS_SCRIPT], {
      encoding: 'utf8', env: { ...process.env, PROBE_MARKER_EXIT: String(marker), PROBE_SERVICE_EXIT: String(service),
        PROBE_USER_EXIT: String(user), PROBE_EVENT_EXIT: String(event) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (expected === 'error') expect(run).toThrow();
    else expect(run().trim()).toBe(`12345678-1234-1234-1234-123456789abc ${expected}`);
  }
});

test('actual main-session probe uses exact matching and does not treat socket errors as absence', () => {
  for (const [message, expected] of [
    ['can\'t find session: main', 42], ['no server running on /tmp/tmux-1000/default', 42],
    ['error connecting to /tmp/tmux-1000/default (Permission denied)', 70], ['server exited unexpectedly', 70],
  ] as const) {
    try {
      execFileSync('sh', ['-c', 'tmux() { test "$3" = "=main" || exit 71; printf "%s" "$PROBE_MESSAGE"; return 1; };' + INCUS_MAIN_SESSION_PROBE],
        { env: { ...process.env, PROBE_MESSAGE: message }, stdio: ['ignore', 'pipe', 'pipe'] });
      throw new Error('Expected probe exit');
    } catch (error) { expect((error as { status?: number }).status).toBe(expected); }
  }
});

test('recovery provisioning failure does not stop an already-running guest', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any), opts = options();
  await runtime.create(opts);
  const execute = client.exec;
  client.exec = async (...args: any[]) => args[1][0] === 'systemctl' && args[1][1] === 'start'
    ? { returnCode: 1, stdout: '', stderr: 'service failure' } : execute(...args);
  events.length = 0;
  await expect(runtime.start(opts, 'original-uuid', { leaveRunningOnFailure: true })).rejects.toThrow('bootstrap command failed');
  expect(events.some((event) => event.operation === 'stop')).toBe(false);
});

test('worker image source survives platform alias movement and cannot be silently changed', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  const original = client.getImage;
  client.getImageAlias = async () => { throw new Error('must not reread mutable platform alias'); };
  events.length = 0;
  const preflight = await runtime.preflightRecreation(opts);
  await runtime.create({ ...opts, start: false }, preflight);
  expect(events.find((event) => event.operation === 'create')!.args[0].source.fingerprint).toBe('a'.repeat(64));
  client.getImage = async (...args) => {
    const image = structuredClone(await original(...args));
    image.properties.source_image_id = 'sha256:' + 'd'.repeat(64);
    return image;
  };
  events.length = 0;
  await expect(runtime.preflightRecreation(opts)).rejects.toThrow('cached worker image source does not match');
  await expect(runtime.create({ ...opts, start: false }, preflight)).rejects.toThrow('reconstruction image source changed');
  expect(events.some((e) => ['volume-create', 'volume-update', 'create', 'stop', 'remove', 'start'].includes(e.operation))).toBe(false);
});

test('cache fingerprint replacement uses exact conversion inputs, not tags or unrelated recipes', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  const recreated = structuredClone(await client.getImage('a'.repeat(64)));
  recreated.fingerprint = 'd'.repeat(64);
  client.getImage = async (fingerprint: string) => {
    if (fingerprint !== recreated.fingerprint) throw Object.assign(new Error('cache removed'), { statusCode: 404 });
    return recreated;
  };
  const foreign = { ...structuredClone(recreated), fingerprint: 'e'.repeat(64) };
  foreign.properties.converter_version = 'v0.4.1';
  client.listImages = async () => [foreign, recreated];
  client.getImageAlias = async () => { throw new Error('no alias fallback'); };
  const preflight = await runtime.preflightRecreation(opts);
  expect(preflight.fingerprint).toBe(recreated.fingerprint);
  await runtime.create({ ...opts, start: false }, preflight);
  const workspace = await client.getCustomVolume(config.incusStoragePool, `${opts.containerName}-workspace`);
  expect(JSON.parse(workspace.config['user.agentor.image-source']).fingerprint).toBe(recreated.fingerprint);
  client.getImage = async () => { throw Object.assign(new Error('gone'), { statusCode: 404 }); };
  client.listImages = async () => [foreign];
  events.length = 0;
  await expect(runtime.preflightRecreation(opts)).rejects.toThrow('immutable OCI source is unavailable');
  expect(events.some((e) => ['volume-create', 'volume-update', 'create', 'stop', 'remove', 'start'].includes(e.operation))).toBe(false);
});

test('older owned compute captures original image before removal, with strict incarnation and storage checks', async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  const workspace = await client.getCustomVolume(config.incusStoragePool, `${opts.containerName}-workspace`);
  delete workspace.config['user.agentor.image-source'];
  client.getImageAlias = async () => { throw new Error('no mutable alias'); };
  await expect(runtime.preflightRecreation(opts)).rejects.toThrow('source is missing');
  events.length = 0;
  await expect(runtime.preserveRecreationSource(opts, 'foreign-uuid')).rejects.toThrow('incarnation changed');
  expect(events.some((e) => e.operation === 'volume-update')).toBe(false);
  await runtime.preserveRecreationSource(opts, 'original-uuid');
  expect((await runtime.preflightRecreation(opts)).fingerprint).toBe('a'.repeat(64));
  expect(events.some((e) => ['stop', 'remove', 'create', 'start', 'file', 'exec'].includes(e.operation))).toBe(false);
});

test('archive retries missing compute only through known canonical source/data and never creates replacement volumes', async () => {
  for (const missingDocker of [false, true]) {
    const { client, events } = fakeClient();
    const runtime = new IncusWorkerRuntime(config, client as any);
    const opts = options(); opts.environmentJson.dockerEnabled = opts.dockerEnabled = true;
    await runtime.create({ ...opts, start: false });
    client.getInstance = async () => { throw Object.assign(new Error('compute already removed'), { statusCode: 404 }); };
    const getVolume = client.getCustomVolume;
    client.getCustomVolume = async (pool, name) => {
      if (missingDocker && name.endsWith('-docker')) throw Object.assign(new Error('data missing'), { statusCode: 404 });
      return getVolume(pool, name);
    };
    events.length = 0;
    if (missingDocker) await expect(runtime.prepareArchive(opts, 'original-uuid')).rejects.toThrow('Existing Incus docker volume is missing');
    else await runtime.prepareArchive(opts, 'original-uuid');
    expect(events.some((e) => ['volume-create', 'volume-update', 'create', 'stop', 'remove', 'start'].includes(e.operation))).toBe(false);
    await expect(runtime.prepareArchive(opts, '')).rejects.toThrow('verified runtime incarnation');
  }
});

test('immutable image identity validates complete pinned conversion metadata', async () => {
  const { client } = fakeClient();
  const original = incusImageIdentity(await client.getImage('a'.repeat(64)) as any);
  expect(validateIncusImageIdentity(original)).toEqual(original);
  for (const key of ['sourceImageId', 'recipeId', 'architecture', 'converterVersion', 'bootstrapGeneration', 'fingerprint']) {
    const malformed: any = { ...original, [key]: key === 'sourceImageId' ? [original.sourceImageId]
      : key === 'converterVersion' ? '' : 'invalid' };
    expect(() => validateIncusImageIdentity(malformed)).toThrow('immutable worker image metadata');
  }
  expect(sameIncusImageSource(original, { ...original, fingerprint: 'd'.repeat(64) })).toBe(true);
  expect(sameIncusImageSource(original, { ...original, recipeId: 'd'.repeat(64) })).toBe(false);
});

test('real read-only recreation resolves persisted OCI conversion identity without platform alias or VM', async () => {
  test.skip(process.env.INCUS_SOURCE_TEST !== 'true', 'Explicit isolated source-volume/cache acceptance');
  test.setTimeout(120_000);
  const runtime = new IncusWorkerRuntime({ ...config, incusWorkerImage: 'must-not-use-this-platform-alias' });
  const id = randomUUID();
  const opts = { ...options(), id, containerName: `${config.containerPrefix}-${id}` };
  opts.workerJson = { ...opts.workerJson, id };
  const storage = new IncusWorkerStorage(runtime.client, config, await backupInstallationId(config.dataDir));
  const image = await runtime.client.getImage((await runtime.client.getImageAlias(config.incusWorkerImage)).target);
  const identity = incusImageIdentity(image);
  try {
    await storage.devices(opts, false);
    // A missing reconstructable cache hint must resolve by exact source inputs,
    // never by the current mutable worker alias or fingerprint alone.
    await storage.recordImageIdentity(opts, { ...identity, fingerprint: 'f'.repeat(64) });
    const preflight = await runtime.preflightRecreation(opts);
    expect(preflight.docker).toBe(false);
    expect(sameIncusImageSource(incusImageIdentity(await runtime.client.getImage(preflight.fingerprint)), identity)).toBe(true);
    expect((await runtime.client.getCustomVolume(config.incusStoragePool, `${opts.containerName}-workspace`)).used_by ?? []).toEqual([]);
    await expect(runtime.client.getInstance(opts.containerName)).rejects.toMatchObject({ statusCode: 404 });
  } finally { await storage.remove(opts); }
});

test("account directories require exact restricted grants before allocating worker data", async () => {
  const { client, events } = fakeClient();
  const storage = new StorageManager({} as any, config);
  storage.dataHostPath = "/platform-data";
  const opts = { ...options(), storageManager: storage };
  await expect(new IncusWorkerRuntime(config, client as any).create(opts)).rejects.toThrow("explicitly allowlist");
  expect(events.some((event) => event.operation === "volume-create")).toBe(false);
  client.request = async () => ({ config: { restricted: "true", "restricted.devices.disk": "allow",
    "restricted.devices.disk.paths": "/platform-data/users/test-user" } });
  await expect(new IncusWorkerRuntime(config, client as any).create(opts)).rejects.toThrow("explicitly allowlist");
  const base = "/platform-data/users/test-user";
  client.request = async () => ({ config: { restricted: "true", "restricted.devices.disk": "allow",
    "restricted.devices.disk.paths": `${base}/credentials,${base}/kilo/config,${base}/kilo/data` } });
  opts.credentialBinds = ["/foreign-host:/home/agent/.agent-data/.codex/auth.json"];
  await expect(new IncusWorkerRuntime(config, client as any).create(opts)).rejects.toThrow("unrecognized account");
  opts.credentialBinds = [];
  await new IncusWorkerRuntime(config, client as any).create(opts);
  const spec = events.find((event) => event.operation === "create")!.args[0];
  expect(spec.devices.cred).toEqual({ type: "disk", source: `${base}/credentials`, path: "/run/agentor/account-credentials" });
  expect(spec.devices.kcfg.source).toBe(`${base}/kilo/config`);
  expect(spec.devices.kdata.source).toBe(`${base}/kilo/data`);
  expect(Object.values(spec.devices).some((device: any) => device.source === base)).toBe(false);
});

test("credential provisioning detaches stale mounts before stat and rejects unsafe sources or busy targets", async () => {
  const { client, events } = fakeClient();
  const storage = new StorageManager({} as any, config);
  storage.dataHostPath = "/platform-data";
  const base = "/platform-data/users/test-user";
  client.request = async () => ({ config: { restricted: "true", "restricted.devices.disk": "allow",
    "restricted.devices.disk.paths": `${base}/credentials,${base}/kilo/config,${base}/kilo/data` } });
  await new IncusWorkerRuntime(config, client as any).create({ ...options(), storageManager: storage });
  const binder = events.find((event) => event.operation === "exec" && event.args[1][3] === "agentor-bind")!.args[1][2];
  expect(binder).toContain("/proc/self/mountinfo");
  const dir = await mkdtemp(join(tmpdir(), "agentor-stale-bind-"));
  const source = join(dir, "source"), target = join(dir, "target"), detached = join(dir, "detached"), mounted = join(dir, "mounted");
  try {
    await writeFile(source, "canonical");
    await writeFile(target, "private backing");
    // Model ESTALE until detachment; no real mount privileges are required.
    const harness = [
      'test() { if [[ "$1" == -f && "$2" == "$AGENTOR_BIND_TARGET" ]] && [[ ! -e "$AGENTOR_BIND_DETACHED" ]]; then return 1; fi; builtin test "$@"; }',
      'awk() { return 0; }',
      'umount() { [[ "$1 $2 $3" == "--internal-only --no-canonicalize --" ]]; printf detached > "$AGENTOR_BIND_DETACHED"; }',
      'mount() { printf mounted > "$AGENTOR_BIND_MOUNTED"; }',
    ].join("\n");
    const run = (prefix = harness) => execFileSync("bash", ["-ec", `${prefix}\n${binder}`, "agentor-bind", source, target], {
      env: { ...process.env, AGENTOR_BIND_TARGET: target, AGENTOR_BIND_DETACHED: detached, AGENTOR_BIND_MOUNTED: mounted },
      stdio: "pipe",
    });
    run();
    expect(await readFile(mounted, "utf-8")).toBe("mounted");
    await rm(detached); await rm(mounted);
    expect(() => run(`${harness}\numount() { return 1; }`)).toThrow();
    await expect(readFile(mounted)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(source); await symlink(target, source);
    expect(() => run()).toThrow();
    await expect(readFile(detached)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(source); await link(target, source);
    expect(() => run()).toThrow();
    await expect(readFile(detached)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(target, "utf-8")).toBe("private backing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("live SSH key refresh verifies account ownership and does not touch stopped guests", async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create({ ...opts, start: false });
  events.length = 0;
  await runtime.refreshSshKeys(opts, "new-key");
  expect(events.some((event) => event.operation === "file")).toBe(false);
  await runtime.start(opts);
  events.length = 0;
  await runtime.refreshSshKeys(opts, "new-key");
  expect(events.find((event) => event.operation === "file")?.args.slice(1, 3)).toEqual(["/home/agent/.ssh/authorized_keys", "new-key"]);
  await expect(runtime.refreshSshKeys({ ...opts, userId: "other-account" }, "wrong-key")).rejects.toThrow("account identity");
  expect(events.filter((event) => event.operation === "file")).toHaveLength(1);
});

test("account fence keeps revocation after delayed startup key delivery", async () => {
  const { client, events } = fakeClient();
  const runtime = new IncusWorkerRuntime(config, client as any);
  const opts = options();
  await runtime.create(opts);
  events.length = 0;
  const push = client.pushFile;
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const enteredPush = new Promise<void>((resolve) => { entered = resolve; });
  client.pushFile = async (...args: any[]) => {
    if (args[1] === "/home/agent/.ssh/authorized_keys" && args[2] === "old-key") { entered(); await blocked; }
    return push(...args);
  };
  let canonical = "old-key";
  const start = withOwnerLifecycleMutation(opts.userId, () => runtime.start({ ...opts, sshAuthorizedKeys: canonical }));
  await enteredPush;
  const revoke = withOwnerLifecycleMutation(opts.userId, async () => {
    canonical = "";
    await runtime.refreshSshKeys(opts, canonical);
  });
  expect(canonical).toBe("old-key");
  release();
  await Promise.all([start, revoke]);
  expect(events.filter((event) => event.operation === "file" && event.args[1] === "/home/agent/.ssh/authorized_keys").map((event) => event.args[2])).toEqual(["old-key", ""]);
});

test("Docker initialization authority is revoked before the worker can start", async () => {
  const { client, events } = fakeClient();
  const opts = options();
  opts.dockerEnabled = opts.environmentJson.dockerEnabled = true;
  await new IncusWorkerRuntime(config, client as any).create(opts);
  const disk = events.find((event) => event.operation === "file" && event.args[1] === "/run/agentor/docker-storage.json")!;
  expect(JSON.parse(disk.args[2])).toEqual({ serial: "incus_docker", volume: `${opts.containerName}-docker`, initialize: true });
  const revoked = events.findIndex((event) => event.operation === "volume-update" && event.args[1]["user.agentor.allow-initialization"] === "false");
  const workerStart = events.findIndex((event) => event.operation === "exec" && event.args[1].join(" ") === "systemctl start agentor-worker.service");
  expect(revoked).toBeGreaterThan(events.indexOf(disk));
  expect(revoked).toBeLessThan(workerStart);
});

test("shell configuration preserves literal quotes/newlines without executing substitutions", () => {
  const value = "quotes '\" and\n$(printf exploited) `printf exploited`";
  const output = execFileSync("bash", ["-c", `${serializeIncusWorkerEnv({ VALUE: value })}\nprintf '%s' \"$VALUE\"`], { encoding: "utf8" });
  expect(output).toBe(value);
  expect(() => serializeIncusWorkerEnv({ "BAD;KEY": "x" })).toThrow();
});

test("bootstrap failure stops the VM and is not reported as success", async () => {
  const { client, events } = fakeClient();
  client.exec = async (...args: any[]) => {
    events.push({ operation: "exec", args });
    return { returnCode: args[1][0] === "systemctl" ? 1 : 0, stdout: "", stderr: "" };
  };
  await expect(new IncusWorkerRuntime(config, client as any).create(options())).rejects.toThrow("bootstrap command failed");
  expect(events.some((event) => event.operation === "stop")).toBe(true);
});

test("production creation rejects unverified transport before touching Incus", async () => {
  const { client, events } = fakeClient();
  await expect(new IncusWorkerRuntime({ ...config, incusServerCertPath: "" }, client as any).create(options())).rejects.toThrow("verified server TLS");
  expect(events).toEqual([]);
});

test("existing-worker lifecycle and inventory reject unverified production transport", async () => {
  for (const invalid of [{ ...config, incusServerCertPath: "" }, { ...config, incusEndpoint: "http://127.0.0.1:18443" }]) {
    const runtime = new IncusWorkerRuntime(invalid);
    await expect(runtime.start(options())).rejects.toThrow("verified server TLS");
    await expect(runtime.stop(options().containerName)).rejects.toThrow("verified server TLS");
    await expect(runtime.remove(options().containerName)).rejects.toThrow("verified server TLS");
    await expect(runtime.client.listInstances()).rejects.toThrow("verified server TLS");
  }
});

test("real production worker create/start, inventory and reprovisioning", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(600_000);
  const dir = await mkdtemp(join(tmpdir(), "agentor-incus-lifecycle-"));
  const store = new WorkerStore(dir);
  await store.init();
  let dockerCreates = 0;
  const manager = new ContainerManager({ listContainers: async () => [],
    createWorkerContainer: async () => { dockerCreates++; throw new Error("Docker fallback"); } } as any, config);
  manager.setWorkerStore(store);
  // Account authorization/resolution is independent of runtime acceptance.
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).resolveGitIdentity = async () => ({ gitName: "Incus Test", gitEmail: "test@example.invalid" });
  let accountSetting = 'old-account';
  (manager as any).resolveUserEnvAndBinds = async () => ({
    userEnv: { ...zeroUserEnvVars("test-user"), envVars: [{ key: 'ACCOUNT_SETTING', value: accountSetting }] },
    credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveEnvironmentConfig = () => ({ ...options(), dockerEnabled: false });
  const runtime = new IncusWorkerRuntime(config);
  manager.setIncusRuntime(runtime);
  let name: string | undefined;
  try {
    const info = await (manager as any).createForOwner({ userId: "test-user", displayName: "Takeover lifecycle acceptance",
      initScript: ': # original-init', workerConfiguration: { variables: [{ key: 'LOCAL_SETTING', value: 'old-local' }] } });
    name = info.containerName;
    expect(info.runtimeKind).toBe("incus-vm");
    expect(info.status).toBe("running");
    expect(store.findById(info.id)?.runtimeKind).toBe("incus-vm");
    await manager.sync();
    expect(manager.get(info.id)?.containerName).toBe(name);
    const primary = await runtime.resolvePrimaryAddress({ id: info.id, userId: info.userId, containerName: name! });
    expect(primary.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(primary.incarnation).toBe((await runtime.client.getInstance(name!)).config["volatile.uuid"]);
    const services = await runtime.client.exec(name!, ["sh", "-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/; echo; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/"]);
    expect(services.returnCode).toBe(0);
    expect(services.stdout).toContain("302");
    expect(services.stdout).toContain("200");
    accountSetting = 'new-account';
    const current = manager.get(info.id)!;
    current.initScript = ': # pending-init'; current.environmentId = 'pending-or-deleted-environment'; current.pendingRebuild = true;
    await store.upsert((manager as any).containerInfoToWorkerRecord(current));
    await useWorkerConfigStore().replace(info.userId, info.id, [{ kind: 'variable', key: 'LOCAL_SETTING', value: 'new-local' }]);
    const desiredEnvironment = (manager as any).resolveEnvironmentConfig;
    (manager as any).resolveEnvironmentConfig = () => { throw new Error('Restart must not resolve pending environment'); };
    await manager.restart(info.id);
    const applied = await runtime.client.exec(name!, ['bash', '-ec',
      'source /run/agentor/worker.env; test "$ACCOUNT_SETTING" = old-account; test "$(printf %s "$WORKER_LOCAL_ENV" | base64 -d | jq -r \'.[] | select(.key == "LOCAL_SETTING") | .value\')" = old-local; test "$(jq -r .initScript <<< "$WORKER")" = ": # original-init"']);
    expect(applied.returnCode, applied.stderr).toBe(0);
    expect(manager.get(info.id)?.pendingRebuild).toBe(true);
    expect((await useWorkerConfigStore().resolveValues(info.userId, info.id))[0]!.value).toBe('new-local');
    (manager as any).resolveEnvironmentConfig = desiredEnvironment;
    await manager.stop(info.id);
    expect((await runtime.client.getInstanceState(name!)).status).toBe("Stopped");
    const opts = await (manager as any).incusOptionsForWorker(info, true);
    opts.sshAuthorizedKeys = "ssh-ed25519 AAAATEST test-fixture\n";
    await runtime.start(opts);
    const worker = await runtime.client.pullFile(name!, "/run/agentor/worker.env");
    expect(worker.uid).toBe(0);
    expect(worker.content.toString()).toContain(info.id);
    expect((await runtime.client.pullFile(name!, "/home/agent/.ssh/authorized_keys")).content.toString()).toBe(opts.sshAuthorizedKeys);
    expect((await runtime.client.pullFile(name!, "/run/agentor/provisioned")).mode).toBe(0o600);
    expect(dockerCreates).toBe(0);
    // Simulate storage cleanup interruption after disposable compute removal.
    // The archived deletion-pending record must remain a usable retry handle.
    const removeStorage = runtime.removeStorage.bind(runtime);
    let failOnce = true;
    runtime.removeStorage = async (owner) => {
      if (failOnce) { failOnce = false; throw new Error("Injected volume cleanup failure"); }
      await removeStorage(owner);
    };
    await expect(manager.remove(info.id)).rejects.toMatchObject({ code: "WORKER_DELETE_CLEANUP_INCOMPLETE" });
    expect(store.findById(info.id)).toMatchObject({ status: "archived", deletionPending: true, runtimeKind: "incus-vm" });
    await runtime.client.getCustomVolume(config.incusStoragePool, `${name}-workspace`);
    await manager.deleteArchived(info.userId, info.id);
    expect(store.findById(info.id)).toBeUndefined();
    await expect(runtime.client.getInstance(name!)).rejects.toMatchObject({ statusCode: 404 });
    await expect(runtime.client.getCustomVolume(config.incusStoragePool, `${name}-workspace`)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    // Derive any failed provisional VM identity from retained authoritative state.
    for (const worker of store.list()) {
      const containerName = manager.buildContainerName(worker.id);
      await runtime.remove(containerName);
      await runtime.removeStorage({ id: worker.id, userId: worker.userId, containerName });
    }
    await rm(dir, { recursive: true, force: true });
  }
});
