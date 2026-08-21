import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface WorkspaceTombstone { schemaVersion: 1; id: string; workerId: string; userId: string; displayName: string; backend: 'directory' | 'volume'; createdAt?: string; deletedAt: string }

/** Serialized, transactional tombstone persistence. A rejected write must not
 * poison the queue: later cleanup attempts still need to be able to persist a
 * retry handle without restarting the orchestrator. */
export class WorkspaceTombstoneStore {
  private loaded: Promise<void> | undefined;
  private entries: WorkspaceTombstone[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private path() { return join(this.dataDir, 'workspace-tombstones.json'); }

  private async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path(), 'utf8'));
      if (parsed?.schemaVersion === 1 && Array.isArray(parsed.entries)) this.entries = parsed.entries;
    } catch { /* first boot or unreadable legacy state */ }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async persist() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const target = this.path();
    const temporary = `${target}.tmp.${process.pid}`;
    await writeFile(temporary, JSON.stringify({ schemaVersion: 1, entries: this.entries }, null, 2), { mode: 0o600 });
    await rename(temporary, target);
  }

  list(): Promise<WorkspaceTombstone[]> {
    return this.enqueue(async () => {
      await (this.loaded ??= this.load());
      return structuredClone(this.entries);
    });
  }

  record(value: Omit<WorkspaceTombstone, 'schemaVersion' | 'id' | 'deletedAt'>): Promise<void> {
    return this.enqueue(async () => {
      await (this.loaded ??= this.load());
      const previous = this.entries;
      const deletedAt = new Date().toISOString();
      this.entries = this.entries.filter((entry) => entry.workerId !== value.workerId);
      this.entries.push({ schemaVersion: 1, id: `deleted-${value.workerId}`, ...value, deletedAt });
      try {
        await this.persist();
      } catch (error) {
        this.entries = previous;
        throw error;
      }
    });
  }

  removeForUser(userId: string): Promise<void> {
    return this.enqueue(async () => {
      await (this.loaded ??= this.load());
      const previous = this.entries;
      const next = previous.filter((entry) => entry.userId !== userId);
      if (next.length === previous.length) return;
      this.entries = next;
      try {
        await this.persist();
      } catch (error) {
        this.entries = previous;
        throw error;
      }
    });
  }
}

const workspaceTombstones = new WorkspaceTombstoneStore(process.env.DATA_DIR || '/data');
export function listWorkspaceTombstones() { return workspaceTombstones.list(); }
export function recordWorkspaceTombstone(value: Omit<WorkspaceTombstone, 'schemaVersion' | 'id' | 'deletedAt'>) { return workspaceTombstones.record(value); }
export function removeWorkspaceTombstonesForUser(userId: string) { return workspaceTombstones.removeForUser(userId); }
