import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import { createWorker, cleanupWorker } from "../helpers/worker-lifecycle";
import { captureCommandOutput } from "../helpers/terminal-ws";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};
const SECRET_SENTINEL = `mcp-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function body(res: APIResponse): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function invoke(
  request: APIRequestContext,
  credential: string,
  tool: string,
  args: Record<string, unknown> = {},
) {
  return request.post("/api/admin/management-mcp/diagnostics/invoke", {
    data: { credential, tool, arguments: args },
  });
}

test.describe.serial("Internal management MCP security", () => {
  let regular: CreatedUser;
  let regularCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  let normalWorker = "";
  let adminWorkspaceId = "";
  let credential = "";

  test.beforeAll(async ({ request }) => {
    regular = await createTestUser("Management MCP Isolation");
    regularCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await new ApiClient(regularCtx).signInEmail(
          regular.email,
          regular.password,
        )
      ).status,
    ).toBe(200);
    normalWorker = (
      await createWorker(regularCtx, {
        displayName: `mcp-normal-${Date.now()}`,
      })
    ).id;
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    const workspace = await (
      await request.post("/api/admin/workspace", { data: {} })
    ).json();
    adminWorkspaceId = workspace.id;
    const resetPolicy = await request.put("/api/admin/management-mcp/policy", {
      data: {
        groups: {
          "read-only-status": true,
          logs: true,
          "volume-browsing": true,
          "configuration-inspection": true,
          "worker-lifecycle": false,
          console: false,
          exports: false,
          backups: false,
          "image-builds": false,
          "configuration-proposals": false,
          "configuration-application": false,
        },
      },
    });
    expect(resetPolicy.status()).toBe(200);
  });

  // This serial suite deliberately exercises a 47-second credential-rotation
  // boundary. Keep each independent test's diagnostic identity short-lived,
  // but issue it immediately before that test rather than allowing setup time
  // in unrelated tests to turn a live-policy assertion into an expiry test.
  test.beforeEach(async ({ request }) => {
    const identity = await request.post(
      "/api/admin/management-mcp/diagnostics/issue-identity",
      { data: { workspaceId: adminWorkspaceId, ttlSeconds: 60 } },
    );
    expect(identity.status()).toBe(201);
    credential = (await identity.json()).credential;
  });

  test.afterAll(async () => {
    if (normalWorker)
      await cleanupWorker(regularCtx, normalWorker).catch(() => {});
    await regularCtx?.dispose();
    await anonymous?.dispose();
    if (regular) await deleteTestUser(regular.id).catch(() => {});
  });

  test("dashboard policy and diagnostic endpoints are admin-only", async () => {
    for (const ctx of [anonymous, regularCtx]) {
      const expected = ctx === anonymous ? 401 : 403;
      expect((await ctx.get("/api/admin/management-mcp/policy")).status()).toBe(
        expected,
      );
      expect(
        (
          await ctx.get("/api/admin/management-mcp/diagnostics/network")
        ).status(),
      ).toBe(expected);
      expect(
        (
          await ctx.post(
            "/api/admin/management-mcp/diagnostics/issue-identity",
            { data: { workspaceId: adminWorkspaceId } },
          )
        ).status(),
      ).toBe(expected);
    }
  });

  test("MCP has an internal-only network with no host port or Traefik route", async ({
    request,
  }) => {
    const res = await request.get(
      "/api/admin/management-mcp/diagnostics/network",
    );
    expect(res.status()).toBe(200);
    const network = await res.json();
    expect(network).toMatchObject({
      network: "agentor-management",
      internal: true,
      publishedPorts: [],
      traefikRoutes: [],
      rawDockerSocket: false,
      attachedWorkspaceIds: [adminWorkspaceId],
      normalWorkerIds: [],
      unexpectedMembers: [],
      orchestratorAttached: true,
    });
    expect(network.members).toHaveLength(2);
  });

  test("an ordinary worker has no TCP route to the management MCP listener", async () => {
    // This deliberately attempts a TCP connection rather than asserting DNS or
    // Docker metadata alone. A normal worker can resolve the orchestrator for
    // its ordinary API, but port 3099 is bound solely to its management-network
    // address and must not be reachable through that worker-facing route.
    const output = await captureCommandOutput(
      normalWorker,
      `node -e 'const net=require("net"); const socket=net.connect({host:"agentor-orchestrator",port:3099}); const done=(value)=>{console.log(value); process.exit(0)}; socket.setTimeout(2500,()=>done("TCP_DENIED_TIMEOUT")); socket.on("connect",()=>{console.log("TCP_UNEXPECTEDLY_CONNECTED"); process.exit(1)}); socket.on("error",()=>done("TCP_DENIED"));'`,
      15_000,
    );
    expect(output).toMatch(/TCP_DENIED/);
    expect(output).not.toContain("TCP_UNEXPECTEDLY_CONNECTED");
  });

  test("the administrative Codex stdio bridge discovers only enabled MCP tools across credential rotation", async () => {
    const requests = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    ];
    const summarize =
      'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const m=d.trim().split(/\\n+/).map(JSON.parse);console.log(JSON.stringify({ids:m.map(x=>x.id),server:m[0]?.result?.serverInfo?.name,tools:m[1]?.result?.tools?.map(x=>x.name)}))})';
    const invokeProxy = () =>
      captureCommandOutput(
        adminWorkspaceId,
        `printf '%s\\n' ${requests.map((line) => `'${line}'`).join(" ")} | /usr/local/bin/agentor-management-mcp | node -e '${summarize}'`,
        20_000,
      );

    let config = "";
    await expect
      .poll(
        async () => {
          config = await captureCommandOutput(
            adminWorkspaceId,
            "grep -A1 '^\\[mcp_servers\\.agentor-management\\]$' /home/agent/.codex/config.toml 2>/dev/null || true",
          );
          return config;
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toContain("[mcp_servers.agentor-management]");
    expect(config).toContain("[mcp_servers.agentor-management]");
    expect(config).toContain(
      'command = "/usr/local/bin/agentor-management-mcp"',
    );

    const first = await invokeProxy();
    expect(first).toContain('"ids":[1,2]');
    expect(first).toContain('"server":"agentor-management"');
    expect(first).toContain("status.system");
    expect(first).not.toContain("worker.stop");

    // The runtime replaces the tmpfs identity every 45 seconds. A second
    // request after that boundary proves the bridge reads the credential file
    // for each request instead of retaining an expiring bearer in Codex.
    await new Promise((resolve) => setTimeout(resolve, 47_000));
    const rotated = await invokeProxy();
    expect(rotated).toContain('"server":"agentor-management"');
    expect(rotated).toContain("status.system");
    expect(rotated).not.toContain("worker.stop");
  }, 90_000);

  test("workspace identity is short-lived, workspace-bound, and not persisted in workspace storage", async ({
    request,
  }) => {
    const metadata = await request.post(
      "/api/admin/management-mcp/diagnostics/introspect-identity",
      { data: { credential } },
    );
    expect(metadata.status()).toBe(200);
    const result = await metadata.json();
    expect(result).toMatchObject({
      workspaceId: adminWorkspaceId,
      audience: "agentor-management-mcp",
      persistedInWorkspace: false,
    });
    expect(
      new Date(result.expiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(60_000);
    const wrong = await request.post(
      "/api/admin/management-mcp/diagnostics/introspect-identity",
      { data: { credential, workspaceId: normalWorker } },
    );
    expect(wrong.status()).toBe(403);
  });

  test("expired and malformed workload identities fail closed", async ({
    request,
  }) => {
    const expired = await request.post(
      "/api/admin/management-mcp/diagnostics/issue-identity",
      { data: { workspaceId: adminWorkspaceId, ttlSeconds: -1 } },
    );
    expect(expired.status()).toBe(201);
    expect(
      (
        await invoke(
          request,
          (await expired.json()).credential,
          "status.system",
        )
      ).status(),
    ).toBe(401);
    expect(
      (
        await invoke(request, "not-a-valid-credential", "status.system")
      ).status(),
    ).toBe(401);
  });

  test("tool groups use an explicit fail-closed allowlist and mutating groups default off", async ({
    request,
  }) => {
    const policy = await (
      await request.get("/api/admin/management-mcp/policy")
    ).json();
    expect(policy.default).toBe("deny");
    expect(policy.groups["read-only-status"].enabled).toBe(true);
    expect(policy.groups.logs.enabled).toBe(true);
    expect(policy.groups["volume-browsing"].enabled).toBe(true);
    expect(policy.groups["configuration-inspection"].enabled).toBe(true);
    for (const group of [
      "worker-lifecycle",
      "console",
      "exports",
      "backups",
      "image-builds",
      "configuration-application",
    ]) {
      expect(policy.groups[group].enabled).toBe(false);
    }
    expect(
      (
        await invoke(request, credential, "worker.stop", {
          workerId: normalWorker,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await invoke(request, credential, "unknown.equivalent_privileged_route")
      ).status(),
    ).toBe(403);
  });

  test("policy changes take effect on every call and disabling removes equivalent access", async ({
    request,
  }) => {
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { "read-only-status": false } },
        })
      ).status(),
    ).toBe(200);
    expect((await invoke(request, credential, "status.system")).status()).toBe(
      403,
    );
    expect((await invoke(request, credential, "workers.list")).status()).toBe(
      403,
    );
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { "read-only-status": true } },
        })
      ).status(),
    ).toBe(200);
    expect((await invoke(request, credential, "status.system")).status()).toBe(
      200,
    );
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { logs: false } },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "logs.read", {
          workerId: normalWorker,
          ownerId: regular.id,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await invoke(request, credential, "workers.inspect", {
          workerId: normalWorker,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { logs: true, "volume-browsing": false } },
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "logs.read", {
          workerId: normalWorker,
          ownerId: regular.id,
        })
      ).status(),
    ).toBe(200);
    expect((await invoke(request, credential, "volumes.list")).status()).toBe(
      403,
    );
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { "volume-browsing": true } },
        })
      ).status(),
    ).toBe(200);
  });

  test("disabled capability groups disappear from MCP discovery", async ({
    request,
  }) => {
    const listed = await request.post(
      "/api/admin/management-mcp/diagnostics/list-tools",
      {
        data: { credential },
      },
    );
    expect(listed.status()).toBe(200);
    const names = (await listed.json()).map(
      (tool: { name: string }) => tool.name,
    );
    expect(names).toContain("status.system");
    expect(names).not.toContain("worker.stop");
    expect(names).not.toContain("console.open");
  });

  test("MCP exposure and app tools share worker ownership, apply mappings, and obey live capability policy", async ({
    request,
  }) => {
    // Both groups are off by default and deny all aliases before dispatch.
    expect(
      (await invoke(request, credential, "port-mappings.list")).status(),
    ).toBe(403);
    expect((await invoke(request, credential, "apps.types")).status()).toBe(
      403,
    );
    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { networking: true, apps: true } },
        })
      ).status(),
    ).toBe(200);

    const discovered = await request.post(
      "/api/admin/management-mcp/diagnostics/list-tools",
      {
        data: { credential },
      },
    );
    const tools = await discovered.json();
    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "port-mappings.create",
          annotations: expect.objectContaining({ readOnlyHint: false }),
        }),
        expect.objectContaining({
          name: "domain-mappings.list",
          annotations: expect.objectContaining({ readOnlyHint: true }),
        }),
        expect.objectContaining({
          name: "apps.stop",
          annotations: expect.objectContaining({ destructiveHint: true }),
        }),
      ]),
    );

    const port = 35000 + Math.floor(Math.random() * 2000);
    const created = await invoke(request, credential, "port-mappings.create", {
      workerId: normalWorker,
      externalPort: port,
      internalPort: 8080,
      type: "localhost",
    });
    expect(created.status()).toBe(200);
    expect(await created.json()).toMatchObject({
      externalPort: port,
      workerId: normalWorker,
      userId: regular.id,
    });
    const scoped = await invoke(request, credential, "port-mappings.list", {
      userId: regular.id,
    });
    expect(scoped.status()).toBe(200);
    expect(await scoped.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          externalPort: port,
          workerId: normalWorker,
          userId: regular.id,
        }),
      ]),
    );
    expect((await invoke(request, credential, "apps.types")).status()).toBe(
      200,
    );
    expect(
      (
        await invoke(request, credential, "apps.list", {
          workerId: normalWorker,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "port-mappings.delete", {
          externalPort: port,
        })
      ).status(),
    ).toBe(200);

    expect(
      (
        await request.put("/api/admin/management-mcp/policy", {
          data: { groups: { networking: false, apps: false } },
        })
      ).status(),
    ).toBe(200);
    expect(
      (await invoke(request, credential, "port-mappings.list")).status(),
    ).toBe(403);
    expect((await invoke(request, credential, "apps.types")).status()).toBe(
      403,
    );
  });

  test("MCP responses and errors never return existing secret values", async ({
    request,
  }) => {
    await request.put(`/api/containers/${adminWorkspaceId}/configuration`, {
      data: { secrets: [{ key: "MCP_TEST_SECRET", value: SECRET_SENTINEL }] },
    });
    for (const tool of [
      "configuration.inspect",
      "logs.read",
      "workers.inspect",
    ]) {
      const res = await invoke(request, credential, tool, {
        workspaceId: adminWorkspaceId,
        workerId: normalWorker,
        ownerId: regular.id,
        query: SECRET_SENTINEL,
      });
      expect(JSON.stringify(await body(res))).not.toContain(SECRET_SENTINEL);
    }
    const logs = await invoke(request, credential, "logs.read", {
      workerId: normalWorker,
      ownerId: regular.id,
      tail: 1000,
    });
    expect(logs.status()).toBe(200);
    expect(await logs.json()).toMatchObject({
      workerId: normalWorker,
      ownerId: regular.id,
      logs: expect.any(String),
    });
  });

  test("MCP console attaches to the selected worker, accepts input, redacts managed secrets, and closes", async ({
    request,
  }) => {
    await request.put("/api/admin/management-mcp/policy", {
      data: { groups: { console: true } },
    });
    const managedSecret = `console-managed-${Date.now()}`;
    expect(
      (
        await regularCtx.put(`/api/containers/${normalWorker}/configuration`, {
          data: {
            secrets: [{ key: "CONSOLE_MANAGED_SECRET", value: managedSecret }],
          },
        })
      ).status(),
    ).toBe(200);
    const opened = await invoke(request, credential, "console.open", {
      workerId: normalWorker,
      windowIndex: 0,
    });
    expect(opened.status()).toBe(200);
    const sessionId = (await opened.json()).id;
    expect(sessionId).toEqual(expect.any(String));
    const marker = `mcp-console-${Date.now()}`;
    expect(
      (
        await invoke(request, credential, "console.write", {
          sessionId,
          input: `printf '${marker}:%s:${managedSecret}\\n' \"$(printf '%s' \"$WORKER\" | jq -r .id)\"\n`,
        })
      ).status(),
    ).toBe(200);
    let output = "";
    for (let attempt = 0; attempt < 30; attempt++) {
      const read = await invoke(request, credential, "console.read", {
        sessionId,
        from: 0,
      });
      expect(read.status()).toBe(200);
      output = (await read.json()).output;
      if (output.includes(marker)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(output).toContain(`${marker}:${normalWorker}:[REDACTED]`);
    expect(output).not.toContain(managedSecret);
    expect(
      (
        await invoke(request, credential, "console.interrupt", { sessionId })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "console.close", { sessionId })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "console.read", { sessionId })
      ).status(),
    ).toBe(404);
  });

  test("authorized harnesses may apply immutable proposals without a dashboard approval gate", async ({
    request,
  }) => {
    await request.put("/api/admin/management-mcp/policy", {
      data: {
        groups: {
          "configuration-proposals": true,
          "configuration-application": true,
        },
      },
    });
    const proposed = await invoke(
      request,
      credential,
      "configuration.propose",
      { patch: { logLevel: "debug" } },
    );
    expect(proposed.status()).toBe(200);
    const proposal = await proposed.json();
    expect(proposal).toMatchObject({
      id: expect.any(String),
      immutable: true,
      status: "pending-dashboard-approval",
      diff: expect.any(Object),
    });
    expect(
      (
        await invoke(request, credential, "configuration.apply", {
          proposalId: proposal.id,
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await invoke(request, credential, "configuration.approve", {
          proposalId: proposal.id,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await request.post(
          `/api/admin/management-mcp/proposals/${proposal.id}/approve`,
          { data: {} },
        )
      ).status(),
    ).toBe(409);
    expect(
      (
        await request.put(
          `/api/admin/management-mcp/proposals/${proposal.id}`,
          { data: { patch: { logLevel: "trace" } } },
        )
      ).status(),
    ).toBe(409);
    expect(
      (
        await invoke(request, credential, "configuration.apply", {
          proposalId: proposal.id,
        })
      ).status(),
    ).toBe(409);
  });

  test("every successful and failed invocation is audited without arguments, credentials, or secrets", async ({
    request,
  }) => {
    expect((await invoke(request, credential, "status.system")).status()).toBe(
      200,
    );
    expect(
      (
        await invoke(request, credential, "unknown.audit-test", {
          value: SECRET_SENTINEL,
        })
      ).status(),
    ).toBe(403);
    const audit = await request.get(
      "/api/admin/management-mcp/audit?limit=200",
    );
    expect(audit.status()).toBe(200);
    const entries = (await audit.json()) as Array<{
      action: string;
      outcome: string;
      details?: Record<string, unknown>;
    }>;
    const invocations = entries.filter(
      (entry) => entry.action === "tool.invoked",
    );
    expect(invocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outcome: "success",
          details: expect.objectContaining({ tool: "status.system" }),
        }),
        expect.objectContaining({
          outcome: "failure",
          details: expect.objectContaining({ tool: "unknown.audit-test" }),
        }),
      ]),
    );
    const serialized = JSON.stringify(entries);
    for (const action of [
      "authorization.denied",
      "policy.changed",
      "proposal.applied",
    ])
      expect(serialized).toContain(action);
    expect(serialized).not.toContain(SECRET_SENTINEL);
    expect(serialized).not.toContain(credential);
  });
});
