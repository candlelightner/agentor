import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IncusWorkerRuntime, serializeIncusWorkerEnv, type IncusWorkerOptions } from "../../orchestrator/server/utils/incus-worker-runtime";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { ContainerManager } from "../../orchestrator/server/utils/container";
import { WorkerStore } from "../../orchestrator/server/utils/worker-store";
import { cleanupWorkerMappings } from "../../orchestrator/server/utils/services";
import { zeroUserEnvVars } from "../../orchestrator/server/utils/user-env-store";
import type { Config } from "../../orchestrator/server/utils/config";

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
  const record = (operation: string, value: any) => async (...args: any[]) => {
    events.push({ operation, args }); return value;
  };
  const client = {
    getReadiness: record("ready", { ready: true }), request: record("project", { config: { restricted: "true" } }),
    getImageAlias: record("image", { target: "image-fingerprint", type: "virtual-machine" }),
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
  await expect(new IncusWorkerRuntime(config, client as any).start({ ...options(), dockerEnabled: true })).rejects.toThrow("storage integration");
  expect(events).toEqual([]);
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
    await manager.remove(info.id);
    expect(store.findById(info.id)).toBeUndefined();
    await expect(runtime.client.getInstance(name!)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    // Derive any failed provisional VM identity from retained authoritative state.
    for (const worker of store.list()) await runtime.remove(manager.buildContainerName(worker.id));
    await rm(dir, { recursive: true, force: true });
  }
});
