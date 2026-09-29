import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { assertSafeUserId, isSafeUserId } from './user-id';

type WorkerFile = Pick<FileHandle, 'writeFile' | 'sync' | 'close'>;
/** Trusted test injection only, never populated by an API request. */
export interface WorkerStoreIO {
  open(path: string, flags: number, mode?: number): Promise<WorkerFile>;
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  rename(source: string, destination: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
const filesystem: WorkerStoreIO = { open, mkdir, rename, unlink };
const filename = 'workers.json';
const unavailableCode = 'WORKER_RECORD_STORE_UNAVAILABLE';
export function isWorkerRecordPersistenceError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === unavailableCode;
}
function unavailable(cause?: unknown): Error {
  return Object.assign(new Error('Worker record store is unavailable for this owner; reconcile retained state before further mutations'),
    { code: unavailableCode, statusCode: 503, cause });
}

/** WorkerStore-only transactions. Generic UserScopedJsonStore is unchanged.
 * DATA_DIR must be durably provisioned; one process owns it. Owner queues are
 * not cross-process locks. Private drafts never back public reads. File and
 * ancestry/directory fsync precede acknowledgement. Uncertainty quarantines
 * the entire owner for this instance (including reload, delete and init).
 * Protected DATA_DIR and its ancestors must not be mutable by untrusted users;
 * no-follow opens reject symlinks but do not provide an openat-based defense
 * against an operator concurrently replacing ancestor directories.
 * Quarantine is NOT persistent across restart: migration journals and their
 * reconciliation holds remain a separate required recovery boundary.
 */
export class WorkerDurableStore<V extends { id: string; userId: string }> {
  private readonly items = new Map<string, Map<string, V>>();
  private readonly candidates = new Map<string, Map<string, V>>();
  private readonly unavailableOwners = new Map<string, 'load' | 'write'>();
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly dataDir: string, private readonly validate: (value: V) => string,
    private readonly io: WorkerStoreIO = filesystem) {}

  private assertAvailable(userId: string, allowCorruptDeletion = false) {
    assertSafeUserId(userId);
    const reason = this.unavailableOwners.get(userId);
    if (reason && !(allowCorruptDeletion && reason === 'load')) throw unavailable();
  }
  private file(userId: string) { assertSafeUserId(userId); return join(this.dataDir, 'users', userId, filename); }
  private queue<T>(userId: string, operation: () => Promise<T>, allowCorruptDeletion = false): Promise<T> {
    assertSafeUserId(userId);
    const next = (this.queues.get(userId) ?? Promise.resolve()).then(() => {
      this.assertAvailable(userId, allowCorruptDeletion);
      return operation();
    });
    this.queues.set(userId, next.then(() => undefined, () => undefined));
    return next;
  }
  async init(): Promise<void> {
    let owners: string[];
    try { owners = await readdir(join(this.dataDir, 'users')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    await Promise.allSettled(owners.filter(isSafeUserId).map(owner => this.loadUser(owner)));
  }
  async loadUser(userId: string): Promise<void> {
    return this.queue(userId, async () => {
      try {
        let raw: string;
        try { raw = await this.readSnapshot(userId); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.items.delete(userId); return; }
          throw error;
        }
        const values: unknown = JSON.parse(raw);
        if (!Array.isArray(values)) throw new Error('Worker snapshot must contain an array');
        const next = new Map<string, V>();
        for (const value of values) {
          if (!value || value.userId !== userId) throw new Error('Worker owner mismatch');
          const key = this.validate(value);
          if (next.has(key)) throw new Error('Duplicate worker record');
          next.set(key, structuredClone(value));
        }
        this.publish(userId, next);
      } catch (error) { this.unavailableOwners.set(userId, 'load'); throw unavailable(error); }
    });
  }
  private async readSnapshot(userId: string): Promise<string> {
    const handles: FileHandle[] = [];
    try {
      for (const path of [this.dataDir, join(this.dataDir, 'users'), join(this.dataDir, 'users', userId)])
        handles.push(await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      const file = await open(this.file(userId), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      handles.push(file);
      if (!(await file.stat()).isFile()) throw new Error('Worker snapshot must be a regular file');
      return await file.readFile('utf8');
    } finally {
      const closed = await Promise.allSettled(handles.map(handle => handle.close()));
      const failed = closed.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
  }
  private publish(userId: string, next: Map<string, V>) {
    if (next.size) this.items.set(userId, next);
    else this.items.delete(userId);
  }
  get(userId: string, key: string): V | undefined {
    this.assertAvailable(userId);
    const value = this.items.get(userId)?.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  has(userId: string, key: string): boolean { return this.get(userId, key) !== undefined; }
  listForUser(userId: string): V[] {
    this.assertAvailable(userId);
    return Array.from(this.items.get(userId)?.values() ?? [], value => structuredClone(value));
  }
  list(): V[] { return this.listUserIds().filter(id => !this.unavailableOwners.has(id)).flatMap(id => this.listForUser(id)); }
  listUserIds(): string[] { return [...new Set([...this.items.keys(), ...this.unavailableOwners.keys()])]; }
  findWithOwner(predicate: (value: V) => boolean): { userId: string; item: V } | undefined {
    for (const item of this.list()) if (predicate(item)) return { userId: item.userId, item };
    return undefined;
  }
  hasUnavailableOwners(): boolean { return this.unavailableOwners.size > 0; }

  /** Synchronous mutation of a detached draft; validation/CAS failures are not
   * storage failures. No callback may do Docker work or acquire lifecycle locks.
   * persist=false is only for no-op/missing-record lookups; it publishes nothing.
   */
  protected transaction<T>(userId: string, change: (draft: Map<string, V>) => { result: T; persist: boolean }, allowCorruptDeletion = false): Promise<T> {
    return this.queue(userId, async () => {
      const draft = new Map(Array.from(this.items.get(userId) ?? [], ([key, value]) => [key, structuredClone(value)]));
      const outcome = change(draft);
      const result = structuredClone(outcome.result);
      if (!outcome.persist) return result;
      for (const [key, value] of draft) {
        if (value.userId !== userId || this.validate(value) !== key) throw new Error('Worker transaction identity mismatch');
      }
      this.candidates.set(userId, draft);
      try {
        await this.persistUser(userId);
        this.publish(userId, draft);
        if (allowCorruptDeletion) this.unavailableOwners.delete(userId);
      } catch (error) { this.unavailableOwners.set(userId, 'write'); throw unavailable(error); }
      finally { this.candidates.delete(userId); }
      return result;
    }, allowCorruptDeletion);
  }
  async removeForUser(userId: string): Promise<number> {
    return this.transaction(userId, draft => {
      const count = draft.size; draft.clear();
      // Even an empty known owner gets an fsynced tombstone, not an unlink.
      return { result: count, persist: true };
    }, true); // Explicit deleted-owner cleanup may retire corrupt-load bytes,
    // but MUST NOT clear a failed/uncertain persistence quarantine.
  }
  protected deleteItem(userId: string, id: string): Promise<boolean> {
    return this.transaction(userId, draft => {
      const deleted = draft.delete(id);
      return { result: deleted, persist: deleted };
    });
  }

  /** Override only for trusted test gates. Uses the transaction's private
   * candidate, never a map that public readers can observe before durability. */
  protected async persistUser(userId: string): Promise<void> {
    const next = this.candidates.get(userId);
    if (!next) throw new Error('Worker persistence outside transaction');
    const handles: WorkerFile[] = [];
    let temporary: string | undefined, created = false, renamed = false;
    try {
      const directory = async (path: string) => {
        const handle = await this.io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(handle); return handle;
      };
      const root = await directory(this.dataDir);
      const usersPath = join(this.dataDir, 'users'), ownerPath = join(usersPath, userId);
      const ensure = async (path: string) => {
        try { await this.io.mkdir(path, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        return directory(path);
      };
      const users = await ensure(usersPath); await root.sync();
      const owner = await ensure(ownerPath); await users.sync();
      temporary = join(ownerPath, `${filename}.tmp.${randomUUID()}`);
      const file = await this.io.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true; handles.push(file);
      await file.writeFile(JSON.stringify([...next.values()], null, 2) + '\n', 'utf8');
      await file.sync(); await file.close(); handles.pop();
      await this.io.rename(temporary, this.file(userId)); renamed = true;
      await owner.sync();
      while (handles.length) { await handles[handles.length - 1]!.close(); handles.pop(); }
    } catch (error) {
      // Rename uncertainty is retained, never rolled back. Only remove our
      // exact exclusively-created temporary file if it was not renamed.
      if (temporary && created && !renamed) await this.io.unlink(temporary).catch(() => {});
      throw error;
    } finally { await Promise.allSettled(handles.map(handle => handle.close())); }
  }
}
