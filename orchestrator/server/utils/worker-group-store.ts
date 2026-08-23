import { randomUUID } from "node:crypto";
import { UserScopedJsonStore } from "./user-scoped-store";

export interface WorkerGroup {
  id: string;
  userId: string;
  name: string;
  workerIds: string[];
  /** Direct parent. Missing on legacy records means an owner-scoped root. */
  parentId?: string;
  /** Names suppressed from ancestors before this group's own entries apply. */
  excludedInheritedEnvVarKeys?: string[];
  adminWorkspace?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
export class WorkerGroupStore extends UserScopedJsonStore<string, WorkerGroup> {
  constructor(dataDir: string) {
    super(dataDir, "worker-groups.json", (group) => group.id);
  }
  async create(
    userId: string,
    name: string,
    parentId?: string,
  ): Promise<WorkerGroup> {
    const stamp = new Date().toISOString();
    const group = {
      id: randomUUID(),
      userId,
      name: name.trim(),
      workerIds: [],
      ...(parentId ? { parentId } : {}),
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.swap(userId, group.id, group);
    return group;
  }
  async update(
    userId: string,
    id: string,
    patch: {
      name?: string;
      workerIds?: string[];
      parentId?: string | null;
      excludedInheritedEnvVarKeys?: string[];
      adminWorkspace?: Record<string, any>;
    },
  ): Promise<WorkerGroup> {
    return this.withUserMutation(userId, async () => {
      // Derive the patch only after entering the per-owner transaction. If two
      // callers read before queuing, the later whole-record write would
      // otherwise silently discard unrelated fields committed by the first.
      const current = this.get(userId, id);
      if (!current)
        throw createError({
          statusCode: 404,
          statusMessage: "Worker group not found",
        });
      const group: WorkerGroup = {
        ...current,
        workerIds: [...current.workerIds],
        updatedAt: new Date().toISOString(),
      };
      if (patch.name !== undefined) group.name = patch.name.trim();
      if (patch.workerIds !== undefined)
        group.workerIds = [...new Set(patch.workerIds)];
      if (patch.parentId !== undefined) {
        if (patch.parentId === null) delete group.parentId;
        else group.parentId = patch.parentId;
      }
      if (patch.excludedInheritedEnvVarKeys !== undefined)
        group.excludedInheritedEnvVarKeys = [
          ...new Set(patch.excludedInheritedEnvVarKeys),
        ].sort();
      if (patch.adminWorkspace !== undefined)
        group.adminWorkspace = structuredClone(patch.adminWorkspace);
      const map = this.items.get(userId)!;
      map.set(id, group);
      try {
        await this.persistUser(userId);
      } catch (error) {
        map.set(id, current);
        throw error;
      }
      return structuredClone(group);
    });
  }
  /** Move one direct worker membership with a single owner-file commit. The
   * expected source closes stale coordinator snapshots; persistence failure
   * restores both records together. */
  async assignWorker(
    userId: string,
    workerId: string,
    expectedSourceId: string | undefined,
    targetId: string | null,
  ): Promise<WorkerGroup | null> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      const containing = [...(map?.values() ?? [])].filter((group) =>
        group.workerIds.includes(workerId),
      );
      if (containing.length > 1 || containing[0]?.id !== expectedSourceId)
        throw createError({
          statusCode: 409,
          statusMessage: "Worker group membership changed concurrently",
        });
      const source = containing[0];
      const target = targetId ? map?.get(targetId) : undefined;
      if (targetId && !target)
        throw createError({
          statusCode: 404,
          statusMessage: "Worker group not found",
        });
      if (source?.id === targetId) return structuredClone(source);

      const stamp = new Date().toISOString();
      const nextSource = source
        ? {
            ...source,
            workerIds: source.workerIds.filter((id) => id !== workerId),
            updatedAt: stamp,
          }
        : undefined;
      const nextTarget = target
        ? {
            ...target,
            workerIds: [...new Set([...target.workerIds, workerId])],
            updatedAt: stamp,
          }
        : undefined;
      if (nextSource) map!.set(nextSource.id, nextSource);
      if (nextTarget) map!.set(nextTarget.id, nextTarget);
      try {
        await this.persistUser(userId);
      } catch (error) {
        if (source) map!.set(source.id, source);
        if (target) map!.set(target.id, target);
        throw error;
      }
      return nextTarget ? structuredClone(nextTarget) : null;
    });
  }
  /** Replace every direct reference to one worker with an exact set of group
   * ids in a single owner-file commit. Permanent worker deletion uses the
   * empty set; the coordinator can restore the prior set if dependent network
   * reconciliation fails. This also repairs legacy duplicate references
   * without exposing a sequence of partially updated group records. */
  async setWorkerReferences(
    userId: string,
    workerId: string,
    groupIds: Iterable<string>,
  ): Promise<string[]> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      if (!map) return [];
      const targets = new Set(groupIds);
      for (const id of targets) {
        if (!map.has(id))
          throw createError({
            statusCode: 404,
            statusMessage: "Worker group not found",
          });
      }
      const changed = [...map.values()].filter(
        (group) =>
          group.workerIds.includes(workerId) !== targets.has(group.id),
      );
      if (!changed.length) return [];
      const stamp = new Date().toISOString();
      for (const current of changed) {
        const without = current.workerIds.filter((id) => id !== workerId);
        map.set(current.id, {
          ...current,
          workerIds: targets.has(current.id)
            ? [...new Set([...without, workerId])]
            : without,
          updatedAt: stamp,
        });
      }
      try {
        await this.persistUser(userId);
      } catch (error) {
        for (const current of changed) map.set(current.id, current);
        throw error;
      }
      return changed.map((group) => group.id);
    });
  }

  async removeWorkerReferences(userId: string, workerId: string) {
    return this.setWorkerReferences(userId, workerId, []);
  }
  async remove(userId: string, id: string) {
    const current = this.get(userId, id);
    if (!current)
      throw createError({
        statusCode: 404,
        statusMessage: "Worker group not found",
      });
    await this.swap(userId, id, undefined);
  }
  findById(id: string) {
    return this.findWithOwner((group) => group.id === id)?.item;
  }
  private async swap(
    userId: string,
    id: string,
    next: WorkerGroup | undefined,
  ) {
    await this.withUserMutation(userId, async () => {
      let map = this.items.get(userId);
      const previous = map?.get(id);
      if (!map && next) {
        map = new Map();
        this.items.set(userId, map);
      }
      if (next) map!.set(id, next);
      else {
        map!.delete(id);
        if (map!.size === 0) this.items.delete(userId);
      }
      try {
        await this.persistUser(userId);
      } catch (error) {
        if (previous) {
          let rollback = this.items.get(userId);
          if (!rollback) {
            rollback = new Map();
            this.items.set(userId, rollback);
          }
          rollback.set(id, previous);
        } else {
          this.items.get(userId)?.delete(id);
          if (this.items.get(userId)?.size === 0) this.items.delete(userId);
        }
        throw error;
      }
    });
  }
}
