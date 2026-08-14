#!/usr/bin/env node

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultEndpoint =
  process.env.AGENTOR_MANAGEMENT_MCP_URL ||
  "http://agentor-orchestrator:3099/mcp";
const defaultCredentialPath =
  process.env.AGENTOR_MANAGEMENT_MCP_CREDENTIAL ||
  "/run/agentor-management/credential";

const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;
const MIN_UPSTREAM_TIMEOUT_MS = 1_000;
const MAX_UPSTREAM_TIMEOUT_MS = 120_000;

export function getUpstreamTimeoutMs(environment = process.env) {
  const value = Number(environment.AGENTOR_MANAGEMENT_MCP_TIMEOUT_MS);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_UPSTREAM_TIMEOUT_MS;
  return Math.min(MAX_UPSTREAM_TIMEOUT_MS, Math.max(MIN_UPSTREAM_TIMEOUT_MS, Math.trunc(value)));
}

function hasRequestId(request) {
  return typeof request === "object" && request !== null && !Array.isArray(request) &&
    Object.hasOwn(request, "id");
}

function upstreamError(id) {
  // Do not expose upstream HTTP status, response text, URLs, or transport
  // errors. Those can contain authorization or deployment details.
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32000, message: "Management MCP upstream request failed" },
  };
}

function isMatchingJsonRpcResponse(response, requestId) {
  if (typeof response !== "object" || response === null || Array.isArray(response)) return false;
  if (response.jsonrpc !== "2.0" || !Object.hasOwn(response, "id") || response.id !== requestId) {
    return false;
  }

  const hasResult = Object.hasOwn(response, "result");
  const hasError = Object.hasOwn(response, "error");
  if (hasResult === hasError) return false;
  if (!hasError) return true;

  return typeof response.error === "object" && response.error !== null &&
    !Array.isArray(response.error) && Number.isInteger(response.error.code) &&
    typeof response.error.message === "string";
}

/**
 * Forward one JSON-RPC request. A request with an id always resolves to one
 * JSON-RPC response; notifications resolve to undefined.
 */
export async function forwardRequest(request, {
  endpoint = defaultEndpoint,
  credentialPath = defaultCredentialPath,
  fetchImpl = fetch,
  readCredentialImpl = readFile,
  timeoutMs = getUpstreamTimeoutMs(),
} = {}) {
  const requestHasId = hasRequestId(request);
  const requestId = requestHasId ? request.id : undefined;

  try {
    // The orchestrator rotates this tmpfs-only identity. Read it for every
    // request so a long-running Codex process never caches an expired token.
    const credential = (await readCredentialImpl(credentialPath, "utf8")).trim();
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // A non-success HTTP response is never a valid JSON-RPC response for the
    // caller, even if an intermediary supplied a JSON body.
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
      throw new Error("Upstream returned a non-success status");
    }

    const body = await response.text();
    if (!requestHasId) return undefined;
    if (!body.trim()) throw new Error("Upstream returned an empty body");

    let upstreamResponse;
    try {
      upstreamResponse = JSON.parse(body);
    } catch {
      throw new Error("Upstream returned malformed JSON");
    }
    if (!isMatchingJsonRpcResponse(upstreamResponse, requestId)) {
      throw new Error("Upstream returned an invalid JSON-RPC response");
    }
    return upstreamResponse;
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
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`,
      );
      continue;
    }

    const response = await forwardRequest(request);
    if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
