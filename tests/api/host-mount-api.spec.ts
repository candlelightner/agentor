import {
  expect,
  request as playwrightRequest,
  test,
  type APIRequestContext,
} from "@playwright/test";
import { ApiClient } from "../helpers/api-client";
import { createTestUser, deleteTestUser } from "../helpers/test-users";
import { deleteApprovedHostPath } from "../helpers/host-mounts";
import {
  cleanupWorker,
  createWorker,
  waitForWorkerRunning,
} from "../helpers/worker-lifecycle";
import { runInFreshWindow } from "../helpers/terminal-ws";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function signedInUser(): Promise<{
  user: Awaited<ReturnType<typeof createTestUser>>;
  context: APIRequestContext;
}> {
  const user = await createTestUser("Host mount owner");
  const context = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const signedIn = await new ApiClient(context).signInEmail(
    user.email,
    user.password,
  );
  if (signedIn.status !== 200) {
    await context.dispose();
    await deleteTestUser(user.id);
    throw new Error(`Could not sign in host-mount test user (${signedIn.status})`);
  }
  return { user, context };
}

test.describe.serial("Host mount authorization API", () => {
  test("only platform admins approve raw paths while owners assign entitled paths to their groups", async ({ request }) => {
    const { user, context } = await signedInUser();
    let pathId = "";
    let groupId = "";
    try {
      const denied = await context.post("/api/host-mounts", {
        data: { name: "forbidden", sourcePath: "/tmp/forbidden-owner-path" },
      });
      expect(denied.status()).toBe(403);

      const created = await request.post("/api/host-mounts", {
        data: {
          name: `owner-entitled-${Date.now()}`,
          sourcePath: `/tmp/owner-entitled-${Date.now()}`,
          allowWrite: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      const path = await created.json();
      pathId = path.id;

      const entitled = await request.put("/api/host-mounts/entitlements", {
        data: { ownerId: user.id, pathId, enabled: true },
      });
      expect(entitled.status(), await entitled.text()).toBe(200);

      const group = await context.post("/api/worker-groups", {
        data: { name: `mount-target-${Date.now()}` },
      });
      expect(group.status(), await group.text()).toBe(201);
      groupId = (await group.json()).id;

      const assigned = await context.post("/api/host-mounts/grants", {
        data: { pathId, targetType: "group", targetId: groupId },
      });
      expect(assigned.status(), await assigned.text()).toBe(201);

      const ungrouped = await context.get("/api/host-mounts");
      expect((await ungrouped.json()).effectivePathIds).not.toContain(pathId);
      const grouped = await context.get(`/api/host-mounts?groupId=${groupId}`);
      expect(grouped.status()).toBe(200);
      expect((await grouped.json()).effectivePathIds).toContain(pathId);
    } finally {
      if (pathId) await deleteApprovedHostPath(request, pathId);
      if (groupId) await context.delete(`/api/worker-groups/${groupId}`).catch(() => undefined);
      await context.dispose();
      await deleteTestUser(user.id);
    }
  });

  test("an account cannot create grants for another owner", async ({ request }) => {
    const first = await signedInUser();
    const second = await signedInUser();
    let pathId = "";
    try {
      const created = await request.post("/api/host-mounts", {
        data: {
          name: `cross-owner-${Date.now()}`,
          sourcePath: `/tmp/cross-owner-${Date.now()}`,
        },
      });
      expect(created.status()).toBe(201);
      pathId = (await created.json()).id;
      expect((await request.put("/api/host-mounts/entitlements", {
        data: { ownerId: second.user.id, pathId, enabled: true },
      })).status()).toBe(200);

      const denied = await first.context.post("/api/host-mounts/grants", {
        data: {
          ownerId: second.user.id,
          pathId,
          targetType: "all",
        },
      });
      expect(denied.status()).toBe(403);
    } finally {
      if (pathId) await deleteApprovedHostPath(request, pathId);
      await first.context.dispose();
      await second.context.dispose();
      await deleteTestUser(first.user.id);
      await deleteTestUser(second.user.id);
    }
  });

  test("revoking an active grant stops the worker, blocks restart, and rebuild removes the bind", async ({ request }) => {
    test.setTimeout(300_000);
    const { user, context } = await signedInUser();
    const sourcePath = `/tmp/revoked-host-${Date.now()}`;
    const targetPath = `/mnt/revoked-host-${Date.now()}`;
    let pathId = "";
    let grantId = "";
    let workerId = "";
    try {
      const created = await request.post("/api/host-mounts", {
        data: {
          name: `revocation-${Date.now()}`,
          sourcePath,
          allowWrite: false,
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      pathId = (await created.json()).id;

      const entitled = await request.put("/api/host-mounts/entitlements", {
        data: { ownerId: user.id, pathId, enabled: true },
      });
      expect(entitled.status(), await entitled.text()).toBe(200);

      const granted = await context.post("/api/host-mounts/grants", {
        data: { pathId, targetType: "all" },
      });
      expect(granted.status(), await granted.text()).toBe(201);
      grantId = (await granted.json()).id;

      const worker = await createWorker(context, {
        mounts: [{ pathId, source: "/forged-source-is-ignored", target: targetPath, readOnly: true }],
      });
      workerId = worker.id;
      const before = await runInFreshWindow(
        context,
        workerId,
        `echo "REVOCATION_MOUNT=$(grep -ca '${targetPath}' /proc/mounts)"`,
        /REVOCATION_MOUNT=\d/,
      );
      expect(before).toContain("REVOCATION_MOUNT=1");

      const revoked = await context.delete(`/api/host-mounts/grants/${grantId}`);
      expect(revoked.status(), await revoked.text()).toBe(200);
      const revokeBody = await revoked.json();
      expect(revokeBody.enforcement.affectedWorkerIds).toContain(workerId);
      expect(revokeBody.enforcement.stoppedWorkerIds).toContain(workerId);

      const api = new ApiClient(context);
      const listed = await api.listContainers();
      const stopped = listed.body.find((candidate: { id: string }) => candidate.id === workerId);
      expect(stopped).toMatchObject({
        id: workerId,
        status: "stopped",
        pendingRebuild: true,
        hostMountsRevoked: true,
      });
      expect(stopped.mounts ?? []).toEqual([]);

      const restart = await api.restartContainer(workerId);
      expect(restart.status).toBe(409);
      expect(restart.body.statusMessage).toContain("Rebuild");

      const rebuilt = await api.rebuildContainer(workerId);
      expect(rebuilt.status).toBe(200);
      expect(rebuilt.body).toMatchObject({
        id: workerId,
        pendingRebuild: false,
        hostMountsRevoked: false,
      });
      expect(rebuilt.body.mounts ?? []).toEqual([]);
      await waitForWorkerRunning(context, workerId, 120_000);
      const after = await runInFreshWindow(
        context,
        workerId,
        `echo "REVOCATION_MOUNT=$(grep -ca '${targetPath}' /proc/mounts)"`,
        /REVOCATION_MOUNT=\d/,
      );
      expect(after).toContain("REVOCATION_MOUNT=0");
    } finally {
      if (workerId) await cleanupWorker(context, workerId);
      if (pathId) await deleteApprovedHostPath(request, pathId);
      await context.dispose();
      await deleteTestUser(user.id);
    }
  });
});
