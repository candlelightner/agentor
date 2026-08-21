import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { USER_ENV_KEY_RE, WORKER_SYSTEM_ENV_VARS } from "./user-env-store";
import {
  decryptWorkerValue,
  encryptWorkerValue,
  type EncryptedWorkerValue,
} from "./worker-config-crypto";
import { assertSafeUserId, isSafeUserId } from "./user-id";
import { useConfig } from "./services";

export type WorkerConfigKind = "variable" | "secret" | "secretFile";
export interface WorkerVariable {
  kind: "variable";
  key: string;
  value: string;
}
export interface WorkerSecret {
  kind: "secret";
  key: string;
  encrypted: EncryptedWorkerValue;
}
export interface WorkerSecretFile {
  kind: "secretFile";
  key: string;
  fileName: string;
  encrypted: EncryptedWorkerValue;
}
export type StoredWorkerConfigEntry =
  WorkerVariable | WorkerSecret | WorkerSecretFile;

export interface WorkerConfigRecord {
  schemaVersion: 1;
  userId: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
  entries: StoredWorkerConfigEntry[];
  /** Last successfully materialized desired revision. Keeping the encrypted
   * applied snapshot lets a plain Docker restart recreate tmpfs secret files
   * without accidentally applying newer pending settings. */
  appliedAt?: string;
  appliedEntries?: StoredWorkerConfigEntry[];
}

export interface WorkerConfigInputEntry {
  kind: WorkerConfigKind;
  key: string;
  value: string;
  fileName?: string;
}
export interface WorkerConfigPatchInput {
  variables?: Array<{ key: string; value: string }>;
  secrets?: Array<{ key: string; value: string }>;
  secretFiles?: Array<{ name: string; path: string; content: string }>;
  envFile?: string;
  deleteSecrets?: string[];
  deleteSecretFiles?: string[];
}
export interface PublicWorkerConfigEntry {
  kind: WorkerConfigKind;
  key: string;
  value?: string;
  configured?: true;
  fileName?: string;
}
export interface EffectiveScopeEntry {
  key: string;
  source: "orchestrator" | "user" | "environment";
  value?: string;
  secret?: boolean;
}
export interface EffectiveWorkerConfigEntry {
  key: string;
  source: "orchestrator" | "user" | "environment" | "worker";
  value?: string;
  masked: boolean;
  kind: WorkerConfigKind;
  overriddenScopes?: Array<{
    source: "orchestrator" | "user" | "environment" | "worker";
    kind: WorkerConfigKind;
    masked: boolean;
  }>;
}

const FILE = "worker-configurations.json";
const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const RESERVED = new Set([
  ...WORKER_SYSTEM_ENV_VARS.map((item) => item.name),
  "HOME",
  "PATH",
  "USER",
]);
const MAX_ENTRIES = 500;
const MAX_VARIABLE_BYTES = 64 * 1024;
const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const MAX_ENV_TOTAL_BYTES = 96 * 1024;
const MAX_SECRET_FILES_TOTAL_BYTES = 12 * 1024 * 1024;

export class WorkerConfigStore {
  private records = new Map<string, Map<string, WorkerConfigRecord>>();
  private queues = new Map<string, Promise<void>>();
  private unavailableUsers = new Set<string>();
  private initPromise?: Promise<void>;
  constructor(private config: Config) {}

  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.load();
    return this.initPromise;
  }

  async get(
    userId: string,
    workerId: string,
  ): Promise<WorkerConfigRecord | undefined> {
    await this.init();
    // Never expose a mutation that has changed memory but has not reached its
    // persistence commit point yet. Failed tails settle after restoring the
    // previous record, so readers observe either the old or committed state.
    await this.queues.get(userId);
    this.assertAvailable(userId);
    const record = this.records.get(userId)?.get(workerId);
    return record === undefined ? undefined : structuredClone(record);
  }

  async replace(
    userId: string,
    workerId: string,
    input: WorkerConfigInputEntry[],
  ): Promise<WorkerConfigRecord> {
    await this.init();
    assertSafeId(userId);
    assertSafeId(workerId);
    const sanitized = validateInput(input);
    return this.withUserMutation(userId, () =>
      this.replaceUnlocked(userId, workerId, sanitized),
    );
  }

  private async replaceUnlocked(
    userId: string,
    workerId: string,
    sanitized: WorkerConfigInputEntry[],
  ): Promise<WorkerConfigRecord> {
    const existing = this.records.get(userId)?.get(workerId);
    const entries: StoredWorkerConfigEntry[] = [];
    for (const entry of sanitized) {
      if (entry.kind === "variable")
        entries.push({ kind: "variable", key: entry.key, value: entry.value });
      else {
        const encrypted = await encryptWorkerValue(
          this.config,
          entry.value,
          aad(userId, workerId, entry.kind, entry.key),
        );
        if (entry.kind === "secret")
          entries.push({ kind: "secret", key: entry.key, encrypted });
        else
          entries.push({
            kind: "secretFile",
            key: entry.key,
            fileName: entry.fileName!,
            encrypted,
          });
      }
    }
    const stamp = new Date().toISOString();
    const record: WorkerConfigRecord = {
      schemaVersion: 1,
      userId,
      workerId,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
      entries,
      appliedAt: existing?.appliedAt,
      appliedEntries: existing?.appliedEntries,
    };
    let map = this.records.get(userId);
    if (!map) {
      map = new Map();
      this.records.set(userId, map);
    }
    map.set(workerId, record);
    try {
      await this.persist(userId);
    } catch (error) {
      if (existing) map.set(workerId, existing);
      else map.delete(workerId);
      if (map.size === 0) this.records.delete(userId);
      throw error;
    }
    return structuredClone(record);
  }

  async markApplied(userId: string, workerId: string): Promise<void> {
    await this.init();
    assertSafeId(userId);
    assertSafeId(workerId);
    return this.withUserMutation(userId, async () => {
      const map = this.records.get(userId);
      const record = map?.get(workerId);
      if (!map || !record) return;
      const next: WorkerConfigRecord = {
        ...record,
        appliedAt: record.updatedAt,
        appliedEntries: structuredClone(record.entries),
      };
      map.set(workerId, next);
      try {
        await this.persist(userId);
      } catch (error) {
        map.set(workerId, record);
        throw error;
      }
    });
  }

  async remove(userId: string, workerId: string): Promise<void> {
    await this.init();
    assertSafeId(userId);
    assertSafeId(workerId);
    return this.withUserMutation(userId, async () => {
      const map = this.records.get(userId);
      const previous = map?.get(workerId);
      if (!map?.delete(workerId) || !previous) return;
      if (map.size === 0) this.records.delete(userId);
      try {
        await this.persist(userId);
      } catch (error) {
        this.records.set(userId, map);
        map.set(workerId, previous);
        throw error;
      }
    });
  }

  async importDotEnv(
    userId: string,
    workerId: string,
    content: string,
    kind: "variable" | "secret",
  ): Promise<WorkerConfigRecord> {
    await this.init();
    assertSafeId(userId);
    assertSafeId(workerId);
    const imported = parseDotEnv(content).map(
      (entry) => ({ ...entry, kind }) as WorkerConfigInputEntry,
    );
    return this.withUserMutation(userId, async () => {
      const existing = await this.resolveEntryValues(
        userId,
        workerId,
        this.records.get(userId)?.get(workerId)?.entries ?? [],
      );
      const importedKeys = new Set(imported.map((entry) => entry.key));
      return this.replaceUnlocked(
        userId,
        workerId,
        validateInput([
          ...existing.filter((entry) => !importedKeys.has(entry.key)),
          ...imported,
        ]),
      );
    });
  }

  async patch(
    userId: string,
    workerId: string,
    input: WorkerConfigPatchInput,
  ): Promise<WorkerConfigRecord> {
    await this.init();
    assertSafeId(userId);
    assertSafeId(workerId);
    if (
      input.deleteSecrets !== undefined &&
      (!Array.isArray(input.deleteSecrets) ||
        input.deleteSecrets.some(
          (key) => typeof key !== "string" || !USER_ENV_KEY_RE.test(key),
        ))
    )
      throw new Error("deleteSecrets must contain valid secret names");
    if (
      input.deleteSecretFiles !== undefined &&
      (!Array.isArray(input.deleteSecretFiles) ||
        input.deleteSecretFiles.some(
          (key) =>
            typeof key !== "string" || !/^[a-zA-Z0-9._-]{1,255}$/.test(key),
        ))
    )
      throw new Error("deleteSecretFiles must contain valid logical names");
    assertUniquePatch(input.variables, (entry) => entry.key);
    assertUniquePatch(input.secrets, (entry) => entry.key);
    assertUniquePatch(input.secretFiles, (entry) => entry.name);
    // Keep the read/merge/write transaction in the same per-user queue. A
    // concurrent replace or patch must never be overwritten by a merge based
    // on an earlier snapshot.
    return this.withUserMutation(userId, () =>
      this.patchUnlocked(userId, workerId, input),
    );
  }

  private async patchUnlocked(
    userId: string,
    workerId: string,
    input: WorkerConfigPatchInput,
  ): Promise<WorkerConfigRecord> {
    const current = await this.resolveEntryValues(
      userId,
      workerId,
      this.records.get(userId)?.get(workerId)?.entries ?? [],
    );
    let variables: WorkerConfigInputEntry[] =
      input.variables === undefined
        ? current
            .filter((entry) => entry.kind === "variable")
            .map((entry) => ({
              kind: "variable",
              key: entry.key,
              value: entry.value,
            }))
        : input.variables.map((entry) => ({ kind: "variable", ...entry }));
    if (input.envFile !== undefined) {
      const imported = new Map<string, string>();
      for (const entry of parseDotEnv(input.envFile))
        imported.set(entry.key, entry.value); // last declaration wins
      if (input.variables === undefined) {
        const merged = new Map(
          variables.map((entry) => [entry.key, entry.value]),
        );
        for (const [key, value] of imported) merged.set(key, value);
        variables = [...merged].map(([key, value]) => ({
          kind: "variable",
          key,
          value,
        }));
      } else {
        // Match worker-creation semantics: bulk input is the baseline and an
        // explicitly typed row wins when both contain the same name.
        const merged = new Map(imported);
        for (const entry of variables) merged.set(entry.key, entry.value);
        variables = [...merged].map(([key, value]) => ({
          kind: "variable",
          key,
          value,
        }));
      }
    }
    const existingSecrets = current
      .filter((entry) => entry.kind === "secret")
      .map((entry) => ({
        kind: "secret" as const,
        key: entry.key,
        value: entry.value,
      }));
    const secretMap = new Map(
      existingSecrets.map((entry) => [entry.key, entry]),
    );
    for (const key of input.deleteSecrets ?? []) secretMap.delete(key);
    for (const entry of input.secrets ?? [])
      secretMap.set(entry.key, { kind: "secret", ...entry });
    const secrets: WorkerConfigInputEntry[] = [...secretMap.values()];
    const existingFiles = current
      .filter((entry) => entry.kind === "secretFile")
      .map((entry) => ({
        kind: "secretFile" as const,
        key: entry.key,
        value: entry.value,
        fileName: entry.fileName,
      }));
    const fileMap = new Map(existingFiles.map((entry) => [entry.key, entry]));
    for (const key of input.deleteSecretFiles ?? []) fileMap.delete(key);
    for (const entry of input.secretFiles ?? []) {
      if (!isSafeSecretPath(entry.path))
        throw new Error(`Invalid secret file path for "${entry.name}"`);
      fileMap.set(entry.name, {
        kind: "secretFile",
        key: entry.name,
        value: entry.content,
        fileName: entry.path,
      });
    }
    const secretFiles: WorkerConfigInputEntry[] = [...fileMap.values()];
    return this.replaceUnlocked(
      userId,
      workerId,
      validateInput([...variables, ...secrets, ...secretFiles]),
    );
  }

  publicRecord(
    record: WorkerConfigRecord | undefined,
    userId: string,
    workerId: string,
  ): {
    schemaVersion: 1;
    userId: string;
    workerId: string;
    createdAt?: string;
    updatedAt?: string;
    entries: PublicWorkerConfigEntry[];
  } {
    return {
      schemaVersion: 1,
      userId,
      workerId,
      createdAt: record?.createdAt,
      updatedAt: record?.updatedAt,
      entries: (record?.entries ?? []).map((entry) =>
        entry.kind === "variable"
          ? { kind: entry.kind, key: entry.key, value: entry.value }
          : entry.kind === "secretFile"
            ? {
                kind: entry.kind,
                key: entry.key,
                fileName: entry.fileName,
                configured: true,
              }
            : { kind: entry.kind, key: entry.key, configured: true },
      ),
    };
  }

  /** Narrow future ContainerManager integration hook. This is server-internal
   * and must never be returned by an API route. */
  async resolveValues(
    userId: string,
    workerId: string,
  ): Promise<
    Array<{
      kind: WorkerConfigKind;
      key: string;
      value: string;
      fileName?: string;
    }>
  > {
    return this.resolveEntryValues(
      userId,
      workerId,
      (await this.get(userId, workerId))?.entries ?? [],
    );
  }

  async resolveAppliedValues(
    userId: string,
    workerId: string,
  ): Promise<
    Array<{
      kind: WorkerConfigKind;
      key: string;
      value: string;
      fileName?: string;
    }>
  > {
    const record = await this.get(userId, workerId);
    return this.resolveEntryValues(
      userId,
      workerId,
      record?.appliedEntries ?? [],
    );
  }

  private async resolveEntryValues(
    userId: string,
    workerId: string,
    entries: StoredWorkerConfigEntry[],
  ): Promise<
    Array<{
      kind: WorkerConfigKind;
      key: string;
      value: string;
      fileName?: string;
    }>
  > {
    const out: Array<{
      kind: WorkerConfigKind;
      key: string;
      value: string;
      fileName?: string;
    }> = [];
    for (const entry of entries) {
      if (entry.kind === "variable")
        out.push({ kind: entry.kind, key: entry.key, value: entry.value });
      else
        out.push({
          kind: entry.kind,
          key: entry.key,
          value: await decryptWorkerValue(
            this.config,
            entry.encrypted,
            aad(userId, workerId, entry.kind, entry.key),
          ),
          ...(entry.kind === "secretFile" ? { fileName: entry.fileName } : {}),
        });
    }
    return out;
  }

  async effectivePreview(
    userId: string,
    workerId: string,
    broader: EffectiveScopeEntry[],
  ): Promise<EffectiveWorkerConfigEntry[]> {
    const merged = new Map<string, EffectiveWorkerConfigEntry>();
    const add = (next: EffectiveWorkerConfigEntry) => {
      const prior = merged.get(next.key);
      if (prior)
        next.overriddenScopes = [
          { source: prior.source, kind: prior.kind, masked: prior.masked },
          ...(prior.overriddenScopes ?? []),
        ];
      merged.set(next.key, next);
    };
    for (const entry of broader)
      add({
        key: entry.key,
        source: entry.source,
        value: entry.secret ? undefined : entry.value,
        masked: !!entry.secret,
        kind: entry.secret ? "secret" : "variable",
      });
    for (const entry of (await this.get(userId, workerId))?.entries ?? [])
      add(
        entry.kind === "variable"
          ? {
              key: entry.key,
              source: "worker",
              value: entry.value,
              masked: false,
              kind: entry.kind,
            }
          : {
              key: entry.key,
              source: "worker",
              masked: true,
              kind: entry.kind,
            },
      );
    return [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  private async load(): Promise<void> {
    const usersDir = join(this.config.dataDir, "users");
    let users: string[] = [];
    try {
      users = await readdir(usersDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const userId of users.filter(isSafeUserId)) {
      const path = join(usersDir, userId, FILE);
      try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
        if (!Array.isArray(parsed))
          throw new Error('Worker configuration state must be an array');
        const map = new Map<string, WorkerConfigRecord>();
        for (const item of parsed as WorkerConfigRecord[]) {
          if (!validStoredRecord(item, userId))
            throw new Error('Invalid worker configuration record');
          if (map.has(item.workerId))
            throw new Error('Duplicate worker configuration id');
          map.set(item.workerId, structuredClone(item));
        }
        if (map.size) this.records.set(userId, map);
        else this.records.delete(userId);
        this.unavailableUsers.delete(userId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.records.delete(userId);
          this.unavailableUsers.delete(userId);
          continue;
        }
        this.unavailableUsers.add(userId);
        useLogger().error(
          `[worker-config] quarantined unreadable configuration for user ${userId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  /** Serialize the complete in-memory mutation, write, and rollback per owner.
   * Serializing only the write allowed an older failed operation to roll back a
   * newer same-key value and allowed the older write to observe that newer
   * snapshot before it was committed. */
  private withUserMutation<T>(
    userId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    assertSafeUserId(userId);
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => {
      this.assertAvailable(userId);
      return operation();
    });
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(userId, tail);
    void tail.finally(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    return next;
  }

  private assertAvailable(userId: string): void {
    if (!this.unavailableUsers.has(userId)) return;
    throw Object.assign(
      new Error(`Stored ${FILE} data is unavailable for this owner`),
      { statusCode: 503 },
    );
  }

  /** Persist the snapshot owned by the currently executing user mutation. */
  private async persist(userId: string): Promise<void> {
    assertSafeUserId(userId);
    const dir = join(this.config.dataDir, "users", userId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = join(dir, FILE);
    const tmp = `${target}.tmp.${process.pid}`;
    await writeFile(
      tmp,
      JSON.stringify(
        [...(this.records.get(userId)?.values() ?? [])],
        null,
        2,
      ),
      { mode: 0o600 },
    );
    await rename(tmp, target);
  }
}

function validateInput(
  input: WorkerConfigInputEntry[],
): WorkerConfigInputEntry[] {
  if (!Array.isArray(input)) throw new Error("entries must be an array");
  if (input.length > MAX_ENTRIES)
    throw new Error(`entries cannot exceed ${MAX_ENTRIES}`);
  const seen = new Set<string>();
  const out: WorkerConfigInputEntry[] = [];
  let envBytes = 0;
  let fileBytes = 0;
  for (const raw of input) {
    if (
      !raw ||
      !["variable", "secret", "secretFile"].includes(raw.kind) ||
      typeof raw.key !== "string" ||
      typeof raw.value !== "string"
    )
      throw new Error("Each entry requires kind, key, and string value");
    const key = raw.key.trim();
    if (raw.kind === "secretFile") {
      if (!/^[a-zA-Z0-9._-]{1,255}$/.test(key) || key === "." || key === "..")
        throw new Error(`Invalid secret file name: "${key}"`);
    } else {
      if (!USER_ENV_KEY_RE.test(key))
        throw new Error(`Invalid configuration name: "${key}"`);
      if (RESERVED.has(key)) throw new Error(`"${key}" is reserved`);
    }
    if (seen.has(key))
      throw new Error(`Duplicate configuration name: "${key}"`);
    seen.add(key);
    const bytes = Buffer.byteLength(raw.value);
    if (raw.kind === "secretFile") {
      if (bytes > MAX_SECRET_FILE_BYTES)
        throw new Error(`Secret file "${key}" exceeds 1 MiB`);
      if (typeof raw.fileName !== "string" || !isSafeSecretPath(raw.fileName))
        throw new Error(`Invalid secret file name for "${key}"`);
      fileBytes += bytes;
    } else {
      if (bytes > MAX_VARIABLE_BYTES)
        throw new Error(`Value for "${key}" exceeds 64 KiB`);
      envBytes += Buffer.byteLength(key) + bytes;
    }
    out.push({
      kind: raw.kind,
      key,
      value: raw.value,
      ...(raw.kind === "secretFile" ? { fileName: raw.fileName } : {}),
    });
  }
  if (envBytes > MAX_ENV_TOTAL_BYTES)
    throw new Error("Worker-local environment exceeds 96 KiB");
  if (fileBytes > MAX_SECRET_FILES_TOTAL_BYTES)
    throw new Error("Worker secret files exceed 12 MiB");
  const destinations = out
    .filter((entry) => entry.kind === "secretFile")
    .map((entry) => entry.fileName!);
  for (let i = 0; i < destinations.length; i++)
    for (let j = i + 1; j < destinations.length; j++) {
      const a = destinations[i]!;
      const b = destinations[j]!;
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`))
        throw new Error(`Conflicting secret file paths: "${a}" and "${b}"`);
    }
  return out;
}

function validStoredEntries(entries: StoredWorkerConfigEntry[]): boolean {
  if (entries.length > MAX_ENTRIES) return false;
  const names = new Set<string>();
  const paths: string[] = [];
  let envBytes = 0;
  let fileBytes = 0;
  for (const entry of entries) {
    if (
      !entry ||
      !["variable", "secret", "secretFile"].includes(entry.kind) ||
      typeof entry.key !== "string" ||
      names.has(entry.key)
    )
      return false;
    names.add(entry.key);
    if (entry.kind === "variable") {
      if (
        !USER_ENV_KEY_RE.test(entry.key) ||
        RESERVED.has(entry.key) ||
        typeof entry.value !== "string" ||
        Buffer.byteLength(entry.value) > MAX_VARIABLE_BYTES
      )
        return false;
      envBytes += Buffer.byteLength(entry.key) + Buffer.byteLength(entry.value);
    } else {
      const value = entry.encrypted;
      const ciphertextBytes = base64ByteLength(value?.ciphertext);
      if (
        !value ||
        value.version !== 1 ||
        value.algorithm !== "aes-256-gcm" ||
        !isBase64(value.iv, 12) ||
        !isBase64(value.tag, 16) ||
        ciphertextBytes === undefined
      )
        return false;
      if (entry.kind === "secret") {
        if (
          !USER_ENV_KEY_RE.test(entry.key) ||
          RESERVED.has(entry.key) ||
          ciphertextBytes > MAX_VARIABLE_BYTES
        )
          return false;
        envBytes += Buffer.byteLength(entry.key) + ciphertextBytes;
      } else {
        if (
          !/^[a-zA-Z0-9._-]{1,255}$/.test(entry.key) ||
          !isSafeSecretPath(entry.fileName) ||
          ciphertextBytes > MAX_SECRET_FILE_BYTES
        )
          return false;
        paths.push(entry.fileName);
        fileBytes += ciphertextBytes;
      }
    }
  }
  if (envBytes > MAX_ENV_TOTAL_BYTES || fileBytes > MAX_SECRET_FILES_TOTAL_BYTES)
    return false;
  for (let i = 0; i < paths.length; i++)
    for (let j = i + 1; j < paths.length; j++)
      if (
        paths[i] === paths[j] ||
        paths[i]!.startsWith(`${paths[j]}/`) ||
        paths[j]!.startsWith(`${paths[i]}/`)
      )
        return false;
  return true;
}

function validStoredRecord(
  record: WorkerConfigRecord,
  expectedUserId: string,
): boolean {
  return !!(
    record &&
    typeof record === 'object' &&
    record.schemaVersion === 1 &&
    record.userId === expectedUserId &&
    typeof record.workerId === 'string' &&
    SAFE_ID_RE.test(record.workerId) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    Array.isArray(record.entries) &&
    validStoredEntries(record.entries) &&
    (record.appliedAt === undefined || typeof record.appliedAt === 'string') &&
    (record.appliedEntries === undefined ||
      (Array.isArray(record.appliedEntries) &&
        validStoredEntries(record.appliedEntries)))
  );
}
function isBase64(value: unknown, bytes?: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return bytes === undefined
      ? decoded.length <= MAX_SECRET_FILE_BYTES + 64
      : decoded.length === bytes;
  } catch {
    return false;
  }
}

function base64ByteLength(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    return undefined;
  try {
    return Buffer.from(value, 'base64').length;
  } catch {
    return undefined;
  }
}

function aad(
  userId: string,
  workerId: string,
  kind: WorkerConfigKind,
  key: string,
): string {
  return `${userId}\0${workerId}\0${kind}\0${key}`;
}
function assertSafeId(id: string): void {
  if (!SAFE_ID_RE.test(id)) throw new Error("Invalid owner or worker id");
}
function isSafeSecretPath(path: string): boolean {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          part !== ".ready" &&
          /^[a-zA-Z0-9._-]{1,255}$/.test(part),
      )
  );
}
function assertUniquePatch<T>(
  entries: T[] | undefined,
  keyOf: (entry: T) => string,
): void {
  if (!entries) return;
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (seen.has(key))
      throw new Error(`Duplicate configuration name: "${key}"`);
    seen.add(key);
  }
}

export function parseDotEnv(
  text: string,
): Array<{ key: string; value: string }> {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("dotenv input must be text no larger than 1 MiB");
  const merged = new Map<string, string>();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.startsWith("export ")
      ? trimmed.slice(7).trim()
      : trimmed;
    const eq = normalized.indexOf("=");
    if (eq < 1) throw new Error(`Invalid dotenv line ${index + 1}`);
    const key = normalized.slice(0, eq).trim();
    let value = normalized.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    merged.set(key, value);
  }
  return [...merged].map(([key, value]) => ({ key, value }));
}

let singleton: WorkerConfigStore | undefined;
export function useWorkerConfigStore(): WorkerConfigStore {
  return (singleton ??= new WorkerConfigStore(useConfig()));
}
