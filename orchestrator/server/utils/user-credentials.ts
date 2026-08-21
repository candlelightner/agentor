import { chown, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { StorageManager } from './storage';
import type { CredentialInfo } from '../../shared/types';
import { isSafeUserId } from './user-id';

/** Files expected to exist in each user's credentials directory. `fileName` is
 * the per-user file on the host; `containerPath` is where the file is bind-mounted
 * inside the worker — the exact path each CLI reads and writes. The paths nest
 * inside the agent-data volume, so the orchestrator pre-creates the mountpoint
 * files on the host (see `StorageManager.ensureWorkerDirs`) to keep Docker
 * Desktop's virtiofs happy with the nested bind. Writes by the CLI land on the
 * host file immediately and every worker the same user owns sees the update.
 *
 * Kilo is the exception: its auth file lives inside the shared Kilo data
 * directory (`<DATA_DIR>/users/<userId>/kilo/data/auth.json`) and is surfaced
 * in workers via a directory bind at `.agent-data/.kilo/shared-data` (then
 * symlinked to `~/.local/share/kilo`). It is NOT bind-mounted as a single
 * file because Kilo rewrites `auth.json` atomically via temp+rename, which
 * breaks a file bind. `getBindMountsForUser` skips it; status/reset read and
 * write the live shared auth file directly. */
export interface AgentCredentialMapping {
  agentId: string;
  fileName: string;
  containerPath: string;
  /** Path relative to the user's data dir when the credential does not live in
   * the standard `credentials/` directory. */
  storagePath?: string;
  /** False when the credential is exposed through a parent directory bind. */
  fileBind?: boolean;
}

const KILO_LEGACY_FILE_NAME = 'kilo.json';
const KILO_AUTH_FILE_NAME = 'auth.json';
const KILO_STORAGE_PATH = `kilo/data/${KILO_AUTH_FILE_NAME}`;

export const AGENT_CREDENTIAL_MAPPINGS: AgentCredentialMapping[] = [
  { agentId: 'claude', fileName: 'claude.json', containerPath: '/home/agent/.agent-data/.claude/.credentials.json' },
  { agentId: 'codex', fileName: 'codex.json', containerPath: '/home/agent/.agent-data/.codex/auth.json' },
  { agentId: 'gemini', fileName: 'gemini.json', containerPath: '/home/agent/.agent-data/.gemini/oauth_creds.json' },
  {
    agentId: 'kilo',
    fileName: KILO_LEGACY_FILE_NAME,
    containerPath: '/home/agent/.agent-data/.kilo/shared-data/auth.json',
    storagePath: KILO_STORAGE_PATH,
    fileBind: false,
  },
];

const AGENT_UID = 1000;
const AGENT_GID = 1000;

/** Manages per-user OAuth credential files. Claude/Codex/Gemini live under
 * `<DATA_DIR>/users/<userId>/credentials/{claude,codex,gemini}.json` and are
 * bind-mounted as single files into that user's workers. Kilo's auth file is
 * the canonical `auth.json` inside the shared Kilo data directory
 * (`<DATA_DIR>/users/<userId>/kilo/data/auth.json`), surfaced via a directory
 * bind — see `AGENT_CREDENTIAL_MAPPINGS`. */
export class UserCredentialManager {
  private storage: StorageManager;
  /** Per-process cache of user IDs whose credential directory + files have
   * already been ensured this run. Skips the mkdir/stat/writeFile/chown
   * syscalls on every subsequent worker create for the same user. */
  private seededUsers = new Set<string>();

  constructor(storage: StorageManager) {
    this.storage = storage;
  }

  /** Absolute in-container path to the user's live Kilo auth file (inside the
   * shared Kilo data directory). */
  private kiloAuthPath(userId: string): string {
    return join(this.storage.getUserDir(userId), 'kilo', 'data', KILO_AUTH_FILE_NAME);
  }

  /** Absolute in-container path to the user's legacy `credentials/kilo.json`
   * (pre-migration duplicate). */
  private kiloLegacyPath(userId: string): string {
    return join(this.credentialsDir(userId), KILO_LEGACY_FILE_NAME);
  }

  /** Resolve the absolute in-container path for any credential `fileName`,
   * routing Kilo to the shared Kilo data directory. */
  filePath(userId: string, fileName: string): string {
    const mapping = AGENT_CREDENTIAL_MAPPINGS.find((entry) => entry.fileName === fileName);
    return mapping?.storagePath
      ? join(this.storage.getUserDir(userId), mapping.storagePath)
      : join(this.credentialsDir(userId), fileName);
  }

  /** Create the user's credentials directory and seed each agent's file as `{}`
   * when missing. Kilo's auth file is seeded inside its shared data dir (which
   * `StorageManager.ensureUserKiloSharedDataDir` ensures). Cached per-userId
   * after first success. */
  async ensureUserDir(userId: string): Promise<void> {
    if (this.seededUsers.has(userId)) return;
    await this.storage.ensureUserDir(userId);
    await this.storage.ensureUserKiloSharedDataDir(userId);
    await Promise.all(
      AGENT_CREDENTIAL_MAPPINGS.map(async (mapping) => {
        const filePath = this.filePath(userId, mapping.fileName);
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        try {
          await stat(filePath);
        } catch {
          await writeFile(filePath, '{}', { mode: 0o600 });
          try {
            await chown(filePath, AGENT_UID, AGENT_GID);
          } catch {
            // Best effort — ownership only matters in directory mode. In volume
            // mode the entrypoint's chown handles it.
          }
        }
      }),
    );
    // Migrate a legacy `credentials/kilo.json` into the shared Kilo auth file,
    // then remove the duplicate so a single canonical secret copy remains.
    const kiloMigrationComplete = await this.migrateLegacyKilo(userId).catch((err) => {
      useLogger().warn(`[user-credentials] Kilo legacy migration failed for user ${userId}: ${err instanceof Error ? err.message : err}`);
      return false;
    });
    // Retry on the next request when malformed/unreadable legacy data was left
    // in place; caching that failure would strand the old secret indefinitely.
    if (kiloMigrationComplete) this.seededUsers.add(userId);
  }

  /** Migrate a legacy `credentials/kilo.json` into the shared Kilo auth file.
   * Never overwrites a non-empty shared auth file; only merges missing
   * top-level entries so the first migration populates shared auth while later
   * legacy duplicates can still add missing provider entries. Removes the
   * legacy file only after a successful merge. Safe against malformed JSON. */
  private async migrateLegacyKilo(userId: string): Promise<boolean> {
    const legacyPath = this.kiloLegacyPath(userId);
    let legacyRaw: string;
    try {
      legacyRaw = await readFile(legacyPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw err;
    }
    const trimmed = legacyRaw.trim();
    if (!trimmed || trimmed === '{}') {
      // Empty legacy duplicate — just remove it.
      await unlink(legacyPath).catch(() => {});
      return true;
    }
    let legacy: Record<string, unknown>;
    try {
      legacy = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Malformed legacy file — leave it in place rather than risk losing
      // secrets, but do not abort worker startup (caller swallows the error).
      useLogger().warn(`[user-credentials] legacy kilo.json for user ${userId} is malformed JSON — leaving in place`);
      return false;
    }
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) {
      return false;
    }

    const authPath = this.kiloAuthPath(userId);
    let shared: Record<string, unknown> = {};
    try {
      const sharedRaw = (await readFile(authPath, 'utf-8')).trim();
      if (sharedRaw && sharedRaw !== '{}') {
        shared = JSON.parse(sharedRaw) as Record<string, unknown>;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Malformed shared file — do not risk overwriting; leave legacy in place.
        useLogger().warn(`[user-credentials] shared Kilo auth for user ${userId} unreadable — skipping legacy merge`);
        return false;
      }
    }
    if (!shared || typeof shared !== 'object' || Array.isArray(shared)) shared = {};

    let changed = false;
    for (const [key, value] of Object.entries(legacy)) {
      if (shared[key] === undefined) {
        shared[key] = value;
        changed = true;
      }
    }
    if (changed) {
      await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
      await writeFile(authPath, JSON.stringify(shared, null, 2), { mode: 0o600 });
      try {
        await chown(authPath, AGENT_UID, AGENT_GID);
      } catch {
        // Best effort.
      }
    }
    await unlink(legacyPath).catch(() => {});
    useLogger().info(`[user-credentials] migrated legacy kilo.json into shared Kilo auth for user ${userId}`);
    return true;
  }

  /** Build the bind strings mapping each of this user's credential files to the
   * expected path inside a worker container. Kilo is excluded — its auth file
   * is surfaced via the shared-data directory bind (see
   * `StorageManager.getKiloSharedDataBind`). Returns an empty array when the
   * StorageManager cannot resolve `dataHostPath` — callers should treat this
   * as "no creds shared". */
  getBindMountsForUser(userId: string): string[] {
    if (!this.storage.dataHostPath) return [];
    const hostDir = join(this.storage.getUserHostDir(userId), 'credentials');
    return AGENT_CREDENTIAL_MAPPINGS
      .filter((m) => m.fileBind !== false)
      .map((m) => `${join(hostDir, m.fileName)}:${m.containerPath}`);
  }

  /** Returns true when the user's credential file contains more than `{}`. */
  async getStatusForUser(userId: string, fileName: string): Promise<boolean> {
    try {
      const content = await readFile(this.filePath(userId, fileName), 'utf-8');
      return content.trim().length > 2;
    } catch {
      return false;
    }
  }

  /** Reset (truncate to `{}`) a single credential file. For Kilo this writes
   * the live shared auth file (shared across all of the user's workers). */
  async reset(userId: string, fileName: string): Promise<void> {
    const mapping = AGENT_CREDENTIAL_MAPPINGS.find((m) => m.fileName === fileName);
    if (!mapping) throw new Error(`Unknown credential file: ${fileName}`);
    await this.ensureUserDir(userId);
    const filePath = this.filePath(userId, fileName);
    await writeFile(filePath, '{}', { mode: 0o600 });
    try {
      await chown(filePath, AGENT_UID, AGENT_GID);
    } catch {
      // See ensureUserDir — best effort.
    }
    useLogger().info(`[user-credentials] reset ${fileName} for user ${userId}`);
  }

  /** Return the per-user status for every known agent credential mapping. */
  async statusList(userId: string): Promise<CredentialInfo[]> {
    return Promise.all(
      AGENT_CREDENTIAL_MAPPINGS.map(async (m) => ({
        agentId: m.agentId,
        fileName: m.fileName,
        configured: await this.getStatusForUser(userId, m.fileName),
      })),
    );
  }

  /** Remove the user's entire data directory (credentials + anything else).
   * Also forgets the user from the ensureUserDir cache. */
  async removeUserData(userId: string): Promise<void> {
    this.seededUsers.delete(userId);
    await this.storage.removeUserDir(userId);
    useLogger().info(`[user-credentials] removed data directory for user ${userId}`);
  }

  /** Enumerate every durable per-user directory, including directories whose
   * typed store files were already removed by a partially completed orphan
   * sweep. This is the final restart-safe candidate source for cleanup retry. */
  async listUserIds(): Promise<string[]> {
    try {
      return (await readdir(join(this.storage.dataDir, 'users')))
        .filter(isSafeUserId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  /** Absolute path to the user's credentials directory, inside the container. */
  credentialsDir(userId: string): string {
    return join(this.storage.getUserDir(userId), 'credentials');
  }
}
