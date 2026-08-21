import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertSafeUserId, isSafeUserId } from './user-id';

/**
 * JSON store partitioned per user. Each user's items live in their own file at
 * `<dataDir>/users/<userId>/<filename>`. On init, scans `<dataDir>/users/*` and
 * loads every matching file into an in-memory `Map<userId, Map<K, V>>`. Writes
 * are serialized per user (each user has its own save queue).
 *
 * Subclasses expose typed `create`/`update`/`delete` methods that call the
 * protected `setItem` / `deleteItem` / `removeWhere` helpers.
 */
export class UserScopedJsonStore<K, V> {
  protected items = new Map<string, Map<K, V>>();
  protected dataDir: string;
  protected filename: string;
  protected keyFn: (item: V) => K;
  private saveQueues = new Map<string, Promise<void>>();
  private unavailableUsers = new Set<string>();

  constructor(dataDir: string, filename: string, keyFn: (item: V) => K) {
    this.dataDir = dataDir;
    this.filename = filename;
    this.keyFn = keyFn;
  }

  async init(): Promise<void> {
    const usersDir = join(this.dataDir, 'users');
    let userIds: string[] = [];
    try {
      userIds = await readdir(usersDir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    // A single corrupt or unreadable per-user file must NOT take down the whole
    // orchestrator for every other user — load each user independently and
    // quarantine (log + skip) any that fail rather than rejecting the boot.
    const results = await Promise.allSettled(
      userIds
        .filter(isSafeUserId)
        .map((userId) => this.loadUser(userId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        useLogger().error(
          `[user-scoped-store] skipped a corrupt/unreadable ${this.filename} during init: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
  }

  /** Load (or reload) a single user's file. Useful after a user dir is created
   * mid-run by some other subsystem. Invalid input quarantines that owner and
   * rejects this load; init() isolates the rejection so other owners still load. */
  async loadUser(userId: string): Promise<void> {
    assertSafeUserId(userId);
    const filePath = this.filePathForUser(userId);
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.unavailableUsers.delete(userId);
        this.items.delete(userId);
        return;
      }
      this.unavailableUsers.add(userId);
      useLogger().error(`[user-scoped-store] failed to load ${filePath}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
    let parsed: V[];
    try {
      parsed = JSON.parse(raw) as V[];
    } catch (err: unknown) {
      // Corrupt JSON (e.g. a truncated write from a hard kill). Quarantine the
      // user (log + skip) instead of crashing every user's load.
      this.unavailableUsers.add(userId);
      useLogger().error(`[user-scoped-store] corrupt ${filePath} — skipping this user: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
    if (!Array.isArray(parsed)) {
      this.unavailableUsers.add(userId);
      const error = new Error(`${filePath} must contain an array`);
      useLogger().error(`[user-scoped-store] corrupt ${filePath} — skipping this user: ${error.message}`);
      throw error;
    }
    const map = new Map<K, V>();
    try {
      for (const item of parsed) {
        // One invalid record makes the source snapshot unsafe to rewrite. If it
        // were merely skipped, the next otherwise-valid mutation would commit
        // the partial in-memory map and silently erase the quarantined bytes.
        if (
          item &&
          typeof item === 'object' &&
          'userId' in item &&
          (item as { userId?: unknown }).userId !== userId
        ) {
          throw new Error('Persisted resource owner mismatch');
        }
        const key = this.keyFn(item);
        if (map.has(key)) throw new Error('Duplicate persisted resource key');
        map.set(key, structuredClone(item));
      }
    } catch (err) {
      // keyFn is supplied by subclasses and commonly dereferences required
      // fields. Treat both an explicit validation failure and a thrown keyFn as
      // corruption of this owner partition, rather than failing open.
      this.unavailableUsers.add(userId);
      useLogger().error(
        `[user-scoped-store] corrupt ${filePath} — skipping this user: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
    this.unavailableUsers.delete(userId);
    if (map.size > 0) this.items.set(userId, map);
    else this.items.delete(userId);
  }

  /** Flat list of every item across every user. */
  list(): V[] {
    const out: V[] = [];
    for (const [userId, map] of this.items) {
      if (this.unavailableUsers.has(userId)) continue;
      for (const v of map.values()) out.push(structuredClone(v));
    }
    return out;
  }

  /** User ids that currently have at least one item in this store. Cheaper
   * than iterating the whole dataset when the caller only needs the key set. */
  listUserIds(): string[] {
    return [...new Set([...this.items.keys(), ...this.unavailableUsers])];
  }

  listForUser(userId: string): V[] {
    this.assertAvailable(userId);
    return Array.from(this.items.get(userId)?.values() ?? [], (item) =>
      structuredClone(item),
    );
  }

  get(userId: string, key: K): V | undefined {
    this.assertAvailable(userId);
    const item = this.items.get(userId)?.get(key);
    return item === undefined ? undefined : structuredClone(item);
  }

  has(userId: string, key: K): boolean {
    this.assertAvailable(userId);
    return this.items.get(userId)?.has(key) ?? false;
  }

  /** Find the first item across all users matching a predicate, along with its owner. */
  findWithOwner(predicate: (item: V) => boolean): { userId: string; item: V } | undefined {
    for (const [userId, map] of this.items) {
      if (this.unavailableUsers.has(userId)) continue;
      for (const item of map.values()) {
        const snapshot = structuredClone(item);
        if (predicate(snapshot)) return { userId, item: snapshot };
      }
    }
    return undefined;
  }

  protected async setItem(userId: string, item: V): Promise<void> {
    assertSafeUserId(userId);
    if (
      item &&
      typeof item === 'object' &&
      'userId' in item &&
      (item as { userId?: unknown }).userId !== userId
    ) {
      throw Object.assign(new Error('Persisted resource owner mismatch'), {
        statusCode: 400,
      });
    }
    // The store owns its in-memory values. Without an ingress copy, a caller
    // could mutate its original object after a successful write and change the
    // apparent durable state without another transaction.
    const ownedItem = structuredClone(item);
    const key = this.keyFn(ownedItem);
    await this.withUserMutation(userId, async () => {
      let map = this.items.get(userId);
      const createdMap = !map;
      if (!map) {
        map = new Map<K, V>();
        this.items.set(userId, map);
      }
      const previous = map.get(key);
      map.set(key, ownedItem);
      try {
        await this.persistUser(userId);
      } catch (error) {
        if (previous !== undefined) map.set(key, previous);
        else map.delete(key);
        if (createdMap && map.size === 0) this.items.delete(userId);
        throw error;
      }
    });
  }

  protected async deleteItem(userId: string, key: K): Promise<boolean> {
    assertSafeUserId(userId);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      if (!map || !map.has(key)) return false;
      const previous = map.get(key)!;
      map.delete(key);
      if (map.size === 0) this.items.delete(userId);
      try {
        await this.persistUser(userId);
      } catch (error) {
        // Persistence is the commit point. Restore the in-memory handle so the
        // exact deletion can be retried instead of falsely succeeding while a
        // stale record remains on disk.
        this.items.set(userId, map);
        map.set(key, previous);
        throw error;
      }
      return true;
    });
  }

  protected async removeWhere(predicate: (item: V) => boolean): Promise<number> {
    let count = 0;
    for (const userId of this.listUserIds()) {
      if (this.unavailableUsers.has(userId)) continue;
      count += await this.withUserMutation(userId, async () => {
        const map = this.items.get(userId);
        if (!map) return 0;
        const entries = [...map].filter(([, item]) =>
          predicate(structuredClone(item)),
        );
        if (!entries.length) return 0;
        for (const [key] of entries) map.delete(key);
        if (map.size === 0) this.items.delete(userId);
        try {
          await this.persistUser(userId);
        } catch (error) {
          let rollback = this.items.get(userId);
          if (!rollback) {
            rollback = new Map<K, V>();
            this.items.set(userId, rollback);
          }
          for (const [key, item] of entries) rollback.set(key, item);
          throw error;
        }
        return entries.length;
      });
    }
    return count;
  }

  /** Remove every item for a user and delete their file. Called by the orphan
   * sweeper (user deletion) and similar admin paths. */
  async removeForUser(userId: string): Promise<number> {
    assertSafeUserId(userId);
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      const count = map?.size ?? 0;
      this.items.delete(userId);
      try {
        await rm(this.filePathForUser(userId), { force: true });
      } catch (error) {
        // A failed unlink is not a committed deletion. Retain the owner as an
        // in-process sweeper candidate and make the failure visible to callers.
        if (map) this.items.set(userId, map);
        throw error;
      }
      this.unavailableUsers.delete(userId);
      return count;
    }, true);
  }

  private filePathForUser(userId: string): string {
    assertSafeUserId(userId);
    return join(this.dataDir, 'users', userId, this.filename);
  }

  /** Serialize the complete in-memory mutation + persistence transaction. */
  protected withUserMutation<T>(
    userId: string,
    operation: () => Promise<T>,
    allowUnavailable = false,
  ): Promise<T> {
    const prev = this.saveQueues.get(userId) ?? Promise.resolve();
    const next = prev.then(() => {
      if (!allowUnavailable) this.assertAvailable(userId);
      return operation();
    });
    this.saveQueues.set(userId, next.then(() => undefined, () => undefined));
    return next;
  }

  private assertAvailable(userId: string): void {
    if (!this.unavailableUsers.has(userId)) return;
    throw Object.assign(
      new Error(`Stored ${this.filename} data is unavailable for this owner`),
      { statusCode: 503 },
    );
  }

  /** Persist the current per-user snapshot. Call only from withUserMutation. */
  protected persistUser(userId: string): Promise<void> {
    return this.writeUser(userId);
  }

  private async writeUser(userId: string): Promise<void> {
    const filePath = this.filePathForUser(userId);
    const items = Array.from(this.items.get(userId)?.values() ?? []);
    try {
      if (items.length === 0) {
        await rm(filePath, { force: true });
        return;
      }
      await mkdir(join(this.dataDir, 'users', userId), { recursive: true });
      // Write to a temp file in the same directory, then atomically rename it
      // into place. A hard kill mid-write (OOM, container stop, self-update
      // swap) can then only leave a stray `.tmp` file, never a truncated store
      // that crashes the next boot's parse.
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(items, null, 2));
      await rename(tmpPath, filePath);
    } catch (err) {
      useLogger().error(`[user-scoped-store] failed to save ${filePath}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }
}
