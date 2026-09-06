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
  private servers = new Map<string, Server>();
  constructor(
    private readonly store: ManagementMcpStore,
    private readonly port = Number(
      process.env.AGENTOR_MANAGEMENT_MCP_PORT || 3099,
    ),
  ) {}

  async start(host: string): Promise<void> {
    if (this.servers.has(host)) return;
    const server = createServer(
      (request, response) => void this.handle(request, response),
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, host, () => {
        server.off("error", reject);
        this.servers.set(host, server);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const downloadMatch = request.url?.match(/^\/downloads\/([0-9a-f-]{36})$/i);
    if (request.method === "GET" && downloadMatch) {
      const authorization = request.headers.authorization || "";
      const credential = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
      let opened: Awaited<ReturnType<ManagementMcpStore["openDownload"]>>;
      try {
        opened = await this.store.openDownload(credential, downloadMatch[1]!);
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
      const credential = authorization.startsWith("Bearer ")
        ? authorization.slice(7)
        : undefined;
      try {
        const upload = parseImportUploadHeaders(request.headers);
        const result = await this.store.uploadImport(
          credential,
          importMatch[1]!,
          request,
          upload.declaredLength,
        );
        return this.send(response, 201, result);
      } catch (error: any) {
        const status = Number.isInteger(error?.statusCode)
          ? error.statusCode
          : 400;
        return this.send(response, status, {
          error: status >= 500 ? "Worker import failed" : error.message,
        });
      }
    }
    if (request.method !== "POST" || request.url !== "/mcp")
      return this.send(response, 404, { error: "Not found" });
    const authorization = request.headers.authorization || "";
    const credential = authorization.startsWith("Bearer ")
      ? authorization.slice(7)
      : undefined;
    let rpcId: unknown = null;
    let hasRpcId = false;
    let isToolCall = false;
    try {
      const body = await readJson(request);
      const id = body?.id ?? null;
      rpcId = id;
      hasRpcId =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        Object.hasOwn(body, "id");
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
        const identity = await this.authenticate(credential, "tools.list");
        return this.rpc(response, id, {
          tools: await this.store.listTools(identity),
        });
      }
      if (body.method === "tools/call") {
        isToolCall = true;
        const name = body.params?.name;
        const result = await this.store.invoke(
          credential,
          name,
          body.params?.arguments || {},
        );
        return this.rpc(response, id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          // MCP structured content must be a JSON object. Several list tools
          // return arrays from their service layer; wrap those results so MCP
          // clients such as Hermes can validate the response consistently.
          structuredContent: structuredContent(result),
          // Although optional in the MCP schema, some clients (notably
          // Hermes) access this attribute unconditionally on CallToolResult.
          isError: false,
        });
      }
      await this.authenticate(credential, "unknown-method");
      return this.rpc(response, id, undefined, {
        code: -32601,
        message: "Method not found",
      });
    } catch (error: any) {
      const status = Number.isInteger(error?.statusCode)
        ? error.statusCode
        : 500;
      // Once a JSON-RPC request has been parsed, tool/application failures are
      // JSON-RPC errors, not HTTP transport failures. Returning HTTP 400 with
      // id:null caused the stdio bridge to wait for the original request until
      // its client-side timeout instead of surfacing validation errors.
      // A parsed JSON-RPC request must always receive a response carrying the
      // same id.  In particular, never turn authentication/authorization
      // failures into id:null responses: stdio MCP clients quite correctly
      // ignore those as unrelated and would leave the original call pending.
      if (hasRpcId && isToolCall) {
        const message = safeToolErrorMessage(status, error);
        const diagnostic = safeToolDiagnostic(error);
        return this.rpc(response, rpcId, {
          content: [{ type: "text", text: message }],
          structuredContent: {
            error: {
              message,
              statusCode: status,
              ...(safeDiagnosticCode(error?.code)
                ? { code: error.code }
                : {}),
              ...(diagnostic ? { diagnostic } : {}),
            },
          },
          isError: true,
        });
      }
      if (hasRpcId)
        return this.rpc(response, rpcId, undefined, {
          code: -32000,
          message:
            status === 404
              ? "Resource not found"
              : status === 401
                ? "Unauthorized"
                : status === 403
                  ? "Forbidden"
                  : error?.message || "Management tool failed",
          data: {
            statusCode: status,
          },
        });
      const httpStatus = [400, 401, 403, 404].includes(status) ? status : 500;
      return this.send(response, httpStatus, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: status === 401 ? -32001 : -32003,
          message:
            httpStatus === 400
              ? "Invalid MCP request"
              : httpStatus === 401
                ? "Unauthorized"
                : httpStatus === 404
                  ? "Resource not found"
                  : "Forbidden",
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

function safeToolErrorMessage(status: number, error: any): string {
  if (status === 404) return "Resource not found";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  // A Docker/BuildKit/worker error can include a container identifier, a
  // command, or text returned by a process.  Tool callers receive only the
  // small server-authored diagnostic vocabulary below; never make the raw
  // error message another (unreviewed) diagnostics channel.  This includes
  // 409 because a lifecycle operation can legitimately surface a daemon
  // conflict using that status.
  if (safeLifecycleDiagnosticCode(error?.code))
    return lifecycleToolErrorMessage(error.code);
  if (status === 409 || status >= 500)
    return "The requested operation could not be completed safely.";
  return typeof error?.message === "string" && error.message
    ? error.message.slice(0, 500)
    : "Management tool failed";
}

function lifecycleToolErrorMessage(code: SafeLifecycleDiagnosticCode): string {
  switch (code) {
    case "DOCKER_OPERATION_TIMEOUT":
      return "The Docker operation timed out; other workers remain available.";
    case "OPERATION_ABORTED":
      return "The operation was cancelled and may be started again safely.";
    case "WORKER_RUNTIME_UNRESPONSIVE":
    case "WORKER_TASK_UNRESPONSIVE":
      return "Agentor could not verify the worker runtime; retry or use managed recovery.";
    case "WORKER_SECRET_BOOTSTRAP_FAILED":
      return "Worker secret bootstrap did not complete; stop and start can retry it.";
    case "WORKER_PERSISTENCE_UNVERIFIED":
      return "Agentor could not verify required persistent mounts; recovery was not attempted.";
    case "WORKER_RECOVERY_DAEMON_STALE":
      return "Managed recovery could not clear the stale Docker runtime; retry after Docker daemon recovery.";
  }
}

function safeToolDiagnostic(error: any): Record<string, unknown> | undefined {
  const value = error?.diagnostic;
  const lifecycle = error?.data;
  if (
    (!value || typeof value !== "object" || Array.isArray(value)) &&
    (!safeLifecycleDiagnosticCode(error?.code) ||
      !lifecycle ||
      typeof lifecycle !== "object" ||
      Array.isArray(lifecycle))
  )
    return undefined;
  // Only the server-created diagnostic vocabulary is allowed across MCP. It
  // deliberately excludes command text, context contents, environment values,
  // and arbitrary error properties.
  const fields = [
    "code",
    "blockedField",
    "constraint",
    "reason",
    "remediation",
    "advancedModeAvailable",
    "advancedModeWarning",
    "dockerAttempted",
  ] as const;
  const diagnostic: Record<string, unknown> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const field of fields) {
      const candidate = value[field];
      if (field === "code") {
        if (safeDiagnosticCode(candidate)) diagnostic[field] = candidate;
      } else if (typeof candidate === "string") diagnostic[field] = candidate.slice(0, 1000);
      else if (typeof candidate === "boolean") diagnostic[field] = candidate;
    }
    if (
      value.blockedStep &&
      typeof value.blockedStep === "object" &&
      !Array.isArray(value.blockedStep)
    )
      diagnostic.blockedStep = {
        ...(Number.isSafeInteger(value.blockedStep.index)
          ? { index: value.blockedStep.index }
          : {}),
        ...(typeof value.blockedStep.type === "string"
          ? { type: value.blockedStep.type.slice(0, 100) }
          : {}),
      };
  }

  // Lifecycle failures use error.data rather than image-build diagnostics.
  // Project a deliberately small vocabulary: never forward Docker messages,
  // commands, environment values, causes, or arbitrary error properties.
  if (
    safeLifecycleDiagnosticCode(error?.code) &&
    lifecycle &&
    typeof lifecycle === "object" &&
    !Array.isArray(lifecycle)
  ) {
    diagnostic.code = error.code;
    for (const field of ["operation", "nextAction", "phase", "workerId"] as const) {
      const candidate = lifecycle[field];
      if (typeof candidate === "string")
        diagnostic[field] = candidate.slice(0, field === "nextAction" ? 1000 : 200);
    }
    if (Number.isSafeInteger(lifecycle.timeoutMs) && lifecycle.timeoutMs >= 0)
      diagnostic.timeoutMs = lifecycle.timeoutMs;
    for (const field of ["retryable", "volumesPreserved"] as const) {
      if (typeof lifecycle[field] === "boolean")
        diagnostic[field] = lifecycle[field];
    }
    if (Array.isArray(lifecycle.missingTargets))
      diagnostic.missingTargets = lifecycle.missingTargets
        .filter((item: unknown): item is string => typeof item === "string")
        .slice(0, 100)
        .map((item: string) => item.slice(0, 500));
  }
  return Object.keys(diagnostic).length ? diagnostic : undefined;
}

type SafeDiagnosticCode =
  | "safe-mode-blocked"
  | "invalid-definition"
  | "invalid-build-context"
  | SafeLifecycleDiagnosticCode;

type SafeLifecycleDiagnosticCode =
  | "DOCKER_OPERATION_TIMEOUT"
  | "OPERATION_ABORTED"
  | "WORKER_RUNTIME_UNRESPONSIVE"
  | "WORKER_TASK_UNRESPONSIVE"
  | "WORKER_SECRET_BOOTSTRAP_FAILED"
  | "WORKER_PERSISTENCE_UNVERIFIED"
  | "WORKER_RECOVERY_DAEMON_STALE";

function safeDiagnosticCode(value: unknown): value is SafeDiagnosticCode {
  return (
    value === "safe-mode-blocked" ||
    value === "invalid-definition" ||
    value === "invalid-build-context" ||
    safeLifecycleDiagnosticCode(value)
  );
}

function safeLifecycleDiagnosticCode(
  value: unknown,
): value is SafeLifecycleDiagnosticCode {
  return (
    value === "DOCKER_OPERATION_TIMEOUT" ||
    value === "OPERATION_ABORTED" ||
    value === "WORKER_RUNTIME_UNRESPONSIVE" ||
    value === "WORKER_TASK_UNRESPONSIVE" ||
    value === "WORKER_SECRET_BOOTSTRAP_FAILED" ||
    value === "WORKER_PERSISTENCE_UNVERIFIED" ||
    value === "WORKER_RECOVERY_DAEMON_STALE"
  );
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result))
    return result as Record<string, unknown>;
  return Array.isArray(result) ? { items: result } : { result };
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
  const contentType = Array.isArray(headers["content-type"])
    ? headers["content-type"][0]
    : headers["content-type"];
  if (
    (contentType || "").split(";", 1)[0].trim().toLowerCase() !==
    "application/x-tar"
  )
    throw Object.assign(new Error("Content-Type must be application/x-tar"), {
      statusCode: 415,
    });
  const raw = headers["content-length"];
  if (raw === undefined) return { declaredLength: undefined };
  if (Array.isArray(raw) || !/^\d+$/.test(raw))
    throw Object.assign(new Error("Invalid Content-Length"), {
      statusCode: 400,
    });
  const declaredLength = Number(raw);
  if (!Number.isSafeInteger(declaredLength))
    throw Object.assign(new Error("Invalid Content-Length"), {
      statusCode: 400,
    });
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
