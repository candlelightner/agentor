import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";

/**
 * This is deliberately opt-in: it fetches the pinned, upstream Codex-LB wheel
 * and npm packages.  It is a replay of the credential-free portions of the
 * reference workflow, not a replacement for its required human login steps.
 */
const ENABLED = process.env.RUN_REFERENCE_WORKFLOW === "1";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
type ImageDefinitionInput = {
  name: string;
  description: string;
  baseImage: string;
  dockerfileFragment: string;
  contextFiles: Array<{ path: string; contentBase64: string }>;
};

const stageA = {
  name: `reference-stage-a-${Date.now()}`,
  description: "Credential-free reference acceptance: Codex-LB and OmniRoute.",
  baseImage: "agentor-worker:approved-latest",
  dockerfileFragment:
    "RUN python3 -m pip install --no-cache-dir --break-system-packages uv==0.12.3 && UV_PYTHON_INSTALL_DIR=/opt/uv-python uv python install 3.13 && curl --fail --location --silent --show-error https://github.com/Soju06/codex-lb/releases/download/v1.23.0/codex_lb-1.23.0-py3-none-any.whl -o /tmp/codex_lb-1.23.0-py3-none-any.whl && echo '8c566151f442a1a13ce8701ed66d694508035fcd2c1a4e321552f23dcf0f167a  /tmp/codex_lb-1.23.0-py3-none-any.whl' > /tmp/codex-lb.sha256 && sha256sum --check --strict /tmp/codex-lb.sha256 && UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_TOOL_DIR=/opt/uv-tools UV_TOOL_BIN_DIR=/usr/local/bin uv tool install --python 3.13 /tmp/codex_lb-1.23.0-py3-none-any.whl && rm /tmp/codex_lb-1.23.0-py3-none-any.whl /tmp/codex-lb.sha256 && npm install --global omniroute@3.8.49\n",
  contextFiles: [],
};
const stageDTemplate =
  '[mcp_servers.tavily]\ncommand = "tavily-mcp"\nenv_vars = ["TAVILY_API_KEY"]\n';
const stageD = {
  name: `reference-stage-d-${Date.now()}`,
  description:
    "Credential-free reference acceptance: OmniRoute and Tavily template.",
  baseImage: "agentor-worker:approved-latest",
  dockerfileFragment:
    "RUN npm install --global omniroute@3.8.49 tavily-mcp@0.2.22 && mkdir -p /opt/agentor-templates\nCOPY --chown=agent:agent codex-tavily.toml /opt/agentor-templates/codex-tavily.toml\n",
  contextFiles: [
    {
      path: "codex-tavily.toml",
      contentBase64: Buffer.from(stageDTemplate).toString("base64"),
    },
  ],
};

async function invoke(
  request: APIRequestContext,
  credential: string,
  tool: string,
  args: Record<string, unknown> = {},
) {
  const response = await request.post(
    "/api/admin/management-mcp/diagnostics/invoke",
    {
      data: { credential, tool, arguments: args },
    },
  );
  const text = await response.text();
  let value: any = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* retain diagnostic body */
  }
  expect(
    response.status(),
    `${tool}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  ).toBeGreaterThanOrEqual(200);
  expect(
    response.status(),
    `${tool}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  ).toBeLessThan(300);
  return value;
}

async function issueIdentity(request: APIRequestContext, workspaceId: string) {
  const response = await request.post(
    "/api/admin/management-mcp/diagnostics/issue-identity",
    {
      data: { workspaceId, ttlSeconds: 60 },
    },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).credential as string;
}

async function buildThroughMcp(
  request: APIRequestContext,
  workspaceId: string,
  ownerId: string,
  definition: ImageDefinitionInput,
  definitionIds: string[],
  buildIds: string[],
) {
  let credential = await issueIdentity(request, workspaceId);
  const validation = await invoke(request, credential, "images.validate", {
    ownerId,
    definition,
  });
  expect(validation).toMatchObject({ valid: true });
  const created = await invoke(request, credential, "images.create", {
    ownerId,
    definition,
  });
  expect(created.id).toEqual(expect.any(String));
  definitionIds.push(created.id);
  const started = await invoke(request, credential, "images.build", {
    ownerId,
    definitionId: created.id,
    builder: "controlled",
  });
  expect(started.id).toEqual(expect.any(String));
  buildIds.push(started.id);

  let lastLogs = "";
  let build: any;
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    // Diagnostic identities intentionally expire quickly; refresh while a
    // genuine controlled build is running rather than retaining a bearer.
    credential = await issueIdentity(request, workspaceId);
    const logs = await invoke(request, credential, "images.build-logs", {
      ownerId,
      buildId: started.id,
      after: 0,
    });
    lastLogs = Array.isArray(logs.logs)
      ? logs.logs.join("\n")
      : String(logs.logs || "");
    build = await invoke(request, credential, "images.build-status", {
      ownerId,
      buildId: started.id,
    });
    if (build.status === "succeeded") break;
    if (["failed", "cancelled"].includes(build.status)) {
      throw new Error(
        `Controlled image build ${build.status}: ${String(build.error || "no safe error supplied")}\n${lastLogs}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  expect(
    build?.status,
    `Controlled image build exceeded its 20 minute deadline.\n${lastLogs}`,
  ).toBe("succeeded");
  expect(lastLogs).not.toMatch(
    /(?:OMNIROUTE_API_KEY|TAVILY_API_KEY|CODEX_LB_API_KEY)\s*=/i,
  );
  expect(build.version).toEqual(expect.any(String));
  expect(build.digest).toMatch(/^sha256:/);
  return { definitionId: created.id as string, build, credential };
}

async function runConsole(
  request: APIRequestContext,
  workspaceId: string,
  workerId: string,
  command: string,
  expected: RegExp,
) {
  let credential = await issueIdentity(request, workspaceId);
  const opened = await invoke(request, credential, "console.open", {
    workerId,
    windowIndex: 0,
  });
  const sessionId = opened.id as string;
  expect(sessionId).toEqual(expect.any(String));
  try {
    await invoke(request, credential, "console.write", {
      sessionId,
      input: `${command}\n`,
    });
    let output = "";
    await expect
      .poll(
        async () => {
          credential = await issueIdentity(request, workspaceId);
          const read = await invoke(request, credential, "console.read", {
            sessionId,
            from: 0,
          });
          output = String(read.output || read.data || "");
          return expected.test(output);
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    return output;
  } finally {
    credential = await issueIdentity(request, workspaceId).catch(() => "");
    if (credential)
      await invoke(request, credential, "console.close", { sessionId }).catch(
        () => {},
      );
  }
}

test.describe
  .serial("Reference routed-agent workflow (opt-in, MCP diagnostics dispatch)", () => {
  test.skip(
    !ENABLED,
    "Set RUN_REFERENCE_WORKFLOW=1 to download and build pinned external Stage A/D artifacts.",
  );

  let owner: CreatedUser;
  let userContext: APIRequestContext;
  let originalPolicy: Record<string, boolean> = {};
  let workspaceId = "";
  const definitionIds: string[] = [];
  const buildIds: string[] = [];
  const workerIds: string[] = [];

  test.beforeAll(async ({ request }) => {
    const policyResponse = await request.get(
      "/api/admin/management-mcp/policy",
    );
    expect(policyResponse.status()).toBe(200);
    const currentPolicy = await policyResponse.json();
    originalPolicy = Object.fromEntries(
      Object.entries(currentPolicy.groups).map(
        ([name, value]: [string, any]) => [name, value.enabled],
      ),
    );
    owner = await createTestUser("Reference workflow MCP");
    userContext = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      storageState: { cookies: [], origins: [] },
    });
    const workspace = await (
      await request.post("/api/admin/workspace", { data: {} })
    ).json();
    workspaceId = workspace.id;
    const policy = await request.put("/api/admin/management-mcp/policy", {
      data: {
        groups: {
          images: true,
          "image-builds": true,
          "worker-lifecycle": true,
          console: true,
          configuration: true,
        },
      },
    });
    expect(policy.status()).toBe(200);
  });

  test.afterAll(async ({ request }) => {
    // Removal goes through MCP as well, so this test never takes a shortcut
    // through the private image or worker REST APIs.
    const cleanupErrors: string[] = [];
    const attempt = async (
      label: string,
      operation: () => Promise<unknown>,
    ) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(`${label}: ${String(error)}`);
      }
    };
    for (const buildId of buildIds.reverse()) {
      await attempt(`cancel build ${buildId}`, async () => {
        const credential = await issueIdentity(request, workspaceId);
        await invoke(request, credential, "images.build-cancel", {
          ownerId: owner.id,
          buildId,
        });
      });
    }
    for (const workerId of workerIds.reverse()) {
      await attempt(`delete worker ${workerId}`, async () => {
        const credential = await issueIdentity(request, workspaceId);
        await invoke(request, credential, "workers.delete", { workerId });
      });
    }
    for (const definitionId of definitionIds.reverse()) {
      await attempt(`delete definition ${definitionId}`, async () => {
        const credential = await issueIdentity(request, workspaceId);
        await invoke(request, credential, "images.delete", {
          ownerId: owner.id,
          definitionId,
        });
      });
    }
    if (Object.keys(originalPolicy).length) {
      await attempt("restore management MCP policy", async () => {
        const restored = await request.put("/api/admin/management-mcp/policy", {
          data: { groups: originalPolicy },
        });
        expect(restored.status()).toBe(200);
      });
    }
    await userContext?.dispose();
    if (owner) {
      await attempt(`delete test user ${owner.id}`, async () => {
        const deleted = await request.post("/api/auth/admin/remove-user", {
          data: { userId: owner.id },
        });
        expect(deleted.status()).toBe(200);
      });
    }
    expect(cleanupErrors).toEqual([]);
  });

  test(
    "builds and smoke-tests the credential-free Stage A and Stage D definitions without promotion",
    async ({ request }, testInfo) => {
      testInfo.setTimeout(45 * 60_000);
      const workflows = [
        {
          label: "stage-a",
          definition: stageA,
          command:
            "command -v codex-lb && command -v omniroute && command -v firefox && mkdir -p /workspace/.codex-lb && ln -sfn /workspace/.codex-lb ~/.codex-lb && tmux new-session -d -s codex-lb 'codex-lb' && tmux new-session -d -s omniroute 'omniroute' && for url in http://127.0.0.1:2455 http://127.0.0.1:20128; do for i in $(seq 1 60); do curl --fail --silent --output /dev/null \"$url\" && break; sleep 1; done; curl --fail --silent --output /dev/null \"$url\" || exit 1; done && (DISPLAY=:99 firefox --new-window http://127.0.0.1:2455 >/tmp/agentor-reference-firefox.log 2>&1 & DISPLAY=:99 firefox --new-window http://127.0.0.1:20128 >>/tmp/agentor-reference-firefox.log 2>&1 & sleep 5; pgrep -f firefox >/dev/null) && echo AGENTOR_REFERENCE_STAGE_A_OK",
          expected: /AGENTOR_REFERENCE_STAGE_A_OK/,
        },
        {
          label: "stage-d",
          definition: stageD,
          command:
            "command -v omniroute && omniroute --help >/dev/null && command -v tavily-mcp && npm list --global --depth=0 tavily-mcp@0.2.22 >/dev/null && mkdir -p ~/.codex && (test -f ~/.codex/config.toml || cp /opt/agentor-templates/codex-tavily.toml ~/.codex/config.toml) && grep -F 'env_vars = [\\\"TAVILY_API_KEY\\\"]' ~/.codex/config.toml && echo AGENTOR_REFERENCE_STAGE_D_OK",
          expected: /AGENTOR_REFERENCE_STAGE_D_OK/,
        },
      ] as const;
      for (const { label, definition, command, expected } of workflows) {
        const built = await buildThroughMcp(
          request,
          workspaceId,
          owner.id,
          definition,
          definitionIds,
          buildIds,
        );
        const credential = await issueIdentity(request, workspaceId);
        const worker =
          label === "stage-d"
            ? await invoke(request, credential, "workers.create", {
                userId: owner.id,
                imageDefinitionId: built.definitionId,
                imageVersion: built.build.version,
                displayName: `reference-${label}-${Date.now()}`,
                configuration: {
                  variables: [
                    {
                      key: "OMNIROUTE_URL",
                      value: "http://reference.invalid:20128",
                    },
                  ],
                  secrets: [
                    {
                      key: "OMNIROUTE_API_KEY",
                      value: "reference-not-a-real-key",
                    },
                    {
                      key: "TAVILY_API_KEY",
                      value: "reference-not-a-real-key",
                    },
                  ],
                },
              })
            : await invoke(request, credential, "images.test-worker", {
                ownerId: owner.id,
                definitionId: built.definitionId,
                version: built.build.version,
                displayName: `reference-${label}-${Date.now()}`,
              });
        workerIds.push(worker.id);
        if (worker.status !== "running")
          await invoke(request, credential, "worker.start", {
            workerId: worker.id,
          });
        if (label === "stage-d") {
          const configuration = await invoke(
            request,
            await issueIdentity(request, workspaceId),
            "configuration.get",
            { workerId: worker.id },
          );
          const serialized = JSON.stringify(configuration);
          expect(serialized).toContain("OMNIROUTE_URL");
          expect(serialized).toContain("OMNIROUTE_API_KEY");
          expect(serialized).toContain("TAVILY_API_KEY");
          expect(serialized).not.toContain("reference-not-a-real-key");
        }
        await runConsole(request, workspaceId, worker.id, command, expected);
      }
    },
    45 * 60_000,
  );
});
