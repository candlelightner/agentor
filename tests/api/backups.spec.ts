import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
} from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { ApiClient } from "../helpers/api-client";
import { createWorker, cleanupWorker } from "../helpers/worker-lifecycle";
import {
  createTestUser,
  deleteTestUser,
  type CreatedUser,
} from "../helpers/test-users";
import { captureCommandOutput, runCommandInWorker } from "../helpers/terminal-ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};
const SECRET_SENTINELS = [
  "BACKUP_DO_NOT_LEAK_TOKEN",
  "BACKUP_DO_NOT_LEAK_FILE",
];

async function body(res: APIResponse): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function waitForJob(
  ctx: APIRequestContext,
  jobId: string,
  timeout = 120_000,
): Promise<any> {
  const started = Date.now();
  let sawProgress = false;
  while (Date.now() - started < timeout) {
    const res = await ctx.get(`/api/backup-jobs/${jobId}`);
    expect(res.status()).toBe(200);
    const job = await res.json();
    sawProgress ||= Number(job.bytesProcessed) > 0 || Number(job.progress) > 0;
    if (["succeeded", "failed", "cancelled"].includes(job.status))
      return { ...job, sawProgress };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Backup job ${jobId} did not become terminal`);
}

async function startBackup(
  ctx: APIRequestContext,
  request: Record<string, unknown>,
) {
  const res = await ctx.post("/api/backups", { data: request });
  expect(res.status()).toBe(202);
  const created = await res.json();
  expect(created.id).toBeTruthy();
  return created;
}

test.describe
  .serial("Backup provider, scheduling, and restore management", () => {
  let owner: CreatedUser;
  let ownerCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  let workspaceA = "";
  let workspaceB = "";
  let successfulBackupId = "";
  let multiWorkspaceBackupId = "";

  test.beforeAll(async () => {
    owner = await createTestUser("Backup API Owner");
    ownerCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect(
      (await new ApiClient(ownerCtx).signInEmail(owner.email, owner.password))
        .status,
    ).toBe(200);
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    workspaceA = (
      await createWorker(ownerCtx, { displayName: `backup-a-${Date.now()}` })
    ).id;
    workspaceB = (
      await createWorker(ownerCtx, { displayName: `backup-b-${Date.now()}` })
    ).id;
    await new ApiClient(ownerCtx).uploadToWorkspace(workspaceA, [
      {
        name: "roundtrip.txt",
        content: Buffer.from("backup round trip marker"),
      },
    ]);
    await new ApiClient(ownerCtx).uploadToWorkspace(workspaceB, [
      {
        name: "workspace-b.txt",
        content: Buffer.from("second workspace marker"),
      },
    ]);
    const secretConfig = await ownerCtx.put(
      `/api/containers/${workspaceA}/configuration`,
      {
        data: {
          variables: [
            { key: "BACKUP_VISIBLE", value: "non-secret configuration" },
          ],
          secrets: [{ key: "BACKUP_TOKEN", value: SECRET_SENTINELS[0] }],
          secretFiles: [
            {
              name: "backup-key",
              path: "backup/key.txt",
              content: SECRET_SENTINELS[1],
            },
          ],
        },
      },
    );
    expect(secretConfig.status()).toBe(200);

    // The fake provider is deterministic, local to the test stack, and accepts
    // fault/chunk controls. No cloud account or credential is ever required.
    const provider = await ownerCtx.post("/api/backup-providers/fake/connect", {
      data: { testMode: true, chunkSize: 64 * 1024 },
    });
    expect(provider.status()).toBe(201);
  });

  test.afterAll(async () => {
    if (workspaceA) await cleanupWorker(ownerCtx, workspaceA).catch(() => {});
    if (workspaceB) await cleanupWorker(ownerCtx, workspaceB).catch(() => {});
    await ownerCtx?.dispose();
    await anonymous?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => {});
  });

  test("all backup surfaces require authentication and ownership while admin retains audited access", async ({
    request,
  }) => {
    for (const res of await Promise.all([
      anonymous.get("/api/backups"),
      anonymous.get("/api/backup-settings"),
      anonymous.post("/api/backups", { data: { workspaceIds: [workspaceA] } }),
      anonymous.get("/api/backup-jobs/not-a-job"),
    ]))
      expect(res.status()).toBe(401);

    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceA],
      providerId: "fake",
    });
    const adminRead = await request.get(`/api/backup-jobs/${created.id}`);
    expect(adminRead.status()).toBe(200);
    expect((await adminRead.json()).ownerId).toBe(owner.id);

    const other = await createTestUser("Backup API Other");
    const otherCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    try {
      expect(
        (await new ApiClient(otherCtx).signInEmail(other.email, other.password))
          .status,
      ).toBe(200);
      expect(
        (await otherCtx.get(`/api/backup-jobs/${created.id}`)).status(),
      ).toBe(403);
      expect(
        (await otherCtx.delete(`/api/backup-jobs/${created.id}`)).status(),
      ).toBe(403);
    } finally {
      await otherCtx.dispose();
      await deleteTestUser(other.id);
      await waitForJob(ownerCtx, created.id);
    }
  });

  test("manual selected-workspace backup is encrypted and integrity-verified before success", async () => {
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceA],
      providerId: "fake",
    });
    const job = await waitForJob(ownerCtx, created.id);
    expect(job).toMatchObject({
      status: "succeeded",
      integrityVerified: true,
      encrypted: true,
      provider: "fake",
    });
    expect(job.workspaceIds).toEqual([workspaceA]);
    expect(job.sawProgress).toBe(true);
    expect(job.sizeBytes).toBeGreaterThan(0);
    expect(job.durationMs).toBeGreaterThanOrEqual(0);
    expect(job.completedAt).toBeTruthy();
    successfulBackupId = job.backupId;

    const serialized = JSON.stringify(job);
    for (const sentinel of SECRET_SENTINELS)
      expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toMatch(
      /ciphertext|authTag|access_token|refresh_token/i,
    );
  });

  test("backup path picker metadata starts at workspace and can browse to the worker root", async () => {
    const initial = await ownerCtx.get(`/api/containers/${workspaceA}/backup-paths`);
    expect(initial.status()).toBe(200);
    expect((await initial.json()).path).toBe("/workspace");
    const root = await ownerCtx.get(`/api/containers/${workspaceA}/backup-paths?path=/`);
    expect(root.status()).toBe(200);
    expect((await root.json()).path).toBe("/");
  });

  test("an explicitly selected directory becomes a rebuild-persistent local volume", async () => {
    const path = "/home/agent/.agentor-persistent-backup-test";
    await captureCommandOutput(
      workspaceB,
      `mkdir -p '${path}' && printf rebuild-persistent > '${path}/state.txt' && printf retained > '${path}/retained.txt'`,
    );
    const settings = await ownerCtx.put("/api/backup-settings", {
      data: {
        enabled: false,
        selection: "selected",
        workspaceIds: [workspaceB],
        selectedPathsByWorkspace: {
          [workspaceB]: ["/workspace", "/home/agent/.agent-data", path],
        },
      },
    });
    expect(settings.status(), await settings.text()).toBe(200);
    expect((await new ApiClient(ownerCtx).rebuildContainer(workspaceB)).status).toBe(200);
    expect(
      (await captureCommandOutput(workspaceB, `cat '${path}/state.txt'`)).trim(),
    ).toBe("rebuild-persistent");
    expect(
      (
        await captureCommandOutput(
          workspaceB,
          `printf -- '-writable' >> '${path}/state.txt' && printf created > '${path}/after-rebuild.txt' && cat '${path}/state.txt'`,
        )
      ).trim(),
    ).toBe("rebuild-persistent-writable");

    const defaultsOnly = await ownerCtx.put("/api/backup-settings", {
      data: {
        enabled: false,
        selection: "selected",
        workspaceIds: [workspaceB],
        selectedPathsByWorkspace: {
          [workspaceB]: ["/workspace", "/home/agent/.agent-data"],
        },
      },
    });
    expect(defaultsOnly.status(), await defaultsOnly.text()).toBe(200);
    expect((await new ApiClient(ownerCtx).rebuildContainer(workspaceB)).status).toBe(200);
    await captureCommandOutput(
      workspaceB,
      `mkdir -p '${path}' && printf detached-current > '${path}/state.txt' && printf new > '${path}/detached.txt'`,
    );
    const reselected = await ownerCtx.put("/api/backup-settings", {
      data: {
        enabled: false,
        selection: "selected",
        workspaceIds: [workspaceB],
        selectedPathsByWorkspace: {
          [workspaceB]: ["/workspace", "/home/agent/.agent-data", path],
        },
      },
    });
    expect(reselected.status(), await reselected.text()).toBe(200);
    expect((await new ApiClient(ownerCtx).rebuildContainer(workspaceB)).status).toBe(200);
    expect(
      (
        await captureCommandOutput(
          workspaceB,
          `printf 'STATE=%s RETAINED=%s DETACHED=%s' "$(cat '${path}/state.txt')" "$(cat '${path}/retained.txt')" "$(cat '${path}/detached.txt')"`,
        )
      ).trim(),
    ).toBe("STATE=detached-current RETAINED=retained DETACHED=new");
  });

  test("an explicitly selected readable absolute path round-trips only into a new worker", async () => {
    const marker = `backup-extra-${Date.now()}`;
    await runCommandInWorker(workspaceA, `printf %s ${marker} > /tmp/${marker}.txt`);
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceA], providerId: "fake",
      selectedPathsByWorkspace: { [workspaceA]: [`/tmp/${marker}.txt`] },
    });
    const job = await waitForJob(ownerCtx, created.id);
    expect(job.status).toBe("succeeded");
    const restore = await ownerCtx.post(`/api/backups/${job.backupId}/restore`, { data: { target: "new" } });
    expect(restore.status()).toBe(202);
    const restored = await waitForJob(ownerCtx, (await restore.json()).jobId);
    try {
      expect(restored.status).toBe("succeeded");
      expect((await captureCommandOutput(restored.workerId, `cat /tmp/${marker}.txt`)).trim()).toBe(marker);
      expect(
        (
          await captureCommandOutput(
            restored.workerId,
            "[ -e /workspace/roundtrip.txt ] && echo present || echo absent",
          )
        ).trim(),
      ).toBe("absent");
      const original = await ownerCtx.post(`/api/backups/${job.backupId}/restore`, { data: { target: "original", workspaceIds: [workspaceA], confirmOverwrite: true } });
      expect(original.status()).toBe(409);
    } finally { if (restored?.workerId) await cleanupWorker(ownerCtx, restored.workerId).catch(() => {}); }
  });

  test("all-workspaces selection records each owned workspace and excludes foreign workspaces", async () => {
    const archived = (
      await createWorker(ownerCtx, {
        displayName: `backup-all-archived-${Date.now()}`,
      })
    ).id;
    let restored: any;
    try {
      expect(
        (
          await new ApiClient(ownerCtx).uploadToWorkspace(archived, [
            {
              name: "all-archived.txt",
              content: Buffer.from("archived all marker"),
            },
          ])
        ).status,
      ).toBe(200);
      expect(
        (await new ApiClient(ownerCtx).archiveContainer(archived)).status,
      ).toBe(200);
      const created = await startBackup(ownerCtx, {
        selection: "all",
        providerId: "fake",
      });
      const job = await waitForJob(ownerCtx, created.id);
      expect(job.status).toBe("succeeded");
      multiWorkspaceBackupId = job.backupId;
      expect(job.workspaceIds).toEqual(
        expect.arrayContaining([workspaceA, workspaceB, archived]),
      );
      expect(
        job.workspaceIds.every((id: string) =>
          [workspaceA, workspaceB, archived].includes(id),
        ),
      ).toBe(true);
      const restore = await ownerCtx.post(
        `/api/backups/${job.backupId}/restore`,
        { data: { target: "new" } },
      );
      expect(restore.status()).toBe(202);
      restored = await waitForJob(ownerCtx, (await restore.json()).jobId);
      expect(restored.status).toBe("succeeded");
      expect(restored.workerIds).toHaveLength(3);
      const payloads = [];
      for (const id of restored.workerIds)
        payloads.push(await new ApiClient(ownerCtx).downloadWorkspace(id));
      const restoredTars = payloads.map((result) =>
        gunzipSync(result.body).toString("utf8"),
      );
      expect(restoredTars.some((tar) => tar.includes("roundtrip.txt"))).toBe(
        true,
      );
      expect(restoredTars.some((tar) => tar.includes("workspace-b.txt"))).toBe(
        true,
      );
      expect(restoredTars.some((tar) => tar.includes("all-archived.txt"))).toBe(
        true,
      );
    } finally {
      for (const id of restored?.workerIds ?? [])
        await cleanupWorker(ownerCtx, id);
      await new ApiClient(ownerCtx)
        .deleteArchivedWorker(archived)
        .catch(() => {});
    }
  });

  test("an existing multi-workspace artifact restores an explicit new-worker subset and defaults to every omitted workspace", async () => {
    expect(multiWorkspaceBackupId).toBeTruthy();
    const subsetResponse = await ownerCtx.post(
      `/api/backups/${multiWorkspaceBackupId}/restore`,
      { data: { target: "new", workspaceIds: [workspaceB] } },
    );
    expect(subsetResponse.status()).toBe(202);
    const subset = await waitForJob(
      ownerCtx,
      (await subsetResponse.json()).jobId,
    );
    try {
      expect(subset).toMatchObject({
        status: "succeeded",
        target: "new",
        artifactWorkspaceIds: expect.arrayContaining([workspaceA, workspaceB]),
        selectedWorkspaceIds: [workspaceB],
        workerIds: [expect.any(String)],
      });
      expect(subset.workerIds).toHaveLength(1);
      const restored = gunzipSync(
        (await new ApiClient(ownerCtx).downloadWorkspace(subset.workerIds[0]))
          .body,
      ).toString("utf8");
      expect(restored).toContain("workspace-b.txt");
      expect(restored).not.toContain("roundtrip.txt");
    } finally {
      for (const id of subset.workerIds ?? [])
        await cleanupWorker(ownerCtx, id).catch(() => {});
    }

    const allResponse = await ownerCtx.post(
      `/api/backups/${multiWorkspaceBackupId}/restore`,
      { data: { target: "new" } },
    );
    expect(allResponse.status()).toBe(202);
    const all = await waitForJob(ownerCtx, (await allResponse.json()).jobId);
    try {
      expect(all).toMatchObject({
        status: "succeeded",
        artifactWorkspaceIds: expect.arrayContaining([workspaceA, workspaceB]),
        selectedWorkspaceIds: expect.arrayContaining([workspaceA, workspaceB]),
      });
      expect(all.workerIds).toHaveLength(all.selectedWorkspaceIds.length);
    } finally {
      for (const id of all.workerIds ?? [])
        await cleanupWorker(ownerCtx, id).catch(() => {});
    }
  });

  test("the legacy synchronous artifact route restores the same exact subset", async () => {
    expect(multiWorkspaceBackupId).toBeTruthy();
    const response = await ownerCtx.post(
      `/api/backups/artifacts/${multiWorkspaceBackupId}/restore`,
      {
        data: {
          mode: "new",
          workspaceIds: [workspaceB],
          displayName: `legacy-subset-${Date.now()}`,
        },
        timeout: 120_000,
      },
    );
    expect(response.status()).toBe(201);
    const restored = await response.json();
    try {
      expect(restored.id).toEqual(expect.any(String));
      const archive = gunzipSync(
        (await new ApiClient(ownerCtx).downloadWorkspace(restored.id)).body,
      ).toString("utf8");
      expect(archive).toContain("workspace-b.txt");
      expect(archive).not.toContain("roundtrip.txt");
    } finally {
      if (restored?.id)
        await cleanupWorker(ownerCtx, restored.id).catch(() => {});
    }
  });

  test("selective restore rejects empty, duplicate, and non-member workspace lists before creating a job", async () => {
    const jobsBefore = (await (await ownerCtx.get("/api/backups")).json()).jobs
      .length;
    for (const workspaceIds of [
      [],
      [workspaceA, workspaceA],
      ["not-in-artifact"],
      workspaceA,
    ]) {
      const rejected = await ownerCtx.post(
        `/api/backups/${multiWorkspaceBackupId}/restore`,
        { data: { target: "new", workspaceIds } },
      );
      expect(rejected.status()).toBe(400);
    }
    expect((await (await ownerCtx.get("/api/backups")).json()).jobs).toHaveLength(
      jobsBefore,
    );
  });

  test("original-worker restore accepts one selected non-first artifact member and rejects multiple members", async () => {
    expect(
      (
        await new ApiClient(ownerCtx).uploadToWorkspace(workspaceA, [
          {
            name: "workspace-a-after-multi-backup.txt",
            content: Buffer.from("workspace A must remain untouched"),
          },
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await new ApiClient(ownerCtx).uploadToWorkspace(workspaceB, [
          {
            name: "workspace-b-after-multi-backup.txt",
            content: Buffer.from("workspace B mutation must be removed"),
          },
        ])
      ).status,
    ).toBe(200);
    expect(
      (await ownerCtx.post(`/api/containers/${workspaceB}/stop`)).status(),
    ).toBe(200);
    const jobsBefore = (await (await ownerCtx.get("/api/backups")).json()).jobs
      .length;
    const multiple = await ownerCtx.post(
      `/api/backups/${multiWorkspaceBackupId}/restore`,
      {
        data: {
          target: "original",
          confirmOverwrite: true,
          workspaceIds: [workspaceA, workspaceB],
        },
      },
    );
    expect(multiple.status()).toBe(400);
    expect((await (await ownerCtx.get("/api/backups")).json()).jobs).toHaveLength(
      jobsBefore,
    );

    const single = await ownerCtx.post(
      `/api/backups/${multiWorkspaceBackupId}/restore`,
      {
        data: {
          target: "original",
          confirmOverwrite: true,
          workspaceIds: [workspaceB],
        },
      },
    );
    expect(single.status()).toBe(202);
    const restore = await waitForJob(ownerCtx, (await single.json()).jobId);
    expect(restore).toMatchObject({
      status: "succeeded",
      target: "original",
      selectedWorkspaceIds: [workspaceB],
      workerId: workspaceB,
    });
    const restoredB = await ownerCtx.get(
      `/api/workspaces/${workspaceB}/download?path=workspace-b.txt`,
    );
    expect(restoredB.status()).toBe(200);
    expect(await restoredB.text()).toContain("second workspace marker");
    expect(
      (
        await ownerCtx.get(
          `/api/workspaces/${workspaceB}/download?path=workspace-b-after-multi-backup.txt`,
        )
      ).status(),
    ).toBe(404);
    const untouchedA = await ownerCtx.get(
      `/api/workspaces/${workspaceA}/download?path=workspace-a-after-multi-backup.txt`,
    );
    expect(untouchedA.status()).toBe(200);
    expect(await untouchedA.text()).toContain("workspace A must remain untouched");
    expect((await ownerCtx.post(`/api/containers/${workspaceB}/restart`)).status()).toBe(
      200,
    );
  });

  test("running workspace backup reports consistency strategy and warning", async () => {
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceB],
      providerId: "fake",
    });
    expect(created.consistency).toMatchObject({ workerState: "running" });
    expect(created.consistency.warning).toMatch(/running|change|consistent/i);
    expect(created.consistency.strategy).toMatch(
      /freeze|snapshot|best-effort|stop/i,
    );
    await waitForJob(ownerCtx, created.id);
  });

  test("archived workspace is backed up and restored without starting the original worker", async () => {
    const archived = (
      await createWorker(ownerCtx, {
        displayName: `backup-archived-${Date.now()}`,
      })
    ).id;
    let restored = "";
    try {
      expect(
        (
          await new ApiClient(ownerCtx).uploadToWorkspace(archived, [
            {
              name: "archived-only.txt",
              content: Buffer.from("archived backup marker"),
            },
          ])
        ).status,
      ).toBe(200);
      expect(
        (await new ApiClient(ownerCtx).archiveContainer(archived)).status,
      ).toBe(200);
      const created = await startBackup(ownerCtx, {
        workspaceIds: [archived],
        providerId: "fake",
      });
      expect(created.consistency).toMatchObject({ workerState: "archived" });
      const backup = await waitForJob(ownerCtx, created.id);
      expect(backup.status).toBe("succeeded");
      const restoreResponse = await ownerCtx.post(
        `/api/backups/${backup.backupId}/restore`,
        { data: { target: "new" } },
      );
      expect(restoreResponse.status()).toBe(202);
      const restore = await waitForJob(
        ownerCtx,
        (await restoreResponse.json()).jobId,
      );
      expect(restore.status).toBe("succeeded");
      restored = restore.workerId;
      expect(
        gunzipSync(
          (await new ApiClient(ownerCtx).downloadWorkspace(restored)).body,
        ).toString("utf8"),
      ).toContain("archived-only.txt");
      const inventory = await (await ownerCtx.get("/api/workspaces")).json();
      expect(
        inventory.find((entry: any) => entry.workerId === archived)?.state,
      ).toBe("archived");
    } finally {
      if (restored) await cleanupWorker(ownerCtx, restored).catch(() => {});
      await new ApiClient(ownerCtx)
        .deleteArchivedWorker(archived)
        .catch(() => {});
    }
  });

  test("schedule supports selected workspaces, interval, retention, enable/disable, and status timestamps", async () => {
    const update = await ownerCtx.put("/api/backup-settings", {
      data: {
        providerId: "fake",
        enabled: true,
        selection: "selected",
        workspaceIds: [workspaceA],
        intervalMinutes: 60,
        retentionCount: 3,
      },
    });
    expect(update.status()).toBe(200);
    const settings = await update.json();
    expect(settings).toMatchObject({
      enabled: true,
      selection: "selected",
      workspaceIds: [workspaceA],
      intervalMinutes: 60,
      retentionCount: 3,
    });
    expect(settings.nextRunAt).toBeTruthy();
    // The dashboard rehydrates from GET after a full page reload; keep a
    // regression assertion that the selected workspace configuration is
    // durable rather than only present in the PUT response.
    expect(await (await ownerCtx.get("/api/backup-settings")).json()).toMatchObject({
      enabled: true,
      selection: "selected",
      workspaceIds: [workspaceA],
    });

    const disabled = await ownerCtx.put("/api/backup-settings", {
      data: { enabled: false },
    });
    expect(disabled.status()).toBe(200);
    expect(await disabled.json()).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
  });

  test("retention cleanup preserves the configured newest backups and explicit deletion removes provider data", async () => {
    expect(
      (
        await ownerCtx.put("/api/backup-settings", {
          data: { providerId: "fake", retentionCount: 2 },
        })
      ).status(),
    ).toBe(200);
    for (let i = 0; i < 3; i++) {
      const created = await startBackup(ownerCtx, {
        workspaceIds: [workspaceA],
        providerId: "fake",
      });
      expect((await waitForJob(ownerCtx, created.id)).status).toBe("succeeded");
    }
    const list = await ownerCtx.get("/api/backups");
    expect(list.status()).toBe(200);
    const backups = (await list.json()).backups;
    expect(
      backups.filter((entry: any) => entry.workspaceIds.includes(workspaceA))
        .length,
    ).toBeLessThanOrEqual(2);
    const target = backups[0];
    // Retention may legitimately expire the earlier artifact captured by the
    // round-trip test. Keep that test pointed at a retained, non-deleted copy.
    successfulBackupId = (
      backups.find(
        (entry: any) =>
          entry.id !== target.id && entry.workspaceIds.includes(workspaceA),
      ) ?? target
    ).id;
    expect((await ownerCtx.delete(`/api/backups/${target.id}`)).status()).toBe(
      204,
    );
    expect((await ownerCtx.get(`/api/backups/${target.id}`)).status()).toBe(
      404,
    );
  });

  test("provider failure is safe, counted, retryable, and resumes without restarting completed chunks", async () => {
    expect(
      (
        await ownerCtx.post("/api/backup-providers/fake/faults", {
          data: { failUploadChunk: 1, failCount: 1 },
        })
      ).status(),
    ).toBe(200);
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceA],
      providerId: "fake",
    });
    const failed = await waitForJob(ownerCtx, created.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBeTruthy();
    expect(failed).toMatchObject({
      errorCode: "BACKUP_FAILED",
      retryable: true,
    });
    expect(failed.error).not.toMatch(/token|credential|cipher|stack|\/data\//i);
    expect(failed.attempt).toBe(1);
    const failedSettings = await (
      await ownerCtx.get("/api/backup-settings")
    ).json();
    expect(failedSettings.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(failedSettings.lastAttemptAt).toBeTruthy();
    expect(failedSettings.lastError).toBeTruthy();

    const retry = await ownerCtx.post(`/api/backup-jobs/${created.id}/retry`);
    expect(retry.status()).toBe(202);
    const succeeded = await waitForJob(ownerCtx, (await retry.json()).id);
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.attempt).toBe(2);
    expect(succeeded.resumedFromChunk).toBeGreaterThanOrEqual(1);
    const recoveredSettings = await (
      await ownerCtx.get("/api/backup-settings")
    ).json();
    expect(recoveredSettings).toMatchObject({
      consecutiveFailures: 0,
      lastError: null,
    });
    expect(recoveredSettings.lastSuccessAt).toBeTruthy();
  });

  test("cancellation is terminal and leaves no backup artifact", async () => {
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceB],
      providerId: "fake",
    });
    const cancelled = await ownerCtx.delete(`/api/backup-jobs/${created.id}`);
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).status).toBe("cancelled");
    const terminal = await waitForJob(ownerCtx, created.id);
    expect(terminal.status).toBe("cancelled");
    const list = await ownerCtx.get("/api/backups");
    expect(
      (await list.json()).backups.some(
        (artifact: any) =>
          artifact.id === created.artifactId || artifact.id === created.id,
      ),
    ).toBe(false);
  });

  test("encrypted restore round trip supports a new worker and verifies integrity before creation", async () => {
    expect(successfulBackupId).toBeTruthy();
    const restore = await ownerCtx.post(
      `/api/backups/${successfulBackupId}/restore`,
      { data: { target: "new", displayName: "restored-backup-worker" } },
    );
    expect(restore.status()).toBe(202);
    const job = await waitForJob(ownerCtx, (await restore.json()).jobId);
    expect(job).toMatchObject({
      status: "succeeded",
      integrityVerified: true,
      target: "new",
    });
    expect(job.workerId).not.toBe(workspaceA);
    expect(job.missingSecrets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: expect.any(String) }),
      ]),
    );
    for (const sentinel of SECRET_SENTINELS)
      expect(JSON.stringify(job.missingSecrets)).not.toContain(sentinel);

    const restored = await new ApiClient(ownerCtx).downloadWorkspace(
      job.workerId,
    );
    expect(restored.status, restored.body.toString("utf8")).toBe(200);
    expect(gunzipSync(restored.body).toString("utf8")).toContain(
      "roundtrip.txt",
    );
    await cleanupWorker(ownerCtx, job.workerId);
  });

  test("original-worker restore requires safety confirmation and the protected worker credential without leaking it", async () => {
    const lockPassword = `backup-restore-lock-${Date.now()}-password`;
    let locked = false;
    expect(
      (
        await new ApiClient(ownerCtx).uploadToWorkspace(workspaceA, [
          {
            name: "after-backup.txt",
            content: Buffer.from("must be removed by original restore"),
          },
        ])
      ).status,
    ).toBe(200);
    const unsafe = await ownerCtx.post(
      `/api/backups/${successfulBackupId}/restore`,
      { data: { target: "original" } },
    );
    expect(unsafe.status()).toBe(409);
    expect(String((await body(unsafe)).statusMessage || "")).toMatch(
      /running|stop|confirm|safe/i,
    );

    try {
      expect(
        (
          await ownerCtx.put(`/api/containers/${workspaceA}/protection`, {
            data: { password: lockPassword },
          })
        ).status(),
      ).toBe(200);
      locked = true;
      expect(
        (
          await ownerCtx.post(`/api/containers/${workspaceA}/stop`, {
            data: { lockPassword },
          })
        ).status(),
      ).toBe(200);

      // A protected source may still be restored as a separate new worker:
      // that operation does not mutate the protected original.
      const separate = await ownerCtx.post(
        `/api/backups/${successfulBackupId}/restore`,
        { data: { target: "new", displayName: "locked-source-copy" } },
      );
      expect(separate.status()).toBe(202);
      const separateJob = await waitForJob(
        ownerCtx,
        (await separate.json()).jobId,
      );
      expect(separateJob.status).toBe("succeeded");
      await cleanupWorker(ownerCtx, separateJob.workerId);

      const jobsBeforeDeniedRestore = (
        await (await ownerCtx.get("/api/backups")).json()
      ).jobs.length;

      for (const data of [
        { target: "original", confirmOverwrite: true },
        {
          target: "original",
          confirmOverwrite: true,
          lockPassword: "wrong-backup-restore-password",
        },
      ]) {
        const denied = await ownerCtx.post(
          `/api/backups/${successfulBackupId}/restore`,
          { data },
        );
        expect(denied.status()).toBe(423);
        expect(JSON.stringify(await body(denied))).not.toContain(lockPassword);
      }
      expect((await (await ownerCtx.get("/api/backups")).json()).jobs).toHaveLength(
        jobsBeforeDeniedRestore,
      );

      const accepted = await ownerCtx.post(
        `/api/backups/${successfulBackupId}/restore`,
        {
          data: {
            target: "original",
            confirmOverwrite: true,
            lockPassword,
          },
        },
      );
      expect(accepted.status()).toBe(202);
      const acceptedBody = await accepted.json();
      expect(JSON.stringify(acceptedBody)).not.toContain(lockPassword);
      const job = await waitForJob(ownerCtx, acceptedBody.jobId);
      expect(job.status).toBe("succeeded");
      expect(JSON.stringify(job)).not.toContain(lockPassword);
      for (const sentinel of SECRET_SENTINELS)
        expect(JSON.stringify(job)).not.toContain(sentinel);
      const restored = await ownerCtx.get(
        `/api/workspaces/${workspaceA}/download?path=roundtrip.txt`,
      );
      expect(restored.status()).toBe(200);
      expect(await restored.text()).toContain("backup round trip marker");
      const removed = await ownerCtx.get(
        `/api/workspaces/${workspaceA}/download?path=after-backup.txt`,
      );
      expect(removed.status()).toBe(404);
    } finally {
      if (locked)
        await ownerCtx.delete(`/api/containers/${workspaceA}/protection`, {
          data: { password: lockPassword },
        });
    }
  });

  test("Google OAuth validates state and stores tokens encrypted without exposing them", async () => {
    const start = await ownerCtx.post(
      "/api/backup-providers/google/oauth/start",
      {
        data: {
          redirectUri: `${BASE_URL}/api/backup-providers/google/oauth/callback`,
        },
      },
    );
    expect(start.status()).toBe(200);
    const challenge = await start.json();
    expect(challenge.authorizationUrl).toMatch(
      /^https:\/\/accounts\.google\.com\//,
    );
    expect(challenge.state).toBeTruthy();

    const invalid = await ownerCtx.get(
      "/api/backup-providers/google/oauth/callback?state=wrong-state&code=fake-test-code",
    );
    expect(invalid.status()).toBe(400);
    const callback = await ownerCtx.get(
      `/api/backup-providers/google/oauth/callback?state=${encodeURIComponent(challenge.state)}&code=fake-test-code`,
      { maxRedirects: 0 },
    );
    expect(callback.status()).toBe(302);

    const providers = await ownerCtx.get("/api/backup-providers");
    const text = await providers.text();
    expect(text).not.toMatch(
      /fake-test-code|access_token|refresh_token|ya29\./i,
    );
    expect(JSON.parse(text)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "google-drive",
          connected: true,
          tokenEncrypted: true,
        }),
      ]),
    );
  });

  test("resumable fake-provider diagnostics prove chunking without real credentials or secret-bearing logs", async () => {
    const provider = await ownerCtx.post("/api/backup-providers/fake/connect", {
      data: { testMode: true, chunkSize: 1024 },
    });
    expect(provider.status()).toBe(201);
    const created = await startBackup(ownerCtx, {
      workspaceIds: [workspaceA],
      providerId: "fake",
    });
    const job = await waitForJob(ownerCtx, created.id);
    expect(job.status).toBe("succeeded");
    const diagnostics = await ownerCtx.get(
      `/api/backup-providers/fake/uploads/${job.id}`,
    );
    expect(diagnostics.status()).toBe(200);
    const upload = await diagnostics.json();
    expect(upload.resumable).toBe(true);
    expect(upload.chunks.length).toBeGreaterThan(1);
    expect(
      upload.chunks.every(
        (chunk: any) => chunk.offset >= 0 && chunk.size > 0 && chunk.checksum,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(upload);
    for (const sentinel of SECRET_SENTINELS)
      expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toMatch(
      /GITHUB_TOKEN|GOOGLE.*TOKEN|refresh_token|access_token/i,
    );
  });
});
