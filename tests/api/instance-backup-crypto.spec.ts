import { expect, test } from "@playwright/test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decryptInstanceBackup,
  encryptedInstancePayloadSha256,
  encryptInstanceBackup,
  inspectInstanceBackup,
  inspectInstanceBackupPrefix,
} from "../../orchestrator/server/utils/instance-backup-crypto";

const metadata = {
  backupId: "instance-backup-1",
  sourceInstallationId: "source-installation-1",
  createdAt: "2026-09-04T12:00:00.000Z",
  formatVersion: 1 as const,
};

test.describe("instance disaster-recovery encryption boundary", () => {
  let root = "";

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentor-instance-crypto-"));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("round-trips an authenticated envelope without exposing recovery material", async () => {
    const input = join(root, "plain.tar");
    const encrypted = join(root, "instance.backup");
    const output = join(root, "restored.tar");
    const recoveryMaterial = Buffer.alloc(32, 37).toString("base64");
    await writeFile(input, Buffer.from("private control-plane snapshot\0payload"));

    const result = await encryptInstanceBackup(
      input,
      encrypted,
      recoveryMaterial,
      metadata,
    );
    const header = await inspectInstanceBackup(encrypted);
    const prefix = await readFile(encrypted);

    expect(header).toEqual(result.header);
    expect(inspectInstanceBackupPrefix(prefix.subarray(0, 16 * 1024))).toEqual(
      result.header,
    );
    expect(header).toMatchObject({
      version: 1,
      algorithm: "aes-256-gcm",
      metadata,
    });
    expect(header.keyFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(prefix.toString("utf8")).not.toContain(recoveryMaterial);
    expect(result.sha256).toBe(await encryptedInstancePayloadSha256(encrypted));
    expect(result.size).toBe((await stat(encrypted)).size);

    await expect(
      decryptInstanceBackup(
        encrypted,
        output,
        recoveryMaterial,
        result.sha256,
      ),
    ).resolves.toEqual(header);
    expect(await readFile(output)).toEqual(await readFile(input));
  });

  test("rejects a wrong key, a mismatched retained digest, and authenticated-data tampering", async () => {
    const input = join(root, "plain.tar");
    const encrypted = join(root, "instance.backup");
    const recoveryMaterial = Buffer.alloc(32, 11).toString("base64");
    await writeFile(input, "sensitive instance state");
    const result = await encryptInstanceBackup(
      input,
      encrypted,
      recoveryMaterial,
      metadata,
    );

    await expect(
      decryptInstanceBackup(
        encrypted,
        join(root, "wrong-key.tar"),
        Buffer.alloc(32, 12).toString("base64"),
      ),
    ).rejects.toThrow(/recovery key is unavailable/i);
    await expect(
      decryptInstanceBackup(
        encrypted,
        join(root, "wrong-digest.tar"),
        recoveryMaterial,
        "0".repeat(64),
      ),
    ).rejects.toThrow(/integrity verification failed/i);

    const bytes = await readFile(encrypted);
    const headerEnd = bytes.indexOf(10, Buffer.byteLength("AGENTOR-INSTANCE-BACKUP-1\n"));
    expect(headerEnd).toBeGreaterThan(0);
    bytes[headerEnd - 1] ^= 1;
    await writeFile(encrypted, bytes);
    await expect(inspectInstanceBackup(encrypted)).rejects.toThrow(
      /invalid instance backup header/i,
    );

    // Restore the valid envelope, then mutate the authentication tag. The
    // retained digest detects it before decryption and AES-GCM rejects it even
    // when no out-of-band digest is supplied.
    await encryptInstanceBackup(input, encrypted, recoveryMaterial, metadata);
    const tagTampered = await readFile(encrypted);
    tagTampered[tagTampered.length - 1] ^= 1;
    await writeFile(encrypted, tagTampered);
    await expect(
      decryptInstanceBackup(
        encrypted,
        join(root, "tampered.tar"),
        recoveryMaterial,
      ),
    ).rejects.toThrow(/authentication failed/i);
  });

  test("rejects foreign, truncated, and overlong discovery preambles", async () => {
    expect(() => inspectInstanceBackupPrefix(Buffer.from("AGENTOR-BACKUP-2\n{}"))).toThrow(
      /unsupported instance backup format/i,
    );
    expect(() =>
      inspectInstanceBackupPrefix(Buffer.from("AGENTOR-INSTANCE-BACKUP-1\n{}\n")),
    ).toThrow(/unsupported|invalid/i);

    const overlong = Buffer.concat([
      Buffer.from("AGENTOR-INSTANCE-BACKUP-1\n"),
      Buffer.alloc(16 * 1024 + 1, 97),
      Buffer.from("\n"),
      Buffer.alloc(12),
    ]);
    expect(() => inspectInstanceBackupPrefix(overlong)).toThrow(
      /invalid instance backup header/i,
    );
  });

  test("honours cancellation without retaining partial encrypted or decrypted payloads", async () => {
    const input = join(root, "plain.tar");
    const encrypted = join(root, "instance.backup");
    const cancelledEncrypted = join(root, "cancelled-encrypt.backup");
    const cancelledOutput = join(root, "cancelled-decrypt.tar");
    const recoveryMaterial = Buffer.alloc(32, 51).toString("base64");
    await writeFile(input, Buffer.alloc(2 * 1024 * 1024, 7));
    const result = await encryptInstanceBackup(
      input,
      encrypted,
      recoveryMaterial,
      metadata,
    );

    const encryptAbort = new AbortController();
    await expect(
      encryptInstanceBackup(
        input,
        cancelledEncrypted,
        recoveryMaterial,
        metadata,
        () => encryptAbort.abort(),
        encryptAbort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(cancelledEncrypted)).rejects.toMatchObject({ code: "ENOENT" });

    const hashAbort = new AbortController();
    hashAbort.abort();
    await expect(
      encryptedInstancePayloadSha256(encrypted, hashAbort.signal),
    ).rejects.toMatchObject({ name: "AbortError" });

    const decryptAbort = new AbortController();
    decryptAbort.abort();
    await expect(
      decryptInstanceBackup(
        encrypted,
        cancelledOutput,
        recoveryMaterial,
        result.sha256,
        decryptAbort.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(stat(cancelledOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
