import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { useConfig, useContainerManager } from "./services";

const MAX_UPLOAD = 40 * 1024 * 1024 * 1024;
const MIN_FREE = 512 * 1024 * 1024;
const TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_PREPARED = 1024;

interface PreparedImport {
  workspaceId: string;
  ownerId: string;
  displayName?: string;
  expiresAt: number;
}
interface ImportDependencies {
  dataDir: () => string;
  importWorker: (ownerId: string, bundlePath: string, options: { displayName?: string }) => Promise<unknown>;
}

/** Controlled binary handoff for management MCP worker imports. Archive bytes
 * never enter JSON-RPC or a base64 buffer: the tool mints a short-lived,
 * one-use path on the private management listener, and upload reuses the
 * existing streamed, validating ContainerManager importer. */
export class ManagementImportDomain {
  private readonly prepared = new Map<string, PreparedImport>();
  private readonly activeOwners = new Set<string>();
  constructor(private readonly deps: ImportDependencies = {
    dataDir: () => useConfig().dataDir,
    importWorker: (ownerId, bundlePath, options) => useContainerManager().importWorker(ownerId, bundlePath, options),
  }) {}

  tools() {
    return [{
      name: "imports.prepare",
      group: "exports" as const,
      description: "Prepare a one-use private streaming upload for a worker export bundle.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["ownerId"],
        properties: {
          ownerId: { type: "string", description: "Owner for the newly imported worker." },
          displayName: { type: "string", minLength: 1, maxLength: 100 },
        },
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }];
  }

  async execute(name: string, args: Record<string, unknown>, workspaceId: string) {
    if (name !== "imports.prepare") return { handled: false };
    const ownerId = required(args.ownerId, "ownerId");
    const displayName = optionalName(args.displayName);
    this.expire();
    if (this.prepared.size >= MAX_PREPARED) throw fail(429, "Too many pending import uploads");
    const token = randomUUID();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.prepared.set(token, { workspaceId, ownerId, displayName, expiresAt });
    return { handled: true, result: {
      method: "PUT",
      uploadPath: `/imports/${token}`,
      contentType: "application/x-tar",
      maxBytes: MAX_UPLOAD,
      expiresAt: new Date(expiresAt).toISOString(),
      authentication: "Use the current workspace-bound management bearer credential",
    } };
  }

  async upload(workspaceId: string, token: string, source: Readable, declaredLength?: number) {
    this.expire();
    const prepared = this.prepared.get(token);
    // Consume before any I/O so replay/concurrent reuse fails closed.
    if (!prepared || prepared.workspaceId !== workspaceId) throw fail(404, "Import upload not found or expired");
    this.prepared.delete(token);
    if (this.activeOwners.has(prepared.ownerId)) throw fail(409, "An import is already active for this owner");
    if (Number.isFinite(declaredLength) && declaredLength! > MAX_UPLOAD) throw fail(413, "Worker import bundle is too large");

    const tmpDir = join(this.deps.dataDir(), "tmp", `management-import-${randomUUID()}`);
    const bundle = join(tmpDir, "bundle.tar");
    this.activeOwners.add(prepared.ownerId);
    try {
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const fsInfo = await statfs(tmpDir);
      if (fsInfo.bavail * fsInfo.bsize < MIN_FREE) throw fail(507, "Insufficient temporary storage for import");
      let uploaded = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          uploaded += Buffer.byteLength(chunk);
          callback(uploaded > MAX_UPLOAD ? fail(413, "Worker import bundle is too large") : null, chunk);
        },
      });
      await pipeline(source, limit, createWriteStream(bundle, { mode: 0o600 }));
      if (!uploaded) throw fail(400, "Worker import bundle is empty");
      return await this.deps.importWorker(prepared.ownerId, bundle, { displayName: prepared.displayName });
    } catch (error: any) {
      if (Number.isInteger(error?.statusCode)) throw error;
      const message = error instanceof Error ? error.message : "";
      throw fail(400, /^(Invalid|Unsupported) worker export/.test(message) ? message : "Worker import failed");
    } finally {
      this.activeOwners.delete(prepared.ownerId);
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private expire() {
    const now = Date.now();
    for (const [token, value] of this.prepared) if (value.expiresAt <= now) this.prepared.delete(token);
  }
}

function required(value: unknown, name: string) { if (typeof value !== "string" || !value.trim()) throw fail(400, `${name} is required`); return value.trim(); }
function optionalName(value: unknown) { if (value === undefined) return undefined; const name = required(value, "displayName"); if (name.length > 100) throw fail(400, "displayName must be at most 100 characters"); return name; }
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
