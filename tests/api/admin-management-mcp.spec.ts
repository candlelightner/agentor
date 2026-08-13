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

  test("workers.list makes archived workers discoverable for unarchive", async ({ request }) => {
    const archived = await createWorker(request, { displayName: `mcp-archived-${Date.now()}` });
    const api = new ApiClient(request);
    try {
      expect((await api.stopContainer(archived.id)).status).toBe(200);
      expect((await api.archiveContainer(archived.id)).status).toBe(200);
      const listed = await invoke(request, credential, "workers.list");
      expect(listed.status()).toBe(200);
      expect((await listed.json()).workers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: archived.id, status: "archived" }),
      ]));
    } finally {
      await api.deleteArchivedWorker(archived.id).catch(() => {});
    }
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

  test("explicit owner selectors require a traversal-safe real user while preserving cross-user administration", async ({
    request,
  }) => {
    // The administrative workspace is allowed to inspect another real user's
    // status. Cross-user administration is intentional; invented owner
    // namespaces and path-shaped ids are not.
    expect(
      (
        await invoke(request, credential, "usage.get", {
          userId: regular.id,
        })
      ).status(),
    ).toBe(200);

    expect(
      (
        await invoke(request, credential, "usage.get", {
          userId: "missing-safe-owner",
        })
      ).status(),
    ).toBe(404);

    for (const userId of [
      "../admin",
      "/absolute",
      "owner/child",
      "owner\\child",
      "%2e%2e%2fadmin",
      "owner%2Fchild",
    ]) {
      const response = await invoke(request, credential, "usage.get", {
        userId,
      });
      expect(response.status(), userId).toBe(400);
    }
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

  test("every legacy lifecycle, configuration, app, and exposure MCP alias enforces worker protection without leaking its credential", async ({
    request,
  }) => {
    const lockPassword = `mcp-alias-lock-${Date.now()}-password`;
    const wrongPassword = "wrong-mcp-alias-lock-password";
    const port = 37000 + Math.floor(Math.random() * 1000);
    const subdomain = `mcp-lock-${Date.now()}`;
    let appId = "";
    let domainId = "";
    let locked = false;
    try {
      expect(
        (
          await regularCtx.put(`/api/containers/${normalWorker}/protection`, {
            data: { password: lockPassword },
          })
        ).status(),
      ).toBe(200);
      locked = true;
      expect(
        (
          await request.put("/api/admin/management-mcp/policy", {
            data: {
              groups: {
                "worker-lifecycle": true,
                "configuration-proposals": true,
                "configuration-application": true,
                networking: true,
                apps: true,
              },
            },
          })
        ).status(),
      ).toBe(200);

      const tools = await (
        await request.post(
          "/api/admin/management-mcp/diagnostics/list-tools",
          { data: { credential } },
        )
      ).json();
      for (const name of [
        "worker.stop",
        "worker.start",
        "configuration.apply",
        "apps.start",
        "apps.stop",
        "port-mappings.create",
        "port-mappings.delete",
        "domain-mappings.create",
        "domain-mappings.delete",
      ])
        expect(
          tools.find((tool: any) => tool.name === name)?.inputSchema?.properties
            ?.lockPassword,
        ).toMatchObject({ type: "string", writeOnly: true });

      const proposed = await invoke(
        request,
        credential,
        "configuration.propose",
        {
          patch: {
            workerId: normalWorker,
            variables: [{ key: "MCP_LOCK_GUARD", value: "applied" }],
          },
        },
      );
      expect(proposed.status()).toBe(200);
      const proposalId = (await proposed.json()).id;

      const assertLocked = async (
        tool: string,
        args: Record<string, unknown>,
      ) => {
        for (const password of [undefined, wrongPassword]) {
          const denied = await invoke(request, credential, tool, {
            ...args,
            ...(password ? { lockPassword: password } : {}),
          });
          expect(denied.status(), `${tool} must require the worker lock`).toBe(
            423,
          );
          expect(JSON.stringify(await body(denied))).not.toContain(lockPassword);
        }
      };

      await assertLocked("configuration.apply", { proposalId });
      const applied = await invoke(
        request,
        credential,
        "configuration.apply",
        { proposalId, lockPassword },
      );
      expect(applied.status()).toBe(200);
      expect(JSON.stringify(await applied.json())).not.toContain(lockPassword);

      await assertLocked("port-mappings.create", {
        workerId: normalWorker,
        externalPort: port,
        internalPort: 8080,
        type: "localhost",
      });
      expect(
        (
          await invoke(request, credential, "port-mappings.create", {
            workerId: normalWorker,
            externalPort: port,
            internalPort: 8080,
            type: "localhost",
            lockPassword,
          })
        ).status(),
      ).toBe(200);
      await assertLocked("port-mappings.delete", { externalPort: port });
      expect(
        (
          await invoke(request, credential, "port-mappings.delete", {
            externalPort: port,
            lockPassword,
          })
        ).status(),
      ).toBe(200);

      await assertLocked("domain-mappings.create", {
        workerId: normalWorker,
        baseDomain: "docker.localhost",
        subdomain,
        protocol: "http",
        internalPort: 8080,
      });
      const domain = await invoke(
        request,
        credential,
        "domain-mappings.create",
        {
          workerId: normalWorker,
          baseDomain: "docker.localhost",
          subdomain,
          protocol: "http",
          internalPort: 8080,
          lockPassword,
        },
      );
      expect(domain.status()).toBe(200);
      domainId = (await domain.json()).id;
      await assertLocked("domain-mappings.delete", { mappingId: domainId });
      expect(
        (
          await invoke(request, credential, "domain-mappings.delete", {
            mappingId: domainId,
            lockPassword,
          })
        ).status(),
      ).toBe(200);
      domainId = "";

      // Mapping reconciliation can be slow on loaded Docker hosts. Refresh the
      // deliberately short-lived diagnostic identity without weakening its
      // production 60-second ceiling before exercising the remaining aliases.
      const refreshed = await request.post(
        "/api/admin/management-mcp/diagnostics/issue-identity",
        { data: { workspaceId: adminWorkspaceId, ttlSeconds: 60 } },
      );
      expect(refreshed.status()).toBe(201);
      credential = (await refreshed.json()).credential;

      await assertLocked("apps.start", {
        workerId: normalWorker,
        appType: "socks5",
      });
      const app = await invoke(request, credential, "apps.start", {
        workerId: normalWorker,
        appType: "socks5",
        lockPassword,
      });
      expect(app.status()).toBe(200);
      appId = (await app.json()).id;
      await assertLocked("apps.stop", {
        workerId: normalWorker,
        appType: "socks5",
        instanceId: appId,
      });
      expect(
        (
          await invoke(request, credential, "apps.stop", {
            workerId: normalWorker,
            appType: "socks5",
            instanceId: appId,
            lockPassword,
          })
        ).status(),
      ).toBe(200);
      appId = "";

      await assertLocked("worker.stop", { workerId: normalWorker });
      expect(
        (
          await invoke(request, credential, "worker.stop", {
            workerId: normalWorker,
            lockPassword,
          })
        ).status(),
      ).toBe(200);
      await assertLocked("worker.start", { workerId: normalWorker });
      expect(
        (
          await invoke(request, credential, "worker.start", {
            workerId: normalWorker,
            lockPassword,
          })
        ).status(),
      ).toBe(200);

      const audit = JSON.stringify(
        await (
          await request.get("/api/admin/management-mcp/audit?limit=500")
        ).json(),
      );
      expect(audit).not.toContain(lockPassword);
    } finally {
      if (appId)
        await invoke(request, credential, "apps.stop", {
          workerId: normalWorker,
          appType: "socks5",
          instanceId: appId,
          lockPassword,
        }).catch(() => {});
      if (domainId)
        await invoke(request, credential, "domain-mappings.delete", {
          mappingId: domainId,
          lockPassword,
        }).catch(() => {});
      await invoke(request, credential, "port-mappings.delete", {
        externalPort: port,
        lockPassword,
      }).catch(() => {});
      if (locked)
        await regularCtx.delete(
          `/api/containers/${normalWorker}/protection`,
          { data: { password: lockPassword } },
        );
    }
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
    // A newly-created worker can still be rendering its full-screen startup
    // status when the tmux attachment opens. Sending shell input during that
    // phase feeds the status program and is intentionally not queued. Wait for
    // the actual shell prompt before exercising console input.
    let readyOutput = "";
    for (let attempt = 0; attempt < 100; attempt++) {
      const read = await invoke(request, credential, "console.read", {
        sessionId,
        from: 0,
      });
      expect(read.status()).toBe(200);
      readyOutput = (await read.json()).output;
      if (/agent@[^\r\n]*\$\s/.test(readyOutput)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(readyOutput).toMatch(/agent@[^\r\n]*\$\s/);
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
      // The attached PTY echoes the command before executing it. Wait for the
      // expanded worker id, not merely the marker embedded in that echo.
      if (output.includes(`${marker}:${normalWorker}:[REDACTED]`)) break;
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
