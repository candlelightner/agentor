import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../orchestrator/server/utils/config";
import { BackupKeyring, backupKeyFingerprint, validateRecoveryKit } from "../../orchestrator/server/utils/backup-keyring";
import { decryptBackup, decryptBackupV2, encryptBackup, encryptBackupV2, inspectBackupV2 } from "../../orchestrator/server/utils/backup-crypto";

function config(dataDir: string): Config { return { dataDir } as Config; }

test.describe("backup recovery keyring and v2 envelope", () => {
  let directory = "";
  test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "agentor-recovery-keyring-")); });
  test.afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  test("owner keys are encrypted at rest, portable kits are idempotent, and status never contains material", async () => {
    const first = new BackupKeyring(config(directory));
    const active = await first.active("owner_a");
    const kit = await first.exportKit("owner_a");
    expect(kit.fingerprint).toBe(active.fingerprint);
    const stored = await readFile(join(directory, "backup-keyring.json"), "utf8");
    expect(stored).not.toContain(active.material);
    expect(JSON.stringify(await first.status("owner_a"))).not.toContain(active.material);

    const second = new BackupKeyring(config(join(directory, "other")));
    const imported = await second.importKit("owner_b", JSON.stringify(kit));
    expect(imported.fingerprint).toBe(active.fingerprint);
    await expect(second.importKit("owner_b", kit)).resolves.toMatchObject({ fingerprint: active.fingerprint });
    expect((await second.status("owner_b")).filter((key) => key.fingerprint === active.fingerprint)).toHaveLength(1);

    const copiedKeyDestination = new BackupKeyring(config(join(directory, "copied")));
    await expect(copiedKeyDestination.importKit("owner_c", active.material)).resolves.toMatchObject({
      fingerprint: active.fingerprint,
    });
  });

  test("first active-key generation and historical-key import serialize per owner", async () => {
    const source = new BackupKeyring(config(join(directory, "source")));
    const historicalKit = await source.exportKit("source_owner");
    const target = new BackupKeyring(config(join(directory, "target")));

    // Both operations begin before either is allowed to observe a persisted
    // owner record. The owner queue must retain both keys, whichever wins the
    // active-key election, without returning either raw material in status.
    const [active, imported] = await Promise.all([
      target.active("target_owner"),
      target.importKit("target_owner", historicalKit),
    ]);
    const status = await target.status("target_owner");
    const fingerprints = status.map(({ fingerprint }) => fingerprint);
    expect(fingerprints).toContain(active.fingerprint);
    expect(fingerprints).toContain(imported.fingerprint);
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    expect(status.filter(({ active }) => active)).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain(historicalKit.keyMaterial);
    expect(JSON.stringify(status)).not.toContain(active.material);
  });

  test("legacy v1 archives stay decryptable and are exposed only as a candidate", async () => {
    const raw = randomBytes(32).toString("base64");
    const before = process.env.BACKUP_ENCRYPTION_KEY;
    process.env.BACKUP_ENCRYPTION_KEY = raw;
    try {
      const input = join(directory, "plain"), encrypted = join(directory, "legacy.enc"), output = join(directory, "out");
      await writeFile(input, "v1 survives");
      const crypt = await encryptBackup(config(directory), input, encrypted);
      await decryptBackup(config(directory), encrypted, output, crypt.sha256);
      expect(await readFile(output, "utf8")).toBe("v1 survives");
      const statuses = await new BackupKeyring(config(directory)).status("owner_a");
      expect(statuses).toContainEqual(expect.objectContaining({ fingerprint: backupKeyFingerprint(raw), source: "legacy", active: false }));
    } finally { if (before === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = before; }
  });

  test("v2 authenticates bounded remote metadata and a destination uses an imported key", async () => {
    const sourceDir = join(directory, "source"), targetDir = join(directory, "target");
    const source = new BackupKeyring(config(sourceDir));
    const input = join(directory, "plain"), encrypted = join(directory, "v2.enc"), output = join(directory, "out");
    // Larger than Node's default stream high-water mark: the integrity pass
    // must drain without buffering an unconsumed Transform output.
    const payload = Buffer.alloc(256 * 1024, 0x61);
    await writeFile(input, payload);
    const crypt = await encryptBackupV2(config(sourceDir), "owner_a", input, encrypted, { backupId: "backup-123", sourceInstallationId: "install-a", createdAt: "2026-01-01T00:00:00.000Z", workspaceIds: ["worker-a"], formatVersion: 2 }, source);
    const inspected = await inspectBackupV2(encrypted);
    expect(inspected).toEqual(crypt.header);
    const target = new BackupKeyring(config(targetDir));
    await expect(decryptBackupV2(config(targetDir), "owner_b", encrypted, output, crypt.sha256, target)).rejects.toThrow("Required recovery key is unavailable");
    await target.importKit("owner_b", await source.exportKit("owner_a"));
    await expect(decryptBackupV2(config(targetDir), "owner_b", encrypted, output, crypt.sha256, target)).resolves.toEqual(crypt.header);
    expect(await readFile(output)).toEqual(payload);
  });

  test("tampering authenticated header or malformed kits never returns raw material", async () => {
    const ring = new BackupKeyring(config(directory)); const active = await ring.active("owner_a");
    const kit = await ring.exportKit("owner_a");
    await expect(Promise.resolve().then(() => validateRecoveryKit({ ...kit, fingerprint: "sha256:" + "0".repeat(64) }))).rejects.toThrow("Invalid recovery kit");
    await expect(Promise.resolve().then(() => validateRecoveryKit({ ...kit, keyMaterial: active.material + "x" }))).rejects.toThrow("Invalid recovery kit");
  });
});
