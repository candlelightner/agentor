import { randomUUID } from "node:crypto";
import { UserScopedJsonStore } from "./user-scoped-store";

export interface WorkerGroup {
  id: string;
  userId: string;
  name: string;
  workerIds: string[];
  adminWorkspace?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
export class WorkerGroupStore extends UserScopedJsonStore<string, WorkerGroup> {
  constructor(dataDir: string) {
    super(dataDir, "worker-groups.json", (group) => group.id);
  }
  async create(userId: string, name: string): Promise<WorkerGroup> {
    const stamp = new Date().toISOString();
    const group = {
      id: randomUUID(),
      userId,
      name: name.trim(),
      workerIds: [],
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
      adminWorkspace?: Record<string, any>;
    },
  ): Promise<WorkerGroup> {
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
    if (patch.adminWorkspace !== undefined)
      group.adminWorkspace = structuredClone(patch.adminWorkspace);
    await this.swap(userId, id, group);
    return group;
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
  }
}
