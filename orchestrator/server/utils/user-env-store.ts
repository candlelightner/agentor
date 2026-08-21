import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PREDEFINED_ENV_VAR_KEYS, type UserEnvVars, type UserEnvVarsInput, type UserEnvVar } from '../../shared/types';
import { assertSafeUserId, isSafeUserId } from './user-id';

export const USER_ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** The env vars the orchestrator (or the worker entrypoint) injects into every
 * worker container. This is the *complete* set of orchestrator-provided env a
 * worker actually receives — nothing else from the orchestrator's own process
 * env (BETTER_AUTH_*, DASHBOARD_*, ACME_*, BASE_DOMAINS, LOG_*, …) is ever passed
 * to a worker. It is the single source of truth behind both the reserved-key
 * guard (users may not override these) and the read-only "provided by the
 * orchestrator" list surfaced in the worker Environment editor
 * (`GET /api/worker-env-vars`). */
export const WORKER_SYSTEM_ENV_VARS: { name: string; description: string }[] = [
  { name: 'ENVIRONMENT', description: 'Environment config JSON — network mode, allowed domains, Docker, setup script, exposed APIs' },
  { name: 'CAPABILITIES', description: 'Enabled capability documents (JSON array)' },
  { name: 'INSTRUCTIONS', description: 'Enabled instruction documents (JSON array)' },
  { name: 'WORKER', description: 'Worker identity & config JSON — id, display name, repos, init script, git identity' },
  { name: 'ORCHESTRATOR_URL', description: 'Base URL of the orchestrator API (used by worker-self calls)' },
  { name: 'WORKER_CONTAINER_NAME', description: "This worker's Docker container name" },
  { name: 'EXPOSE_PORT_MAPPINGS', description: 'Whether the worker-self port-mapping API is exposed (from Expose APIs)' },
  { name: 'EXPOSE_DOMAIN_MAPPINGS', description: 'Whether the worker-self domain-mapping API is exposed (from Expose APIs)' },
  { name: 'EXPOSE_USAGE', description: 'Whether the worker-self usage API is exposed (from Expose APIs)' },
];

/** Reserved env var names that must not appear in a user's env vars (they are
 * injected by the orchestrator or the entrypoint and would collide). The
 * orchestrator-injected names come straight from `WORKER_SYSTEM_ENV_VARS`; the
 * remaining three are OS-level vars the entrypoint relies on. */
const RESERVED_KEYS = new Set<string>([
  ...WORKER_SYSTEM_ENV_VARS.map((v) => v.name),
  'HOME',
  'PATH',
  'USER',
]);
export function isAllowedUserEnvKey(key:string){return USER_ENV_KEY_RE.test(key)&&!RESERVED_KEYS.has(key);}

export function zeroUserEnvVars(userId: string): UserEnvVars {
  return {
    userId,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    envVars: [],
  };
}

/** Look up a single env var's value by name (empty string if unset). */
export function getUserEnvVar(env: UserEnvVars, key: string): string {
  return env.envVars.find((e) => e.key === key)?.value ?? '';
}

/** Validate a names-only worker exclusion list. Predefined keys remain legal
 * even when currently unset; custom keys must exist in the owner's account. */
export function normalizeExcludedGlobalEnvVarKeys(env: UserEnvVars, value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((key) => typeof key !== 'string'))
    throw Object.assign(new Error('excludedGlobalEnvVarKeys must be an array of strings'), { statusCode: 400 });
  const allowed = new Set<string>([...PREDEFINED_ENV_VAR_KEYS, ...env.envVars.map(({ key }) => key)]);
  const result = [...new Set(value as string[])].sort();
  const unknown = result.filter((key) => !allowed.has(key));
  if (unknown.length) throw Object.assign(new Error(`Unknown account environment variable key: ${unknown.join(', ')}`), { statusCode: 400 });
  return result;
}

const FILENAME = 'env-vars.json';

/** Per-user env vars, persisted as a single JSON object at
 * `<DATA_DIR>/users/<userId>/env-vars.json`. The file carries the owner `userId`
 * (matching the directory name) like every other user-scoped resource.
 *
 * Serialized writes per user via an in-memory save queue. */
export class UserEnvVarStore {
  private items = new Map<string, UserEnvVars>();
  private dataDir: string;
  private saveQueues = new Map<string, Promise<void>>();
  private unavailableUsers = new Set<string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
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
    // Load each user independently — a single corrupt env-vars file must not
    // crash the boot for everyone else (mirrors UserScopedJsonStore.init).
    const results = await Promise.allSettled(
      userIds
        .filter(isSafeUserId)
        .map((userId) => this.loadUser(userId)),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        useLogger().error(
          `[user-env-store] skipped a corrupt/unreadable ${FILENAME} during init: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
        );
      }
    }
  }

  async loadUser(userId: string): Promise<void> {
    assertSafeUserId(userId);
    const filePath = this.filePath(userId);
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
      useLogger().error(`[user-env-store] failed to load ${filePath}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (err: unknown) {
      this.unavailableUsers.add(userId);
      useLogger().error(`[user-env-store] corrupt ${filePath} — skipping this user: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
    try {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Environment variable state must be an object');
      const value = parsed as Partial<UserEnvVars>;
      if (value.userId !== userId)
        throw new Error('Persisted environment variable owner mismatch');
      if (value.createdAt !== undefined && typeof value.createdAt !== 'string')
        throw new Error('Invalid environment variable createdAt');
      if (value.updatedAt !== undefined && typeof value.updatedAt !== 'string')
        throw new Error('Invalid environment variable updatedAt');
      if (value.envVars !== undefined && !Array.isArray(value.envVars))
        throw new Error('Persisted envVars must be an array');
      const now = new Date().toISOString();
      this.items.set(userId, {
        userId,
        createdAt: value.createdAt ?? now,
        updatedAt: value.updatedAt ?? now,
        envVars: validatePersistedEnvVars(value.envVars ?? []),
      });
      this.unavailableUsers.delete(userId);
    } catch (err) {
      this.unavailableUsers.add(userId);
      useLogger().error(
        `[user-env-store] corrupt ${filePath} — skipping this user: ${err instanceof Error ? err.message : err}`,
      );
      throw err;
    }
  }

  list(): UserEnvVars[] {
    return Array.from(this.items, ([userId, item]) =>
      this.unavailableUsers.has(userId) ? undefined : structuredClone(item),
    ).filter((item): item is UserEnvVars => item !== undefined);
  }

  getOrDefault(userId: string): UserEnvVars {
    this.assertAvailable(userId);
    return structuredClone(this.items.get(userId) ?? zeroUserEnvVars(userId));
  }

  async upsert(userId: string, input: UserEnvVarsInput): Promise<UserEnvVars> {
    assertSafeUserId(userId);
    return this.withUserMutation(userId, async () => {
      const previous = this.items.get(userId);
      const existing = previous ?? zeroUserEnvVars(userId);
      const envVars = input.envVars !== undefined
        ? sanitizeEnvVars(input.envVars)
        : existing.envVars;

      const merged: UserEnvVars = {
        userId,
        createdAt: existing.createdAt && existing.createdAt !== new Date(0).toISOString()
          ? existing.createdAt
          : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        envVars,
      };
      this.items.set(userId, merged);
      try {
        await this.write(userId);
      } catch (error) {
        if (previous) this.items.set(userId, previous);
        else this.items.delete(userId);
        throw error;
      }
      useLogger().debug(`[user-env-store] upserted env vars for user ${userId}`);
      return structuredClone(merged);
    });
  }

  async delete(userId: string): Promise<void> {
    assertSafeUserId(userId);
    return this.withUserMutation(userId, async () => {
      const previous = this.items.get(userId);
      this.items.delete(userId);
      try {
        await rm(this.filePath(userId), { force: true });
      } catch (error) {
        if (previous) this.items.set(userId, previous);
        throw error;
      }
      this.unavailableUsers.delete(userId);
      useLogger().info(`[user-env-store] removed env vars for user ${userId}`);
    }, true);
  }

  private filePath(userId: string): string {
    assertSafeUserId(userId);
    return join(this.dataDir, 'users', userId, FILENAME);
  }

  private withUserMutation<T>(
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
      new Error(`Stored ${FILENAME} data is unavailable for this owner`),
      { statusCode: 503 },
    );
  }

  private async write(userId: string): Promise<void> {
    const entry = this.items.get(userId);
    if (!entry) return;
    const filePath = this.filePath(userId);
    try {
      await mkdir(join(this.dataDir, 'users', userId), { recursive: true });
      // Persist the full record (incl. `userId`) like every user-scoped resource.
      // Atomic write — temp file + rename, so a hard kill mid-write can't leave a
      // truncated file that crashes the next boot's parse.
      const tmpPath = `${filePath}.tmp.${process.pid}`;
      await writeFile(tmpPath, JSON.stringify(entry, null, 2));
      await rename(tmpPath, filePath);
    } catch (err) {
      useLogger().error(`[user-env-store] failed to save ${filePath}: ${err instanceof Error ? err.message : err}`);
      throw err;
    }
  }
}

/** Validate + dedupe a user's env var list. All env vars (predefined + custom)
 * go through the same checks: key format `[A-Z_][A-Z0-9_]*`, not a reserved name,
 * no duplicates. Empty-keyed entries are dropped. */
function sanitizeEnvVars(input: UserEnvVar[]): UserEnvVar[] {
  if (!Array.isArray(input)) throw new Error('envVars must be an array');
  const out: UserEnvVar[] = [];
  const seen = new Set<string>();
  for (const entry of input) {
    if (!entry || typeof entry.key !== 'string' || typeof entry.value !== 'string') continue;
    const key = entry.key.trim();
    if (!key) continue;
    if (!USER_ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env var name: "${key}". Must match ${USER_ENV_KEY_RE}.`);
    }
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`"${key}" is reserved and cannot be set as an env var.`);
    }
    if (seen.has(key)) {
      throw new Error(`Duplicate env var name: "${key}"`);
    }
    seen.add(key);
    out.push({ key, value: entry.value });
  }
  return out;
}

/** Disk input is not an interactive form: dropping malformed rows would make
 * the next save silently destroy evidence and potentially remove credentials. */
function validatePersistedEnvVars(input: UserEnvVar[]): UserEnvVar[] {
  for (const entry of input) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.key !== 'string' ||
      !entry.key.trim() ||
      typeof entry.value !== 'string'
    ) {
      throw new Error('Invalid persisted environment variable entry');
    }
  }
  return sanitizeEnvVars(input);
}

/** Render user env vars as a list of `KEY=VALUE` strings, skipping empty values.
 * Order follows the stored list; later entries shadow earlier ones on key clash. */
export function renderUserEnvVars(env: UserEnvVars): string[] {
  const merged = new Map<string, string>();
  for (const { key, value } of env.envVars) {
    if (value) merged.set(key, value);
  }
  return [...merged.entries()].map(([k, v]) => `${k}=${v}`);
}
