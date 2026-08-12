import { randomUUID } from "node:crypto";
import { UserScopedJsonStore } from "./user-scoped-store";

export type ManagedNetworkScope = "all" | "selected" | "group";
export interface ManagedNetwork {
  id: string;
  userId: string;
  name: string;
  dockerName: string;
  scope: ManagedNetworkScope;
  groupId?: string;
  workerIds: string[];
  createdAt: string;
  updatedAt: string;
}

export class ManagedNetworkStore extends UserScopedJsonStore<string, ManagedNetwork> {
  constructor(dataDir: string) {
    super(dataDir, "managed-networks.json", (network) => network.id);
  }
  findById(id: string) {
    return this.findWithOwner((network) => network.id === id)?.item;
  }
  async create(
    userId: string,
    name: string,
    scope: ManagedNetworkScope,
    groupId?: string,
  ) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const item: ManagedNetwork = {
      id,
      userId,
      name: name.trim(),
      dockerName: `agentor-managed-${id}`,
      scope,
      ...(groupId ? { groupId } : {}),
      workerIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.setItem(userId, item);
    return item;
  }
  async update(
    userId: string,
    id: string,
    patch: Partial<Pick<ManagedNetwork, "name" | "scope" | "groupId" | "workerIds">>,
  ) {
    const item = this.get(userId, id);
    if (!item)
      throw createError({ statusCode: 404, statusMessage: "Managed network not found" });
    if (patch.name !== undefined) item.name = patch.name.trim();
    if (patch.scope !== undefined) item.scope = patch.scope;
    if (patch.groupId !== undefined) item.groupId = patch.groupId || undefined;
    if (patch.workerIds !== undefined) item.workerIds = [...new Set(patch.workerIds)];
    item.updatedAt = new Date().toISOString();
    await this.setItem(userId, item);
    return item;
  }
  async remove(userId: string, id: string) {
    if (!(await this.deleteItem(userId, id)))
      throw createError({ statusCode: 404, statusMessage: "Managed network not found" });
  }
}
