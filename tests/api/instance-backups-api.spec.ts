import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
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

async function waitForJob(request: APIRequestContext, endpoint: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request.get(endpoint);
    expect(response.status()).toBe(200);
    const job = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Instance backup discovery job did not become terminal");
}

test.describe.serial("whole-instance disaster-recovery REST boundary", () => {
  let regular: CreatedUser;
  let regularRequest: APIRequestContext;
  let anonymous: APIRequestContext;

  test.beforeAll(async () => {
    regular = await createTestUser("Instance DR REST isolation");
    regularRequest = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (
        await new ApiClient(regularRequest).signInEmail(
          regular.email,
          regular.password,
        )
      ).status,
    ).toBe(200);
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
  });

  test.afterAll(async () => {
    await regularRequest?.dispose();
    await anonymous?.dispose();
    await deleteTestUser(regular.id);
  });

  test("is unavailable to anonymous and non-platform-admin callers", async ({
    request,
  }) => {
    expect((await anonymous.get("/api/admin/instance-backups")).status()).toBe(
      401,
    );
    expect(
      (await regularRequest.get("/api/admin/instance-backups")).status(),
    ).toBe(403);
    expect((await request.get("/api/admin/instance-backups")).status()).toBe(
      200,
    );
  });

  test("starts provider discovery asynchronously with retry-safe identity and concrete next actions", async ({
    request,
  }) => {
    const connected = await request.post("/api/backup-providers/fake/connect", {
      data: { testMode: true, accountId: `instance-rest-${Date.now()}` },
    });
    expect(connected.status()).toBe(201);

    const requestId = `instance-discovery-${Date.now()}`;
    const start = () =>
      request.post("/api/admin/instance-backups/remote", {
        headers: { "Idempotency-Key": requestId },
        data: { provider: "fake", requestId },
      });
    const first = await start();
    expect(first.status()).toBe(202);
    const accepted = await first.json();
    expect(accepted).toMatchObject({
      accepted: true,
      jobId: expect.any(String),
      state: expect.stringMatching(/queued|running/),
      nextActions: {
        status: { method: "GET", endpoint: expect.any(String) },
        logs: { method: "GET", endpoint: expect.any(String) },
        cancel: { method: "DELETE", endpoint: expect.any(String) },
      },
    });

    const retry = await start();
    expect(retry.status()).toBe(202);
    expect((await retry.json()).jobId).toBe(accepted.jobId);

    const terminal = await waitForJob(
      request,
      accepted.nextActions.status.endpoint,
    );
    expect(terminal).toMatchObject({
      id: accepted.jobId,
      operation: "discovery",
      status: "succeeded",
      nextActions: {
        status: accepted.nextActions.status,
        logs: accepted.nextActions.logs,
      },
    });
    expect(terminal.nextActions.cancel).toBeUndefined();

    const logs = await request.get(accepted.nextActions.logs.endpoint, {
      params: { after: "0", limit: "1" },
    });
    expect(logs.status()).toBe(200);
    expect(await logs.json()).toMatchObject({
      jobId: accepted.jobId,
      after: 0,
      next: expect.any(Number),
      hasMore: expect.any(Boolean),
      logs: expect.any(Array),
    });
    expect(
      (
        await request.get(accepted.nextActions.logs.endpoint, {
          params: { after: "-1" },
        })
      ).status(),
    ).toBe(400);
  });

  test("rejects conflicting header/body idempotency identities before starting a job", async ({
    request,
  }) => {
    const response = await request.post(
      "/api/admin/instance-backups/remote",
      {
        headers: { "Idempotency-Key": "instance-header-identity" },
        data: {
          provider: "fake",
          requestId: "instance-body-identity",
        },
      },
    );
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain(
      "Idempotency-Key header and requestId body field must match",
    );
  });
});
