import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { ManagementMcpTransport } from "../../orchestrator/server/utils/management-mcp-transport";

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) =>
    server.listen(0, "127.0.0.1", resolve).once("error", reject),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

test("MCP wraps list results in an object for structuredContent", async () => {
  const port = await unusedPort();
  const transport = new ManagementMcpTransport({
    invoke: async () => [{ id: "group-private-image", groupId: "group-a" }],
  } as any, port);
  await transport.start("127.0.0.1");
  try {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "images.list", arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.structuredContent).toEqual({
      items: [{ id: "group-private-image", groupId: "group-a" }],
    });
    expect(body.result.isError).toBe(false);
    expect(body.result.content).toEqual([
      { type: "text", text: JSON.stringify([{ id: "group-private-image", groupId: "group-a" }]) },
    ]);
  } finally {
    await transport.stop();
  }
});

test("MCP serializes tool failures as bounded CallToolResult errors", async () => {
  const port = await unusedPort();
  const transport = new ManagementMcpTransport({
    invoke: async () => { throw Object.assign(new Error("foreign metadata must not leak"), { statusCode: 404 }); },
  } as any, port);
  await transport.start("127.0.0.1");
  try {
    const started = Date.now();
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "workers.inspect", arguments: { workerId: "foreign" } } }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("error");
    expect(body.result).toEqual({
      content: [{ type: "text", text: "Resource not found" }],
      structuredContent: { error: { message: "Resource not found", statusCode: 404 } },
      isError: true,
    });
    expect(JSON.stringify(body)).not.toContain("foreign metadata");
  } finally {
    await transport.stop();
  }
});
