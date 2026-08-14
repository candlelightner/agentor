import assert from "node:assert/strict";
import test from "node:test";

import { forwardRequest, getUpstreamTimeoutMs } from "./management-mcp-proxy.mjs";

const request = { jsonrpc: "2.0", id: "request-7", method: "workers/list" };
const expectedError = {
  jsonrpc: "2.0",
  id: "request-7",
  error: { code: -32000, message: "Management MCP upstream request failed" },
};

function upstream(status, body) {
  return { status, text: async () => body };
}

function options(fetchImpl) {
  return {
    fetchImpl,
    readCredentialImpl: async () => "rotating-credential\n",
    timeoutMs: 25,
  };
}

test("passes through a valid matching JSON-RPC response", async () => {
  const result = { jsonrpc: "2.0", id: "request-7", result: { workers: [] } };
  const actual = await forwardRequest(request, options(async () => upstream(200, JSON.stringify(result))));
  assert.deepEqual(actual, result);
});

for (const [name, status, body] of [
  ["unauthorized response", 401, '{"jsonrpc":"2.0","id":null,"error":{"message":"secret"}}'],
  ["forbidden response", 403, '{"jsonrpc":"2.0","id":null,"error":{"message":"secret"}}'],
  ["not found response", 404, "not found"],
  ["empty successful response", 200, ""],
  ["malformed successful response", 200, "{"],
  ["response with a missing id", 200, '{"jsonrpc":"2.0","result":{}}'],
  ["response with a mismatched id", 200, '{"jsonrpc":"2.0","id":"other","result":{}}'],
]) {
  test(`returns the original id for ${name}`, async () => {
    const actual = await forwardRequest(request, options(async () => upstream(status, body)));
    assert.deepEqual(actual, expectedError);
  });
}

test("returns a safe JSON-RPC error when the upstream fetch fails", async () => {
  const actual = await forwardRequest(request, options(async () => {
    throw new Error("connection to http://private.example failed with token=leak");
  }));
  assert.deepEqual(actual, expectedError);
});

test("returns a safe JSON-RPC error when the upstream times out", async () => {
  const actual = await forwardRequest(request, options(async (_url, init) => {
    await new Promise((resolve, reject) => {
      const safetyTimer = setTimeout(() => reject(new Error("timeout did not abort")), 100);
      init.signal.addEventListener("abort", () => {
        clearTimeout(safetyTimer);
        reject(init.signal.reason);
      }, { once: true });
    });
  }));
  assert.deepEqual(actual, expectedError);
});

test("does not emit a response for notifications", async () => {
  const actual = await forwardRequest(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    options(async () => upstream(403, "forbidden")),
  );
  assert.equal(actual, undefined);
});

test("bounds the configurable upstream timeout", () => {
  assert.equal(getUpstreamTimeoutMs({}), 30_000);
  assert.equal(getUpstreamTimeoutMs({ AGENTOR_MANAGEMENT_MCP_TIMEOUT_MS: "10" }), 1_000);
  assert.equal(getUpstreamTimeoutMs({ AGENTOR_MANAGEMENT_MCP_TIMEOUT_MS: "999999" }), 120_000);
  assert.equal(getUpstreamTimeoutMs({ AGENTOR_MANAGEMENT_MCP_TIMEOUT_MS: "nope" }), 30_000);
});
