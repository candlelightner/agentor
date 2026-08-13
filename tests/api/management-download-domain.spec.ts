import { createServer, get as httpGet } from "node:http";
import { Readable } from "node:stream";
import { expect, test } from "@playwright/test";
import { ManagementDownloadDomain } from "../../orchestrator/server/utils/management-download-domain";
import { ManagementMcpTransport } from "../../orchestrator/server/utils/management-mcp-transport";

const item = (owner = "owner-a") => ({
  id: "workspace-a",
  workerId: "workspace-a",
  userId: owner,
  displayName: "Workspace A",
  backend: "volume" as const,
  state: "stopped" as const,
  size: null,
  storageRef: "workspace-a-volume",
});

const job = (status: "running" | "succeeded" = "succeeded") => ({
  id: "export-a",
  userId: "owner-a",
  workerId: "workspace-a",
  includeRootfs: false,
  status,
  phase: status === "succeeded" ? ("complete" as const) : ("workspace" as const),
  progress: status === "succeeded" ? 100 : 50,
  bytesProcessed: 10,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  filename: "worker export.tar",
});

test("workspace handoffs bind identity, owner, and exact normalized paths", async () => {
  let current = item();
  const opened: unknown[] = [];
  const domain = new ManagementDownloadDomain({
    now: () => 1_000,
    listWorkspaces: async () => [current],
    downloadWorkspace: async (workspace, paths) => {
      opened.push({ owner: workspace.userId, paths });
      return {
        kind: "file", stream: Readable.from("large-payload"),
        entry: { name: "large payload.bin", path: paths[0]!, type: "file", size: 4_000_000,
          mtime: new Date(0).toISOString(), mode: "0644", owner: "1000", group: "1000" },
      } as any;
    },
    getExportJob: async () => undefined,
    openExportArtifact: async () => { throw new Error("unexpected"); },
  });
  const prepared: any = await domain.execute("workspaces.download", {
    workspaceId: "workspace-a", paths: ["folder/./file.bin"],
  }, "admin-workspace");
  expect(prepared.result).toMatchObject({ method: "GET",
    authentication: "Use the current workspace-bound management bearer credential" });
  expect(prepared.result.downloadPath).toMatch(/^\/downloads\/[0-9a-f-]{36}$/);
  expect(JSON.stringify(prepared.result)).not.toMatch(/\/api\/workspaces|base64|cookie/i);
  const token = prepared.result.downloadPath.split("/").pop();
  await expect(domain.open("other-workspace", token, () => {})).rejects.toMatchObject({ statusCode: 404 });
  const download = await domain.open("admin-workspace", token, (capability) => expect(capability).toBe("storage"));
  expect(download).toMatchObject({ contentType: "application/octet-stream", filename: "large_payload.bin", size: 4_000_000,
    audit: { workspaceId: "admin-workspace", kind: "workspace", resourceId: "workspace-a", ownerId: "owner-a" } });
  expect(opened).toEqual([{ owner: "owner-a", paths: ["folder/file.bin"] }]);
  expect(Buffer.concat(await collect(download.stream)).toString()).toBe("large-payload");
  await expect(domain.open("admin-workspace", token, () => {})).rejects.toMatchObject({ statusCode: 404 });

  const stale: any = await domain.execute("workspaces.download", { workspaceId: "workspace-a", path: "file.bin" }, "admin-workspace");
  current = item("owner-b");
  await expect(domain.open("admin-workspace", stale.result.downloadPath.split("/").pop(), () => {})).rejects.toMatchObject({ statusCode: 404 });
  expect(opened).toHaveLength(1);
});

test("capability is rechecked before consumption and expiry fails closed", async () => {
  let now = 1_000;
  const domain = new ManagementDownloadDomain({
    now: () => now,
    listWorkspaces: async () => [item()],
    downloadWorkspace: async () => ({ kind: "zip", stream: Readable.from("zip") }),
    getExportJob: async () => undefined,
    openExportArtifact: async () => { throw new Error("unexpected"); },
  });
  const prepared: any = await domain.execute("workspaces.download", { workspaceId: "workspace-a", paths: [""] }, "admin-workspace");
  const token = prepared.result.downloadPath.split("/").pop();
  await expect(domain.open("admin-workspace", token, () => {
    throw Object.assign(new Error("Tool denied by policy"), { statusCode: 403 });
  })).rejects.toMatchObject({ statusCode: 403 });
  await expect(domain.open("admin-workspace", token, () => {})).resolves.toMatchObject({
    contentType: "application/zip", filename: "workspace-download.zip",
  });
  const expiring: any = await domain.execute("workspaces.download", { workspaceId: "workspace-a", path: "file" }, "admin-workspace");
  now += 10 * 60 * 1_000 + 1;
  await expect(domain.open("admin-workspace", expiring.result.downloadPath.split("/").pop(), () => {})).rejects.toMatchObject({ statusCode: 404 });
});

test("completed export handoffs recheck job ownership", async () => {
  let current: any = job("running");
  let artifactOpens = 0;
  const domain = new ManagementDownloadDomain({
    now: () => 1_000, listWorkspaces: async () => [],
    downloadWorkspace: async () => { throw new Error("unexpected"); },
    getExportJob: async (id) => id === current.id ? current : undefined,
    openExportArtifact: async () => { artifactOpens++; return { stream: Readable.from("tar"), size: 3, filename: "worker export.tar" }; },
  });
  await expect(domain.execute("exports.download", { jobId: current.id }, "admin-workspace"))
    .resolves.toMatchObject({ handled: true, result: { ready: false, status: "running" } });
  current = job();
  const prepared: any = await domain.execute("exports.download", { jobId: current.id }, "admin-workspace");
  expect(prepared.result).toMatchObject({ ready: true, method: "GET", filename: "worker_export.tar" });
  current = { ...current, userId: "owner-b" };
  await expect(domain.open("admin-workspace", prepared.result.downloadPath.split("/").pop(),
    (capability) => expect(capability).toBe("exports"))).rejects.toMatchObject({ statusCode: 404 });
  expect(artifactOpens).toBe(0);
});

test("unexpected workspace source errors are sanitized", async () => {
  const domain = new ManagementDownloadDomain({
    now: () => 1_000,
    listWorkspaces: async () => [item()],
    downloadWorkspace: async () => {
      throw new Error("Docker socket /private/host/path exploded");
    },
    getExportJob: async () => undefined,
    openExportArtifact: async () => { throw new Error("unexpected"); },
  });
  const prepared: any = await domain.execute("workspaces.download", {
    workspaceId: "workspace-a", path: "file",
  }, "admin-workspace");
  const error = await domain
    .open("admin-workspace", prepared.result.downloadPath.split("/").pop(), () => {})
    .catch((value) => value);
  expect(error).toMatchObject({ statusCode: 500, message: "Workspace download failed" });
  expect(String(error)).not.toMatch(/private|Docker socket|exploded/);
});

test("private transport streams with headers and audits without a session", async () => {
  const port = await unusedPort();
  const calls: unknown[] = [];
  const transport = new ManagementMcpTransport({
    openDownload: async (credential: unknown, token: string) => {
      calls.push({ credential, token });
      return { stream: Readable.from(["first-", "second"]), contentType: "application/octet-stream",
        filename: "payload.bin", size: 12,
        audit: { workspaceId: "admin-workspace", kind: "workspace", resourceId: "workspace-a", ownerId: "owner-a" } };
    },
    auditDownloadTransfer: async (audit: unknown, outcome: string) => calls.push({ audit, outcome }),
  } as any, port);
  await transport.start("127.0.0.1");
  try {
    const token = "01234567-89ab-4cde-8fab-0123456789ab";
    const response = await fetch(`http://127.0.0.1:${port}/downloads/${token}`, {
      headers: { authorization: "Bearer current-credential" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="payload.bin"');
    expect(response.headers.get("content-length")).toBe("12");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("first-second");
    expect(calls).toEqual([
      { credential: "current-credential", token },
      { audit: { workspaceId: "admin-workspace", kind: "workspace", resourceId: "workspace-a", ownerId: "owner-a" }, outcome: "success" },
    ]);
    expect((await fetch(`http://127.0.0.1:${port}/downloads/${token}/extra`)).status).toBe(404);
  } finally { await transport.stop(); }
});

test("private transport destroys the source on client disconnect", async () => {
  const port = await unusedPort();
  let sourceClosed = false;
  const outcomes: string[] = [];
  const source = new Readable({ read() { this.push(Buffer.alloc(64 * 1024, 1)); } });
  source.once("close", () => { sourceClosed = true; });
  const transport = new ManagementMcpTransport({
    openDownload: async () => ({ stream: source, contentType: "application/octet-stream", filename: "large.bin",
      audit: { workspaceId: "admin-workspace", kind: "workspace", resourceId: "workspace-a", ownerId: "owner-a" } }),
    auditDownloadTransfer: async (_audit: unknown, outcome: string) => { outcomes.push(outcome); },
  } as any, port);
  await transport.start("127.0.0.1");
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpGet(`http://127.0.0.1:${port}/downloads/01234567-89ab-4cde-8fab-0123456789ab`,
        { headers: { authorization: "Bearer credential" } }, (response) => {
          response.once("data", () => { request.destroy(); resolve(); });
        });
      request.once("error", (error: NodeJS.ErrnoException) => { if (error.code !== "ECONNRESET") reject(error); });
    });
    await expect.poll(() => ({ sourceClosed, outcomes }), { timeout: 5_000 })
      .toEqual({ sourceClosed: true, outcomes: ["failure"] });
  } finally { await transport.stop(); }
});

async function collect(stream: Readable) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return chunks; }
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve())); return address.port;
}
