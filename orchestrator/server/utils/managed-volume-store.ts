import { randomUUID } from "node:crypto";
import { join, posix } from "node:path";
import type { ManagedVolume, PersistencePolicy } from "../../shared/managed-volumes";
import { UserScopedJsonStore } from "./user-scoped-store";

export function volumeError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode, statusMessage: message, storageSafeError: true });
}

export function pathsOverlap(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

// Unlike a backup selection, a mount may obscure runtime/authorization files.
// Also reject ancestors of protected paths (e.g. /home/agent and /var).
const PROTECTED = [
  "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/root",
  "/bin", "/sbin", "/lib", "/lib64", "/usr", "/var/lib/docker",
  "/var/lib/containerd", "/home/agent/.agent-data", "/home/agent/.ssh",
  "/home/agent/.claude", "/home/agent/.codex", "/home/agent/.gemini",
  "/home/agent/.agents", "/home/agent/.config/kilo", "/home/agent/.local/share/kilo",
];

export function validatePersistenceTarget(input: unknown): string {
  if (typeof input !== "string" || input.length > 4096 || !input.startsWith("/") ||
      input.endsWith("/") || /[\u0000-\u001f\u007f\\:]/.test(input) || posix.normalize(input) !== input)
    throw volumeError(400, "Choose a canonical absolute directory path, without traversal or control characters.");
  if (PROTECTED.some((path) => pathsOverlap(input, path)))
    throw volumeError(400, "This path overlaps protected system, runtime, or credential storage. Choose an application data directory.");
  return input;
}

export interface StoredManagedVolume extends ManagedVolume {
  /** Internal only. Never accepted from REST/MCP or exposed in public results. */
  dockerName: string;
  seeded: boolean;
  /** A live mount is transient until a Docker-declared replacement exists. */
  liveContainerId?: string;
  previousRestartPolicy?: { Name: string; MaximumRetryCount?: number };
}

function validateRecord(v: StoredManagedVolume) {
  if (!v || typeof v.id !== "string" || !/^[a-f0-9-]{36}$/.test(v.id) ||
      typeof v.userId !== "string" || typeof v.workerId !== "string" ||
      typeof v.target !== "string" || !v.target.startsWith("/") ||
      !/^agentor-persist-[a-zA-Z0-9-]+$/.test(v.dockerName) ||
      !["persistent-path", "legacy-backup-path"].includes(v.purpose) ||
      !["pending", "preparing", "ready", "failed", "detached"].includes(v.state) ||
      typeof v.attached !== "boolean" || typeof v.seeded !== "boolean")
    throw new Error("Invalid managed volume record");
  if (v.purpose === "persistent-path") validatePersistenceTarget(v.target);
  return v.id;
}

/** All writes must be made under the existing owner/worker lifecycle fence. */
export class ManagedVolumeStore extends UserScopedJsonStore<string, StoredManagedVolume> {
  private readonly retained: RetainedVolumeRecords;
  constructor(dataDir: string) {
    super(dataDir, "managed-volumes.v1.json", validateRecord);
    this.retained = new RetainedVolumeRecords(dataDir);
  }
  override async init() { await super.init(); await this.retained.init(); }
  override list() { return mergeVolumeRecords(super.list(), this.retained.list()); }
  override listForUser(userId: string) { return mergeVolumeRecords(super.listForUser(userId), this.retained.listForUser(userId)); }
  override get(userId: string, id: string) { return this.retained.get(userId, id) ?? super.get(userId, id); }

  /** Copy first, then remove the disposable owner partition. A crash with both
   * copies present is safe: the administrator-retained record wins on load. */
  async retainForDeletedOwner(userId: string) {
    for (const v of this.listForUser(userId))
      await this.retained.save({ ...v, attached: false, state: "detached", retainedAfterAccountDeletion: true });
    await super.removeForUser(userId);
  }

  forWorker(userId: string, workerId: string) {
    return this.listForUser(userId).filter((v) => v.workerId === workerId);
  }

  async create(userId: string, workerId: string, target: string, name?: string) {
    validatePersistenceTarget(target);
    const volumes = this.forWorker(userId, workerId);
    const existing = volumes.find((v) => v.target === target && v.attached);
    if (existing) return existing;
    if (volumes.filter((v) => v.attached).length >= 32)
      throw volumeError(409, "A worker may have at most 32 persistent paths.");
    if (volumes.some((v) => v.attached && pathsOverlap(v.target, target)))
      throw volumeError(409, "This path overlaps an existing persistent path.");
    const id = randomUUID(), stamp = new Date().toISOString();
    const record: StoredManagedVolume = {
      id, userId, workerId, target, name: volumeName(name, posix.basename(target)),
      dockerName: `agentor-persist-${id}`, purpose: "persistent-path",
      attached: true, seeded: false, state: "pending", createdAt: stamp, updatedAt: stamp,
    };
    await this.save(record);
    return record;
  }

  async save(record: StoredManagedVolume) {
    validateRecord(record);
    if (record.retainedAfterAccountDeletion) return this.retained.save(record);
    await this.setItem(record.userId, { ...record, updatedAt: new Date().toISOString() });
  }

  async forget(userId: string, id: string) { await this.deleteItem(userId, id); await this.retained.forget(userId, id); }
}

function mergeVolumeRecords(ordinary: StoredManagedVolume[], retained: StoredManagedVolume[]) {
  return [...new Map([...ordinary, ...retained].map((v) => [v.id, v])).values()];
}

/** Outside users/<owner>, so ordinary account cleanup cannot erase the handle. */
class RetainedVolumeRecords extends UserScopedJsonStore<string, StoredManagedVolume> {
  constructor(dataDir: string) { super(join(dataDir, "retained-storage"), "managed-volumes.v1.json", (v) => {
    if (v?.retainedAfterAccountDeletion !== true || v.attached) throw new Error("Invalid retained volume record");
    return validateRecord(v);
  }); }
  async save(v: StoredManagedVolume) { await this.setItem(v.userId, { ...v, updatedAt: new Date().toISOString() }); }
  async forget(userId: string, id: string) { await this.deleteItem(userId, id); }
}

export function publicVolume(v: StoredManagedVolume): ManagedVolume {
  const { dockerName: _docker, seeded: _seeded, liveContainerId: _live,
    previousRestartPolicy: _restart, ...result } = v;
  return result;
}

export function volumeName(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value))
    throw volumeError(400, "Volume name must contain 1–100 printable characters.");
  return value.trim();
}

export class PersistencePolicyStore extends UserScopedJsonStore<string, PersistencePolicy> {
  constructor(dataDir: string) {
    super(dataDir, "persistence-policies.v1.json", (p) => {
      if (!p || typeof p.workerId !== "string" || typeof p.userId !== "string" ||
          [p.selfService, p.allowSelfRecreate, p.allowLiveMount].some((v) => typeof v !== "boolean"))
        throw new Error("Invalid persistence policy");
      return p.workerId;
    });
  }
  policy(userId: string, workerId: string): PersistencePolicy {
    return this.get(userId, workerId) ?? { userId, workerId, selfService: false, allowSelfRecreate: false, allowLiveMount: false };
  }
  async configure(userId: string, workerId: string, input: Record<string, unknown>) {
    if (Object.keys(input).some((key) => !["selfService", "allowSelfRecreate", "allowLiveMount"].includes(key)))
      throw volumeError(400, "Unknown persistence policy field.");
    const policy = { ...this.policy(userId, workerId) };
    for (const key of ["selfService", "allowSelfRecreate", "allowLiveMount"] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== "boolean") throw volumeError(400, `${key} must be boolean.`);
      policy[key] = input[key];
    }
    await this.setItem(userId, policy);
    return policy;
  }
}

export interface VolumeRecreationJournal {
  userId: string;
  workerId: string;
  originalId: string;
  containerName: string;
  rollbackName: string;
  replacementId?: string;
  createdAt: string;
}

export class VolumeRecreationStore extends UserScopedJsonStore<string, VolumeRecreationJournal> {
  constructor(dataDir: string) {
    super(dataDir, "volume-recreations.v1.json", (v) => {
      if (!v || typeof v.userId !== "string" || typeof v.workerId !== "string" ||
          !/^[a-f0-9]{64}$/.test(v.originalId) || typeof v.containerName !== "string" ||
          !v.rollbackName?.startsWith(`${v.containerName}-storage-rollback-`) ||
          (v.replacementId !== undefined && !/^[a-f0-9]{64}$/.test(v.replacementId)))
        throw new Error("Invalid volume recreation journal");
      return v.workerId;
    });
  }
  async save(v: VolumeRecreationJournal) { await this.setItem(v.userId, v); }
  async clear(userId: string, workerId: string) { await this.deleteItem(userId, workerId); }
}
