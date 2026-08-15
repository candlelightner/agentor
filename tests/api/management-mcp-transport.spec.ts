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
    expect(body.result.content).toEqual([
      { type: "text", text: JSON.stringify([{ id: "group-private-image", groupId: "group-a" }]) },
    ]);
  } finally {
    await transport.stop();
  }
});
