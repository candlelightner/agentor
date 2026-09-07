import { expect, test } from "@playwright/test";
import {
  effectiveGroupWorkerSelfApiAccess,
  effectiveWorkerSelfApiAccess,
  isWorkerSelfApiAccess,
} from "../../orchestrator/server/utils/worker-self-access";
import type { WorkerGroup } from "../../orchestrator/server/utils/worker-group-store";

const stamp = "2026-09-07T00:00:00.000Z";
const owner = "owner-a";

function group(
  id: string,
  options: {
    parentId?: string;
    workerIds?: string[];
    access?: "inherit" | "allow" | "deny";
    userId?: string;
  } = {},
): WorkerGroup {
  return {
    id,
    userId: options.userId ?? owner,
    name: id,
    workerIds: options.workerIds ?? [],
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.access ? { workerSelfApiAccess: options.access } : {}),
    createdAt: stamp,
    updatedAt: stamp,
  };
}

test("legacy workers and groups remain allowed by default", () => {
  expect(effectiveWorkerSelfApiAccess({ id: "worker", userId: owner }, [])).toEqual({
    allowed: true,
    decision: "allow",
    source: "default",
  });
  expect(
    effectiveWorkerSelfApiAccess(
      { id: "worker", userId: owner },
      [group("legacy", { workerIds: ["worker"] })],
    ),
  ).toEqual({ allowed: true, decision: "allow", source: "default" });
});

test("the nearest group policy is inherited and an explicit worker override wins", () => {
  const groups = [
    group("root", { access: "deny" }),
    group("child", { parentId: "root", workerIds: ["worker"] }),
    group("leaf", { parentId: "child", access: "allow" }),
  ];
  expect(effectiveGroupWorkerSelfApiAccess(owner, "child", groups)).toEqual({
    allowed: false,
    decision: "deny",
    source: "group",
    groupId: "root",
  });
  expect(effectiveGroupWorkerSelfApiAccess(owner, "leaf", groups)).toEqual({
    allowed: true,
    decision: "allow",
    source: "group",
    groupId: "leaf",
  });
  expect(
    effectiveWorkerSelfApiAccess(
      { id: "worker", userId: owner, workerSelfApiAccess: "allow" },
      groups,
    ),
  ).toEqual({ allowed: true, decision: "allow", source: "worker" });
});

test("legacy duplicate memberships deny if any path denies", () => {
  const decision = effectiveWorkerSelfApiAccess(
    { id: "worker", userId: owner },
    [
      group("allowed", { workerIds: ["worker"], access: "allow" }),
      group("denied", { workerIds: ["worker"], access: "deny" }),
    ],
  );
  expect(decision).toMatchObject({
    allowed: false,
    decision: "deny",
    source: "group",
    groupId: "denied",
  });
});

test("malformed or cross-owner hierarchy references fail closed", () => {
  expect(
    effectiveWorkerSelfApiAccess(
      { id: "worker", userId: owner, workerSelfApiAccess: "corrupt" as never },
      [],
    ),
  ).toMatchObject({ allowed: false, decision: "deny", source: "worker" });
  expect(
    effectiveGroupWorkerSelfApiAccess(owner, "corrupt", [
      group("corrupt", { access: "corrupt" as never }),
    ]),
  ).toMatchObject({ allowed: false, source: "invalid-group-hierarchy" });
  expect(
    effectiveGroupWorkerSelfApiAccess(owner, "orphan", [
      group("orphan", { parentId: "missing" }),
    ]),
  ).toMatchObject({ allowed: false, source: "invalid-group-hierarchy" });
  expect(
    effectiveGroupWorkerSelfApiAccess(owner, "one", [
      group("one", { parentId: "two", access: "allow" }),
      group("two", { parentId: "one" }),
    ]),
  ).toMatchObject({ allowed: false, source: "invalid-group-hierarchy" });
  expect(
    effectiveGroupWorkerSelfApiAccess(owner, "child", [
      group("child", { parentId: "foreign" }),
      group("foreign", { userId: "owner-b", access: "allow" }),
    ]),
  ).toMatchObject({ allowed: false, source: "invalid-group-hierarchy" });
});

test("only the three persisted policy values are accepted", () => {
  for (const value of ["inherit", "allow", "deny"])
    expect(isWorkerSelfApiAccess(value)).toBe(true);
  for (const value of [undefined, null, "", "enabled", true])
    expect(isWorkerSelfApiAccess(value)).toBe(false);
});
