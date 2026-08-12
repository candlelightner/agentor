import { randomUUID } from 'node:crypto';
import { UserScopedJsonStore } from './user-scoped-store';

export interface WorkerGroup { id: string; userId: string; name: string; workerIds: string[]; createdAt: string; updatedAt: string; }
export class WorkerGroupStore extends UserScopedJsonStore<string, WorkerGroup> {
  constructor(dataDir: string) { super(dataDir, 'worker-groups.json', (group) => group.id); }
  async create(userId: string, name: string): Promise<WorkerGroup> { const stamp = new Date().toISOString(); const group = { id: randomUUID(), userId, name: name.trim(), workerIds: [], createdAt: stamp, updatedAt: stamp }; await this.setItem(userId, group); return group; }
  async update(userId: string, id: string, patch: { name?: string; workerIds?: string[] }): Promise<WorkerGroup> { const group = this.get(userId, id); if (!group) throw createError({ statusCode: 404, statusMessage: 'Worker group not found' }); if (patch.name !== undefined) group.name = patch.name.trim(); if (patch.workerIds !== undefined) group.workerIds = [...new Set(patch.workerIds)]; group.updatedAt = new Date().toISOString(); await this.setItem(userId, group); return group; }
  async remove(userId: string, id: string) { if (!await this.deleteItem(userId, id)) throw createError({ statusCode: 404, statusMessage: 'Worker group not found' }); }
  findById(id: string) { return this.findWithOwner((group) => group.id === id)?.item; }
}
