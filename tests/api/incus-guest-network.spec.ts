import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, readFile, writeFile, readlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

async function fixture(run: (f: { invoke: (mode: string, domains?: string) => void; log: () => Promise<string>; conf: () => Promise<string>; resolver: () => Promise<string>; root: string }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "agentor-guest-network-"));
  try {
    const bin = join(root, "bin"), runtime = join(root, "runtime"), upstream = join(root, "resolved"), target = join(root, "resolv.conf");
    await mkdir(bin); await mkdir(runtime); await mkdir(upstream);
    await writeFile(join(upstream, "resolv.conf"), "nameserver 10.20.30.1\nnameserver 127.0.0.53\nnameserver fd42::1\n");
    for (const tool of ["iptables", "ip6tables", "systemctl", "ipset"]) {
      await writeFile(join(bin, tool), `#!/bin/bash\nprintf '%s %s\\n' '${tool}' "$*" >> "$FIXTURE_LOG"\nif [[ "$*" == *' -S '* || "$*" == *' -C '* ]]; then exit 1; fi\n`, { mode: 0o755 });
    }
    await writeFile(join(bin, "dig"), "#!/bin/sh\necho 127.0.0.1\n", { mode: 0o755 });
    const script = (await readFile("../worker/vm/agentor-network.sh", "utf8"))
      .replaceAll("/run/agentor", runtime).replaceAll("/run/systemd/resolve", upstream).replaceAll("/etc/resolv.conf", target);
    await run({ root, invoke: (mode, domains = "[]") => execFileSync("bash", ["-c", script, "fixture", mode, domains],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE_LOG: join(root, "log") }, stdio: "pipe" }),
      log: () => readFile(join(root, "log"), "utf8"), conf: () => readFile(join(runtime, "firewall-dns.conf"), "utf8"),
      resolver: () => readlink(target) });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("VM policy uses actual DHCP DNS, an independent loopback listener, and IPv6 fail-closed", async () => {
  await fixture(async (f) => {
    f.invoke("custom", '["*.example.test"]');
    const config = await f.conf();
    expect(config).toContain("listen-address=127.0.0.55");
    expect(config).toContain("server=10.20.30.1");
    expect(config).toContain("ipset=/example.test/allowed_ips");
    expect(config).not.toMatch(/127\.0\.0\.(11|53)|fd42/);
    expect(await f.resolver()).toBe(join(f.root, "runtime/filter-resolv.conf"));
    const log = await f.log();
    expect(log).toContain("ip6tables -w -A AGENTOR-OUTPUT -j DROP");
    expect(log).toContain("iptables -w -I AGENTOR-OUTPUT 1 -d 10.20.30.1 -p udp --dport 53 -j ACCEPT");
    expect(log).not.toMatch(/ -P | -F OUTPUT|DOCKER/);
  });
});

test("reprovisioning flushes only guest-owned policy and full mode restores DHCP resolver without stale ipset grants", async () => {
  await fixture(async (f) => {
    f.invoke("custom", '["example.test"]');
    f.invoke("custom", '["other.test"]');
    expect(await f.conf()).not.toContain("example.test");
    expect((await f.log()).match(/ipset flush allowed_ips/g)).toHaveLength(2);
    f.invoke("full");
    expect(await f.resolver()).toBe(join(f.root, "resolved/stub-resolv.conf"));
    const log = await f.log();
    expect(log).toContain("iptables -w -A AGENTOR-OUTPUT -j RETURN");
    expect(log).toContain("ip6tables -w -A AGENTOR-OUTPUT -j RETURN");
    expect((log.match(/systemctl stop agentor-dnsmasq.service/g) ?? []).length).toBe(3);
  });
});

test("block-all keeps existing private-network allowance but no domain/DNS exceptions", async () => {
  await fixture(async (f) => {
    f.invoke("block-all");
    const log = await f.log();
    expect(log).toContain("iptables -w -A AGENTOR-OUTPUT -d 10.0.0.0/8 -j ACCEPT");
    expect(log).not.toContain("--dport 53");
    expect(log).not.toContain("systemctl start agentor-dnsmasq.service");
    expect(log).toContain("iptables -w -A AGENTOR-OUTPUT -j DROP");
  });
});

test("missing upstream and injected DNS directives fail closed without public DNS fallback", async () => {
  await fixture(async (f) => {
    await writeFile(join(f.root, "resolved/resolv.conf"), "nameserver 127.0.0.53\n");
    expect(() => f.invoke("custom", '["example.test"]')).toThrow();
    expect(await f.log()).toContain("iptables -w -A AGENTOR-OUTPUT -j DROP");
    expect(await f.log()).not.toContain("systemctl start agentor-dnsmasq.service");
    await writeFile(join(f.root, "resolved/resolv.conf"), "nameserver 10.20.30.1\n");
    expect(() => f.invoke("custom", '["example.test\\nserver=8.8.8.8"]')).toThrow();
    expect(await f.conf()).not.toContain("8.8.8.8");
    expect(() => f.invoke("custom", '["foo.test\\nbar.test"]')).toThrow();
  });
});
