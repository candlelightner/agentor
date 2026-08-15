import { expect, test } from "@playwright/test";
import { WorkerGroupHierarchy } from "../../orchestrator/server/utils/worker-group-hierarchy";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";

const owner = "owner";
const stamp = "2026-01-01T00:00:00.000Z";
function value(id: string, parentId?: string, workerIds: string[] = []): WorkerGroup {
  return { id, userId: owner, name: id, ...(parentId ? { parentId } : {}), workerIds, createdAt: stamp, updatedAt: stamp };
}
function hierarchy(groups: WorkerGroup[]) {
  return new WorkerGroupHierarchy({
    listForUser: (userId) => groups.filter((group) => group.userId === userId),
    get: (userId, id) => groups.find((group) => group.userId === userId && group.id === id),
  });
}

test("resolves arbitrary-depth ancestry, descendants, and subtree workers", () => {
  const tree = hierarchy([value("root", undefined, ["a"]), value("middle", "root", ["b"]), value("leaf", "middle", ["c"])]);
  expect(tree.ancestors(owner, "leaf", true).map((group) => group.id)).toEqual(["leaf", "middle", "root"]);
  expect(tree.descendants(owner, "root", true).map((group) => group.id)).toEqual(["root", "middle", "leaf"]);
  expect(tree.subtreeWorkerIds(owner, "root")).toEqual(["a", "b", "c"]);
  expect(tree.canAdminister(owner, "middle", "leaf")).toBe(true);
  expect(tree.canAdminister(owner, "leaf", "middle")).toBe(false);
});

test("rejects self-parenting, descendant parenting, and foreign parents", () => {
  const groups = [value("root"), value("child", "root"), { ...value("foreign"), userId: "other" }];
  const tree = hierarchy(groups);
  expect(() => tree.validateParent(owner, "root", "root")).toThrow(/own parent/);
  expect(() => tree.validateParent(owner, "root", "child")).toThrow(/cycle/);
  expect(() => tree.validateParent(owner, "root", "foreign")).toThrow(/not found/);
});

test("reports legacy overlapping memberships without silently changing them", () => {
  const tree = hierarchy([value("one", undefined, ["worker"]), value("two", undefined, ["worker"])]);
  expect(tree.membershipConflicts(owner)).toEqual([{ workerId: "worker", groupIds: ["one", "two"] }]);
  expect(() => tree.assertMembershipAvailable(owner, "two", ["worker"])).toThrow(/only one/);
  expect(tree.membershipConflicts(owner, { groupId: "two", workerIds: [] })).toEqual([]);
});

test("malformed persisted cycles fail promptly", () => {
  const tree = hierarchy([value("one", "two"), value("two", "one")]);
  expect(() => tree.ancestors(owner, "one")).toThrow(/cycle/);
  expect(() => tree.descendants(owner, "one")).toThrow(/cycle/);
  expect(tree.hierarchyErrors(owner)).toEqual([
    { groupId: "one", code: "cycle" },
    { groupId: "two", code: "cycle" },
  ]);
});

test("validation reports missing parents without disclosing another owner", () => {
  const tree = hierarchy([value("orphan", "foreign"), { ...value("foreign"), userId: "other" }]);
  expect(tree.hierarchyErrors(owner)).toEqual([{ groupId: "orphan", code: "missing-parent" }]);
});
