import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { IncusWorkerStorage } from "../../orchestrator/server/utils/incus-worker-storage";
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

test('early guest agent retains explicit shutdown ordering for background exec children', () => {
  const unit = readFileSync(new URL('../../worker/vm/incus-agent.service', import.meta.url), 'utf8');
  expect(unit).toMatch(/^DefaultDependencies=no$/m);
  expect(unit).toMatch(/^Conflicts=.*\bshutdown\.target\b/m);
  expect(unit).toMatch(/^Before=.*\bshutdown\.target\b/m);
});

test("real derived image boots unattended and waits for runtime provisioning", async () => {
  test.skip(process.env.INCUS_LIVE_TEST !== "true", "Explicit disposable-host acceptance run");
  test.setTimeout(600_000);
  const client = IncusClient.fromConfig(config);
  const id = randomUUID();
  const name = `${config.containerPrefix}-${id}`;
  const image = await client.getImageAlias(config.incusWorkerImage);
  const storage = new IncusWorkerStorage(client, config, name);
  const owner = { id, userId: "image-test", containerName: name };
  const devices = await storage.devices(owner, false);
  let created = false;
  try {
    await client.createInstance({ name, type: "virtual-machine", profiles: [],
      source: { type: "image", fingerprint: image.target },
      config: { "security.secureboot": "false", "limits.memory": "2GiB", "limits.cpu": "2" },
      devices: {
        ...devices,
        root: { type: "disk", path: "/", pool: config.incusStoragePool },
        eth0: { type: "nic", name: "eth0", network: config.incusNetwork,
          "security.ipv4_filtering": "true", "security.mac_filtering": "true", "security.ipv6_filtering": "true" },
      },
    });
    created = true;
    await client.startInstance(name);
    let agentError = '';
    try {
      await expect.poll(async () => {
        try { return (await client.exec(name, ["true"])).returnCode; }
        catch (error) { agentError = String(error); return -1; }
      }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
    } catch (error) {
      console.error('Derived-image guest readiness failure', name, agentError);
      // Capture the exact disposable fixture before teardown removes its
      // console. CLI is diagnostic only; normal runtime stays API-based.
      try {
        console.error(execFileSync('ssh', ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
          '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
          '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1',
          `sudo incus console ${name} --project agentor --show-log`], { encoding: 'utf8', timeout: 30_000 }));
      } catch (diagnosticError) { console.error('Console diagnostic unavailable', String(diagnosticError)); }
      throw error;
    }
    const unconfigured = await client.exec(name, ["bash", "-ec", [
      "test \"$(cat /proc/1/comm)\" = systemd",
      "systemctl is-active --quiet incus-agent",
      "systemctl show incus-agent -p Conflicts --value | grep -qw shutdown.target",
      "systemctl show incus-agent -p Before --value | grep -qw shutdown.target",
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
    await client.pushFile(name, "/run/agentor/provisioned", "image-acceptance\n", { mode: 0o600, uid: 0, gid: 0 });
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
    const network = await client.exec(name, ["bash", "-ec", [
      "/usr/lib/agentor/agentor-network.sh custom '[\"example.com\"]'",
      "test \"$(readlink /etc/resolv.conf)\" = /run/agentor/filter-resolv.conf",
      "! grep -q 127.0.0.11 /run/agentor/firewall-dns.conf",
      "getent ahostsv4 example.com",
      "curl --ipv4 --noproxy '*' -fsSI --max-time 30 https://example.com",
      "iptables -Z AGENTOR-OUTPUT",
      "! curl --noproxy '*' -fsS --connect-timeout 2 --max-time 3 http://198.51.100.10:81/",
      "iptables -nvxL AGENTOR-OUTPUT | awk '$3 == \"DROP\" { if($1>0) found=1 } END { exit !found }'",
      "/usr/lib/agentor/agentor-network.sh custom '[\"example.org\"]'",
      "! grep -q 'example.com' /run/agentor/firewall-dns.conf",
      "test \"$(iptables -S OUTPUT | grep -c -- '-j AGENTOR-OUTPUT')\" = 1",
      "ip6tables -S AGENTOR-OUTPUT | grep -q -- '-j DROP'",
      "/usr/lib/agentor/agentor-network.sh full",
      "test \"$(readlink /etc/resolv.conf)\" = /run/systemd/resolve/stub-resolv.conf",
      "! systemctl is-active --quiet agentor-dnsmasq.service",
      "getent ahostsv4 example.org",
    ].join("; ")]);
    expect(network.returnCode, `${network.stdout}\n${network.stderr}`).toBe(0);
    // Background exec children used by apps/plugins must stop with the guest
    // agent, before final shutdown/unmount. Keep the production stop bound.
    expect((await client.exec(name, ["bash", "-ec", "cd /workspace; sleep 600 >/dev/null 2>&1 &"])).returnCode).toBe(0);
    await client.stopInstance(name, { timeout: 30 });
    expect((await client.getInstanceState(name)).status).toBe('Stopped');
  } finally {
    // A transport/operation timeout may occur after creation was accepted.
    // Cleanup only this exact generated test name, not an arbitrary inventory.
    const exists = created || await client.getInstance(name).then(() => true, (error) => {
      if (error.statusCode === 404) return false;
      throw error;
    });
    if (exists) {
      if ((await client.getInstanceState(name)).status !== "Stopped")
        await client.stopInstance(name, { force: true });
      await client.deleteInstance(name);
    }
    await storage.remove(owner);
  }
});
