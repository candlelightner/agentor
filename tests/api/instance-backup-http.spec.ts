import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { PublicInstanceBackupJob } from "../../orchestrator/server/utils/instance-backup-types";

const applyingRestore: PublicInstanceBackupJob = {
  schemaVersion: 1,
  id: "restore-applying",
  userId: "instance-admin",
  operation: "restore",
  provider: "local",
  status: "running",
  phase: "applying",
  progress: 75,
  bytesProcessed: 42,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
  logLineCount: 3,
};

let instanceBackupRequestId: (
  event: any,
  bodyRequestId: unknown,
) => string | undefined;
let instanceBackupHttpJob: (job: PublicInstanceBackupJob) => any;

function httpError(input: { statusCode: number; statusMessage: string }) {
  return Object.assign(new Error(input.statusMessage), input);
}

test.beforeAll(async () => {
  // Server route modules use Nuxt auto-imports.  Install the smallest faithful
  // boundary here so these tests exercise the actual handlers without a live
  // Docker/restore environment.
  Object.assign(globalThis, {
    createError: httpError,
    getHeader: (event: any, key: string) => event.headers?.[key.toLowerCase()],
  });
  ({ instanceBackupRequestId, instanceBackupHttpJob } = await import(
    "../../orchestrator/server/utils/instance-backup-http"
  ));
});

test("instance-backup REST start rejects mismatched header and body request identities", async () => {
  const event = {
    headers: { "idempotency-key": "header-identity" },
  };
  expect(() => instanceBackupRequestId(event, "body-identity")).toThrow(
    "Idempotency-Key header and requestId body field must match when both are supplied",
  );
});

test("persisted instance-backup status exposes its current follow-up actions", async () => {
  const response = instanceBackupHttpJob(applyingRestore);
  expect(response).toMatchObject({
    id: applyingRestore.id,
    status: "running",
    phase: "applying",
    nextActions: {
      status: {
        method: "GET",
        endpoint: `/api/admin/instance-backups/jobs/${applyingRestore.id}`,
      },
      logs: {
        method: "GET",
        endpoint: `/api/admin/instance-backups/jobs/${applyingRestore.id}/logs`,
      },
    },
  });
  expect(response.nextActions.cancel).toBeUndefined();
  expect(response.logs).toBeUndefined();
  expect(response.logLineCount).toBe(3);
});

test("instance-backup log route has a strict bounded integer cursor boundary", async () => {
  const source = await readFile(
    new URL(
      "../../orchestrator/server/api/admin/instance-backups/jobs/[id]/logs.get.ts",
      import.meta.url,
    ),
    "utf8",
  );
  expect(source).toContain('integerQuery(query.after, "after", 0, Number.MAX_SAFE_INTEGER, 0)');
  expect(source).toContain('integerQuery(query.limit, "limit", 1, 200, 100)');
  expect(source).toContain("/^\\d+$/.test(value)");
  expect(source).toContain("statusCode: 400");
});
