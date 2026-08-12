import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import {
  createWorker,
  cleanupWorker,
  waitForWorkerRunning,
} from "../helpers/worker-lifecycle";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";
import { TerminalWsClient } from "../helpers/terminal-ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

type ConfigInput = {
  variables?: Array<{ key: string; value: string }>;
  secrets?: Array<{ key: string; value: string }>;
  secretFiles?: Array<{ name: string; path: string; content: string }>;
  envFile?: string;
};

async function body(res: APIResponse): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function putConfig(
  ctx: APIRequestContext,
  workerId: string,
  data: ConfigInput,
) {
  const res = await ctx.put(`/api/containers/${workerId}/configuration`, {
    data,
  });
  return { status: res.status(), body: await body(res) };
}

async function getConfig(ctx: APIRequestContext, workerId: string) {
  const res = await ctx.get(`/api/containers/${workerId}/configuration`);
  return { status: res.status(), body: await body(res) };
}

async function shellValue(
  ctx: APIRequestContext,
  workerId: string,
  expression: string,
): Promise<string> {
  const api = new ApiClient(ctx);
  let pane: number | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    const created = await api.createPane(workerId);
    if (created.status === 201 && typeof created.body.index === "number") {
      pane = created.body.index;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (pane === undefined)
    throw new Error("worker terminal did not become ready");
  const ws = new TerminalWsClient(workerId, String(pane));
  const marker = `CFG_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  try {
    await ws.connect();
    await ws.waitForOutput(/[$#>]\s*$/, 15_000);
    ws.sendLine("stty -echo");
    await ws.waitForOutput(/[$#>]\s*$/, 5_000);
    ws.clearBuffer();
    ws.sendLine(
      `printf '${marker}_BEGIN\\n'; printf '%s\\n' "${expression}"; printf '${marker}_END\\n'; stty echo`,
    );
    const output = await ws.waitForOutput(
      new RegExp(`${marker}_END(?:\\r?\\n|$)`),
      20_000,
    );
    const framed = output.match(
      new RegExp(`${marker}_BEGIN\\r?\\n([\\s\\S]*?)\\r?\\n${marker}_END`),
    );
    if (!framed)
      throw new Error(`terminal output did not contain ${marker} frame`);
    return framed[1]!.trim();
  } finally {
    ws.close();
    await api.deletePane(workerId, pane).catch(() => {});
  }
}

function assertSecretAbsent(value: unknown, ...sentinels: string[]) {
  const serialized = JSON.stringify(value);
  for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
}

test.describe.serial("Worker-local configuration security", () => {
  let workerA = "";
  let workerB = "";
  let otherWorker = "";
  let otherUser: CreatedUser;
  let otherCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const variableValue = `worker-local-variable-${stamp}`;
  const secretValue = `worker-local-secret-${stamp}`;
  const secretFileValue = `worker-local-file-secret-${stamp}`;

  test.beforeAll(async ({ request }) => {
    workerA = (
      await createWorker(request, { displayName: `config-a-${stamp}` })
    ).id;
    workerB = (
      await createWorker(request, { displayName: `config-b-${stamp}` })
    ).id;
    otherUser = await createTestUser("Worker Config Other");
    otherCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await new ApiClient(otherCtx).signInEmail(
          otherUser.email,
          otherUser.password,
        )
      ).status,
    ).toBe(200);
    otherWorker = (
      await createWorker(otherCtx, { displayName: `config-other-${stamp}` })
    ).id;
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
  });

  test.afterAll(async ({ request }) => {
    if (workerA) await cleanupWorker(request, workerA).catch(() => {});
    if (workerB) await cleanupWorker(request, workerB).catch(() => {});
    if (otherWorker) await cleanupWorker(otherCtx, otherWorker).catch(() => {});
    await otherCtx?.dispose();
    await anonymous?.dispose();
    if (otherUser) await deleteTestUser(otherUser.id).catch(() => {});
  });

  test("configuration endpoints require authentication and worker ownership", async () => {
    expect((await getConfig(anonymous, workerA)).status).toBe(401);
    expect(
      (await putConfig(anonymous, workerA, { variables: [] })).status,
    ).toBe(401);
    expect((await getConfig(otherCtx, workerA)).status).toBe(403);
    expect((await putConfig(otherCtx, workerA, { variables: [] })).status).toBe(
      403,
    );
  });

  test("stores distinct variables, masked secrets, and secret files without returning secret values", async ({
    request,
  }) => {
    const saved = await putConfig(request, workerA, {
      variables: [{ key: "WORKER_LOCAL_VISIBLE", value: variableValue }],
      secrets: [{ key: "WORKER_LOCAL_SECRET", value: secretValue }],
      secretFiles: [
        {
          name: "service-token",
          path: "nested/service-token",
          content: secretFileValue,
        },
      ],
    });
    expect(saved.status).toBe(200);
    assertSecretAbsent(saved.body, secretValue, secretFileValue);
    expect(saved.body).toMatchObject({
      pendingRebuild: true,
      secretsEncryptedAtRest: true,
    });

    const fetched = await getConfig(request, workerA);
    expect(fetched.status).toBe(200);
    assertSecretAbsent(fetched.body, secretValue, secretFileValue);
    expect(fetched.body.local.secrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "WORKER_LOCAL_SECRET",
          configured: true,
          masked: true,
          encryptedAtRest: true,
        }),
      ]),
    );
    expect(fetched.body.local.secretFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "service-token",
          path: "nested/service-token",
          configured: true,
          encryptedAtRest: true,
        }),
      ]),
    );
  });

  test("effective preview reports precedence and source without revealing secret values", async ({
    request,
  }) => {
    const config = await getConfig(request, workerA);
    expect(config.status).toBe(200);
    const visible = config.body.effective.find(
      (item: any) => item.key === "WORKER_LOCAL_VISIBLE",
    );
    const secret = config.body.effective.find(
      (item: any) => item.key === "WORKER_LOCAL_SECRET",
    );
    expect(visible).toMatchObject({
      value: variableValue,
      source: "worker",
      type: "variable",
    });
    expect(secret).toMatchObject({
      source: "worker",
      type: "secret",
      masked: true,
    });
    expect(secret).not.toHaveProperty("value");
    expect(config.body.precedence).toEqual([
      "orchestrator",
      "user",
      "environment",
      "worker",
    ]);
  });

  test("bulk env import trims comments, resolves duplicate names deterministically, and preserves equals signs", async ({
    request,
  }) => {
    const result = await putConfig(request, workerB, {
      envFile:
        "# comment\nBULK_ALPHA=first\nBULK_EQUALS=left=right\nBULK_ALPHA=last\n\n",
      variables: [{ key: "BULK_ALPHA", value: "typed-wins" }],
    });
    expect(result.status).toBe(200);
    expect(result.body.local.variables).toEqual(
      expect.arrayContaining([
        { key: "BULK_ALPHA", value: "typed-wins" },
        { key: "BULK_EQUALS", value: "left=right" },
      ]),
    );
  });

  test("rejects reserved names, invalid names, duplicate typed entries, and unsafe secret-file paths", async ({
    request,
  }) => {
    const cases: ConfigInput[] = [
      { variables: [{ key: "WORKER", value: "override" }] },
      { variables: [{ key: "bad-key", value: "x" }] },
      {
        variables: [
          { key: "DUPLICATE", value: "one" },
          { key: "DUPLICATE", value: "two" },
        ],
      },
      {
        variables: [{ key: "COLLISION", value: "plain" }],
        secrets: [{ key: "COLLISION", value: "secret" }],
      },
      { secretFiles: [{ name: "escape", path: "../outside", content: "x" }] },
      {
        secretFiles: [{ name: "absolute", path: "/tmp/outside", content: "x" }],
      },
    ];
    for (const input of cases)
      expect((await putConfig(request, workerB, input)).status).toBe(400);
  });

  test("changes are not injected before rebuild and are applied after rebuild", async ({
    request,
  }) => {
    expect(
      await shellValue(request, workerA, "${WORKER_LOCAL_VISIBLE-unset}"),
    ).toBe("unset");
    expect(
      (await new ApiClient(request).rebuildContainer(workerA)).status,
    ).toBe(200);
    await waitForWorkerRunning(request, workerA, 90_000);
    expect(
      await shellValue(request, workerA, "${WORKER_LOCAL_VISIBLE-unset}"),
    ).toBe(variableValue);
    expect(
      await shellValue(request, workerA, "${WORKER_LOCAL_SECRET-unset}"),
    ).toBe(secretValue);
    expect(
      await shellValue(
        request,
        workerA,
        "$(cat /run/agentor-secrets/nested/service-token 2>/dev/null || printf missing)",
      ),
    ).toBe(secretFileValue);
    expect(
      await shellValue(
        request,
        workerA,
        "$(stat -c %u:%a /run/agentor-secrets /run/agentor-secrets/.ready | paste -sd, -)",
      ),
    ).toBe("0:711,0:444");
    expect(
      await shellValue(
        request,
        workerA,
        "$(touch /run/agentor-secrets/forged 2>/dev/null && printf forged || printf blocked)",
      ),
    ).toBe("blocked");
    expect(
      await shellValue(
        request,
        workerA,
        `$(result=$(grep -RFl -- ${JSON.stringify(secretFileValue)} /workspace 2>/dev/null | head -1); [ -n "$result" ] && printf '%s' "$result" || printf absent)`,
      ),
    ).toBe("absent");
  });

  test("restart does not silently apply a pending configuration update", async ({
    request,
  }) => {
    const next = `pending-${stamp}`;
    expect(
      (
        await putConfig(request, workerA, {
          variables: [{ key: "WORKER_LOCAL_VISIBLE", value: next }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await new ApiClient(request).restartContainer(workerA)).status,
    ).toBe(200);
    await waitForWorkerRunning(request, workerA, 90_000);
    expect(
      await shellValue(request, workerA, "${WORKER_LOCAL_VISIBLE-unset}"),
    ).toBe(variableValue);
    expect((await getConfig(request, workerA)).body).toMatchObject({
      pendingRebuild: true,
    });
  });

  test("worker-local configuration never crosses into another worker of the same user", async ({
    request,
  }) => {
    expect(
      await shellValue(request, workerB, "${WORKER_LOCAL_SECRET-unset}"),
    ).toBe("unset");
    const config = await getConfig(request, workerB);
    assertSecretAbsent(config.body, secretValue, secretFileValue);
    expect(JSON.stringify(config.body)).not.toContain("WORKER_LOCAL_SECRET");
    expect(
      await shellValue(
        request,
        workerB,
        "$(cat /run/agentor-secrets/nested/service-token 2>/dev/null || printf absent)",
      ),
    ).toBe("absent");
  });

  test("worker-local configuration never crosses user boundaries", async () => {
    expect(
      await shellValue(otherCtx, otherWorker, "${WORKER_LOCAL_SECRET-unset}"),
    ).toBe("unset");
    const config = await getConfig(otherCtx, otherWorker);
    assertSecretAbsent(config.body, secretValue, secretFileValue);
    expect(JSON.stringify(config.body)).not.toContain("WORKER_LOCAL_SECRET");
  });

  test("clone copies non-secret variables but reports omitted secret names only", async ({
    request,
  }) => {
    const res = await request.post(`/api/containers/${workerA}/clone`, {
      data: { displayName: `config-clone-${stamp}` },
    });
    expect(res.status()).toBe(201);
    const cloned = await res.json();
    try {
      expect(cloned.missingSecrets).toEqual(
        expect.arrayContaining(["WORKER_LOCAL_SECRET", "service-token"]),
      );
      assertSecretAbsent(cloned, secretValue, secretFileValue);
      const config = await getConfig(request, cloned.id);
      expect(config.body.effective).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "WORKER_LOCAL_VISIBLE",
            source: "worker",
          }),
        ]),
      );
      assertSecretAbsent(config.body, secretValue, secretFileValue);
    } finally {
      if (cloned.id) await cleanupWorker(request, cloned.id).catch(() => {});
    }
  });

  test("export manifest excludes secret values and reports omitted secret names", async ({
    request,
  }) => {
    const created = await request.post(
      `/api/containers/${workerA}/export-jobs`,
      { data: { includeRootfs: false } },
    );
    expect(created.status()).toBe(202);
    const job = await created.json();
    let state: any;
    for (let attempt = 0; attempt < 180; attempt++) {
      const status = await request.get(`/api/export-jobs/${job.id}`);
      state = await status.json();
      if (["succeeded", "failed", "cancelled"].includes(state.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(state.status).toBe("succeeded");
    expect(state.missingSecrets).toEqual(
      expect.arrayContaining(["WORKER_LOCAL_SECRET", "service-token"]),
    );
    assertSecretAbsent(state, secretValue, secretFileValue);
    const artifact = await request.get(`/api/export-jobs/${job.id}/download`);
    expect(artifact.status()).toBe(200);
    const bytes = await artifact.body();
    expect(bytes.includes(Buffer.from(secretValue))).toBe(false);
    expect(bytes.includes(Buffer.from(secretFileValue))).toBe(false);
  });

  test("secret values never appear in container/configuration/log API responses", async ({
    request,
  }) => {
    const responses = await Promise.all([
      request.get("/api/containers"),
      request.get(`/api/containers/${workerA}/configuration`),
      request.get(`/api/containers/${workerA}/logs`),
      request.get("/api/logs"),
    ]);
    for (const response of responses)
      assertSecretAbsent(await body(response), secretValue, secretFileValue);
  });
});
