defineRouteMeta({
  openAPI: {
    tags: ["Worker Self"],
    summary: "Call worker-self plugin MCP tool",
    description:
      "Source-IP-authenticated MCP endpoint for the calling worker only. It cannot target another worker or owner. Plugin environment and secret inputs are key names only; values are never accepted or returned.",
    operationId: "workerSelfPluginMcp",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["method"],
            properties: {
              jsonrpc: { type: "string", enum: ["2.0"] },
              id: {
                type: ["string", "number", "null"],
                description: "Client correlation value.",
              },
              method: { type: "string", enum: ["tools/list", "tools/call"] },
              params: {
                type: "object",
                description:
                  "For tools/call: `{ name, arguments }`; plugin mutation arguments use envKeys/secretKeys names only.",
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: "MCP result or JSON-RPC error response" },
      400: { description: "Invalid MCP request or tool arguments" },
      401: { description: "Caller is not a recognized worker" },
      404: { description: "Tool resource is unavailable to the caller" },
      409: { description: "Plugin lifecycle or worker state conflict" },
      502: { description: "Plugin runner failed" },
      504: { description: "Plugin lifecycle timed out" },
    },
  },
});

import { requirePluginSelf } from "../../utils/worker-auth";
import { handleWorkerSelfMcp } from "../../utils/worker-self-mcp";
import { WorkerSelfPluginDomain } from "../../utils/worker-self-plugin-domain";

const domain = new WorkerSelfPluginDomain();
export default defineEventHandler(async (event) => {
  const context = await requirePluginSelf(event);
  const result = await handleWorkerSelfMcp(
    await readBody(event),
    context,
    domain,
  );
  setResponseStatus(event, result.status);
  return result.body;
});
