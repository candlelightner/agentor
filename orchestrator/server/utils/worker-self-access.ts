import type {
  EffectiveWorkerSelfApiAccess,
  WorkerSelfApiAccess,
} from "../../shared/types";
import type { WorkerGroup } from "./worker-group-store";

export interface WorkerSelfAccessSubject {
  id: string;
  userId: string;
  workerSelfApiAccess?: WorkerSelfApiAccess;
}

export function isWorkerSelfApiAccess(value: unknown): value is WorkerSelfApiAccess {
  return value === "inherit" || value === "allow" || value === "deny";
}

export function effectiveGroupWorkerSelfApiAccess(
  userId: string,
  groupId: string,
  groups: WorkerGroup[],
): EffectiveWorkerSelfApiAccess {
  const owned = new Map(
    groups
      .filter((group) => group.userId === userId)
      .map((group) => [group.id, group]),
  );
  const seen = new Set<string>();
  let current = owned.get(groupId);
  let nearest:
    | { decision: "allow" | "deny"; groupId: string }
    | undefined;
  while (current) {
    if (seen.has(current.id))
      return {
        allowed: false,
        decision: "deny",
        source: "invalid-group-hierarchy",
        groupId: current.id,
      };
    seen.add(current.id);
    const currentPolicy: unknown = current.workerSelfApiAccess;
    if (
      currentPolicy !== undefined &&
      currentPolicy !== "inherit" &&
      currentPolicy !== "allow" &&
      currentPolicy !== "deny"
    )
      return {
        allowed: false,
        decision: "deny",
        source: "invalid-group-hierarchy",
        groupId: current.id,
      };
    if (
      !nearest &&
      (currentPolicy === "allow" || currentPolicy === "deny")
    )
      nearest = {
        decision: currentPolicy,
        groupId: current.id,
      };
    if (!current.parentId)
      return nearest
        ? {
            allowed: nearest.decision === "allow",
            decision: nearest.decision,
            source: "group",
            groupId: nearest.groupId,
          }
        : { allowed: true, decision: "allow", source: "default" };
    const parent = owned.get(current.parentId);
    if (!parent)
      return {
        allowed: false,
        decision: "deny",
        source: "invalid-group-hierarchy",
        groupId: current.id,
      };
    current = parent;
  }
  return {
    allowed: false,
    decision: "deny",
    source: "invalid-group-hierarchy",
    groupId,
  };
}

/** Resolve a live ordinary-worker decision. Worker overrides win; otherwise
 * the nearest explicit group policy wins. Legacy duplicate memberships fail
 * closed if any applicable path denies access. */
export function effectiveWorkerSelfApiAccess(
  worker: WorkerSelfAccessSubject,
  groups: WorkerGroup[],
): EffectiveWorkerSelfApiAccess {
  const workerPolicy: unknown = worker.workerSelfApiAccess;
  if (workerPolicy === "allow" || workerPolicy === "deny")
    return {
      allowed: workerPolicy === "allow",
      decision: workerPolicy,
      source: "worker",
    };
  // Missing is the backward-compatible legacy value; any other unrecognized
  // persisted value is corruption and must not silently widen access.
  if (workerPolicy !== undefined && workerPolicy !== "inherit")
    return { allowed: false, decision: "deny", source: "worker" };
  const memberships = groups.filter(
    (group) =>
      group.userId === worker.userId && group.workerIds.includes(worker.id),
  );
  if (!memberships.length)
    return { allowed: true, decision: "allow", source: "default" };
  const decisions = memberships.map((group) =>
    effectiveGroupWorkerSelfApiAccess(worker.userId, group.id, groups),
  );
  return decisions.find((decision) => !decision.allowed) ?? decisions[0]!;
}

export function withEffectiveWorkerSelfApiAccess<T extends WorkerSelfAccessSubject>(
  worker: T,
  groups: WorkerGroup[],
): T & { effectiveWorkerSelfApiAccess: EffectiveWorkerSelfApiAccess } {
  return {
    ...worker,
    effectiveWorkerSelfApiAccess: effectiveWorkerSelfApiAccess(worker, groups),
  };
}
