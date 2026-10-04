import { test, expect, request as playwrightRequest, chromium } from "@playwright/test";
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
  let ipv6FixtureStarted = false;
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
    // Exercise the unchanged dashboard panes in a real browser, not only the
    // proxy endpoints. Reuse this isolated test's session and exact workers.
    const browser = await chromium.launch({ executablePath: process.env.INCUS_BROWSER_EXECUTABLE });
    try {
      const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
      const page = await context.newPage();
      await page.goto("/");
      const card = page.locator(".rounded-lg").filter({ hasText: victim.displayName }).first();
      await expect(card.locator("text=running")).toBeVisible({ timeout: 60_000 });
      await card.locator("button").nth(1).click();
      const editorFrame = page.locator(`iframe[src*="/editor/${victim.id}/"]`);
      await expect(editorFrame).toBeVisible({ timeout: 30_000 });
      await expect(editorFrame.contentFrame().locator(".monaco-workbench")).toBeVisible({ timeout: 60_000 });
      await card.locator("button").nth(2).click();
      const desktopFrame = page.locator(`iframe[src*="/desktop/${victim.id}/"]`);
      await expect(desktopFrame).toBeVisible({ timeout: 30_000 });
      await expect(desktopFrame.contentFrame().locator("#noVNC_container canvas")).toBeVisible({ timeout: 30_000 });
      await expect(desktopFrame.contentFrame().locator("html")).toHaveClass(/noVNC_connected/, { timeout: 30_000 });
    } finally { await browser.close(); }
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
      const ws = new WebSocket(baseURL.replace(/^http/, "ws") + `/ws/desktop/${victim.id}`, { headers: { Cookie: cookie, Origin: baseURL } });
      const timeout = setTimeout(() => { ws.terminate(); reject(new Error("noVNC relay handshake timeout")); }, 15_000);
      ws.once("message", (data: Buffer) => { clearTimeout(timeout); ws.close(); resolve(data.toString()); });
      ws.once("error", (error: Error) => { clearTimeout(timeout); ws.terminate(); reject(error); });
      ws.once("close", () => { clearTimeout(timeout); reject(new Error("noVNC relay closed before its RFB handshake")); });
    });
    expect(rfb).toMatch(/^RFB 003\./);
    await checked(victim.containerName, "docker run -d --restart unless-stopped --name agentor-route-test -p 18080:80 nginx:alpine");
    const domain = await api.post("/api/domain-mappings", { data: { workerId: victim.id, subdomain: "phase6", baseDomain: "incus.test", protocol: "http", internalPort: 18080 } });
    expect(domain.status(), await domain.text()).toBe(201);
    const tcpDomain = await api.post("/api/domain-mappings", { data: { workerId: victim.id, subdomain: "phase6tcp", baseDomain: "incus.test", protocol: "tcp", internalPort: 18080 } });
    expect(tcpDomain.status(), await tcpDomain.text()).toBe(201);
    const port = await api.post("/api/port-mappings", { data: { workerId: victim.id, externalPort: 38081, type: "localhost", internalPort: 18080 } });
    expect(port.status(), await port.text()).toBe(201);
    // Creating a new port entrypoint can recreate Traefik after the mapping
    // response. A transient curl failure is a negative poll observation, not
    // an exception that prevents expect.poll from retrying readiness.
    await expect.poll(() => host("curl --noproxy '*' -fsS --max-time 5 -H 'Host: phase6.incus.test' http://127.0.0.1/ || true"), { timeout: 30_000 }).toContain("Welcome to nginx!");
    expect(host("curl --noproxy '*' -fsS http://127.0.0.1:38081/")).toContain("Welcome to nginx!");
    // The TCP router terminates TLS but does not translate HTTP/2 frames for
    // its raw HTTP/1 backend. Exercise the intended TCP transport explicitly.
    expect(host("curl --noproxy '*' --http1.1 -kfsS --resolve phase6tcp.incus.test:443:127.0.0.1 https://phase6tcp.incus.test/")).toContain("Welcome to nginx!");
    const victimIP = await primary(victim.containerName), attackerIP = await primary(attacker.containerName);
    const victimMAC = (await client.getInstance(victim.containerName)).config["volatile.eth0.hwaddr"]!;
    const attackerMAC = (await client.getInstance(attacker.containerName)).config["volatile.eth0.hwaddr"]!;
    const attackerPrefix = (await client.getInstanceState(attacker.containerName)).network?.eth0?.addresses
      .find((entry: any) => entry.address === attackerIP)?.netmask;
    expect(attackerPrefix).toBeTruthy();
    // root in the attacker guest can assign an arbitrary address. Host filtering
    // must reject it, and the victim's current identity/routing must survive.
    const healthyAttacker = async () => expect(JSON.parse(await checked(attacker.containerName,
      `curl --noproxy '*' -fsS --max-time 5 ${quote(gateway + "/api/worker-self/info")}`)).workerId).toBe(attacker.id);
    const gatewayHost = new URL(gateway).hostname;
    const blockedProbe = (source: string) => `ip -4 addr show dev eth0 | grep -F '${source}/'; ip -4 route get ${gatewayHost} from ${source}; code=0; curl --noproxy '*' --interface ${source} -fsS --connect-timeout 2 --max-time 3 ${quote(gateway + "/api/worker-self/info")} || code=$?; test "$code" = 28`;
    await healthyAttacker();
    await checked(attacker.containerName, `trap 'ip addr del ${victimIP}/32 dev eth0' EXIT; ip addr add ${victimIP}/32 dev eth0; ${blockedProbe(victimIP)}`);
    await healthyAttacker();
    // Networkd removes DHCP addresses when link identity changes. Pause only
    // the fixture's guest manager and deliberately assign a valid source/route
    // so the negative control tests host MAC filtering, not missing guest IPs.
    await checked(attacker.containerName, `trap 'ip link set eth0 down; ip link set eth0 address ${attackerMAC}; ip link set eth0 up; systemctl start systemd-networkd' EXIT; systemctl stop systemd-networkd; ip link set eth0 down; ip link set eth0 address ${victimMAC}; ip link set eth0 up; ip -4 addr replace ${attackerIP}/${attackerPrefix} dev eth0; ip route replace default via ${gatewayHost} dev eth0; ${blockedProbe(attackerIP)}`);
    await expect.poll(async () => {
      const result = await client.exec(attacker.containerName, ["curl", "--noproxy", "*", "-fsS", "--max-time", "5", gateway + "/api/worker-self/info"]);
      return result.returnCode === 0 ? JSON.parse(result.stdout).workerId : null;
    }, { timeout: 30_000 }).toBe(attacker.id);
    const ipv6CIDR = host("sudo incus network get incusbr0 ipv6.address");
    if (ipv6CIDR && ipv6CIDR !== "none") {
      const gateway6 = ipv6CIDR.split("/")[0]!;
      const addresses = async (name: string) => (await client.getInstanceState(name)).network?.eth0?.addresses ?? [];
      const global6 = async (name: string) => (await addresses(name)).find((entry: any) => entry.family === "inet6" && entry.scope === "global")?.address;
      await expect.poll(() => global6(victim.containerName), { timeout: 30_000 }).toBeTruthy();
      await expect.poll(() => global6(attacker.containerName), { timeout: 30_000 }).toBeTruthy();
      const source6 = await global6(victim.containerName);
      // Host-side fixture serves a constant only, never a host directory. Its
      // narrow listener expires even if this test process disappears.
      const server = "import http.server,socket; H=type('H',(http.server.BaseHTTPRequestHandler,),{'do_GET':lambda s:(s.send_response(200),s.end_headers(),s.wfile.write(b'agentor-ipv6-fixture')),'log_message':lambda *a:None}); S=type('S',(http.server.HTTPServer,),{'address_family':socket.AF_INET6}); S((" + JSON.stringify(gateway6) + ",38886),H).serve_forever()";
      host(`sudo systemd-run --quiet --collect --unit=agentor-phase6-ipv6-fixture --uid=ubuntu --property=RuntimeMaxSec=600 /usr/bin/python3 -c ${quote(server)}`);
      ipv6FixtureStarted = true;
      const target6 = `http://[${gateway6}]:38886/`;
      await expect.poll(async () => (await client.exec(attacker.containerName,
        ["curl", "--noproxy", "*", "-6", "-fsS", "--max-time", "3", target6])).stdout.trim(), { timeout: 15_000 }).toBe("agentor-ipv6-fixture");
      expect(await checked(victim.containerName, `curl --noproxy '*' -6 --interface ${source6} -fsS --max-time 5 ${quote(target6)}`)).toBe("agentor-ipv6-fixture");
      await checked(attacker.containerName, `trap 'ip -6 addr del ${source6}/128 dev eth0' EXIT; ip -6 addr add ${source6}/128 dev eth0 nodad; ip -6 route get ${gateway6} from ${source6}; code=0; curl --noproxy '*' -6 --interface ${source6} -fsS --connect-timeout 2 --max-time 3 ${quote(target6)} || code=$?; test "$code" = 28`);
      expect(await checked(attacker.containerName, `curl --noproxy '*' -6 -fsS --max-time 5 ${quote(target6)}`)).toBe("agentor-ipv6-fixture");
    }
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
    // MAC/link testing can overlap the periodic backend refresh. Require
    // convergence after host identity recovers, not an unchanged route cache.
    await expect.poll(() => host("curl --noproxy '*' -sS --max-time 5 -H 'Host: phase6.incus.test' http://127.0.0.1/ || true"),
      { timeout: 60_000, intervals: [1000] }).toContain("Welcome to nginx!");
    await expect.poll(async () => [await primary(victim.containerName), await primary(attacker.containerName)],
      { timeout: 10_000, intervals: [1000] }).toEqual([victimIP, attackerIP]);
    // Also check after processing has settled, not just immediately after send.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(await primary(victim.containerName)).toBe(victimIP);
    expect(await primary(attacker.containerName)).toBe(attackerIP);
    if (process.env.INCUS_IP_CHANGE_TEST === 'true') {
      // Operator-side reservation changes are runtime state, not WorkerRecord
      // configuration. Discover a free test address; never alter a foreign VM.
      const cidr = host('sudo incus network get incusbr0 ipv4.address');
      expect(cidr).toMatch(/^\d+\.\d+\.\d+\.\d+\/24$/);
      const subnet = cidr.split('/')[0]!.split('.').slice(0, 3).join('.');
      const used = new Set<string>(JSON.parse(host('sudo incus query /1.0/networks/incusbr0/leases'))
        .map((lease: any) => lease.address));
      used.add(cidr.split('/')[0]!); used.add(victimIP); used.add(attackerIP);
      const all = JSON.parse(host('sudo incus query "/1.0/instances?all-projects=true&recursion=1"'));
      for (const instance of all) for (const device of Object.values(instance.expanded_devices ?? instance.devices) as any[]) {
        if (device.type === 'nic' && device.network === 'incusbr0' && device['ipv4.address']) used.add(device['ipv4.address']);
      }
      const projects = JSON.parse(host('sudo incus query /1.0/projects?recursion=1'));
      for (const project of projects) {
        const profiles = JSON.parse(host(`sudo incus query ${quote('/1.0/profiles?recursion=1&project=' + encodeURIComponent(project.name))}`));
        for (const profile of profiles) for (const device of Object.values(profile.devices ?? {}) as any[]) {
          if (device.type === 'nic' && device.network === 'incusbr0' && device['ipv4.address']) used.add(device['ipv4.address']);
        }
      }
      const newIP = Array.from({ length: 253 }, (_, i) => `${subnet}.${254 - i}`).find((address) => !used.has(address));
      expect(newIP).toBeTruthy();
      const readdress = async (worker: any, address: string) => {
        const stop = await api.post(`/api/containers/${worker.id}/stop`, { data: {} });
        expect(stop.status(), await stop.text()).toBe(200); expect(await stop.json()).toEqual({ ok: true });
        const instance = await client.getInstance(worker.containerName);
        expect(instance.config).toMatchObject({ 'user.agentor.id': worker.id, 'user.agentor.owner': owner,
          'volatile.uuid': worker.containerId.slice(6) });
        expect(instance.status).toBe('Stopped');
        await client.updateInstanceDevices(worker.containerName, { ...instance.devices,
          eth0: { ...instance.devices.eth0!, 'ipv4.address': address } });
        const restart = await api.post(`/api/containers/${worker.id}/restart`, { data: {} });
        expect(restart.status(), await restart.text()).toBe(200); expect(await restart.json()).toEqual({ ok: true });
        await expect.poll(() => primary(worker.containerName), { timeout: 60_000 }).toBe(address);
        expect(JSON.parse(await checked(worker.containerName,
          `curl --noproxy '*' -fsS --max-time 5 ${quote(gateway + '/api/worker-self/info')}`)).workerId).toBe(worker.id);
      };
      await readdress(victim, newIP!);
      // Reassign the retired source to a different owned fixture. Worker-self
      // must now resolve that worker, while victim routes move to its new IP.
      await readdress(attacker, victimIP);
      // Make only this guest's desktop/editor ports unavailable. Keep service
      // health intact so reconciliation does not undo the negative control.
      // A stale target must fail, not pass through an identical worker UI.
      await checked(attacker.containerName, 'iptables -I INPUT 1 -p tcp -m multiport --dports 6080,8443 -j REJECT; ! curl --noproxy "*" -fsS --max-time 3 http://127.0.0.1:6080/; ! curl --noproxy "*" -fsS --max-time 3 http://127.0.0.1:8443/');
      await checked(attacker.containerName, "mkdir -p /tmp/agentor-stale-ip-fixture; printf stale-backend-attacker > /tmp/agentor-stale-ip-fixture/index.html; python3 -c \"import subprocess; subprocess.Popen(['python3','-m','http.server','18080','--directory','/tmp/agentor-stale-ip-fixture'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)\"");
      await expect.poll(async () => (await client.exec(attacker.containerName,
        ['curl', '--noproxy', '*', '-fsS', '--max-time', '5', 'http://127.0.0.1:18080/'])).stdout,
      { timeout: 15_000 }).toBe('stale-backend-attacker');
      await expect.poll(() => host("curl --noproxy '*' -sS --max-time 5 -H 'Host: phase6.incus.test' http://127.0.0.1/ || true"),
        { timeout: 60_000, intervals: [1000] }).toContain('Welcome to nginx!');
      expect(host("curl --noproxy '*' -fsS http://127.0.0.1:38081/")).toContain('Welcome to nginx!');
      expect(host("curl --noproxy '*' --http1.1 -kfsS --resolve phase6tcp.incus.test:443:127.0.0.1 https://phase6tcp.incus.test/")).toContain('Welcome to nginx!');
      expect([200, 302]).toContain((await api.get(`/editor/${victim.id}/`, { maxRedirects: 0 })).status());
      expect((await api.get(`/desktop/${victim.id}/agentor.html`)).status()).toBe(200);
      const noVnc = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(baseURL.replace(/^http/, 'ws') + `/ws/desktop/${victim.id}`, { headers: { Cookie: cookie, Origin: baseURL } });
        const timer = setTimeout(() => { ws.terminate(); reject(new Error('Readdressed noVNC handshake timeout')); }, 15_000);
        ws.once('message', (bytes: Buffer) => { clearTimeout(timer); ws.close(); resolve(bytes.toString()); });
        ws.once('error', (error: Error) => { clearTimeout(timer); ws.terminate(); reject(error); });
        ws.once('close', () => { clearTimeout(timer); reject(new Error('Readdressed noVNC closed before handshake')); });
      });
      expect(noVnc).toMatch(/^RFB 003\./);
      // Confirm anti-spoofing survives the operator's address changes.
      for (const worker of workers) expect((await client.getInstance(worker.containerName)).devices.eth0).toMatchObject({
        'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
    }
  } catch (error) {
    primaryFailure = true;
    try { console.error(host("sudo docker logs --tail 60 agentor-traefik 2>&1 || true")); }
    catch { console.error("Traefik failure diagnostics unavailable; preserving primary test error"); }
    throw error;
  } finally {
    const cleanupFailures: string[] = [];
    for (const worker of workers.reverse()) {
      try {
        const removed = await api.delete(`/api/containers/${worker.id}`);
        if (!removed.ok()) cleanupFailures.push(`Worker cleanup ${worker.id}: HTTP ${removed.status()}`);
      } catch { cleanupFailures.push(`Worker cleanup ${worker.id}: transport failure`); }
    }
    for (const id of envs) {
      try {
        const removed = await api.delete(`/api/environments/${id}`);
        if (!removed.ok()) cleanupFailures.push(`Environment cleanup ${id}: HTTP ${removed.status()}`);
      } catch { cleanupFailures.push(`Environment cleanup ${id}: transport failure`); }
    }
    try { host(`sudo incus project set agentor restricted.devices.disk.paths ${quote(previousPaths)}`); }
    catch { cleanupFailures.push("Test project allowlist restoration failed"); }
    finally { await Promise.allSettled([api.dispose(), anonymous.dispose()]); }
    if (ipv6FixtureStarted) {
      try { host("sudo systemctl stop agentor-phase6-ipv6-fixture.service"); }
      catch { cleanupFailures.push("IPv6 fixture cleanup deferred (bounded expiry remains active)"); }
    }
    if (cleanupFailures.length) {
      console.error(cleanupFailures.join("\n"));
      // Preserve the primary test evidence while still failing a successful run
      // whose exact fixture cleanup did not complete.
      if (!primaryFailure) throw new Error(cleanupFailures.join("; "));
    }
  }
});
