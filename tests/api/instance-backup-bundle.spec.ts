import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import {
  createInstanceDataArchive,
  inspectInstanceBundle,
  instanceVolumeArchiveName,
  packInstanceBundle,
  sha256File,
  validateInstanceManifest,
} from "../../orchestrator/server/utils/instance-backup-bundle";
import type {
  InstanceBackupManifest,
  InstanceBackupOptions,
} from "../../orchestrator/server/utils/instance-backup-types";

const orchestratorRequire = createRequire(
  new URL("../../orchestrator/package.json", import.meta.url),
);
const tar = orchestratorRequire("tar-stream") as {
  pack(): any;
  extract(): any;
};

const defaultOptions: InstanceBackupOptions = {
  includeWorkers: true,
  includeAgentData: true,
  includeDockerVolumes: true,
  includeLocalBackups: false,
  includeLogs: false,
};

async function writeTarGzip(
  path: string,
  entries: Array<{
    name: string;
    body?: string | Buffer;
    type?: string;
    linkname?: string;
  }>,
) {
  const pack = tar.pack();
  const completed = pipeline(pack, createGzip(), createWriteStream(path));
  for (const item of entries) {
    const body = Buffer.isBuffer(item.body)
      ? item.body
      : Buffer.from(item.body ?? "");
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: item.name,
          type: item.type ?? "file",
          size: item.type && item.type !== "file" ? 0 : body.length,
          ...(item.linkname ? { linkname: item.linkname } : {}),
        },
        item.type && item.type !== "file" ? undefined : body,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await completed;
}

async function readTarGzip(path: string) {
  const files = new Map<string, Buffer>();
  const extract = tar.extract();
  extract.on("entry", (header: any, stream: any, next: () => void) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => {
      files.set(header.name.replace(/\/$/, ""), Buffer.concat(chunks));
      next();
    });
    stream.resume();
  });
  await pipeline(createReadStream(path), createGunzip(), extract);
  return files;
}

async function manifestFor(
  dataArchive: string,
  overrides: Partial<InstanceBackupManifest> = {},
): Promise<InstanceBackupManifest> {
  const base: InstanceBackupManifest = {
    kind: "agentor-instance-backup",
    formatVersion: 1,
    backupId: "instance-bundle-1",
    sourceInstallationId: "source-installation-1",
    createdByUserId: "platform-admin",
    createdAt: "2026-09-04T12:00:00.000Z",
    agentorVersion: "test",
    storage: { mode: "volume", containerPrefix: "agentor-worker" },
    options: defaultOptions,
    dataArchive: {
      archive: "data.tar.gz",
      sha256: await sha256File(dataArchive),
      size: (await stat(dataArchive)).size,
    },
    volumes: [],
    plugins: {
      platformDefinitionCount: 1,
      ownerDefinitionCount: 2,
      installationCount: 3,
    },
    hostMounts: { configuredPaths: ["/srv/agent-data"], contentsIncluded: false },
    images: {
      definitions: 2,
      immutableDigests: [`sha256:${"a".repeat(64)}`],
      layersIncluded: false,
    },
    excludedDataPaths: ["tmp", "logs"],
  };
  return { ...base, ...overrides };
}

test.describe("instance disaster-recovery bundle boundary", () => {
  let root = "";

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentor-instance-bundle-"));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("uses the SQLite snapshot and applies recursive-data exclusions without dropping plugin state", async () => {
    const dataDir = join(root, "data");
    const authSnapshot = join(root, "auth-snapshot.db");
    const archive = join(root, "data.tar.gz");
    await mkdir(join(dataDir, "users", "owner", "workspaces"), {
      recursive: true,
    });
    await mkdir(join(dataDir, "users", "owner", "agents"), {
      recursive: true,
    });
    await mkdir(join(dataDir, "tmp"), { recursive: true });
    await mkdir(join(dataDir, "logs"), { recursive: true });
    await mkdir(join(dataDir, "backup-objects"), { recursive: true });
    await writeFile(join(dataDir, "auth.db"), "inconsistent live database");
    await writeFile(join(dataDir, "auth.db-wal"), "live wal");
    await writeFile(authSnapshot, "consistent sqlite online backup");
    await writeFile(join(dataDir, "plugin-definitions.platform.json"), "platform plugins");
    await writeFile(
      join(dataDir, "users", "owner", "plugin-definitions.json"),
      "owner plugins",
    );
    await writeFile(
      join(dataDir, "users", "owner", "plugin-installations.json"),
      "desired plugin state",
    );
    await writeFile(
      join(dataDir, "users", "owner", "workspaces", "project.txt"),
      "workspace",
    );
    await writeFile(
      join(dataDir, "users", "owner", "agents", "state.txt"),
      "agent state",
    );
    await writeFile(join(dataDir, "tmp", "recursive.backup"), "recursive");
    await writeFile(join(dataDir, "logs", "agentor.log"), "ephemeral log");
    await writeFile(join(dataDir, "backup-objects", "old.backup"), "portable backup");

    const result = await createInstanceDataArchive({
      dataDir,
      authSnapshotPath: authSnapshot,
      output: archive,
      options: { ...defaultOptions, includeAgentData: false },
    });
    const entries = await readTarGzip(archive);

    expect(entries.get("auth.db")?.toString()).toBe(
      "consistent sqlite online backup",
    );
    expect(entries.has("auth.db-wal")).toBe(false);
    expect(entries.has("plugin-definitions.platform.json")).toBe(true);
    expect(entries.has("users/owner/plugin-definitions.json")).toBe(true);
    expect(entries.has("users/owner/plugin-installations.json")).toBe(true);
    expect(entries.has("users/owner/workspaces/project.txt")).toBe(true);
    expect(entries.has("users/owner/agents/state.txt")).toBe(false);
    expect(entries.has("tmp/recursive.backup")).toBe(false);
    expect(entries.has("logs/agentor.log")).toBe(false);
    expect(entries.has("backup-objects/old.backup")).toBe(false);
    expect(result.excludedDataPaths).toEqual(
      expect.arrayContaining([
        "tmp",
        "logs",
        "backup-objects",
        "users/*/agents",
        "admin/instance-backups.v1.json",
      ]),
    );
    expect(result.sha256).toBe(await sha256File(archive));

    await symlink("/etc/passwd", join(dataDir, "absolute-link"));
    await expect(
      createInstanceDataArchive({
        dataDir,
        authSnapshotPath: authSnapshot,
        output: join(root, "unsafe-link.tar.gz"),
        options: defaultOptions,
      }),
    ).rejects.toThrow(/unsafe symlink/i);
  });

  test("round-trips the manifest, control-plane archive, and declared volume by exact digest", async () => {
    const dataArchive = join(root, "data.tar.gz");
    const volumeArchive = join(root, "volume.tar.gz");
    const bundle = join(root, "bundle.tar");
    await writeTarGzip(dataArchive, [{ name: "auth.db", body: "sqlite snapshot" }]);
    await writeTarGzip(volumeArchive, [
      { name: "source/", type: "directory" },
      { name: "source/workspace.txt", body: "workspace data" },
    ]);
    const volumeName = "agentor-worker-safe-workspace";
    const volume = {
      name: volumeName,
      kind: "worker-workspace" as const,
      ownerId: "owner-1",
      workerId: "worker-1",
      archive: instanceVolumeArchiveName(volumeName),
      sha256: await sha256File(volumeArchive),
      size: (await stat(volumeArchive)).size,
    };
    const manifest = await manifestFor(dataArchive, { volumes: [volume] });

    await packInstanceBundle(
      manifest,
      dataArchive,
      [{ manifest: volume, path: volumeArchive }],
      bundle,
    );
    const inspected = await inspectInstanceBundle(
      bundle,
      join(root, "inspected"),
    );

    expect(inspected.manifest).toEqual(manifest);
    expect(await sha256File(inspected.dataArchivePath)).toBe(
      manifest.dataArchive.sha256,
    );
    expect(inspected.volumeArchives.has(volumeName)).toBe(true);
    expect(
      await sha256File(inspected.volumeArchives.get(volumeName)!),
    ).toBe(volume.sha256);
  });

  test("rejects traversal, reserved recovery paths, special entries, duplicate paths, and non-directory ancestors", async () => {
    const cases: Array<{
      name: string;
      entries: Array<{ name: string; body?: string; type?: string; linkname?: string }>;
      error: RegExp;
    }> = [
      {
        name: "traversal",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "../outside", body: "escape" },
        ],
        error: /unsafe path/i,
      },
      {
        name: "reserved path",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "instance-restore-staging/plan.json", body: "recursive" },
        ],
        error: /reserved recovery path/i,
      },
      {
        name: "special entry",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "device", type: "character-device" },
        ],
        error: /special entry/i,
      },
      {
        name: "absolute symlink",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "links/absolute", type: "symlink", linkname: "/etc/passwd" },
        ],
        error: /unsafe symlink/i,
      },
      {
        name: "escaping symlink",
        entries: [
          { name: "auth.db", body: "db" },
          {
            name: "links/escaping",
            type: "symlink",
            linkname: "../../../outside",
          },
        ],
        error: /outside its archive root/i,
      },
      {
        name: "duplicate",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "duplicate", body: "one" },
          { name: "duplicate", body: "two" },
        ],
        error: /duplicate entry/i,
      },
      {
        name: "non-directory ancestor",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "parent", body: "file" },
          { name: "parent/child", body: "child" },
        ],
        error: /non-directory/i,
      },
      {
        name: "absolute symlink target",
        entries: [
          { name: "auth.db", body: "db" },
          { name: "unsafe-link", type: "symlink", linkname: "/etc/shadow" },
        ],
        error: /unsafe symlink|outside its archive root/i,
      },
      {
        name: "upward symlink target",
        entries: [
          { name: "auth.db", body: "db" },
          {
            name: "nested/unsafe-link",
            type: "symlink",
            linkname: "../../outside",
          },
        ],
        error: /unsafe symlink|outside its archive root/i,
      },
    ];

    for (const item of cases) {
      const dataArchive = join(root, `${item.name}.tar.gz`);
      const bundle = join(root, `${item.name}.bundle.tar`);
      await writeTarGzip(dataArchive, item.entries);
      const manifest = await manifestFor(dataArchive, {
        backupId: `bad-${item.name.replace(/ /g, "-")}`,
      });
      await packInstanceBundle(manifest, dataArchive, [], bundle);
      await expect(
        inspectInstanceBundle(bundle, join(root, `${item.name}-output`)),
      ).rejects.toThrow(item.error);
    }
  });

  test("rejects missing authentication data, digest mismatch, undeclared payloads, and unsafe manifest fields", async () => {
    const noAuth = join(root, "no-auth.tar.gz");
    const noAuthBundle = join(root, "no-auth.bundle.tar");
    await writeTarGzip(noAuth, [{ name: "settings.json", body: "{}" }]);
    await packInstanceBundle(await manifestFor(noAuth), noAuth, [], noAuthBundle);
    await expect(
      inspectInstanceBundle(noAuthBundle, join(root, "no-auth-output")),
    ).rejects.toThrow(/no authentication database/i);

    const validData = join(root, "valid-data.tar.gz");
    const digestBundle = join(root, "digest.bundle.tar");
    await writeTarGzip(validData, [{ name: "auth.db", body: "db" }]);
    const badDigest = await manifestFor(validData);
    badDigest.dataArchive.sha256 = "0".repeat(64);
    await packInstanceBundle(badDigest, validData, [], digestBundle);
    await expect(
      inspectInstanceBundle(digestBundle, join(root, "digest-output")),
    ).rejects.toThrow(/integrity check failed/i);

    const missingPayloadManifest = await manifestFor(validData, {
      volumes: [
        {
          name: "missing-volume",
          kind: "persistent-path",
          archive: instanceVolumeArchiveName("missing-volume"),
          sha256: "0".repeat(64),
          size: 0,
        },
      ],
    });
    await expect(
      packInstanceBundle(
        missingPayloadManifest,
        validData,
        [],
        join(root, "missing-payload.bundle.tar"),
      ),
    ).rejects.toThrow(/does not match its payloads/i);

    const manifest = await manifestFor(validData);
    expect(() =>
      validateInstanceManifest({
        ...manifest,
        hostMounts: {
          configuredPaths: ["relative/host/path"],
          contentsIncluded: false,
        },
      }),
    ).toThrow(/invalid instance backup manifest/i);
    expect(() =>
      validateInstanceManifest({
        ...manifest,
        images: { ...manifest.images, layersIncluded: true },
      }),
    ).toThrow(/invalid instance backup manifest/i);
    expect(() =>
      validateInstanceManifest({
        ...manifest,
        excludedDataPaths: ["/absolute/exclusion"],
      }),
    ).toThrow(/invalid instance backup manifest/i);
  });
});
