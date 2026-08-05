import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
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
        return this.rpc(response, id, { tools: this.store.listTools() });
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
