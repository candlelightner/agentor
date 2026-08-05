import Docker from 'dockerode';
import { opendir, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { useConfig, useContainerManager, useStorageManager, useWorkerStore } from './services';
import { listWorkspaceTombstones } from './workspace-tombstones';

export type WorkspaceState = 'running' | 'stopped' | 'archived' | 'deleted' | 'orphaned';

export interface WorkspaceInventoryItem {
  id: string;
  workerId?: string;
  userId?: string;
  displayName: string;
  backend: 'directory' | 'volume';
  state: WorkspaceState;
  createdAt?: string;
  updatedAt?: string;
  size: number | null;
  storageRef: string;
  /** Path visible inside the orchestrator, used only to validate a directory
   * source before Docker receives the corresponding host path. */
  validationRef?: string;
}

export interface PublicWorkspaceInventoryItem {
  id: string;
  workerId?: string;
  owner: string;
  workerName: string;
  backend: 'directory' | 'volume';
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
  sizeBytes: number | null;
  latestBackup: { status: string; completedAt?: string; error?: string } | null;
  capabilities: { browse: boolean; backup: boolean; clone: boolean };
}
export function publicWorkspaceInventoryItem(item: WorkspaceInventoryItem): PublicWorkspaceInventoryItem {
  const now = new Date().toISOString();
  return {
    id: item.id,
    workerId: item.workerId,
    owner: item.userId ?? 'unassigned',
    workerName: item.displayName,
    backend: item.backend,
    state: item.state,
    createdAt: item.createdAt ?? item.updatedAt ?? now,
    updatedAt: item.updatedAt ?? item.createdAt ?? now,
    sizeBytes: item.size,
    latestBackup: null,
    capabilities: { browse: !['orphaned', 'deleted'].includes(item.state), backup: !['orphaned', 'deleted'].includes(item.state), clone: !['orphaned', 'deleted'].includes(item.state) },
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Discovers workspaces from the durable WorkerStore plus physical storage.
 * Runtime state is derived on every request rather than persisted. */
export async function listWorkspaceInventory(includeOrphans: boolean): Promise<WorkspaceInventoryItem[]> {
  const config = useConfig();
  const storage = useStorageManager();
  const workers = useWorkerStore().list();
  const cm = useContainerManager();
  const items: WorkspaceInventoryItem[] = await Promise.all(workers.map(async (worker) => {
    const live = cm.get(worker.id);
    const state: WorkspaceState = worker.status === 'archived'
      ? 'archived'
      : live?.status === 'running' ? 'running' : 'stopped';
    const containerName = cm.buildContainerName(worker.id);
    return {
      id: worker.id,
      workerId: worker.id,
      userId: worker.userId,
      displayName: worker.displayName || worker.id,
      backend: storage.mode,
      state,
      createdAt: worker.createdAt,
      updatedAt: worker.updatedAt,
      // Directory-backed workspaces are directly visible to the orchestrator,
      // so report their size without starting the worker. The bounded walker
      // never follows symlinks and returns `null` for an unreadable or very
      // large tree rather than making inventory requests unbounded. Named
      // volumes remain unknown until Docker exposes a cheap size primitive.
      size: storage.mode === 'directory'
        ? await boundedDirectorySize(join(storage.dataDir, 'users', worker.userId, 'workspaces', worker.id))
        : null,
      storageRef: storage.mode === 'directory'
        ? join(storage.dataRef, 'users', worker.userId, 'workspaces', worker.id)
        : `${containerName}-workspace`,
      validationRef: storage.mode === 'directory'
        ? join(storage.dataDir, 'users', worker.userId, 'workspaces', worker.id)
        : undefined,
    };
  }));

  const liveIds = new Set(items.map((item) => item.workerId));
  for (const deleted of await listWorkspaceTombstones()) {
    if (liveIds.has(deleted.workerId)) continue;
    items.push({ id: deleted.id, workerId: deleted.workerId, userId: deleted.userId, displayName: deleted.displayName, backend: deleted.backend, state: 'deleted', createdAt: deleted.createdAt, updatedAt: deleted.deletedAt, size: 0, storageRef: '' });
  }

  if (!includeOrphans) return items;
  const known = new Set(items.map((item) => item.storageRef));
  if (storage.mode === 'volume') {
    const docker = new Docker({ socketPath: '/var/run/docker.sock' });
    const volumes = (await docker.listVolumes()).Volumes ?? [];
    const prefix = `${config.containerPrefix}-`;
    for (const volume of volumes) {
      const name = volume.Name;
      if (!name.startsWith(prefix) || !name.endsWith('-workspace') || known.has(name)) continue;
      const id = name.slice(prefix.length, -'-workspace'.length);
      if (!UUID_RE.test(id)) continue;
      items.push({ id: name, displayName: name, backend: 'volume', state: 'orphaned', size: null, storageRef: name });
    }
  } else {
    const usersDir = join(storage.dataDir, 'users');
    for (const userId of await safeReadDir(usersDir)) {
      const root = join(usersDir, userId, 'workspaces');
      for (const id of await safeReadDir(root)) {
        if (!UUID_RE.test(id)) continue;
        const validationRef = join(root, id);
        const ref = join(storage.dataRef, 'users', userId, 'workspaces', id);
        if (known.has(ref)) continue;
        try {
          const st = await lstat(validationRef);
          if (!st.isDirectory() || st.isSymbolicLink()) continue;
        } catch { continue; }
        items.push({ id: `orphan-${userId}-${id}`, userId, displayName: id, backend: 'directory', state: 'orphaned', size: null, storageRef: ref, validationRef });
      }
    }
  }
  return items;
}

async function safeReadDir(path: string): Promise<string[]> {
  try { return await readdir(path); } catch { return []; }
}

const MAX_SIZE_ENTRIES = 100_000;

/** Return the byte size of regular files below `root`, without following any
 * symlink. A bounded traversal keeps inventory responsive for pathological
 * workspaces; `null` means the size is not currently available. */
async function boundedDirectorySize(root: string): Promise<number | null> {
  const pending = [root];
  let entries = 0;
  let total = 0;
  try {
    while (pending.length) {
      const directory = pending.pop()!;
      const handle = await opendir(directory);
      for await (const entry of handle) {
        if (++entries > MAX_SIZE_ENTRIES) return null;
        const path = join(directory, entry.name);
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(path);
        else if (stat.isFile()) total += stat.size;
      }
    }
    return total;
  } catch {
    return null;
  }
}

export async function findWorkspaceInventory(id: string, includeOrphans: boolean): Promise<WorkspaceInventoryItem | undefined> {
  return (await listWorkspaceInventory(includeOrphans)).find((item) => item.id === id);
}
