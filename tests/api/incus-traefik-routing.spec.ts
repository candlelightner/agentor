import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { TraefikManager } from "../../orchestrator/server/utils/traefik-manager";
import type { Config } from "../../orchestrator/server/utils/config";

const { parse } = createRequire(join(process.cwd(), "../orchestrator/package.json"))("yaml");
(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

async function fixture(run: (manager: TraefikManager, mappings: any, read: () => Promise<any>) => Promise<void>) {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-traefik-incus-"));
  const worker = { workerId: "vm", userId: "owner", containerName: "agentor-worker-vm" };
  const mappings = {
    domain: [
      { ...worker, id: "vm-http", subdomain: "app", baseDomain: "example.test", path: "/app", protocol: "https", internalPort: 8080 },
      { ...worker, id: "vm-tcp", subdomain: "db", baseDomain: "example.test", path: "", protocol: "tcp", internalPort: 5432 },
      { workerId: "legacy", userId: "owner", containerName: "agentor-worker-legacy", id: "legacy", subdomain: "old", baseDomain: "example.test", path: "", protocol: "http", internalPort: 3000 },
    ],
    port: [{ ...worker, externalPort: 22222, internalPort: 22, type: "localhost" }],
  };
  const manager = new TraefikManager({ dataDir, dashboardSubdomain: "dash", dashboardBaseDomain: "example.test",
    baseDomains: ["example.test"], baseDomainConfigs: [{ domain: "example.test", challengeType: "dns", dnsProvider: "test" }],
  } as Config, { list: () => mappings.domain } as any, { list: () => mappings.port } as any, {} as any, {} as any);
  try { await run(manager, mappings, async () => parse(await readFile(join(dataDir, "traefik-config.yml"), "utf8"))); }
  finally { await rm(dataDir, { recursive: true, force: true }); }
}

test("VM HTTP/TCP targets share one authoritative lookup per render and refresh on the next render", async () => {
  await fixture(async (manager, mappings, read) => {
    let address = "10.20.30.42", reads = 0;
    manager.setWorkerBackendResolver(async (m) => { reads++; return m.workerId === "vm" ? address : m.containerName; });
    await (manager as any).writeTraefikConfig(mappings);
    expect(reads).toBe(2);
    let config = await read();
    expect(config.http.services["http-vm-http"].loadBalancer.servers).toEqual([{ url: "http://10.20.30.42:8080" }]);
    expect(config.tcp.services["tcp-vm-tcp"].loadBalancer.servers).toEqual([{ address: "10.20.30.42:5432" }]);
    expect(config.tcp.services["pm-22222"].loadBalancer.servers).toEqual([{ address: "10.20.30.42:22" }]);
    expect(config.http.routers["http-vm-http"].tls.certResolver).toBe("letsencrypt-dns-test");
    expect(config.http.middlewares["strip-vm-http"].stripPrefix.prefixes).toEqual(["/app"]);
    expect(config.http.routers["http-vm-http"].rule).toBe("Host(`app.example.test`) && PathPrefix(`/app`)");
    address = "10.20.30.43";
    await manager.refreshWorkerBackends();
    config = await read();
    expect(reads).toBe(4);
    expect(config.http.services["http-vm-http"].loadBalancer.servers[0].url).toBe("http://10.20.30.43:8080");
    expect(config.tcp.services["pm-22222"].loadBalancer.servers[0].address).toBe("10.20.30.43:22");
  });
});

test("unavailable VM is unrouted, never Docker-fallback, without disturbing dashboard or legacy mappings", async () => {
  await fixture(async (manager, mappings, read) => {
    for (const unavailable of ["error", "null"]) {
      manager.setWorkerBackendResolver(async (m) => {
        if (m.workerId === "vm") { if (unavailable === "error") throw new Error("Incus observation unavailable"); return null; }
        return m.containerName;
      });
      await (manager as any).writeTraefikConfig(mappings);
      const config = await read();
      expect(config.http.services["http-vm-http"].loadBalancer.servers).toEqual([]);
      expect(config.tcp.services["tcp-vm-tcp"].loadBalancer.servers).toEqual([]);
      expect(config.tcp.services["pm-22222"].loadBalancer.servers).toEqual([]);
      expect(config.http.routers["http-vm-http"].rule).toBe("Host(`app.example.test`) && PathPrefix(`/app`)");
      expect(config.http.services.dashboard.loadBalancer.servers[0].url).toBe("http://agentor-orchestrator:3000");
      expect(config.http.services["http-legacy"].loadBalancer.servers[0].url).toBe("http://agentor-worker-legacy:3000");
    }
  });
});

test("backend coalescing never shares lookups between different mapping owners", async () => {
  await fixture(async (manager, mappings, read) => {
    mappings.domain[0].userId = "foreign";
    manager.setWorkerBackendResolver(async (m) => m.userId === "foreign" ? null : "10.20.30.42");
    await (manager as any).writeTraefikConfig(mappings);
    const config = await read();
    expect(config.http.services["http-vm-http"].loadBalancer.servers).toEqual([]);
    expect(config.tcp.services["tcp-vm-tcp"].loadBalancer.servers[0].address).toBe("10.20.30.42:5432");
  });
});

test("unavailable exact-host and path routes retain precedence over another worker wildcard", async () => {
  await fixture(async (manager, mappings, read) => {
    mappings.domain[2].wildcard = true;
    mappings.domain[2].subdomain = "";
    manager.setWorkerBackendResolver(async (m) => m.workerId === "vm" ? null : m.containerName);
    await (manager as any).writeTraefikConfig(mappings);
    const config = await read();
    expect(config.http.routers["http-vm-http"].rule).toBe("Host(`app.example.test`) && PathPrefix(`/app`)");
    expect(config.http.routers["http-legacy"].priority).toBe(1);
    expect(config.http.services["http-vm-http"].loadBalancer.servers).toEqual([]);
    expect(config.tcp.routers["tcp-vm-tcp"].rule).toBe("HostSNI(`db.example.test`)");
    expect(config.tcp.services["tcp-vm-tcp"].loadBalancer.servers).toEqual([]);
  });
});
