import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import type { Config } from "../../orchestrator/server/utils/config";

function serializeIncusWorkerEnv(values: Record<string, string>): string {
  return Object.entries(values).map(([key, value]) => key + "='" + value.replaceAll("'", "'\\''") + "'").join("\n") + "\n";
}

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

function options() {
  return {
    userId: "test-user", id: "test-worker", containerName: "agentor-worker-test-worker", dockerEnabled: false,
    environmentJson: { networkMode: "full", allowedDomains: [], dockerEnabled: false,
      setupScript: "", envVars: "", exposeApis: { portMappings: true, domainMappings: true, usage: true } },
    capabilitiesJson: [], instructionsJson: [],
    workerJson: { id: "test-worker", displayName: "Incus test", repos: [], initScript: "", gitName: "", gitEmail: "" },
  };
}

test("real derived image boots unattended and waits for runtime provisioning", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(240_000);
  const client = IncusClient.fromConfig(config);
  const name = `phase3-${randomUUID()}`;
  const image = await client.getImageAlias(config.incusWorkerImage);
  let created = false;
  try {
    await client.createInstance({ name, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint: image.target },
      config: { "security.secureboot": "false", "limits.memory": "2GiB", "limits.cpu": "2" },
      devices: {
        root: { type: "disk", path: "/", pool: config.incusStoragePool },
        eth0: { type: "nic", name: "eth0", network: config.incusNetwork,
          "security.ipv4_filtering": "true", "security.mac_filtering": "true", "security.ipv6_filtering": "true" },
      },
    });
    created = true;
    await client.startInstance(name);
    await expect.poll(async () => {
      try { return (await client.exec(name, ["true"])).returnCode; } catch { return -1; }
    }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    const unconfigured = await client.exec(name, ["bash", "-ec", [
      "test \"$(cat /proc/1/comm)\" = systemd",
      "systemctl is-active --quiet incus-agent",
      "test ! -e /run/agentor/worker.env",
      "! systemctl is-active --quiet agentor-worker docker docker.socket containerd",
      "systemctl start agentor-worker",
      "! systemctl is-active --quiet agentor-worker",
      "id agent; sudo -u agent sudo -n true",
    ].join("; ")]);
    expect(unconfigured.returnCode, unconfigured.stderr).toBe(0);
    const opts = options();
    await client.pushFile(name, "/run/agentor", "", { type: "directory", mode: 0o711 });
    await client.pushFile(name, "/run/agentor/worker.env", serializeIncusWorkerEnv({
      ENVIRONMENT: JSON.stringify(opts.environmentJson), WORKER: JSON.stringify(opts.workerJson),
      CAPABILITIES: "[]", INSTRUCTIONS: "[]", ORCHESTRATOR_URL: config.incusInternalGatewayUrl,
      AGENTOR_RUNTIME_ROLE: "worker", WORKER_CONTAINER_NAME: name,
    }), { mode: 0o640, uid: 0, gid: 1000 });
    expect((await client.exec(name, ["sudo", "-u", "agent", "test", "-r", "/run/agentor/worker.env"])).returnCode).toBe(0);
    expect((await client.exec(name, ["systemctl", "start", "agentor-worker"])).returnCode).toBe(0);
    await expect.poll(async () => (await client.exec(name, ["grep", "-q", "^READY|", "/tmp/worker-events"])).returnCode,
      { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    const services = await client.exec(name, ["bash", "-ec", [
      "systemctl is-active --quiet agentor-worker", "! systemctl is-active --quiet docker",
      "sudo -u agent tmux has-session -t main",
      "for process in Xvfb fluxbox x11vnc; do pgrep -x \"$process\"; done",
      "curl -fsS -o /dev/null http://127.0.0.1:6080/",
      "test \"$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8443/)\" = 302",
    ].join("; ")]);
    expect(services.returnCode, services.stderr).toBe(0);
    expect(await client.getPrimaryIp(name)).toBeTruthy();
  } finally {
    if (created) {
      if ((await client.getInstanceState(name)).status !== "Stopped")
        await client.stopInstance(name, { force: true });
      await client.deleteInstance(name);
    }
  }
});
