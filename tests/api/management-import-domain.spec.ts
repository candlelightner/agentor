import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createServer } from "node:net";
import { ManagementImportDomain } from "../../orchestrator/server/utils/management-import-domain";
import { ManagementMcpTransport, parseImportUploadHeaders } from "../../orchestrator/server/utils/management-mcp-transport";
import { isCleanupEligibleStaging } from "../../orchestrator/server/utils/storage-visibility";

test("management import prepares a private one-use streamed handoff", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-management-import-"));
  const calls: unknown[] = [];
  const domain = new ManagementImportDomain({
    dataDir: () => dataDir,
    importWorker: async (ownerId, path, options) => {
      calls.push({ ownerId, bytes: await readFile(path, "utf8"), options });
      return { id: "imported-worker", userId: ownerId };
    },
  });
  try {
    const prepared: any = await domain.execute("imports.prepare", { ownerId: "owner-a", displayName: "restored" }, "admin-workspace");
    expect(prepared.handled).toBe(true);
    expect(prepared.result).toMatchObject({ method: "PUT", contentType: "application/x-tar" });
    const token = prepared.result.uploadPath.split("/").pop();
    await expect(domain.upload("other-workspace", token, Readable.from("bundle"), 6)).rejects.toMatchObject({ statusCode: 404 });
    // Binding failures reveal nothing and do not make another identity's token usable.
    const next: any = await domain.execute("imports.prepare", { ownerId: "owner-a", displayName: "restored" }, "admin-workspace");
    const nextToken = next.result.uploadPath.split("/").pop();
    await expect(domain.upload("admin-workspace", nextToken, Readable.from("bundle"), 6)).resolves.toMatchObject({ id: "imported-worker" });
    expect(calls).toEqual([{ ownerId: "owner-a", bytes: "bundle", options: { displayName: "restored" } }]);
    await expect(domain.upload("admin-workspace", nextToken, Readable.from("again"), 5)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("management import tool is mutating, bounded, and requires an owner", async () => {
  const domain = new ManagementImportDomain({ dataDir: () => tmpdir(), importWorker: async () => ({}) });
  expect(domain.tools()[0]).toMatchObject({ name: "imports.prepare", group: "exports", annotations: { readOnlyHint: false, openWorldHint: false } });
  await expect(domain.execute("imports.prepare", {}, "admin-workspace")).rejects.toMatchObject({ statusCode: 400 });
});

test("management import transport accepts only canonical tar uploads", () => {
  expect(parseImportUploadHeaders({ "content-type": "application/x-tar; charset=binary", "content-length": "12" })).toEqual({ declaredLength: 12 });
  expect(parseImportUploadHeaders({ "content-type": "application/x-tar" })).toEqual({ declaredLength: undefined });
  expect(() => parseImportUploadHeaders({ "content-type": "application/octet-stream" })).toThrow("Content-Type must be application/x-tar");
  expect(() => parseImportUploadHeaders({ "content-type": "application/x-tar", "content-length": "-1" })).toThrow("Invalid Content-Length");
});

test("management import staging participates in conservative stale cleanup", () => {
  expect(isCleanupEligibleStaging("management-import-4c489aec")).toBe(true);
  expect(isCleanupEligibleStaging("unrelated-user-directory")).toBe(false);
});

test("management import HTTP handoff enforces media type and forwards a stream", async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const calls: unknown[] = [];
  const transport = new ManagementMcpTransport({
    uploadImport: async (credential: unknown, token: string, source: Readable, declaredLength?: number) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      calls.push({ credential, token, declaredLength, body: Buffer.concat(chunks).toString("utf8") });
      return { id: "imported" };
    },
  } as any, port);
  await transport.start("127.0.0.1");
  try {
    const token = "01234567-89ab-4cde-8fab-0123456789ab";
    const wrongType = await fetch(`http://127.0.0.1:${port}/imports/${token}`, { method: "PUT", headers: { authorization: "Bearer credential", "content-type": "application/octet-stream" }, body: "bundle" });
    expect(wrongType.status).toBe(415);
    const uploaded = await fetch(`http://127.0.0.1:${port}/imports/${token}`, { method: "PUT", headers: { authorization: "Bearer credential", "content-type": "application/x-tar" }, body: "bundle" });
    expect(uploaded.status).toBe(201);
    expect(await uploaded.json()).toEqual({ id: "imported" });
    expect(calls).toEqual([{ credential: "credential", token, declaredLength: 6, body: "bundle" }]);
    expect((await fetch(`http://127.0.0.1:${port}/imports/${token}/extra`, { method: "PUT", headers: { "content-type": "application/x-tar" }, body: "bundle" })).status).toBe(404);
  } finally {
    await transport.stop();
  }
});

test("management import rejects invalid streams and always removes staging", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "agentor-management-import-errors-"));
  const domain = new ManagementImportDomain({
    dataDir: () => dataDir,
    importWorker: async () => { throw new Error("tar unexpectedly exploded with /private/path"); },
  });
  try {
    const empty: any = await domain.execute("imports.prepare", { ownerId: "owner-a" }, "admin-workspace");
    await expect(domain.upload("admin-workspace", empty.result.uploadPath.split("/").pop(), Readable.from([]), 0)).rejects.toMatchObject({ statusCode: 400, message: "Worker import bundle is empty" });
    const malformed: any = await domain.execute("imports.prepare", { ownerId: "owner-a" }, "admin-workspace");
    await expect(domain.upload("admin-workspace", malformed.result.uploadPath.split("/").pop(), Readable.from("bad"), 3)).rejects.toMatchObject({ statusCode: 400, message: "Worker import failed" });
    const tooLarge: any = await domain.execute("imports.prepare", { ownerId: "owner-a" }, "admin-workspace");
    await expect(domain.upload("admin-workspace", tooLarge.result.uploadPath.split("/").pop(), Readable.from("ignored"), tooLarge.result.maxBytes + 1)).rejects.toMatchObject({ statusCode: 413 });
    const broken: any = await domain.execute("imports.prepare", { ownerId: "owner-a" }, "admin-workspace");
    const source = new Readable({ read() { this.destroy(new Error("client disconnected")); } });
    await expect(domain.upload("admin-workspace", broken.result.uploadPath.split("/").pop(), source)).rejects.toMatchObject({ statusCode: 400, message: "Worker import failed" });
    expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
