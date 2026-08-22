import { expect, test } from "@playwright/test";
import { handleWorkerSelfMcp, type WorkerSelfMcpDomain } from "../../orchestrator/server/utils/worker-self-mcp";

const context = {
  userId: "owner",
  workerId: "worker-a",
  containerName: "agentor-worker-a",
  container: { id: "worker-a", userId: "owner", status: "running" } as any,
  authority: { kind: "ordinary", userId: "owner", workerId: "worker-a" },
};

const domain: WorkerSelfMcpDomain = {
  tools: () => [{
    name: "plugins.installed.list",
    description: "List only plugins installed on the calling worker.",
    inputSchema: { type: "object", additionalProperties: false },
  }],
  invoke: async (ctx, name, args) => {
    if (name === "plugins.error")
      throw Object.assign(new Error("private target"), { statusCode: 404 });
    return { workerId: ctx.workerId, name, args };
  },
};

test("worker-self MCP initializes and lists its narrow tools", async () => {
  const initialized = await handleWorkerSelfMcp(
    { jsonrpc: "2.0", id: 1, method: "initialize" }, context, domain,
  );
  expect(initialized.body).toMatchObject({
    jsonrpc: "2.0", id: 1,
    result: { serverInfo: { name: "agentor-worker" } },
  });
  const listed = await handleWorkerSelfMcp(
    { jsonrpc: "2.0", id: 2, method: "tools/list" }, context, domain,
  );
  expect((listed.body as any).result.tools).toHaveLength(1);
  expect((listed.body as any).result.tools[0].name).toBe("plugins.installed.list");
});

test("worker-self MCP derives the worker from trusted context, not arguments", async () => {
  const called = await handleWorkerSelfMcp({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: {
      name: "plugins.installed.list",
      arguments: { workerId: "attacker-selected-worker" },
    },
  }, context, domain);
  expect(called.body).toMatchObject({
    result: {
      isError: false,
      structuredContent: { workerId: "worker-a" },
    },
  });
});

test("worker-self MCP returns normal structured safe tool errors", async () => {
  const called = await handleWorkerSelfMcp({
    jsonrpc: "2.0", id: "denied", method: "tools/call",
    params: { name: "plugins.error", arguments: {} },
  }, context, domain);
  expect(called.body).toEqual({
    jsonrpc: "2.0",
    id: "denied",
    result: {
      content: [{ type: "text", text: "Resource not found" }],
      structuredContent: {
        error: { message: "Resource not found", statusCode: 404 },
      },
      isError: true,
    },
  });
});
