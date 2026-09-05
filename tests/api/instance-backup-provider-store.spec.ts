import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeBackupProvider,
  GoogleDriveBackupProvider,
  LocalBackupProvider,
} from "../../orchestrator/server/utils/backup-provider";
import { InstanceBackupStore } from "../../orchestrator/server/utils/instance-backup-store";
import type {
  InstanceBackupArtifact,
  InstanceBackupJob,
  RemoteInstanceBackupRecord,
} from "../../orchestrator/server/utils/instance-backup-types";

const fingerprint = `sha256:${"a".repeat(64)}`;
const integritySha256 = "b".repeat(64);
const createdAt = "2026-09-04T12:00:00.000Z";

const instanceMetadata = {
  artifactKind: "instance" as const,
  artifactId: "instance-object",
  formatVersion: 1,
  keyFingerprint: fingerprint,
  integritySha256,
  createdAt,
  incomplete: false,
};

test.describe("instance backup provider selector", () => {
  let root = "";

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentor-instance-provider-"));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("local and fake providers keep worker and instance discovery disjoint", async () => {
    for (const provider of [
      new LocalBackupProvider(join(root, "local")),
      new FakeBackupProvider(join(root, "fake")),
    ]) {
      const source = join(root, `${provider.kind}-source`);
      await writeFile(source, "encrypted backup");
      if (provider instanceof FakeBackupProvider)
        provider.bindAccount("destination", "shared-drive-account");
      if (provider instanceof FakeBackupProvider)
        provider.bindAccount("source", "shared-drive-account");

      const uploader = provider instanceof FakeBackupProvider ? "source" : "destination";
      await provider.upload(
        uploader,
        "worker-object",
        source,
        () => {},
        undefined,
        undefined,
        { artifactKind: "worker", artifactId: "worker-object", formatVersion: 2 },
      );
      await provider.upload(
        uploader,
        "instance-object",
        source,
        () => {},
        undefined,
        undefined,
        instanceMetadata,
      );

      await expect(provider.discover!("destination")).resolves.toMatchObject({
        records: [
          expect.objectContaining({
            objectId: "worker-object",
            artifactKind: "worker",
          }),
        ],
      });
      await expect(
        provider.discoverInstances!("destination"),
      ).resolves.toMatchObject({
        records: [
          expect.objectContaining({
            objectId: "instance-object",
            artifactKind: "instance",
            keyFingerprint: fingerprint,
            integritySha256,
          }),
        ],
      });
      expect((await provider.discover!("destination")).records).toHaveLength(1);
      expect(
        (await provider.discoverInstances!("destination")).records,
      ).toHaveLength(1);
    }
  });

  test("Google Drive uses a separate marker, filename, and discovery query for instance artifacts", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const source = join(root, "instance.backup");
    await writeFile(source, "encrypted instance artifact");
    const provider = new GoogleDriveBackupProvider(
      async () => ({ access_token: "access-token", expires_at: Date.now() + 3_600_000 }),
      async () => {},
      async () => ({ clientId: "client", clientSecret: "client-secret" }),
      async (input, init) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.includes("uploadType=resumable"))
          return new Response("", {
            status: 200,
            headers: {
              location: "https://www.googleapis.com/upload/drive/v3/files/session-1",
            },
          });
        if (url.includes("/upload/drive/v3/files/session-1"))
          return new Response(JSON.stringify({ id: "opaque-drive-object" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.includes("/drive/v3/files?"))
          return new Response(
            JSON.stringify({
              files: [
                {
                  id: "worker-drive-object",
                  size: "11",
                  createdTime: createdAt,
                  appProperties: {
                    agentorBackup: "v2",
                    artifactKind: "worker",
                    artifactId: "worker-object",
                    formatVersion: "2",
                  },
                },
                {
                  id: "instance-drive-object",
                  size: "22",
                  createdTime: createdAt,
                  appProperties: {
                    agentorInstanceBackup: "v1",
                    artifactKind: "instance",
                    artifactId: "instance-object",
                    formatVersion: "1",
                    keyFingerprint: fingerprint,
                    integritySha256,
                  },
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        throw new Error(`Unexpected request: ${url}`);
      },
    );

    const upload = await provider.upload(
      "owner",
      "instance-object",
      source,
      () => {},
      undefined,
      undefined,
      instanceMetadata,
    );
    expect(upload.objectId).toBe("opaque-drive-object");
    const start = requests.find((item) => item.url.includes("uploadType=resumable"));
    expect(start).toBeTruthy();
    const uploadMetadata = JSON.parse(String(start!.init?.body));
    expect(uploadMetadata).toMatchObject({
      name: "agentor-instance-instance-object.backup",
      appProperties: {
        agentorInstanceBackup: "v1",
        artifactKind: "instance",
        artifactId: "instance-object",
        formatVersion: "1",
        keyFingerprint: fingerprint,
        integritySha256,
      },
    });
    expect(JSON.stringify(uploadMetadata)).not.toContain("client-secret");
    expect(uploadMetadata.appProperties).not.toHaveProperty("agentorBackup");

    const workerPage = await provider.discover("owner");
    const instancePage = await provider.discoverInstances("owner");
    expect(workerPage.records).toEqual([
      expect.objectContaining({
        objectId: "worker-drive-object",
        artifactKind: "worker",
      }),
    ]);
    expect(instancePage.records).toEqual([
      expect.objectContaining({
        objectId: "instance-drive-object",
        artifactKind: "instance",
        keyFingerprint: fingerprint,
      }),
    ]);
    const listRequests = requests.filter(
      (item) =>
        item.url.includes("www.googleapis.com/drive/v3/files?") &&
        !item.url.includes("/upload/"),
    );
    expect(decodeURIComponent(listRequests[0]!.url)).toContain(
      "key='agentorBackup'",
    );
    expect(decodeURIComponent(listRequests[0]!.url)).not.toContain(
      "agentorInstanceBackup",
    );
    expect(decodeURIComponent(listRequests[1]!.url)).toContain(
      "key='agentorInstanceBackup'",
    );
  });
});

function job(id: string): InstanceBackupJob {
  return {
    schemaVersion: 1,
    id,
    userId: "platform-admin",
    operation: "discovery",
    provider: "google-drive",
    status: "queued",
    phase: "queued",
    progress: 0,
    bytesProcessed: 0,
    createdAt,
    updatedAt: createdAt,
    requestId: `request-${id}`,
    requestFingerprint: "c".repeat(64),
    logs: ["discovery queued."],
  };
}

function artifact(id: string): InstanceBackupArtifact {
  return {
    schemaVersion: 1,
    id,
    userId: "platform-admin",
    provider: "google-drive",
    providerObjectId: `drive-${id}`,
    createdAt,
    size: 100,
    sha256: "d".repeat(64),
    keyFingerprint: fingerprint,
    sourceInstallationId: "source-installation",
    formatVersion: 1,
    integrityStatus: "verified",
    provenance: "remote-adopted",
  };
}

function remote(id: string, objectId: string): RemoteInstanceBackupRecord {
  return {
    schemaVersion: 1,
    id,
    userId: "platform-admin",
    provider: "google-drive",
    providerObjectId: objectId,
    discoveredAt: createdAt,
    lastSeenAt: createdAt,
    remote: {
      objectId,
      artifactKind: "instance",
      size: 100,
      keyFingerprint: fingerprint,
    },
    state: "ready-to-adopt",
    keyFingerprint: fingerprint,
    sourceInstallationId: "source-installation",
    formatVersion: 1,
  };
}

test.describe("instance backup durable store", () => {
  let root = "";

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentor-instance-store-"));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("serializes concurrent updates atomically and reloads every durable record", async () => {
    const store = new InstanceBackupStore(root);
    await store.init();
    await Promise.all([
      ...Array.from({ length: 12 }, (_, index) => store.saveJob(job(`job-${index}`))),
      ...Array.from({ length: 8 }, (_, index) =>
        store.saveArtifact(artifact(`artifact-${index}`)),
      ),
    ]);
    const firstRemote = await store.upsertRemote(remote("remote-1", "object-1"));
    const adopted = await store.upsertRemote({
      ...firstRemote,
      state: "adopted",
      adoptedArtifactId: "artifact-0",
      lastSeenAt: "2026-09-05T12:00:00.000Z",
    });
    const repeatedScan = await store.upsertRemote({
      ...remote("replacement-id", "object-1"),
      lastSeenAt: "2026-09-06T12:00:00.000Z",
    });

    expect(adopted.id).toBe("remote-1");
    expect(repeatedScan).toMatchObject({
      id: "remote-1",
      state: "adopted",
      adoptedArtifactId: "artifact-0",
      discoveredAt: createdAt,
      lastSeenAt: "2026-09-06T12:00:00.000Z",
    });

    const reloaded = new InstanceBackupStore(root);
    await reloaded.init();
    expect(reloaded.listJobs()).toHaveLength(12);
    expect(reloaded.listArtifacts()).toHaveLength(8);
    expect(reloaded.listRemote()).toEqual([repeatedScan]);
    expect((await stat(join(root, "admin", "instance-backups.v1.json"))).mode & 0o777).toBe(0o600);

    const cloned = reloaded.listJobs();
    cloned[0]!.logs.push("mutated by caller");
    expect(reloaded.listJobs()[0]!.logs).not.toContain("mutated by caller");
  });

  test("fails closed on a symlinked or invalid persisted store", async () => {
    const admin = join(root, "admin");
    const target = join(root, "foreign.json");
    await mkdir(admin, { recursive: true });
    await writeFile(target, JSON.stringify({ schemaVersion: 1, jobs: [], artifacts: [], remoteBackups: [] }));
    await (await import("node:fs/promises")).symlink(
      target,
      join(admin, "instance-backups.v1.json"),
    );
    await expect(new InstanceBackupStore(root).init()).rejects.toThrow(
      /state is unavailable/i,
    );

    await rm(join(admin, "instance-backups.v1.json"));
    await writeFile(
      join(admin, "instance-backups.v1.json"),
      JSON.stringify({
        schemaVersion: 1,
        jobs: [],
        artifacts: [],
        remoteBackups: [
          {
            ...remote("remote-invalid", "object-invalid"),
            remote: {
              objectId: "different-object",
              artifactKind: "worker",
              size: 100,
            },
          },
        ],
      }),
    );
    await expect(new InstanceBackupStore(root).init()).rejects.toThrow(
      /state is unavailable/i,
    );
    expect(await readFile(join(admin, "instance-backups.v1.json"), "utf8")).not.toContain(
      "client-secret",
    );
  });
});
