import { constants } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeUserId, isSafeUserId } from './user-id';

type JournalFile = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>;
/** Injectable filesystem boundary for failure tests; never supplied by requests. */
export interface MigrationJournalIO {
  open(path: string, flags: number, mode?: number): Promise<JournalFile>;
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
const filesystem: MigrationJournalIO = { open, mkdir, rename, unlink };
const filename = 'worker-runtime-migrations.v1.json';
const unavailableCode = 'WORKER_RUNTIME_MIGRATION_JOURNAL_UNAVAILABLE';
export function isMigrationJournalPersistenceError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === unavailableCode;
}
function unavailable(cause?: unknown): Error {
  return Object.assign(new Error('Runtime migration journal is unavailable; stop mutations and reconcile retained state'),
    { code: unavailableCode, statusCode: 503, cause });
}

/** Migration-only persistence. DATA_DIR must already be provisioned durably.
 * Candidate snapshots are invisible until file + directory fsync succeeds.
 * Every failed persistence quarantines that owner for this store's lifetime,
 * including reload/init. Quarantine itself is not persistent across restart.
 * Every loaded record is marked for explicit reconciliation: valid JSON,
 * including a completion rename whose directory sync failed, cannot prove
 * that all Docker operations settled. This is not whole-migration power-loss
 * safety; worker-record callbacks have a separate persistence boundary.
 */
export class DurableMigrationJournalStore<V extends { userId: string }> {
  private readonly items = new Map<string, Map<string, V>>();
  private readonly unavailableOwners = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly loaded = new Map<string, Set<string>>();
  constructor(private readonly dataDir: string, protected readonly keyFn: (value: V) => string,
    private readonly io: MigrationJournalIO = filesystem) {}

  private assertAvailable(userId: string) {
    assertSafeUserId(userId);
    if (this.unavailableOwners.has(userId)) throw unavailable();
  }
  private file(userId: string) { assertSafeUserId(userId); return join(this.dataDir, 'users', userId, filename); }
  private queue<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    assertSafeUserId(userId);
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(() => {
      this.assertAvailable(userId);
      return operation();
    });
    this.queues.set(userId, next.then(() => undefined, () => undefined));
    return next;
  }
  async init(): Promise<void> {
    let owners: string[];
    try { owners = await readdir(join(this.dataDir, 'users')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await Promise.allSettled(owners.filter(isSafeUserId).map((owner) => this.loadUser(owner)));
  }
  async loadUser(userId: string): Promise<void> {
    return this.queue(userId, async () => {
      try {
        let raw: string;
        try { raw = await readFile(this.file(userId), 'utf8'); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.items.delete(userId); this.loaded.delete(userId); return; }
          throw error;
        }
        const values: unknown = JSON.parse(raw);
        if (!Array.isArray(values)) throw new Error('Journal must contain an array');
        const next = new Map<string, V>();
        for (const value of values) {
          if (!value || value.userId !== userId) throw new Error('Journal owner mismatch');
          const key = this.keyFn(value);
          if (next.has(key)) throw new Error('Duplicate migration journal');
          next.set(key, structuredClone(value));
        }
        this.items.set(userId, next);
        this.loaded.set(userId, new Set(next.keys()));
      } catch (error) { this.unavailableOwners.add(userId); throw unavailable(error); }
    });
  }
  get(userId: string, key: string): V | undefined {
    this.assertAvailable(userId);
    const value = this.items.get(userId)?.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  listForUser(userId: string): V[] {
    this.assertAvailable(userId);
    return Array.from(this.items.get(userId)?.values() ?? [], (value) => structuredClone(value));
  }
  list(): V[] { return this.listUserIds().filter((id) => !this.unavailableOwners.has(id)).flatMap((id) => this.listForUser(id)); }
  listUserIds(): string[] { return [...new Set([...this.items.keys(), ...this.unavailableOwners])]; }
  protected requiresLoadedReconciliation(userId: string, key: string): boolean {
    this.assertAvailable(userId);
    return this.loaded.get(userId)?.has(key) === true;
  }
  protected acknowledgeLoadedReconciliation(userId: string, key: string): void {
    this.assertAvailable(userId);
    this.loaded.get(userId)?.delete(key);
  }
  protected async setItem(userId: string, value: V): Promise<void> {
    const owned = structuredClone(value);
    if (owned.userId !== userId) throw new Error('Journal owner mismatch');
    const key = this.keyFn(owned);
    await this.queue(userId, async () => {
      const next = new Map(this.items.get(userId));
      next.set(key, owned);
      await this.persist(userId, next);
      this.items.set(userId, next);
    });
  }
  protected async deleteItem(userId: string, key: string): Promise<void> {
    await this.queue(userId, async () => {
      const next = new Map(this.items.get(userId));
      if (!next.delete(key)) return;
      // Empty arrays are durable tombstones; an unsynced unlink cannot revive
      // a finalized journal after a crash.
      await this.persist(userId, next);
      this.items.set(userId, next);
      this.loaded.get(userId)?.delete(key);
    });
  }
  private async persist(userId: string, next: Map<string, V>): Promise<void> {
    const handles: JournalFile[] = [];
    let temporary: string | undefined;
    let createdTemporary = false;
    let renamed = false;
    try {
      const directory = async (path: string) => {
        const handle = await this.io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(handle);
        return handle;
      };
      const root = await directory(this.dataDir);
      const usersPath = join(this.dataDir, 'users');
      const ownerPath = join(usersPath, userId);
      const ensure = async (path: string) => {
        try { await this.io.mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        return directory(path);
      };
      const users = await ensure(usersPath);
      await root.sync(); // Persist users/ even on a first-owner write.
      const owner = await ensure(ownerPath);
      await users.sync(); // Persist the owner directory before its journal.
      temporary = join(ownerPath, `${filename}.tmp.${randomUUID()}`);
      const file = await this.io.open(temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      createdTemporary = true;
      handles.push(file);
      await file.writeFile(JSON.stringify([...next.values()], null, 2) + '\n', 'utf8');
      await file.sync();
      await file.close(); handles.pop();
      await this.io.rename(temporary, this.file(userId));
      renamed = true;
      await owner.sync();
      // Close errors also fail closed. Do not publish a candidate prematurely.
      while (handles.length) { await handles[handles.length - 1]!.close(); handles.pop(); }
    } catch (error) {
      this.unavailableOwners.add(userId);
      // Never roll back a rename: its persistence is uncertain after an error.
      // Only our exact exclusively-created temporary file may be removed.
      if (temporary && createdTemporary && !renamed) await this.io.unlink(temporary).catch(() => {});
      throw unavailable(error);
    } finally {
      await Promise.allSettled(handles.map((handle) => handle.close()));
    }
  }
}
