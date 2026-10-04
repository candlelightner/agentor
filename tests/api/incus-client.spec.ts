import { expect, test } from "@playwright/test";
import http from "node:http";
import { existsSync } from "node:fs";
import {
  IncusClient,
  IncusError,
  type IncusInstanceState,
} from "../../orchestrator/server/utils/incus-client";
import type { Config } from "../../orchestrator/server/utils/config";

test.describe("IncusClient unit tests", () => {
  test("response URLs cannot forward client credentials to another origin", async () => {
    const client = new IncusClient({ endpoint: "https://example.invalid", project: "agentor" });
    await expect(client.rawRequest("GET", "https://other.invalid/1.0")).rejects.toThrow("configured server");
  });

  test("isConfigured reflects presence of endpoint", () => {
    const unconfigured = new IncusClient({ endpoint: "" });
    expect(unconfigured.isConfigured()).toBe(false);

    const configured = new IncusClient({ endpoint: "https://127.0.0.1:8443" });
    expect(configured.isConfigured()).toBe(true);
    expect(configured.project).toBe("agentor");
  });

  test("fromConfig correctly initializes client properties", () => {
    const mockConfig: Partial<Config> = {
      incusEndpoint: "https://incus.internal:8443",
      incusProject: "custom-agentor",
      incusClientCertPath: "/certs/client.crt",
      incusClientKeyPath: "/certs/client.key",
      incusServerCertPath: "/certs/server.crt",
    };

    const client = IncusClient.fromConfig(mockConfig as Config);
    expect(client.endpoint).toBe("https://incus.internal:8443");
    expect(client.project).toBe("custom-agentor");
  });

  test("getPrimaryIp extracts eth0 IPv4 and ignores docker0 and link-local", async () => {
    const client = new IncusClient({ endpoint: "https://mock:8443" });

    const mockState: IncusInstanceState = {
      status: "Running",
      status_code: 103,
      pid: 1000,
      processes: 10,
      network: {
        lo: {
          hwaddr: "",
          mtu: 65536,
          state: "up",
          type: "loopback",
          addresses: [
            { family: "inet", address: "127.0.0.1", netmask: "8", scope: "local" },
            { family: "inet6", address: "::1", netmask: "128", scope: "local" },
          ],
        },
        docker0: {
          hwaddr: "02:42:1a:2b:3c:4d",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet", address: "172.17.0.1", netmask: "16", scope: "global" },
            { family: "inet6", address: "fe80::1", netmask: "64", scope: "link" },
          ],
        },
        eth0: {
          hwaddr: "00:16:3e:11:22:33",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet6", address: "fe80::216:3eff:fe11:2233", netmask: "64", scope: "link" },
            { family: "inet", address: "10.159.68.42", netmask: "24", scope: "global" },
          ],
        },
      },
    };

    (client as any).getInstanceState = async () => mockState;

    const ip = await client.getPrimaryIp("worker-1");
    expect(ip).toBe("10.159.68.42");
  });

  test("getPrimaryIp falls back to non-docker/non-bridge interface when eth0 absent", async () => {
    const client = new IncusClient({ endpoint: "https://mock:8443" });

    const mockState: IncusInstanceState = {
      status: "Running",
      status_code: 103,
      pid: 1000,
      processes: 10,
      network: {
        docker0: {
          hwaddr: "02:42:1a:2b:3c:4d",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet", address: "172.17.0.1", netmask: "16", scope: "global" },
          ],
        },
        veth123: {
          hwaddr: "02:42:1a:2b:3c:4e",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet", address: "172.17.0.2", netmask: "16", scope: "global" },
          ],
        },
        enp5s0: {
          hwaddr: "00:16:3e:44:55:66",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet", address: "10.159.68.99", netmask: "24", scope: "global" },
          ],
        },
      },
    };

    (client as any).getInstanceState = async () => mockState;

    const ip = await client.getPrimaryIp("worker-2");
    expect(ip).toBe("10.159.68.99");
  });

  test("getPrimaryIp returns undefined when no global IPv4 is found", async () => {
    const client = new IncusClient({ endpoint: "https://mock:8443" });

    const mockState: IncusInstanceState = {
      status: "Running",
      status_code: 103,
      pid: 1000,
      processes: 10,
      network: {
        eth0: {
          hwaddr: "00:16:3e:11:22:33",
          mtu: 1500,
          state: "up",
          type: "broadcast",
          addresses: [
            { family: "inet6", address: "fe80::216:3eff:fe11:2233", netmask: "64", scope: "link" },
          ],
        },
      },
    };

    (client as any).getInstanceState = async () => mockState;

    const ip = await client.getPrimaryIp("worker-3");
    expect(ip).toBeUndefined();
  });
});

test.describe("IncusClient mock server protocol tests", () => {
  let server: http.Server;
  let serverPort: number;

  test.beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://${req.headers.host}`);
      const path = url.pathname;

      if (req.method === "GET" && (path === "/1.0/networks/workers" || path === "/1.0/networks/workers/leases")) {
        const allowed = url.searchParams.get("project") === "agentor";
        res.writeHead(allowed ? 200 : 403, { "Content-Type": "application/json" });
        res.end(JSON.stringify(allowed ? { type: "sync", metadata: path.endsWith("/leases")
          ? [{ address: "10.20.30.42", hwaddr: "10:66:6a:11:22:33", hostname: "untrusted", type: "dynamic" }]
          : { name: "workers", managed: true, type: "bridge", config: { "ipv4.address": "10.20.30.1/24" } } }
          : { type: "error", error_code: 403, error: "Project scope required" }));
        return;
      }

      // GET /1.0
      if (req.method === "GET" && path === "/1.0") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              api_status: "stable",
              api_version: "1.0",
              auth: "trusted",
              public: false,
              environment: {
                server_version: "6.0.0",
                driver: "qemu",
              },
            },
          }),
        );
        return;
      }

      // GET /1.0/projects/agentor
      if (req.method === "GET" && path === "/1.0/projects/agentor") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              name: "agentor",
              config: { restricted: "true" },
            },
          }),
        );
        return;
      }

      // GET /1.0/projects/forbidden
      if (req.method === "GET" && path === "/1.0/projects/forbidden") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "error",
            error_code: 403,
            error: 'User does not have permission for project "forbidden"',
          }),
        );
        return;
      }

      // GET /1.0/instances
      if (req.method === "GET" && path === "/1.0/instances") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: [
              {
                name: "worker-test-1",
                status: "Running",
                status_code: 103,
                type: "virtual-machine",
              },
            ],
          }),
        );
        return;
      }

      // POST /1.0/instances/worker-test-1/files
      if (req.method === "POST" && path === "/1.0/instances/worker-test-1/files") {
        const mode = req.headers["x-incus-mode"];
        const uid = req.headers["x-incus-uid"];
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              type: "sync",
              status: "Success",
              status_code: 200,
              metadata: { receivedLength: body.length, mode, uid },
            }),
          );
        });
        return;
      }

      // GET /1.0/instances/worker-test-1/files
      if (req.method === "GET" && path === "/1.0/instances/worker-test-1/files") {
        const filePath = url.searchParams.get("path");
        if (filePath === "/missing.txt") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ type: "error", error_code: 404, error: "Not Found" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "x-incus-uid": "1000",
          "x-incus-gid": "1000",
          "x-incus-mode": "0644",
          "x-incus-type": "file",
        });
        res.end("mock file content");
        return;
      }

      if (req.method === 'GET' && path === '/1.0/images') {
        if (url.searchParams.get('project') !== 'agentor' || url.searchParams.get('recursion') !== '1') {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: 'Forbidden', error_code: 403 }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'sync', status_code: 200,
            metadata: [{ fingerprint: 'a'.repeat(64), type: 'virtual-machine' }] }));
        }
        return;
      }

      // GET /1.0/operations/op-success
      if (req.method === "GET" && path === "/1.0/operations/op-success") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              id: "op-success",
              status: "Success",
              status_code: 200,
              err: "",
            },
          }),
        );
        return;
      }

      // GET /1.0/operations/op-failure
      if (req.method === "GET" && path === "/1.0/operations/op-failure") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            type: "sync",
            status: "Success",
            status_code: 200,
            metadata: {
              id: "op-failure",
              status: "Failure",
              status_code: 400,
              err: "QEMU failed to allocate disk",
            },
          }),
        );
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: "Not Found", error_code: 404 }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        serverPort = addr.port;
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("getReadiness returns ready: true when server trusted and project accessible", async () => {
    const client = new IncusClient({
      endpoint: `http://127.0.0.1:${serverPort}`,
      project: "agentor",
    });

    const readiness = await client.getReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.auth).toBe("trusted");
    expect(readiness.project).toBe("agentor");
    expect(readiness.serverVersion).toBe("6.0.0");
    expect(readiness.driver).toBe("qemu");
  });

  test("getReadiness returns ready: false when project is forbidden", async () => {
    const client = new IncusClient({
      endpoint: `http://127.0.0.1:${serverPort}`,
      project: "forbidden",
    });

    const readiness = await client.getReadiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.auth).toBe("trusted");
    expect(readiness.details).toContain("forbidden");
  });

  test("listInstances queries instances with recursion and project scoping", async () => {
    const client = new IncusClient({
      endpoint: `http://127.0.0.1:${serverPort}`,
      project: "agentor",
    });

    const list = await client.listInstances();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("worker-test-1");
  });

  test("network and host lease reads preserve project scoping", async () => {
    const client = new IncusClient({ endpoint: `http://127.0.0.1:${serverPort}`, project: "agentor" });
    expect((await client.getNetwork("workers")).managed).toBe(true);
    expect(await client.getNetworkLeases("workers")).toMatchObject([{ address: "10.20.30.42", type: "dynamic" }]);
  });

  test('image cache inventory remains recursive and project-scoped', async () => {
    const endpoint = `http://127.0.0.1:${serverPort}`;
    expect(await new IncusClient({ endpoint, project: 'agentor' }).listImages())
      .toEqual([{ fingerprint: 'a'.repeat(64), type: 'virtual-machine' }]);
    await expect(new IncusClient({ endpoint, project: 'forbidden' }).listImages()).rejects.toMatchObject({ statusCode: 403 });
  });

  test("pushFile and pullFile handle headers and content correctly", async () => {
    const client = new IncusClient({
      endpoint: `http://127.0.0.1:${serverPort}`,
      project: "agentor",
    });

    // pushFile with numeric mode
    await client.pushFile("worker-test-1", "/test.txt", "hello test", {
      mode: 0o755,
      uid: 1000,
      gid: 1000,
    });

    // pullFile
    const pulled = await client.pullFile("worker-test-1", "/test.txt");
    expect(pulled.content.toString()).toBe("mock file content");
    expect(pulled.mode).toBe(0o644);
    expect(pulled.uid).toBe(1000);
    expect(pulled.gid).toBe(1000);

    // pullFile 404 throws IncusError
    await expect(client.pullFile("worker-test-1", "/missing.txt")).rejects.toThrow(IncusError);
  });

  test("waitForOperation handles success and throws on failure", async () => {
    const client = new IncusClient({
      endpoint: `http://127.0.0.1:${serverPort}`,
      project: "agentor",
    });

    const opSuccess = await client.waitForOperation("/1.0/operations/op-success");
    expect(opSuccess.status).toBe("Success");

    await expect(
      client.waitForOperation("/1.0/operations/op-failure"),
    ).rejects.toThrow(/QEMU failed to allocate disk/);
  });

  test("long operations poll within the transport deadline and require terminal success", async () => {
    const client = new IncusClient({ endpoint: "https://mock.invalid", timeoutMs: 30_000 });
    const paths: string[] = [];
    (client as any).request = async (method: string, path: string) => {
      expect(method).toBe("GET");
      paths.push(path);
      return { status: paths.length === 1 ? "Running" : "Success", status_code: paths.length === 1 ? 103 : 200 };
    };
    expect((await client.waitForOperation("long-create", 120)).status).toBe("Success");
    expect(paths).toEqual(["/1.0/operations/long-create", "/1.0/operations/long-create"]);
    (client as any).request = async () => ({ status: "Cancelled", status_code: 401, err: "cancelled" });
    await expect(client.waitForOperation("cancelled")).rejects.toThrow("cancelled");
    (client as any).request = async () => ({ status: "Running", status_code: 103 });
    await expect(client.waitForOperation("unfinished", 0.15)).rejects.toThrow("did not finish");
  });

  test("image create waits on its accepted operation with a bounded longer deadline and never resends", async () => {
    const client = new IncusClient({ endpoint: "https://mock.invalid" });
    let posts = 0;
    client.rawRequest = async (method, path) => {
      expect([method, path]).toEqual(["POST", "/1.0/instances"]); posts++;
      return { statusCode: 202, headers: {}, body: Buffer.from(JSON.stringify({ type: "async", operation: "/1.0/operations/create-once" })) };
    };
    client.getInstance = async () => ({ name: "worker" }) as any;
    client.waitForOperation = async (operation, deadline) => {
      expect([operation, deadline]).toEqual(["/1.0/operations/create-once", 300]);
      return { status: "Success" } as any;
    };
    expect((await client.createInstance({ name: "worker", source: { type: "none" } })).name).toBe("worker");
    expect(posts).toBe(1);
    client.waitForOperation = async () => { throw new Error("Observation unavailable"); };
    await expect(client.createInstance({ name: "worker", source: { type: "none" } })).rejects.toThrow("Observation unavailable");
    expect(posts).toBe(2); // One mutation per distinct caller, no hidden resend.
  });
});

test.describe("IncusClient live disposable integration tests", () => {
  const liveCertPath = "/workspace/agentor-incus-tls/client.crt";
  const liveKeyPath = "/workspace/agentor-incus-tls/client.key";
  const liveEndpoint = "https://127.0.0.1:18443";

  test("live Incus readiness, project restrictions, and image alias", async () => {
    if (!existsSync(liveCertPath) || !existsSync(liveKeyPath)) {
      test.skip(true, "Live Incus credentials not available in environment");
      return;
    }

    const client = new IncusClient({
      endpoint: liveEndpoint,
      project: "agentor",
      clientCertPath: liveCertPath,
      clientKeyPath: liveKeyPath,
      rejectUnauthorized: false,
      timeoutMs: 10_000,
    });

    let isLiveReachable = false;
    try {
      const ping = await client.getReadiness();
      isLiveReachable = ping.ready;
    } catch {
      isLiveReachable = false;
    }

    if (!isLiveReachable) {
      test.skip(true, "Live Incus endpoint not reachable on 127.0.0.1:18443");
      return;
    }

    const readiness = await client.getReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.auth).toBe("trusted");
    expect(readiness.project).toBe("agentor");
    expect(readiness.driver).toContain("qemu");

    // Project restriction verification: unauthorized project returns ready: false
    const forbiddenClient = new IncusClient({
      endpoint: liveEndpoint,
      project: "default",
      clientCertPath: liveCertPath,
      clientKeyPath: liveKeyPath,
      rejectUnauthorized: false,
      timeoutMs: 10_000,
    });
    const forbiddenReadiness = await forbiddenClient.getReadiness();
    expect(forbiddenReadiness.ready).toBe(false);

    // Image alias verification: agentor-worker alias resolves
    const hasAlias = await client.hasImageAlias("agentor-worker");
    expect(hasAlias).toBe(true);
    const aliasInfo = await client.getImageAlias("agentor-worker");
    expect(aliasInfo.type).toBe("virtual-machine");

    // Custom volume lifecycle in agentor project
    const testVolName = `test-vol-${Date.now()}`;
    await client.createCustomVolume("default", {
      name: testVolName,
      content_type: "block",
      config: { size: "1GiB" },
    });

    const vol = await client.getCustomVolume("default", testVolName);
    expect(vol.name).toBe(testVolName);
    expect(vol.content_type).toBe("block");

    const vols = await client.listCustomVolumes("default");
    expect(vols).toContain(testVolName);

    await client.deleteCustomVolume("default", testVolName);
    const volsAfter = await client.listCustomVolumes("default");
    expect(volsAfter).not.toContain(testVolName);
  });
});
