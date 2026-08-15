import { createError } from "h3";
import type { WorkerGroup } from "./worker-group-store";

export interface WorkerGroupHierarchyStore {
  listForUser(userId: string): WorkerGroup[];
  get(userId: string, groupId: string): WorkerGroup | undefined;
}

/** Pure, owner-scoped hierarchy queries. Every traversal is iterative and
 * cycle-safe so malformed legacy data cannot hang authorization requests. */
export class WorkerGroupHierarchy {
  constructor(private readonly groups: WorkerGroupHierarchyStore) {}

  roots(userId: string) {
    return this.groups.listForUser(userId).filter((group) => !group.parentId);
  }

  ancestors(userId: string, groupId: string, includeSelf = false) {
    const result: WorkerGroup[] = [];
    const visited = new Set<string>();
    let current = this.required(userId, groupId);
    if (includeSelf) result.push(current);
    visited.add(current.id);
    while (current.parentId) {
      if (visited.has(current.parentId)) this.invalid("Worker group hierarchy contains a cycle");
      visited.add(current.parentId);
      current = this.groups.get(userId, current.parentId) ?? this.invalid("Worker group parent not found");
      result.push(current);
    }
    return result;
  }

  descendants(userId: string, groupId: string, includeSelf = false) {
    const root = this.required(userId, groupId);
    const byParent = new Map<string, WorkerGroup[]>();
    for (const group of this.groups.listForUser(userId)) {
      if (!group.parentId) continue;
      const children = byParent.get(group.parentId) ?? [];
      children.push(group);
      byParent.set(group.parentId, children);
    }
    const result: WorkerGroup[] = includeSelf ? [root] : [];
    const visited = new Set([root.id]);
    const queue = [...(byParent.get(root.id) ?? [])];
    for (let index = 0; index < queue.length; index++) {
      const group = queue[index]!;
      if (visited.has(group.id)) this.invalid("Worker group hierarchy contains a cycle");
      visited.add(group.id);
      result.push(group);
      queue.push(...(byParent.get(group.id) ?? []));
    }
    return result;
  }

  subtreeWorkerIds(userId: string, groupId: string) {
    return [...new Set(this.descendants(userId, groupId, true).flatMap((group) => group.workerIds))];
  }

  canAdminister(userId: string, authorityGroupId: string, targetGroupId: string) {
    return this.descendants(userId, authorityGroupId, true).some((group) => group.id === targetGroupId);
  }

  validateParent(userId: string, groupId: string | undefined, parentId?: string | null) {
    if (!parentId) return;
    if (parentId === groupId) this.invalid("A worker group cannot be its own parent");
    this.required(userId, parentId); // deliberately owner-scoped
    if (groupId && this.descendants(userId, groupId).some((group) => group.id === parentId))
      this.invalid("Moving this worker group would create a cycle");
  }

  membershipConflicts(userId: string, prospective?: { groupId: string; workerIds: string[] }) {
    const memberships = new Map<string, string[]>();
    for (const group of this.groups.listForUser(userId)) {
      const ids = prospective?.groupId === group.id ? prospective.workerIds : group.workerIds;
      for (const workerId of new Set(ids)) memberships.set(workerId, [...(memberships.get(workerId) ?? []), group.id]);
    }
    return [...memberships.entries()]
      .filter(([, groupIds]) => groupIds.length > 1)
      .map(([workerId, groupIds]) => ({ workerId, groupIds }));
  }

  hierarchyErrors(userId: string) {
    const groups = this.groups.listForUser(userId);
    const ids = new Set(groups.map((group) => group.id));
    const errors: Array<{ groupId: string; code: "missing-parent" | "cycle" }> = [];
    for (const group of groups) {
      if (group.parentId && !ids.has(group.parentId)) {
        errors.push({ groupId: group.id, code: "missing-parent" });
        continue;
      }
      const visited = new Set([group.id]);
      let current = group;
      while (current.parentId) {
        if (visited.has(current.parentId)) {
          errors.push({ groupId: group.id, code: "cycle" });
          break;
        }
        visited.add(current.parentId);
        const parent = this.groups.get(userId, current.parentId);
        if (!parent) break;
        current = parent;
      }
    }
    return errors;
  }

  assertMembershipAvailable(userId: string, groupId: string, workerIds: string[]) {
    const conflicts = this.membershipConflicts(userId, { groupId, workerIds });
    if (conflicts.length) throw createError({
      statusCode: 409,
      statusMessage: "A worker can belong directly to only one worker group",
      data: { conflicts },
    });
  }

  private required(userId: string, groupId: string) {
    return this.groups.get(userId, groupId) ?? this.invalid("Worker group not found", 404);
  }

  private invalid(message: string, statusCode = 400): never {
    throw createError({ statusCode, statusMessage: message });
  }
}
