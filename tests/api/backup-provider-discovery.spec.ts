import { expect, test } from "@playwright/test";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackupStore } from "../../orchestrator/server/utils/backup-store";
import { FakeBackupProvider, GoogleDriveBackupProvider, LocalBackupProvider } from "../../orchestrator/server/utils/backup-provider";

test("local discovery is owner scoped and header reads are bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-discovery-local-"));
  try {
    const provider = new LocalBackupProvider(root);
    const source = join(root, "source");
    await writeFile(source, "AGENTOR-BACKUP-1\nheader");
    await provider.upload("owner-a", "artifact-a", source, () => {}, undefined, undefined, { formatVersion: 2, keyFingerprint: `sha256:${"a".repeat(64)}` });
    await provider.upload("owner-b", "artifact-b", source, () => {});
    await expect(provider.discover("owner-a")).resolves.toMatchObject({ records: [{ objectId: "artifact-a", formatVersion: 2, keyFingerprint: `sha256:${"a".repeat(64)}` }] });
    await expect(provider.discover("owner-a")).resolves.not.toMatchObject({ records: expect.arrayContaining([expect.objectContaining({ objectId: "artifact-b" })]) });
    await expect(provider.readRange("owner-a", "artifact-a", 16)).resolves.toEqual(Buffer.from("AGENTOR-BACKUP-1"));
    await expect(provider.readRange("owner-a", "artifact-a", 0)).rejects.toMatchObject({ statusCode: 400 });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("fake discovery can explicitly share one remote account without persisting a source user", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-discovery-fake-"));
  try {
    const provider = new FakeBackupProvider(root);
    const source = join(root, "source"); await writeFile(source, "backup");
    provider.bindAccount("instance-a", "same-account");
    provider.bindAccount("instance-b", "same-account");
    provider.bindAccount("other-user", "other-account");
    await provider.upload("instance-a", "artifact-a", source, () => {});
    const remote = await provider.discover("instance-b");
    expect(remote.records).toEqual([expect.objectContaining({ objectId: "artifact-a" })]);
    expect(JSON.stringify(remote.records)).not.toContain("instance-a");
    expect((await provider.discover("other-user")).records).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("provider downloads enforce the discovered size before retaining staged bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-download-limit-"));
  try {
    const provider = new LocalBackupProvider(root);
    const source = join(root, "source");
    const destination = join(root, "staged");
    await writeFile(source, "provider object grew");
    await provider.upload("owner", "artifact", source, () => {});
    await expect(
      provider.download("owner", "artifact", destination, undefined, {
        expectedSize: 4,
        maxBytes: 4,
      }),
    ).rejects.toMatchObject({ code: "BACKUP_OBJECT_TOO_LARGE" });
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("google discovery paginates only marked files and uses a bounded range request", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const provider = new GoogleDriveBackupProvider(
    async () => ({ access_token: "token", expires_at: Date.now() + 3600_000 }), async () => {}, async () => ({ clientId: "client", clientSecret: "secret" }),
    async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes("alt=media")) return new Response("AGENTOR-BACKUP-1", { status: 206 });
      return new Response(JSON.stringify({ nextPageToken: "next", files: [
        { id: "drive-id", size: "123", createdTime: "2026-01-01T00:00:00.000Z", appProperties: { agentorBackup: "v2", artifactId: "artifact-a", formatVersion: "2", keyFingerprint: `sha256:${"a".repeat(64)}` } },
        { id: "ignored", size: "9", appProperties: {} },
      ] }), { status: 200 });
    },
  );
  const page = await provider.discover("owner");
  expect(page).toMatchObject({ nextCursor: "next", records: [{ objectId: "drive-id", formatVersion: 2 }] });
  expect(requests[0]!.url).toContain("appProperties");
  await expect(provider.readRange("owner", "drive-id", 32)).resolves.toEqual(Buffer.from("AGENTOR-BACKUP-1"));
  expect(requests[1]!.init?.headers).toMatchObject({ Range: "bytes=0-31" });
});

test("remote backup records deduplicate by provider object id and never accept a foreign owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-discovery-store-"));
  try {
    const store = new BackupStore(root); await store.init();
    const first = await store.upsertRemoteBackup("owner", { schemaVersion: 1, id: "remote-one", userId: "owner", provider: "fake", providerObjectId: "object-one", discoveredAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", remote: { objectId: "object-one", size: 1 } });
    const second = await store.upsertRemoteBackup("owner", { ...first, id: "attempted-replacement", lastSeenAt: "2026-01-02T00:00:00.000Z" });
    expect(second.id).toBe("remote-one");
    expect((store.get("owner") as any).remoteBackups).toHaveLength(1);
    await expect(store.upsertRemoteBackup("owner", { ...first, userId: "other" })).rejects.toMatchObject({ statusCode: 400 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
