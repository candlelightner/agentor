import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config";
import { decryptWorkerValue, decryptWorkerValueForInstanceRestore, encryptWorkerValue, type EncryptedWorkerValue } from "./worker-config-crypto";
import { assertSafeUserId, isSafeUserId } from "./user-id";
import { instanceControlPlaneCoordinator } from "./instance-snapshot-gate";
import { operationSettlement, type OperationFailureWithSettlement, combineSettlements, attachSettlement } from "./operation-deadline";
import { readExistingRecoveryKey } from "./recovery-key-read";

const KIT_KIND = "agentor-backup-recovery-kit";
const KIT_VERSION = 1;
const MAX_KIT_BYTES = 16 * 1024;
const keyringFiles = { chmod, mkdir, open, rename, rm };

export interface BackupRecoveryKit {
  kind: typeof KIT_KIND;
  version: typeof KIT_VERSION;
  keyMaterial: string;
  fingerprint: string;
  encryptionFormat: 2;
  createdAt: string;
}

export interface BackupKeyStatus {
  fingerprint: string;
  active: boolean;
  source: "generated" | "imported" | "legacy";
  createdAt?: string;
}

interface StoredKey {
  fingerprint: string;
  source: "generated" | "imported";
  createdAt: string;
  material: EncryptedWorkerValue;
}
interface OwnerKeyring { activeFingerprint: string; keys: StoredKey[]; }
interface KeyringState { version: 1; owners: Record<string, OwnerKeyring>; }

/**
 * Owner-scoped recovery keys.  The on-disk record contains only worker-config-
 * encrypted key material; status APIs deliberately return fingerprints only.
 */
export class BackupKeyring {
  private state: KeyringState = { version: 1, owners: {} };
  private initialized?: Promise<void>;
  private ready = false;
  private writes = Promise.resolve();
  /**
   * `active()` may create an owner record and `importKit()` may create or
   * extend the same record. Serialize both mutations per owner: the global
   * file-write queue alone cannot prevent an older active() snapshot from
   * replacing a just-imported historical key.
   */
  private ownerMutations = new Map<string, Promise<void>>();
  private readonly path: string;

  constructor(private readonly config: Config, path?: string, private readonly files = keyringFiles) {
    this.path = path ?? join(config.dataDir, "backup-keyring.json");
  }

  init() {
    return instanceControlPlaneCoordinator.run(() =>
      (this.initialized ??= this.load().then(() => { this.ready = true; })));
  }

  async status(ownerId: string): Promise<BackupKeyStatus[]> {
    return instanceControlPlaneCoordinator.run(async () => {
    assertSafeUserId(ownerId);
    await this.init();
    const owner = this.state.owners[ownerId];
    const result: BackupKeyStatus[] = owner?.keys.map((key) => ({
      fingerprint: key.fingerprint, active: key.fingerprint === owner.activeFingerprint,
      source: key.source, createdAt: key.createdAt,
    })) ?? [];
    // The v1 installation key is a read candidate for every owner. It is not
    // written into this keyring and must remain usable for old artifacts.
    const legacy = await this.legacyStatus();
    if (legacy && !result.some((item) => item.fingerprint === legacy.fingerprint)) result.push(legacy);
    return result;
    });
  }

  async active(ownerId: string): Promise<{ fingerprint: string; material: string }> {
    return instanceControlPlaneCoordinator.run(async () => {
    assertSafeUserId(ownerId);
    await this.init();
    return this.mutateOwner(ownerId, async () => {
      // Recheck after joining the owner mutation queue. Without this guard,
      // two first backups (or an import racing the first backup) could encrypt
      // with different keys while only one record reached disk.
      const current = this.state.owners[ownerId];
      if (current) return this.activeFromRecord(ownerId, current);
      const material = randomBytes(32).toString("base64");
      const fingerprint = backupKeyFingerprint(material);
      const now = new Date().toISOString();
      const stored: StoredKey = {
        fingerprint, source: "generated", createdAt: now,
        material: await encryptWorkerValue(this.config, material, this.aad(ownerId, fingerprint)),
      };
      const owner = { activeFingerprint: fingerprint, keys: [stored] };
      await this.commit((state) => { state.owners[ownerId] = owner; });
      return { fingerprint, material };
    });
    });
  }

  private async activeFromRecord(ownerId: string, owner: OwnerKeyring) {
    const stored = owner.keys.find((key) => key.fingerprint === owner.activeFingerprint);
    if (!stored) throw new Error("Backup recovery key is unavailable");
    return { fingerprint: stored.fingerprint, material: await this.decrypt(ownerId, stored) };
  }

  async find(ownerId: string, fingerprint: string): Promise<string | undefined> {
    return instanceControlPlaneCoordinator.run(async () => {
    assertSafeUserId(ownerId);
    if (!isFingerprint(fingerprint)) return undefined;
    await this.init();
    const stored = this.state.owners[ownerId]?.keys.find((key) => key.fingerprint === fingerprint);
    if (stored) return this.decrypt(ownerId, stored);
    const legacy = await this.legacyMaterial();
    return legacy && backupKeyFingerprint(legacy) === fingerprint ? legacy : undefined;
    });
  }

  /** Only for restore authentication after init() and the mutation drain have
   * completed. Deliberately cannot initialize, generate, or chmod key files. */
  async findForInstanceRestore(ownerId: string, fingerprint: string): Promise<string | undefined> {
    assertSafeUserId(ownerId);
    if (!this.ready) throw new Error("Backup recovery keyring must be initialized before instance restore");
    if (!isFingerprint(fingerprint)) return undefined;
    const stored = this.state.owners[ownerId]?.keys.find((key) => key.fingerprint === fingerprint);
    if (stored) return this.decrypt(ownerId, stored, true);
    const legacy = await this.legacyMaterial(true);
    return legacy && backupKeyFingerprint(legacy) === fingerprint ? legacy : undefined;
  }

  async candidates(ownerId: string): Promise<Array<{ fingerprint: string; material: string }>> {
    return instanceControlPlaneCoordinator.run(async () => {
    assertSafeUserId(ownerId);
    await this.init();
    const owner = this.state.owners[ownerId];
    const results = await Promise.allSettled((owner?.keys ?? []).map((key) =>
      instanceControlPlaneCoordinator.run(async () => ({ fingerprint: key.fingerprint, material: await this.decrypt(ownerId, key) }))));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const keys = results.map((result) => (result as PromiseFulfilledResult<{ fingerprint: string; material: string }>).value);
    const legacy = await this.legacyMaterial();
    if (legacy && !keys.some((key) => key.fingerprint === backupKeyFingerprint(legacy))) keys.push({ fingerprint: backupKeyFingerprint(legacy), material: legacy });
    return keys;
    });
  }

  async importKit(ownerId: string, input: string | unknown): Promise<BackupKeyStatus> {
    return instanceControlPlaneCoordinator.run(async () => {
    assertSafeUserId(ownerId);
    const kit = validateRecoveryKit(input);
    await this.init();
    return this.mutateOwner(ownerId, async () => {
      const existing = await this.find(ownerId, kit.fingerprint);
      if (existing)
        return {
          fingerprint: kit.fingerprint,
          active: this.state.owners[ownerId]?.activeFingerprint === kit.fingerprint,
          source: "imported" as const,
        };
      const stored: StoredKey = {
        fingerprint: kit.fingerprint, source: "imported", createdAt: kit.createdAt,
        material: await encryptWorkerValue(this.config, kit.keyMaterial, this.aad(ownerId, kit.fingerprint)),
      };
      await this.commit((state) => {
        const owner = state.owners[ownerId] ?? { activeFingerprint: stored.fingerprint, keys: [] };
        if (!owner.keys.some((key) => key.fingerprint === stored.fingerprint))
          owner.keys.push(stored);
        state.owners[ownerId] = owner;
      });
      const active = this.state.owners[ownerId]!.activeFingerprint === stored.fingerprint;
      return { fingerprint: stored.fingerprint, active, source: "imported" as const, createdAt: stored.createdAt };
    });
    });
  }

  async exportKit(ownerId: string, fingerprint?: string): Promise<BackupRecoveryKit> {
    return instanceControlPlaneCoordinator.run(async () => {
    const key = fingerprint ? await this.find(ownerId, fingerprint) : (await this.active(ownerId)).material;
    if (!key) throw new Error("Backup recovery key is unavailable");
    const actualFingerprint = backupKeyFingerprint(key);
    return { kind: KIT_KIND, version: KIT_VERSION, keyMaterial: key, fingerprint: actualFingerprint, encryptionFormat: 2, createdAt: new Date().toISOString() };
    });
  }

  private aad(ownerId: string, fingerprint: string) { return `agentor-backup-keyring-v1:${ownerId}:${fingerprint}`; }
  private async decrypt(ownerId: string, stored: StoredKey, readOnly = false) {
    try { return await (readOnly ? decryptWorkerValueForInstanceRestore : decryptWorkerValue)(this.config, stored.material, this.aad(ownerId, stored.fingerprint)); }
    catch (error) { throw unavailableKeyError("Backup recovery key is unavailable", error); }
  }
  private async load() {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let readError: unknown;
    try {
      file = await this.files.open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > 16 * 1024 * 1024)
        throw new Error("Invalid backup recovery keyring");
      await file.chmod(0o600);
      const raw = await file.readFile("utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!validKeyringState(parsed))
        throw new Error("Invalid backup recovery keyring");
      this.state = parsed;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        // Missing keyrings remain compatible with an empty installation, but
        // absence reported by a bounded operation does not settle that work.
        await mutationTail(Promise.reject(error));
      } else readError = error;
    } finally {
      let closeError: unknown;
      if (file) {
        try {
          await file.close();
        } catch (error) {
          closeError = error;
        }
      }
      const combined = combineSettlements(readError, closeError);
      if (closeError) {
        await mutationTail(Promise.reject(closeError));
      }
      if (readError && closeError) {
        const error = unavailableKeyError("Backup recovery keyring is unavailable", readError);
        attachSettlement(error, combined);
        throw error;
      }
      if (readError) {
        throw unavailableKeyError("Backup recovery keyring is unavailable", readError);
      }
      if (closeError) {
        const error = unavailableKeyError("Backup recovery keyring cleanup is unavailable", closeError);
        attachSettlement(error, combined);
        throw error;
      }
    }
  }
  private async commit(change: (state: KeyringState) => void) {
    return instanceControlPlaneCoordinator.run(() => {
    const write = async () => {
      const next = structuredClone(this.state); change(next);
      await this.files.mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await this.files.open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(JSON.stringify(next), "utf8");
        await file.close();
        file = undefined;
        await this.files.rename(temporary, this.path);
        this.state = next;
      } finally {
        if (file) await mutationTail(file.close());
        await mutationTail(this.files.rm(temporary, { force: true }));
      }
    };
    const pending = this.writes.then(write); this.writes = mutationTail(pending); return pending;
    });
  }
  private async mutateOwner<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
    return instanceControlPlaneCoordinator.run(() => {
    const previous = this.ownerMutations.get(ownerId) ?? Promise.resolve();
    const next = previous.then(operation);
    const settled = mutationTail(next);
    this.ownerMutations.set(ownerId, settled);
    void settled.then(() => {
      if (this.ownerMutations.get(ownerId) === settled)
        this.ownerMutations.delete(ownerId);
    });
    return next;
    });
  }
  private async legacyMaterial(readOnly = false): Promise<string | undefined> {
    const configured = process.env.BACKUP_ENCRYPTION_KEY?.trim();
    if (configured) return configured;
    const path = join(this.config.dataDir, "backup.key");
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (readOnly) return (await readExistingRecoveryKey(path, 4096, this.files.open)) || undefined;
      file = await this.files.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await file.stat();
      if (!info.isFile() || info.size > 4096) return undefined;
      if (!readOnly) await this.files.chmod(path, 0o600);
      const value = (await file.readFile("utf8")).trim();
      return value || undefined;
    } catch (error) {
      // Legacy lookup deliberately treats unreadable material as absent, but
      // must not retire any exposed late normalization work with that fallback.
      await mutationTail(Promise.reject(error));
      return undefined;
    } finally {
      if (file) await mutationTail(file.close());
    }
  }
  private async legacyStatus(): Promise<BackupKeyStatus | undefined> {
    const material = await this.legacyMaterial();
    return material ? { fingerprint: backupKeyFingerprint(material), active: false, source: "legacy" } : undefined;
  }
}

function mutationTail(pending: Promise<unknown>): Promise<void> {
  return pending.then(() => undefined, async (error: OperationFailureWithSettlement) => {
    await Promise.resolve(error?.[operationSettlement]).catch(() => {});
  });
}

function unavailableKeyError(message: string, error: unknown): Error {
  const unavailable = new Error(message);
  const settlement = (error as OperationFailureWithSettlement | undefined)?.[operationSettlement];
  if (settlement) Object.defineProperty(unavailable, operationSettlement, { value: settlement, configurable: true });
  return unavailable;
}

export function backupKeyFingerprint(material: string): string {
  return `sha256:${createHash("sha256").update(deriveBackupArchiveKey(material)).digest("hex")}`;
}

/** Same HKDF derivation as the legacy v1 envelope. */
export function deriveBackupArchiveKey(material: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material), Buffer.from("agentor-backups-v1"), Buffer.from("archive-key"), 32));
}

export function validateRecoveryKit(input: string | unknown): BackupRecoveryKit {
  let value: any = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > MAX_KIT_BYTES) throw new Error("Invalid recovery kit");
    try {
      value = JSON.parse(input);
    } catch {
      // Reveal/copy intentionally returns only the generated 256-bit material.
      // Accept that canonical representation directly as well as the portable
      // JSON kit, without broadening import to arbitrary user-controlled text.
      const material = input.trim();
      if (!/^[A-Za-z0-9+/]{43}=$/.test(material) || Buffer.from(material, "base64").length !== 32)
        throw new Error("Invalid recovery kit");
      value = {
        kind: KIT_KIND,
        version: KIT_VERSION,
        keyMaterial: material,
        fingerprint: backupKeyFingerprint(material),
        encryptionFormat: 2,
        createdAt: new Date().toISOString(),
      };
    }
  }
  const allowed = new Set([
    "kind",
    "version",
    "keyMaterial",
    "fingerprint",
    "encryptionFormat",
    "createdAt",
  ]);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.has(key)) || value.kind !== KIT_KIND || value.version !== KIT_VERSION || value.encryptionFormat !== 2 || typeof value.keyMaterial !== "string" || !value.keyMaterial || Buffer.byteLength(value.keyMaterial, "utf8") > 4096 || !isFingerprint(value.fingerprint) || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt)) || backupKeyFingerprint(value.keyMaterial) !== value.fingerprint) throw new Error("Invalid recovery kit");
  return { kind: KIT_KIND, version: KIT_VERSION, keyMaterial: value.keyMaterial, fingerprint: value.fingerprint, encryptionFormat: 2, createdAt: value.createdAt };
}

function isFingerprint(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function validKeyringState(value: unknown): value is KeyringState {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as any).version !== 1 ||
    !(value as any).owners ||
    typeof (value as any).owners !== "object" ||
    Array.isArray((value as any).owners)
  )
    return false;
  const owners = Object.entries((value as any).owners as Record<string, unknown>);
  if (owners.length > 10_000) return false;
  for (const [ownerId, rawOwner] of owners) {
    if (!isSafeUserId(ownerId) || !rawOwner || typeof rawOwner !== "object")
      return false;
    const owner = rawOwner as Record<string, unknown>;
    if (!isFingerprint(owner.activeFingerprint) || !Array.isArray(owner.keys) || owner.keys.length < 1 || owner.keys.length > 256)
      return false;
    const fingerprints = new Set<string>();
    for (const rawKey of owner.keys) {
      if (!rawKey || typeof rawKey !== "object") return false;
      const key = rawKey as Record<string, unknown>;
      if (
        !isFingerprint(key.fingerprint) ||
        fingerprints.has(key.fingerprint) ||
        (key.source !== "generated" && key.source !== "imported") ||
        typeof key.createdAt !== "string" ||
        !Number.isFinite(Date.parse(key.createdAt)) ||
        !validEncryptedMaterial(key.material)
      )
        return false;
      fingerprints.add(key.fingerprint);
    }
    if (!fingerprints.has(owner.activeFingerprint)) return false;
  }
  return true;
}
function validEncryptedMaterial(value: unknown): value is EncryptedWorkerValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const encrypted = value as Record<string, unknown>;
  if (
    encrypted.version !== 1 ||
    encrypted.algorithm !== "aes-256-gcm" ||
    typeof encrypted.iv !== "string" ||
    Buffer.from(encrypted.iv, "base64").length !== 12 ||
    typeof encrypted.tag !== "string" ||
    Buffer.from(encrypted.tag, "base64").length !== 16 ||
    typeof encrypted.ciphertext !== "string" ||
    encrypted.ciphertext.length > 8 * 1024
  )
    return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(encrypted.ciphertext);
}
