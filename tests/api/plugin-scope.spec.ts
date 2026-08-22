import { expect, test } from "@playwright/test";
import {
  definitionVisibleToGroupAdmin,
  definitionVisibleToPluginSelf,
  definitionVisibleToWorker,
  groupAdminCanMutateDefinition,
} from "../../orchestrator/server/utils/plugin-scope";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";

const stamp = "2026-01-01T00:00:00.000Z";
function group(id: string, workerIds: string[], parentId?: string): WorkerGroup {
  return { id, userId: "owner", name: id, workerIds, ...(parentId ? { parentId } : {}), createdAt: stamp, updatedAt: stamp };
}
function groups(items: WorkerGroup[]) {
  return {
    listForUser: (userId: string) => items.filter((item) => item.userId === userId),
    get: (userId: string, id: string) => items.find((item) => item.userId === userId && item.id === id),
  } as any;
}
function definition(overrides: Record<string, unknown> = {}) {
  return {
    id: "definition",
    scope: "group",
    userId: "owner",
    groupId: "root",
    manifest: { version: "1" },
    definitionHash: "hash",
    ...overrides,
  } as any;
}

test("ordinary worker visibility flows from an ancestor group, never siblings or descendants", () => {
  const hierarchy = groups([
    group("root", []),
    group("child", ["worker"], "root"),
    group("sibling", ["other"], "root"),
    group("grandchild", [], "child"),
  ]);
  const worker = { id: "worker", userId: "owner" } as any;
  expect(definitionVisibleToWorker(definition({ groupId: "root" }), worker, hierarchy)).toBe(true);
  expect(definitionVisibleToWorker(definition({ groupId: "child" }), worker, hierarchy)).toBe(true);
  expect(definitionVisibleToWorker(definition({ groupId: "sibling" }), worker, hierarchy)).toBe(false);
  expect(definitionVisibleToWorker(definition({ groupId: "grandchild" }), worker, hierarchy)).toBe(false);
  expect(definitionVisibleToWorker(definition({ userId: "other-owner" }), worker, hierarchy)).toBe(false);
});

test("group admin can manage only its subtree and can read ancestor definitions", () => {
  const hierarchy = groups([
    group("root", ["root-worker"]),
    group("child", ["child-worker"], "root"),
    group("grandchild", ["grand-worker"], "child"),
    group("sibling", ["sibling-worker"], "root"),
  ]);
  const ancestor = definition({ groupId: "root" });
  const own = definition({ groupId: "child" });
  const descendant = definition({ groupId: "grandchild" });
  const sibling = definition({ groupId: "sibling" });
  const owner = definition({ scope: "owner", groupId: undefined });
  const admin = "child";

  expect(definitionVisibleToGroupAdmin(ancestor, "owner", admin, hierarchy)).toBe(true);
  expect(definitionVisibleToGroupAdmin(own, "owner", admin, hierarchy)).toBe(true);
  expect(definitionVisibleToGroupAdmin(descendant, "owner", admin, hierarchy)).toBe(true);
  expect(definitionVisibleToGroupAdmin(sibling, "owner", admin, hierarchy)).toBe(false);
  expect(definitionVisibleToGroupAdmin(owner, "owner", admin, hierarchy)).toBe(true);

  // Ancestor/platform/owner definitions are usable but immutable to a group admin.
  expect(groupAdminCanMutateDefinition(ancestor, "owner", admin, hierarchy)).toBe(false);
  expect(groupAdminCanMutateDefinition(owner, "owner", admin, hierarchy)).toBe(false);
  expect(groupAdminCanMutateDefinition(own, "owner", admin, hierarchy)).toBe(true);
  expect(groupAdminCanMutateDefinition(descendant, "owner", admin, hierarchy)).toBe(true);
  expect(groupAdminCanMutateDefinition(sibling, "owner", admin, hierarchy)).toBe(false);
  expect(groupAdminCanMutateDefinition(definition({ scope: "platform", groupId: undefined }), "owner", admin, hierarchy)).toBe(false);
  expect(groupAdminCanMutateDefinition(definition({ userId: "other-owner" }), "owner", admin, hierarchy)).toBe(false);
});

test("worker-scoped definitions are visible to an admin only when their worker is in the subtree", () => {
  const hierarchy = groups([
    group("root", []),
    group("child", ["inside"], "root"),
    group("sibling", ["outside"], "root"),
  ]);
  const inside = definition({ scope: "worker", groupId: undefined, workerId: "inside" });
  const outside = definition({ scope: "worker", groupId: undefined, workerId: "outside" });
  const unknown = definition({ scope: "worker", groupId: undefined, workerId: "missing" });
  expect(definitionVisibleToGroupAdmin(inside, "owner", "root", hierarchy)).toBe(true);
  expect(definitionVisibleToGroupAdmin(outside, "owner", "child", hierarchy)).toBe(false);
  expect(definitionVisibleToGroupAdmin(unknown, "owner", "child", hierarchy)).toBe(false);
});

test("plugin-self visibility is role-bound and never owner-wide", () => {
  const hierarchy = groups([group("root", []), group("child", ["worker"], "root")]);
  const ordinary = { kind: "ordinary", userId: "owner", workerId: "worker" } as const;
  const platform = { kind: "platform-admin", workspaceId: "platform-workspace" } as const;
  const groupAdmin = { kind: "group-admin", workspaceId: "group-workspace", groupId: "child", ownerId: "owner" } as const;
  expect(definitionVisibleToPluginSelf(definition({ scope: "platform", groupId: undefined }), ordinary, hierarchy)).toBe(true);
  expect(definitionVisibleToPluginSelf(definition({ scope: "platform", groupId: undefined }), platform, hierarchy)).toBe(true);
  expect(definitionVisibleToPluginSelf(definition({ scope: "owner", groupId: undefined }), platform, hierarchy)).toBe(false);
  expect(definitionVisibleToPluginSelf(definition({ scope: "worker", workerId: "platform-workspace", userId: "__agentor_admin__" }), platform, hierarchy)).toBe(true);
  expect(definitionVisibleToPluginSelf(definition({ scope: "worker", workerId: "worker" }), platform, hierarchy)).toBe(false);
  expect(definitionVisibleToPluginSelf(definition({ scope: "group", groupId: "root" }), groupAdmin, hierarchy)).toBe(true);
  expect(definitionVisibleToPluginSelf(definition({ scope: "group", groupId: "child" }), groupAdmin, hierarchy)).toBe(true);
  expect(definitionVisibleToPluginSelf(definition({ scope: "owner", groupId: undefined }), groupAdmin, hierarchy)).toBe(false);
});
