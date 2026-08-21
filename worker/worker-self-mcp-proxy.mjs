#!/usr/bin/env node

import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MIN_UPSTREAM_TIMEOUT_MS = 1_000;
const MAX_UPSTREAM_TIMEOUT_MS = 120_000;

export function workerMcpEndpoint(environment = process.env) {
  const explicit = environment.AGENTOR_WORKER_MCP_URL?.trim();
  if (explicit) return explicit;
  const orchestrator = environment.ORCHESTRATOR_URL?.replace(/\/+$/, "");
  return orchestrator
    ? `${orchestrator}/api/worker-self/mcp`
    : "http://agentor-orchestrator:3000/api/worker-self/mcp";
}

export function getWorkerUpstreamTimeoutMs(environment = process.env) {
  const value = Number(environment.AGENTOR_WORKER_MCP_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(
    MAX_UPSTREAM_TIMEOUT_MS,
    Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.trunc(value)),
  );
}

function hasRequestId(request) {
  return typeof request === "object" && request !== null &&
    !Array.isArray(request) && Object.hasOwn(request, "id");
}

function upstreamError(id) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: "Worker MCP upstream request failed" },
  };
}

function isMatchingJsonRpcResponse(response, requestId) {
  if (typeof response !== "object" || response === null || Array.isArray(response))
    return false;
  if (response.jsonrpc !== "2.0" || !Object.hasOwn(response, "id") ||
      response.id !== requestId)
    return false;
  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  return typeof response.error === "object" && response.error !== null &&
    !Array.isArray(response.error) && Number.isInteger(response.error.code) &&
    typeof response.error.message === "string";
}

/**
 * Forward one stdio JSON-RPC message to the source-IP-authenticated worker-self
 * endpoint. Requests with an id always settle exactly once; notifications do
 * not emit a response. No bearer credential is read or sent.
 */
export async function forwardWorkerRequest(request, {
  endpoint = workerMcpEndpoint(),
  fetchImpl = fetch,
  timeoutMs = getWorkerUpstreamTimeoutMs(),
} = {}) {
  const requestHasId = hasRequestId(request);
  const requestId = requestHasId ? request.id : undefined;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response || !Number.isInteger(response.status) ||
        response.status < 200 || response.status >= 300)
      throw new Error("Upstream returned a non-success status");
    const body = await response.text();
    if (!requestHasId) return undefined;
    if (!body.trim()) throw new Error("Upstream returned an empty body");
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Upstream returned malformed JSON");
    }
    if (!isMatchingJsonRpcResponse(parsed, requestId))
      throw new Error("Upstream returned an invalid JSON-RPC response");
    return parsed;
  } catch {
    return requestHasId ? upstreamError(requestId) : undefined;
  }
}

async function run() {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      })}\n`);
      continue;
    }
    const response = await forwardWorkerRequest(request);
    if (response !== undefined)
      process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) run();
