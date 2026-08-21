import assert from "node:assert/strict";
import test from "node:test";
import {
  forwardWorkerRequest,
  getWorkerUpstreamTimeoutMs,
  workerMcpEndpoint,
} from "./worker-self-mcp-proxy.mjs";

test("derives the endpoint without credentials", () => {
  assert.equal(
    workerMcpEndpoint({ ORCHESTRATOR_URL: "http://orch:3000/" }),
    "http://orch:3000/api/worker-self/mcp",
  );
  assert.equal(
    workerMcpEndpoint({
      ORCHESTRATOR_URL: "http://orch:3000",
      AGENTOR_WORKER_MCP_URL: "http://custom/mcp",
    }),
    "http://custom/mcp",
  );
});

test("bounds its timeout", () => {
  assert.equal(getWorkerUpstreamTimeoutMs({ AGENTOR_WORKER_MCP_TIMEOUT_MS: "10" }), 1_000);
  assert.equal(getWorkerUpstreamTimeoutMs({ AGENTOR_WORKER_MCP_TIMEOUT_MS: "999999" }), 120_000);
  assert.equal(getWorkerUpstreamTimeoutMs({ AGENTOR_WORKER_MCP_TIMEOUT_MS: "nope" }), 30_000);
});

test("forwards matching responses and sends no authorization header", async () => {
  let headers;
  const result = await forwardWorkerRequest(
    { jsonrpc: "2.0", id: 7, method: "tools/list" },
    {
      endpoint: "http://worker-self/mcp",
      fetchImpl: async (_url, init) => {
        headers = init.headers;
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          result: { tools: [] },
        }));
      },
    },
  );
  assert.deepEqual(result, { jsonrpc: "2.0", id: 7, result: { tools: [] } });
  assert.equal(headers.authorization, undefined);
});

for (const [name, response] of [
  ["non-success", new Response("denied", { status: 403 })],
  ["empty", new Response("")],
  ["malformed", new Response("{")],
  ["wrong id", new Response(JSON.stringify({ jsonrpc: "2.0", id: 8, result: {} }))],
]) {
  test(`${name} response settles as a safe JSON-RPC error`, async () => {
    const result = await forwardWorkerRequest(
      { jsonrpc: "2.0", id: "request", method: "tools/call" },
      { fetchImpl: async () => response },
    );
    assert.deepEqual(result, {
      jsonrpc: "2.0",
      id: "request",
      error: { code: -32000, message: "Worker MCP upstream request failed" },
    });
  });
}

test("notifications do not emit transport errors", async () => {
  const result = await forwardWorkerRequest(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { fetchImpl: async () => { throw new Error("offline"); } },
  );
  assert.equal(result, undefined);
});
