import type { WorkerSelfContext } from "./worker-auth";

export interface WorkerSelfMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, boolean>;
}

export interface WorkerSelfMcpDomain {
  tools(context: WorkerSelfContext): Promise<WorkerSelfMcpTool[]> | WorkerSelfMcpTool[];
  invoke(
    context: WorkerSelfContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
}

interface RpcResult {
  status: number;
  body: unknown;
}

/**
 * Transport-neutral JSON-RPC handler for the narrow worker-self MCP. The route
 * resolves its trusted WorkerSelfContext from the Docker source IP before this
 * function runs; request arguments can never select another worker or owner.
 */
export async function handleWorkerSelfMcp(
  body: unknown,
  context: WorkerSelfContext,
  domain: WorkerSelfMcpDomain,
): Promise<RpcResult> {
  const request = record(body);
  const hasId = !!request && Object.hasOwn(request, "id");
  const id = hasId ? request!.id : null;
  if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string")
    return rpcError(id, -32600, "Invalid request");

  try {
    if (request.method === "initialize")
      return rpc(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "agentor-worker", version: "1" },
      });
    if (request.method === "notifications/initialized")
      return { status: 202, body: null };
    if (request.method === "tools/list")
      return rpc(id, { tools: await domain.tools(context) });
    if (request.method === "tools/call") {
      const params = record(request.params);
      const name = typeof params?.name === "string" ? params.name : "";
      if (!name) return rpcError(id, -32602, "Tool name is required");
      const args = record(params?.arguments) || {};
      try {
        const result = await domain.invoke(context, name, args);
        return rpc(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: structuredContent(result),
          isError: false,
        });
      } catch (error: any) {
        const status = httpStatus(error);
        const message = safeToolMessage(status, error);
        return rpc(id, {
          content: [{ type: "text", text: message }],
          structuredContent: { error: { message, statusCode: status } },
          isError: true,
        });
      }
    }
    return rpcError(id, -32601, "Method not found");
  } catch (error: any) {
    return rpcError(id, -32000, safeToolMessage(httpStatus(error), error), {
      statusCode: httpStatus(error),
    });
  }
}

function rpc(id: unknown, result: unknown): RpcResult {
  return { status: 200, body: { jsonrpc: "2.0", id, result } };
}

function rpcError(
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): RpcResult {
  return {
    status: 200,
    body: { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } },
  };
}

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function structuredContent(result: unknown): Record<string, unknown> {
  if (result !== null && typeof result === "object" && !Array.isArray(result))
    return result as Record<string, unknown>;
  return Array.isArray(result) ? { items: result } : { result };
}

function httpStatus(error: any) {
  const status = error?.statusCode;
  return Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : 500;
}

function safeToolMessage(status: number, error: any) {
  if (status === 404) return "Resource not found";
  if (status === 401) return "Unauthorized";
  if (status === 403) return "Forbidden";
  return typeof error?.message === "string" && error.message
    ? error.message.slice(0, 500)
    : "Worker tool failed";
}
