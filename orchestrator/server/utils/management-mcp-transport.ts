import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import type { ManagementMcpStore } from "./management-mcp-store";

const MAX_BODY = 1024 * 1024;

/** Minimal MCP JSON-RPC transport. It is bound to the orchestrator's address on
 * the internal management network only; Docker/Traefik publish no port. Every
 * tool call still passes through workload-identity and live-policy checks. */
export class ManagementMcpTransport {
  private server?: Server;
  constructor(
    private readonly store: ManagementMcpStore,
    private readonly port = Number(
      process.env.AGENTOR_MANAGEMENT_MCP_PORT || 3099,
    ),
  ) {}

  async start(host: string): Promise<void> {
    if (this.server) return;
    this.server = createServer(
      (request, response) => void this.handle(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.port, host, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const downloadMatch = request.url?.match(
      /^\/downloads\/([0-9a-f-]{36})$/i,
    );
    if (request.method === "GET" && downloadMatch) {
      const authorization = request.headers.authorization || "";
      const credential = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
      let opened: Awaited<ReturnType<ManagementMcpStore["openDownload"]>>;
      try {
        opened = await this.store.openDownload(
          credential,
          downloadMatch[1]!,
        );
      } catch (error: any) {
        const status = httpStatus(error);
        return this.send(response, status, {
          error: status >= 500 ? "Download failed" : error.message,
        });
      }

      response.statusCode = 200;
      response.setHeader("Content-Type", opened.contentType);
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeAttachmentName(opened.filename)}"`,
      );
      if (Number.isSafeInteger(opened.size) && opened.size! >= 0)
        response.setHeader("Content-Length", String(opened.size));

      const disconnect = () => {
        if (!response.writableEnded)
          opened.stream.destroy(new Error("Download client disconnected"));
      };
      response.once("close", disconnect);
      try {
        // pipeline preserves source backpressure and destroys both sides on a
        // disconnect. No archive or file content is accumulated in memory.
        await pipeline(opened.stream, response);
        await this.store.auditDownloadTransfer(opened.audit, "success");
      } catch {
        await this.store
          .auditDownloadTransfer(opened.audit, "failure")
          .catch(() => {});
        if (!response.destroyed) response.destroy();
      } finally {
        response.off("close", disconnect);
      }
      return;
    }
    const importMatch = request.url?.match(/^\/imports\/([0-9a-f-]{36})$/i);
    if (request.method === "PUT" && importMatch) {
      const authorization = request.headers.authorization || "";
      const credential = authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      try {
        const upload = parseImportUploadHeaders(request.headers);
        const result = await this.store.uploadImport(credential, importMatch[1]!, request, upload.declaredLength);
        return this.send(response, 201, result);
      } catch (error: any) {
        const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
        return this.send(response, status, { error: status >= 500 ? "Worker import failed" : error.message });
      }
    }
    if (request.method !== "POST" || request.url !== "/mcp")
      return this.send(response, 404, { error: "Not found" });
    const authorization = request.headers.authorization || "";
    const credential = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : undefined;
    try {
      const body = await readJson(request);
      const id = body?.id ?? null;
      if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") {
        await this.authenticate(credential, "invalid-request");
        return this.rpc(response, id, undefined, {
          code: -32600,
          message: "Invalid request",
        });
      }
      if (body.method === "initialize") {
        await this.authenticate(credential, "initialize");
        return this.rpc(response, id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "agentor-management", version: "1" },
        });
      }
      if (body.method === "notifications/initialized") {
        await this.authenticate(credential, "notifications.initialized");
        return this.send(response, 202, null);
      }
      if (body.method === "tools/list") {
        await this.authenticate(credential, "tools.list");
        return this.rpc(response, id, { tools: await this.store.listTools() });
      }
      if (body.method === "tools/call") {
        const name = body.params?.name;
        const result = await this.store.invoke(
          credential,
          name,
          body.params?.arguments || {},
        );
        return this.rpc(response, id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }
      await this.authenticate(credential, "unknown-method");
      return this.rpc(response, id, undefined, {
        code: -32601,
        message: "Method not found",
      });
    } catch (error: any) {
      const status =
        error?.statusCode === 401 ? 401 : error?.statusCode === 403 ? 403 : 400;
      return this.send(response, status, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: status === 401 ? -32001 : -32003,
          message: status === 400 ? "Invalid MCP request" : error.message,
        },
      });
    }
  }

  private async authenticate(credential: unknown, operation: string) {
    try {
      return await this.store.introspect(credential);
    } catch (error) {
      await this.store.auditAuthorizationFailure(operation);
      throw error;
    }
  }

  private rpc(
    response: ServerResponse,
    id: unknown,
    result?: unknown,
    error?: unknown,
  ) {
    return this.send(response, 200, {
      jsonrpc: "2.0",
      id,
      ...(error ? { error } : { result }),
    });
  }
  private send(response: ServerResponse, status: number, value: unknown) {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
}

function httpStatus(error: any): number {
  const status = error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 400;
}

function safeAttachmentName(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "download"
    : "download";
}

export function parseImportUploadHeaders(headers: IncomingMessage["headers"]) {
  const contentType = Array.isArray(headers["content-type"]) ? headers["content-type"][0] : headers["content-type"];
  if ((contentType || "").split(";", 1)[0].trim().toLowerCase() !== "application/x-tar")
    throw Object.assign(new Error("Content-Type must be application/x-tar"), { statusCode: 415 });
  const raw = headers["content-length"];
  if (raw === undefined) return { declaredLength: undefined };
  if (Array.isArray(raw) || !/^\d+$/.test(raw)) throw Object.assign(new Error("Invalid Content-Length"), { statusCode: 400 });
  const declaredLength = Number(raw);
  if (!Number.isSafeInteger(declaredLength)) throw Object.assign(new Error("Invalid Content-Length"), { statusCode: 400 });
  return { declaredLength };
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY) throw new Error("Request too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
