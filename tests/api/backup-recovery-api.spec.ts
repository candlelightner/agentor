import { expect, test, request as playwrightRequest } from "@playwright/test";
import { gunzipSync } from "node:zlib";
import { ApiClient } from "../helpers/api-client";
import { createTestUser, deleteTestUser, type CreatedUser } from "../helpers/test-users";
import { cleanupWorker, createWorker } from "../helpers/worker-lifecycle";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const options = { baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL }, storageState: { cookies: [], origins: [] } };

async function waitForBackupJob(
  api: Awaited<ReturnType<typeof playwrightRequest.newContext>>,
  jobId: string,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await api.get(`/api/backup-jobs/${jobId}`);
    expect(response.status()).toBe(200);
    const job = await response.json();
    if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Backup job ${jobId} did not become terminal`);
}

test.describe.serial("backup recovery REST boundary", () => {
  let owner: CreatedUser;
  let api: Awaited<ReturnType<typeof playwrightRequest.newContext>>;

  test.beforeAll(async () => {
    owner = await createTestUser("Backup Recovery REST");
    api = await playwrightRequest.newContext(options);
    expect((await new ApiClient(api).signInEmail(owner.email, owner.password)).status).toBe(200);
  });
  test.afterAll(async () => { await api?.dispose(); await deleteTestUser(owner.id); });

  test("key status is non-cacheable; reveal/export require server-side fresh password verification", async () => {
    const status = await api.get("/api/backups/recovery-key");
    expect(status.status()).toBe(200);
    expect(status.headers()["cache-control"]).toContain("no-store");
    expect(JSON.stringify(await status.json())).not.toContain("keyMaterial");

    const denied = await api.post("/api/backups/recovery-key/reveal", { data: {} });
    expect(denied.status()).toBe(401);
    const freshSessionBypass = await api.post("/api/backups/recovery-key/reveal", {
      data: { useFreshSession: true },
    });
    expect(freshSessionBypass.status()).toBe(401);
    const exportFreshSessionBypass = await api.post("/api/backups/recovery-key/export", {
      data: { useFreshSession: true },
    });
    expect(exportFreshSessionBypass.status()).toBe(401);
    const revealed = await api.post("/api/backups/recovery-key/reveal", { data: { password: owner.password } });
    expect(revealed.status()).toBe(200);
    expect(revealed.headers()["cache-control"]).toContain("no-store");
    expect(revealed.headers()["x-content-type-options"]).toBe("nosniff");
    const material = await revealed.json();
    expect(material.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(typeof material.keyMaterial).toBe("string");

    const copied = await api.post("/api/backups/recovery-key/import", {
      data: { kit: material.keyMaterial },
    });
    expect(copied.status()).toBe(200);
    expect(JSON.stringify(await copied.json())).not.toContain(material.keyMaterial);

    const exported = await api.post("/api/backups/recovery-key/export", { data: { password: owner.password } });
    expect(exported.status()).toBe(200);
    expect(exported.headers()["content-disposition"]).toContain("attachment");
    const kit = await exported.json();
    const imported = await api.post("/api/backups/recovery-key/import", { data: { kit } });
    expect(imported.status()).toBe(200);
    expect(JSON.stringify(await imported.json())).not.toContain(material.keyMaterial);
  });

  test("remote discovery starts asynchronously and exposes owner-scoped logs", async () => {
    expect((await api.post("/api/backup-providers/fake/connect", { data: { testMode: true } })).status()).toBe(201);
    const started = await api.post("/api/backups/remote", { data: { provider: "fake", requestId: `discovery-${Date.now()}` } });
    expect(started.status()).toBe(202);
    const body = await started.json();
    expect(body.next.logs).toContain(`/api/backups/jobs/${body.jobId}/logs`);
    const logs = await api.get(body.next.logs);
    expect(logs.status()).toBe(200);
    expect(await logs.json()).toMatchObject({ logs: expect.any(Array) });
    expect((await api.get("/api/backups/remote")).status()).toBe(200);
  });
});

test("a second account partition sharing one fake provider account can discover, adopt, and restore a remote-only backup", async () => {
  const source = await createTestUser("Cross-instance recovery source");
  const destination = await createTestUser("Cross-instance recovery destination");
  const sourceApi = await playwrightRequest.newContext(options);
  const destinationApi = await playwrightRequest.newContext(options);
  let sourceWorkerId = "";
  let restoredWorkerId = "";
  const remoteAccountId = `cross-instance-${Date.now()}`;
  try {
    expect((await new ApiClient(sourceApi).signInEmail(source.email, source.password)).status).toBe(200);
    expect((await new ApiClient(destinationApi).signInEmail(destination.email, destination.password)).status).toBe(200);
    sourceWorkerId = (await createWorker(sourceApi, { displayName: "remote-recovery-source" })).id;
    expect(
      (
        await new ApiClient(sourceApi).uploadToWorkspace(sourceWorkerId, [
          { name: "cross-instance-marker.txt", content: Buffer.from("remote recovery succeeded") },
        ])
      ).status,
    ).toBe(200);

    for (const api of [sourceApi, destinationApi])
      expect(
        (
          await api.post("/api/backup-providers/fake/connect", {
            data: { testMode: true, accountId: remoteAccountId },
          })
        ).status(),
      ).toBe(201);

    const backupStart = await sourceApi.post("/api/backups", {
      data: { workspaceIds: [sourceWorkerId], providerId: "fake" },
    });
    expect(backupStart.status()).toBe(202);
    const backup = await waitForBackupJob(sourceApi, (await backupStart.json()).id);
    expect(backup).toMatchObject({ status: "succeeded", integrityVerified: true });

    const kitResponse = await sourceApi.post("/api/backups/recovery-key/export", {
      data: { password: source.password },
    });
    expect(kitResponse.status()).toBe(200);
    const recoveryKit = await kitResponse.json();

    const initiallyLocal = await (await destinationApi.get("/api/backups")).json();
    expect(initiallyLocal.backups).toEqual([]);
    const discoveryStart = await destinationApi.post("/api/backups/remote", {
      data: { provider: "fake", requestId: `discover-${remoteAccountId}` },
    });
    expect(discoveryStart.status()).toBe(202);
    const discoveryJob = await waitForBackupJob(destinationApi, (await discoveryStart.json()).jobId);
    expect(discoveryJob.status).toBe("succeeded");
    const discoveredMissingKey = await (await destinationApi.get("/api/backups/remote")).json();
    expect(discoveredMissingKey).toEqual([
      expect.objectContaining({ state: "missing-key", workspaceIds: [sourceWorkerId] }),
    ]);

    const keyImport = await destinationApi.post("/api/backups/recovery-key/import", {
      data: { kit: recoveryKit },
    });
    expect(keyImport.status()).toBe(200);
    expect(await keyImport.json()).toMatchObject({
      imported: true,
      matchingRemoteBackupIds: [discoveredMissingKey[0].id],
    });

    const adoptionStart = await destinationApi.post(
      `/api/backups/remote/${discoveredMissingKey[0].id}/adopt`,
      { data: { requestId: `adopt-${remoteAccountId}` } },
    );
    expect(adoptionStart.status()).toBe(202);
    const adoptionJob = await waitForBackupJob(destinationApi, (await adoptionStart.json()).jobId);
    expect(adoptionJob).toMatchObject({ status: "succeeded", integrityVerified: true });
    const adopted = await (
      await destinationApi.get(`/api/backups/${adoptionJob.artifactId}`)
    ).json();
    expect(adopted).toMatchObject({
      provenance: "remote-adopted",
      workspaceIds: [sourceWorkerId],
      reconstruction: [
        expect.objectContaining({
          workspaceId: sourceWorkerId,
          image: expect.objectContaining({ kind: "platform-default" }),
        }),
      ],
    });

    const restoreStart = await destinationApi.post(
      `/api/backups/${adoptionJob.artifactId}/restore`,
      {
        data: {
          target: "new",
          workspaceIds: [sourceWorkerId],
          displayName: "remote-recovery-restored",
          requestId: `restore-${remoteAccountId}`,
        },
      },
    );
    expect(restoreStart.status()).toBe(202);
    const restoreJob = await waitForBackupJob(destinationApi, (await restoreStart.json()).jobId);
    expect(restoreJob).toMatchObject({
      status: "succeeded",
      integrityVerified: true,
      restoreMappings: [
        { sourceWorkspaceId: sourceWorkerId, workerId: expect.any(String) },
      ],
    });
    restoredWorkerId = restoreJob.restoreMappings[0].workerId;
    expect(restoredWorkerId).not.toBe(sourceWorkerId);
    const restoredWorkspace = await new ApiClient(destinationApi).downloadWorkspace(restoredWorkerId);
    expect(restoredWorkspace.status).toBe(200);
    expect(gunzipSync(restoredWorkspace.body).toString("utf8")).toContain(
      "cross-instance-marker.txt",
    );
  } finally {
    if (restoredWorkerId) await cleanupWorker(destinationApi, restoredWorkerId).catch(() => {});
    if (sourceWorkerId) await cleanupWorker(sourceApi, sourceWorkerId).catch(() => {});
    await sourceApi.dispose();
    await destinationApi.dispose();
    await deleteTestUser(source.id).catch(() => {});
    await deleteTestUser(destination.id).catch(() => {});
  }
});
