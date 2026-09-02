import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostMountStore, validateHostMountCatalogSource } from "../../orchestrator/server/utils/host-mount-store";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";
import { ManagementWorkerDomain } from "../../orchestrator/server/utils/management-worker-domain";
import { ManagementHostMountDomain } from "../../orchestrator/server/utils/management-host-mount-domain";

const owner = "owner-a";
const stamp = "2026-09-02T00:00:00.000Z";

function group(id: string, parentId?: string, workerIds: string[] = []): WorkerGroup {
  return { id, userId: owner, name: id, parentId, workerIds, createdAt: stamp, updatedAt: stamp };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agentor-host-mount-"));
  const groups = [group("root", undefined, ["worker-root"]), group("child", "root", ["worker-child"]), group("sibling", undefined, ["worker-sibling"])];
  const workers = new Set(["worker-root", "worker-child", "worker-sibling"]);
  const groupStore = {
    listForUser: (userId: string) => groups.filter((item) => item.userId === userId),
    get: (userId: string, id: string) => groups.find((item) => item.userId === userId && item.id === id),
  };
  const workerStore = {
    get: (userId: string, id: string) => userId === owner && workers.has(id)
      ? { id, userId, status: "active", displayName: id, createdAt: stamp, updatedAt: stamp }
      : undefined,
  };
  const store = new HostMountStore(dir, () => "/srv/agentor-data", groupStore as any, workerStore as any);
  await store.init();
  return { dir, store, groups };
}

test("host mount catalog starts empty and rejects authority surfaces and Agentor storage overlap", async () => {
  const { dir, store } = await fixture();
  try {
    expect(store.listCatalog()).toEqual([]);
    for (const source of ["/", "/etc", "/etc/ssh", "/var", "/var/lib/docker/volumes", "/srv", "/srv/agentor-data/users"])
      expect(() => validateHostMountCatalogSource(source, "/srv/agentor-data")).toThrow();
    for (const source of ["/srv/line\nbreak", "/srv/tab\tpath", "/srv/data:rw"])
      expect(() => validateHostMountCatalogSource(source, "/srv/agentor-data")).toThrow(/control|colon/);
    expect(validateHostMountCatalogSource("/srv/shared-data", "/srv/agentor-data")).toBe("/srv/shared-data");
    await expect(store.createPath({
      name: "Bad write flag",
      sourcePath: "/srv/bad-write-flag",
      allowWrite: "true",
    })).rejects.toThrow(/boolean/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requires platform entitlement and owner assignment, defaults read-only, and resolves source server-side", async () => {
  const { dir, store } = await fixture();
  try {
    const path = await store.createPath({ name: "Shared", sourcePath: "/srv/shared-data" });
    expect(() => store.resolveMounts(owner, "worker-root", [{ pathId: path.id, source: "/forged", target: "/mnt/shared" }], "root"))
      .toThrow(/not assigned/);
    await store.setEntitlement(owner, path.id, true);
    await store.createOwnerGrant(owner, { pathId: path.id, targetType: "group", targetId: "root" });
    expect(store.resolveMounts(owner, "worker-root", [{ pathId: path.id, source: "/forged", target: "/mnt/shared" }], "root"))
      .toEqual([{ pathId: path.id, source: "/srv/shared-data", target: "/mnt/shared", readOnly: true }]);
    expect(() => store.resolveMounts(owner, "worker-root", [{ pathId: path.id, source: "", target: "/mnt/shared", readOnly: false }], "root"))
      .toThrow(/read-only/);
    expect(() => store.resolveMounts(owner, "worker-child", [{ pathId: path.id, source: "", target: "/mnt/shared" }], "child"))
      .toThrow(/not assigned/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("group admins delegate only an existing group grant and only downward", async () => {
  const { dir, store } = await fixture();
  try {
    const path = await store.createPath({ name: "Writable lab", sourcePath: "/srv/lab", allowWrite: true });
    await store.setEntitlement(owner, path.id, true);
    const allWorkers = await store.createOwnerGrant(owner, { pathId: path.id, targetType: "all" });
    expect(store.canWorkerUsePath(owner, "worker-root", path.id, "root")).toBe(true);
    expect(store.delegablePathsForGroup(owner, "root")).toEqual([]);
    await expect(store.createGroupDelegation(owner, "root", { pathId: path.id, targetType: "group", targetId: "child" }))
      .rejects.toThrow(/Ask the account owner/);
    const parent = await store.createOwnerGrant(owner, { pathId: path.id, targetType: "group", targetId: "root" });
    expect(store.delegablePathsForGroup(owner, "root").map((item) => item.id)).toContain(path.id);
    expect(store.delegablePathsForGroup(owner, "sibling")).toEqual([]);
    const child = await store.createGroupDelegation(owner, "root", { pathId: path.id, targetType: "group", targetId: "child" });
    expect(store.canWorkerUsePath(owner, "worker-child", path.id, "child")).toBe(true);
    await expect(store.createGroupDelegation(owner, "root", { pathId: path.id, targetType: "group", targetId: "sibling" }))
      .rejects.toMatchObject({ statusCode: 403 });
    const removed = await store.deleteGrant(owner, parent.id);
    expect(removed.removedGrantIds).toEqual(expect.arrayContaining([parent.id, child.id]));
    expect(store.listGrants(owner).map((grant) => grant.id)).not.toEqual(
      expect.arrayContaining([parent.id, child.id]),
    );
    // Removing one grant tree must not revoke an independent owner grant.
    expect(store.canWorkerUsePath(owner, "worker-child", path.id, "child")).toBe(true);
    await store.deleteGrant(owner, allWorkers.id);
    expect(store.canWorkerUsePath(owner, "worker-child", path.id, "child")).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel entitlement, owner-grant, and delegation retries remain idempotent", async () => {
  const { dir, store } = await fixture();
  try {
    const path = await store.createPath({
      name: "Concurrent",
      sourcePath: "/srv/concurrent",
    });
    const entitlements = await Promise.all(
      Array.from({ length: 12 }, () => store.setEntitlement(owner, path.id, true)),
    );
    expect(new Set(entitlements.map((entry) => entry.grant?.id)).size).toBe(1);

    const ownerGrants = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.createOwnerGrant(owner, {
          pathId: path.id,
          targetType: "group",
          targetId: "root",
        }),
      ),
    );
    expect(new Set(ownerGrants.map((grant) => grant.id)).size).toBe(1);

    const delegations = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.createGroupDelegation(owner, "root", {
          pathId: path.id,
          targetType: "group",
          targetId: "child",
        }),
      ),
    );
    expect(new Set(delegations.map((grant) => grant.id)).size).toBe(1);
    expect(store.listGrants(owner, true)).toHaveLength(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy source-only mounts require an exact approved and effective path", async () => {
  const { dir, store } = await fixture();
  try {
    const path = await store.createPath({ name: "Legacy exact", sourcePath: "/srv/legacy" });
    await store.setEntitlement(owner, path.id, true);
    await store.createOwnerGrant(owner, { pathId: path.id, targetType: "worker", targetId: "worker-root" });
    expect(store.resolveMounts(owner, "worker-root", [{ source: "/srv/legacy", target: "/mnt/legacy" }], "root")?.[0])
      .toMatchObject({ pathId: path.id, source: "/srv/legacy", readOnly: true });
    expect(() => store.resolveMounts(owner, "worker-root", [{ source: "/srv/not-approved", target: "/mnt/no" }], "root"))
      .toThrow(/not an approved catalog path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker MCP schemas accept path identities but never arbitrary mount sources", () => {
  const tools = new ManagementWorkerDomain().tools();
  for (const name of ["workers.create", "workers.update"]) {
    const schema: any = tools.find((tool) => tool.name === name)?.inputSchema;
    const mountProperties = schema?.properties?.mounts?.items?.properties;
    expect(mountProperties).toBeTruthy();
    expect(mountProperties.pathId).toBeTruthy();
    expect(mountProperties.target).toBeTruthy();
    expect(mountProperties.source).toBeUndefined();
  }
  const createSchema: any = tools.find((tool) => tool.name === "workers.create")?.inputSchema;
  expect(createSchema?.properties?.workerGroupId).toMatchObject({ type: "string" });
});

test("management MCP separates platform catalog controls from group delegations", () => {
  const tools = new ManagementHostMountDomain().tools();
  const names = tools.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining([
    "host-mounts.catalog.list",
    "host-mounts.catalog.create",
    "host-mounts.entitlements.set",
    "host-mounts.grants.create",
    "host-mounts.delegations.list",
    "host-mounts.delegations.create",
    "host-mounts.delegations.delete",
  ]));
  const catalogCreate: any = tools.find((tool) => tool.name === "host-mounts.catalog.create")?.inputSchema;
  expect(catalogCreate?.properties?.sourcePath).toBeTruthy();
  const delegationCreate: any = tools.find((tool) => tool.name === "host-mounts.delegations.create")?.inputSchema;
  expect(delegationCreate?.properties?.sourcePath).toBeUndefined();
  expect(delegationCreate?.properties).toMatchObject({
    pathId: { type: "string" },
    targetType: { enum: ["group", "worker"] },
    targetId: { type: "string" },
  });
});
