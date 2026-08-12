#!/usr/bin/env node

import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";

const endpoint =
  process.env.AGENTOR_MANAGEMENT_MCP_URL ||
  "http://agentor-orchestrator:3099/mcp";
const credentialPath =
  process.env.AGENTOR_MANAGEMENT_MCP_CREDENTIAL ||
  "/run/agentor-management/credential";

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

  try {
    // The orchestrator rotates this tmpfs-only identity. Read it for every
    // request so a long-running Codex process never caches an expired token.
    const credential = (await readFile(credentialPath, "utf8")).trim();
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (request.id !== undefined && request.id !== null) {
      if (!body) throw new Error(`Management MCP returned HTTP ${response.status}`);
      process.stdout.write(`${body}\n`);
    }
  } catch (error) {
    if (request.id !== undefined && request.id !== null) {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: error instanceof Error ? error.message : "Management MCP request failed" } })}\n`,
      );
    }
  }
}
