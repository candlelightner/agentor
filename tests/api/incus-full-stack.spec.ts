import { test, expect, request as playwrightRequest } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";
import { resolveIncusPrimaryLease } from "../../orchestrator/server/utils/incus-worker-network";

const require = createRequire(join(process.cwd(), "../orchestrator/package.json"));
const WebSocket = require("ws");
const ssh = ["-p", "22375", "-i", "/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519",
  "-o", "UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts", "-o", "BatchMode=yes",
  "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes", "kata-test@172.19.0.1"];
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const host = (script: string) => execFileSync("ssh", [...ssh, "bash -ec " + quote(script)], { encoding: "utf8", timeout: 60_000 }).trim();

test("real Dockerized Agentor routes editor/desktop/Traefik and authorizes filtered VM source identity", async () => {
  test.skip(process.env.INCUS_STACK_TEST !== "true", "Explicit isolated disposable-host full-stack acceptance");
  test.setTimeout(900_000);
  const baseURL = process.env.INCUS_STACK_URL || "http://127.0.0.1:38000";
  const gateway = process.env.INCUS_STACK_GATEWAY || "http://10.159.68.1:38000";
  const data = process.env.INCUS_STACK_DATA_HOST;
  if (!data || !/^\/var\/tmp\/agentor-phase6-production\.[A-Za-z0-9]+\/stack-data$/.test(data))
    throw new Error("Explicit disposable fixture data path required");
  const api = await playwrightRequest.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL }, timeout: 360_000 });
  const anonymous = await playwrightRequest.newContext({ baseURL });
  const client = new IncusClient({ endpoint: "https://127.0.0.1:18443", project: "agentor",
    clientCertPath: "/workspace/agentor-incus-tls/client.crt", clientKeyPath: "/workspace/agentor-incus-tls/client.key",
    serverCertPath: "/workspace/agentor-incus-tls/server.crt" });
  const workers: any[] = [], envs: string[] = [];
  let primaryFailure = false;
  const previousPaths = JSON.parse(host("sudo incus query /1.0/projects/agentor")).config["restricted.devices.disk.paths"] || "";
  const checked = async (name: string, script: string) => {
    const result = await client.exec(name, ["bash", "-ec", script]);
    expect(result.returnCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  const primary = async (name: string) => {
    const [instance, peers, network, leases] = await Promise.all([
      client.getInstance(name), client.listInstances(), client.getNetwork("incusbr0"), client.getNetworkLeases("incusbr0"),
    ]);
    return resolveIncusPrimaryLease(instance, peers, network, leases, "incusbr0").address;
  };
  try {
    await expect.poll(async () => (await api.get("/api/health")).status(), { timeout: 60_000 }).toBe(200);
    if ((await (await api.get("/api/setup/status")).json()).needsSetup) {
      const setup = await api.post("/api/setup/create-admin", { data: { email: "incus-stack@agentor.test", password: "isolated-incus-stack-test-password", name: "Incus Stack Test" } });
      expect(setup.ok(), await setup.text()).toBe(true);
    }
    const signIn = await api.post("/api/auth/sign-in/email", { data: { email: "incus-stack@agentor.test", password: "isolated-incus-stack-test-password" } });
    expect(signIn.ok(), await signIn.text()).toBe(true);
    const owner = (await signIn.json()).user.id;
    expect(owner).toMatch(/^[A-Za-z0-9_-]+$/);
    const dirs = [`${data}/users/${owner}/credentials`, `${data}/users/${owner}/kilo/config`, `${data}/users/${owner}/kilo/data`];
    // Test-side operator authority, not the restricted production API client.
    host(`sudo incus project set agentor restricted.devices.disk.paths ${quote([previousPaths, ...dirs].filter(Boolean).join(","))}`);
    for (const dockerEnabled of [true, false]) {
      const env = await api.post("/api/environments", { data: { name: `Incus phase6 ${dockerEnabled}`, networkMode: "full", dockerEnabled, memoryLimit: "2GiB", cpuLimit: 2 } });
      expect(env.status(), await env.text()).toBe(201);
      const environment = await env.json(); envs.push(environment.id);
      const created = await api.post("/api/containers", { data: { displayName: `Incus full-stack ${dockerEnabled}`, environmentId: environment.id } });
      expect(created.status(), await created.text()).toBe(201);
      const worker = await created.json(); workers.push(worker);
      expect(worker.runtimeKind).toBe("incus-vm");
      expect(worker.status).toBe("running");
      expect(worker.userId).toBe(owner);
    }
    const [victim, attacker] = workers;
    for (const worker of workers) {
      const identity = JSON.parse(await checked(worker.containerName, `curl --noproxy '*' -fsS ${quote(gateway + "/api/worker-self/info")}`));
      expect(identity.workerId).toBe(worker.id);
      expect(identity.userId).toBe(owner);
      expect((await anonymous.get(`/editor/${worker.id}/`, { maxRedirects: 0 })).status()).toBe(401);
      const editor = await api.get(`/editor/${worker.id}/`, { maxRedirects: 0 });
      expect([200, 302]).toContain(editor.status());
      expect((await api.get(`/desktop/${worker.id}/agentor.html`)).status()).toBe(200);
    }
    const cookie = (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const rfb = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(baseURL.replace(/^http/, "ws") + `/desktop/${victim.id}/websockify`, { headers: { Cookie: cookie } });
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error("noVNC relay handshake timeout")); }, 15_000);
      ws.once("message", (data: Buffer) => { clearTimeout(timeout); ws.close(); resolve(data.toString()); });
      ws.once("error", (error: Error) => { clearTimeout(timeout); ws.terminate(); reject(error); });
    });
    expect(rfb).toMatch(/^RFB 003\./);
    await checked(victim.containerName, "docker run -d --name agentor-route-test -p 18080:80 nginx:alpine");
    const domain = await api.post("/api/domain-mappings", { data: { workerId: victim.id, subdomain: "phase6", baseDomain: "incus.test", protocol: "http", internalPort: 18080 } });
    expect(domain.status(), await domain.text()).toBe(201);
    const port = await api.post("/api/port-mappings", { data: { workerId: victim.id, externalPort: 38081, type: "localhost", internalPort: 18080 } });
    expect(port.status(), await port.text()).toBe(201);
    await expect.poll(() => host("curl --noproxy '*' -fsS -H 'Host: phase6.incus.test' http://127.0.0.1/"), { timeout: 30_000 }).toContain("Welcome to nginx!");
    expect(host("curl --noproxy '*' -fsS http://127.0.0.1:38081/")).toContain("Welcome to nginx!");
    const victimIP = await primary(victim.containerName), attackerIP = await primary(attacker.containerName);
    const victimMAC = (await client.getInstance(victim.containerName)).config["volatile.eth0.hwaddr"]!;
    const attackerMAC = (await client.getInstance(attacker.containerName)).config["volatile.eth0.hwaddr"]!;
    // root in the attacker guest can assign an arbitrary address. Host filtering
    // must reject it, and the victim's current identity/routing must survive.
    const healthyAttacker = async () => expect(JSON.parse(await checked(attacker.containerName,
      `curl --noproxy '*' -fsS --max-time 5 ${quote(gateway + "/api/worker-self/info")}`)).workerId).toBe(attacker.id);
    const gatewayHost = new URL(gateway).hostname;
    const blockedProbe = (source: string) => `ip -4 addr show dev eth0 | grep -F '${source}/'; ip -4 route get ${gatewayHost} from ${source}; code=0; curl --noproxy '*' --interface ${source} -fsS --connect-timeout 2 --max-time 3 ${quote(gateway + "/api/worker-self/info")} || code=$?; test "$code" = 28`;
    await healthyAttacker();
    await checked(attacker.containerName, `trap 'ip addr del ${victimIP}/32 dev eth0' EXIT; ip addr add ${victimIP}/32 dev eth0; ${blockedProbe(victimIP)}`);
    await healthyAttacker();
    await checked(attacker.containerName, `trap 'ip link set eth0 down; ip link set eth0 address ${attackerMAC}; ip link set eth0 up' EXIT; ip link set eth0 down; ip link set eth0 address ${victimMAC}; ip link set eth0 up; ${blockedProbe(attackerIP)}`);
    await expect.poll(async () => {
      const result = await client.exec(attacker.containerName, ["curl", "--noproxy", "*", "-fsS", "--max-time", "5", gateway + "/api/worker-self/info"]);
      return result.returnCode === 0 ? JSON.parse(result.stdout).workerId : null;
    }, { timeout: 30_000 }).toBe(attacker.id);
    // Ethernet filtering doesn't compare DHCP chaddr. Forge it deliberately;
    // even if DHCP replies, it must not retarget authority to the attacker.
    const forged = `import socket,struct,random\nmac=bytes.fromhex('${attackerMAC}'.replace(':',''))\nvictim=bytes.fromhex('${victimMAC}'.replace(':',''))\ns=socket.socket(socket.AF_PACKET,socket.SOCK_RAW); s.bind(('eth0',0))\nfor kind in (1,3):\n body=struct.pack('!BBBBIHH4s4s4s4s16s64s128s',1,1,6,0,random.randrange(2**32),0,32768,b'\\0'*4,b'\\0'*4,b'\\0'*4,b'\\0'*4,victim+b'\\0'*10,b'\\0'*64,b'\\0'*128)+b'\\x63\\x82\\x53\\x63'+bytes([53,1,kind,50,4])+socket.inet_aton('${victimIP}')+bytes([255])\n udp=struct.pack('!HHHH',68,67,8+len(body),0)+body\n ip=struct.pack('!BBHHHBBH4s4s',69,0,20+len(udp),1,0,64,17,0,b'\\0'*4,b'\\xff'*4)\n words=struct.unpack('!10H',ip); checksum=sum(words); checksum=(checksum&65535)+(checksum>>16); checksum=(checksum&65535)+(checksum>>16)\n ip=ip[:10]+struct.pack('!H',65535-checksum)+ip[12:]\n s.send(b'\\xff'*6+mac+b'\\x08\\x00'+ip+udp)\ns.close()\n`;
    expect((await client.exec(attacker.containerName, ["python3", "-c", forged])).returnCode).toBe(0);
    expect(await primary(victim.containerName)).toBe(victimIP);
    expect(await primary(attacker.containerName)).toBe(attackerIP);
    for (const worker of workers) {
      await expect.poll(async () => {
        const result = await client.exec(worker.containerName, ["curl", "--noproxy", "*", "-fsS", "--max-time", "5", gateway + "/api/worker-self/info"]);
        return result.returnCode === 0 ? JSON.parse(result.stdout).workerId : null;
      }, { timeout: 30_000 }).toBe(worker.id);
    }
    expect(host("curl --noproxy '*' -fsS -H 'Host: phase6.incus.test' http://127.0.0.1/")).toContain("Welcome to nginx!");
    await expect.poll(async () => [await primary(victim.containerName), await primary(attacker.containerName)],
      { timeout: 10_000, intervals: [1000] }).toEqual([victimIP, attackerIP]);
    // Also check after processing has settled, not just immediately after send.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await primary(victim.containerName)).toBe(victimIP);
    expect(await primary(attacker.containerName)).toBe(attackerIP);
  } catch (error) {
    primaryFailure = true;
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    for (const worker of workers.reverse()) {
      try {
        const removed = await api.delete(`/api/containers/${worker.id}`);
        if (!removed.ok()) cleanupFailures.push(`Worker cleanup ${worker.id}: HTTP ${removed.status()}`);
      } catch { cleanupFailures.push(`Worker cleanup ${worker.id}: transport failure`); }
    }
    for (const id of envs) await api.delete(`/api/environments/${id}`).catch(() => cleanupFailures.push(`Environment cleanup ${id} deferred`));
    try { host(`sudo incus project set agentor restricted.devices.disk.paths ${quote(previousPaths)}`); }
    catch { cleanupFailures.push("Test project allowlist restoration failed"); }
    finally { await Promise.allSettled([api.dispose(), anonymous.dispose()]); }
    if (cleanupFailures.length) {
      console.error(cleanupFailures.join("\n"));
      // Preserve the primary test evidence while still failing a successful run
      // whose exact fixture cleanup did not complete.
      if (!primaryFailure) throw new Error(cleanupFailures.join("; "));
    }
  }
});
