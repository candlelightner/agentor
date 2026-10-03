import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { IncusWorkerRuntime, serializeIncusWorkerEnv, type IncusWorkerOptions } from "../../orchestrator/server/utils/incus-worker-runtime";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import { cleanupWorkerMappings } from "../../orchestrator/server/utils/services";
import { zeroUserEnvVars } from "../../orchestrator/server/utils/user-env-store";
import type { Config } from "../../orchestrator/server/utils/config";
import { withOwnerLifecycleMutation } from "../../orchestrator/server/utils/worker-lifecycle-coordinator";
import { StorageManager } from "../../orchestrator/server/utils/storage";

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
    getImageAlias: record("image", { target: "image-fingerprint", type: "virtual-machine" }),
    getImage: record("image-info", { properties: { bootstrap_generation: "2" } }),
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
    createInstance: async (spec: any) => { events.push({ operation: "create", args: [spec] }); instance = spec; return spec; },
    getInstance: async (...args: any[]) => { events.push({ operation: "instance", args }); return instance; },
    getInstanceState: async (...args: any[]) => { events.push({ operation: "state", args }); return { status }; },
    startInstance: async (...args: any[]) => { events.push({ operation: "start", args }); status = "Running"; },
    stopInstance: record("stop", undefined), deleteInstance: record("remove", undefined),
    exec: record("exec", { returnCode: 0, stdout: "", stderr: "" }), pushFile: record("file", undefined),
  };
  return { client, events };
}

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
  const spec = events.find((event) => event.operation === "create")!.args[0];
  spec.config["user.agentor.installation"] = "foreign-installation";
  events.length = 0;
  expect(await runtime.matchesWorkerIdentity(spec, opts.id)).toBe(false);
  await expect(runtime.start(opts)).rejects.toThrow("installation/worker identity");
  await expect(runtime.stop(opts.containerName)).rejects.toThrow("installation/worker identity");
  await expect(runtime.remove(opts.containerName)).rejects.toThrow("installation/worker identity");
  expect(events.some((event) => ["start", "stop", "remove", "file", "exec"].includes(event.operation))).toBe(false);
});

test("start rejects unsupported persistent capabilities before any mutation", async () => {
  const { client, events } = fakeClient();
  await expect(new IncusWorkerRuntime(config, client as any).start({ ...options(), mounts: [{}] as any })).rejects.toThrow("feature integration");
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
  test.setTimeout(240_000);
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
  (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: zeroUserEnvVars("test-user"), credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveEnvironmentConfig = () => ({ ...options(), dockerEnabled: false });
  const runtime = new IncusWorkerRuntime(config);
  manager.setIncusRuntime(runtime);
  let name: string | undefined;
  try {
    const info = await (manager as any).createForOwner({ userId: "test-user", displayName: "Takeover lifecycle acceptance" });
    name = info.containerName;
    expect(info.runtimeKind).toBe("incus-vm");
    expect(info.status).toBe("running");
    expect(store.findById(info.id)?.runtimeKind).toBe("incus-vm");
    await manager.sync();
    expect(manager.get(info.id)?.containerName).toBe(name);
    const services = await runtime.client.exec(name!, ["sh", "-c", "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/; echo; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6080/"]);
    expect(services.returnCode).toBe(0);
    expect(services.stdout).toContain("302");
    expect(services.stdout).toContain("200");
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
