import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  lstat,
  link,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import {
  createInstanceDataArchive,
  inspectInstanceBundle,
  instanceVolumeArchiveName,
  packInstanceBundle,
  sha256File,
  validateInstanceManifest,
  prepareInstanceNativeVolumeArchive,
} from "../../orchestrator/server/utils/instance-backup-bundle";
import type {
  InstanceBackupManifest,
  InstanceBackupOptions,
  InstanceBackupVolumeManifest,
} from "../../orchestrator/server/utils/instance-backup-types";

const nativeWorker = '11111111-2222-3333-4444-555555555555';
const nativeManaged = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const nativeSource = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
  architecture: 'amd64' as const, converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const };
function nativeVolume(role: 'workspace' | 'agents' | 'docker' | 'managed', bytes = Buffer.alloc(0)): InstanceBackupVolumeManifest {
  const name = role === 'managed' ? 'agentor-persist-' + nativeManaged : 'agentor-worker-' + nativeWorker + '-' + role;
  return { name, ownerId: 'native-owner', workerId: nativeWorker,
    kind: ({ workspace: 'worker-workspace', agents: 'worker-agent-data', docker: 'worker-dind', managed: 'persistent-path' } as const)[role],
    archive: instanceVolumeArchiveName(name), sha256: 'a'.repeat(64), size: bytes.length,
    runtime: role === 'managed' ? { kind: 'incus-vm' as const, role, managedVolumeId: nativeManaged, target: '/srv/persisted' }
      : { kind: 'incus-vm' as const, role, source: nativeSource } };
}

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

  test("never includes private native cleanup receipts, regardless of data options", async () => {
    const dataDir = join(root, "data"), authSnapshot = join(root, "auth-snapshot.db");
    await mkdir(join(dataDir, "incus-backup-helpers"), { recursive: true, mode: 0o700 });
    await writeFile(join(dataDir, "incus-backup-helpers", "receipt.json"), '{"nativeUUID":"host-local","operation":"pending"}', { mode: 0o600 });
    await writeFile(join(dataDir, "incus-backup-helpers", "receipt.tmp"), "private partial receipt", { mode: 0o600 });
    const sizing = "system-state/users/volume-sizing";
    await mkdir(join(dataDir, sizing), { recursive: true });
    await writeFile(join(dataDir, sizing, "volume-size-jobs.v1.json"), '{"nativeUUID":"source-only","helperOperation":"pending"}');
    await writeFile(join(dataDir, sizing, "volume-size-cache.v1.json"), '{"incarnation":"source-only"}');
    await writeFile(join(dataDir, sizing, "other-state.json"), "unrelated retained system state");
    await writeFile(join(dataDir, "worker-state.json"), "canonical control-plane state");
    await writeFile(authSnapshot, "sqlite snapshot");
    for (const [index, options] of [defaultOptions,
      { ...defaultOptions, includeLocalBackups: true, includeLogs: true },
      { ...defaultOptions, includeWorkers: false, includeAgentData: false, includeDockerVolumes: false }].entries()) {
      const archive = join(root, "without-native-receipts-" + index + ".gz");
      const result = await createInstanceDataArchive({ dataDir, authSnapshotPath: authSnapshot, output: archive, options });
      const entries = await readTarGzip(archive);
      expect([...entries.keys()].some(name => name === "incus-backup-helpers" || name.startsWith("incus-backup-helpers/"))).toBe(false);
      expect(entries.get("worker-state.json")?.toString()).toBe("canonical control-plane state");
      expect(entries.get("auth.db")?.toString()).toBe("sqlite snapshot");
      expect(result.excludedDataPaths).toContain("incus-backup-helpers");
      for (const name of ["volume-size-jobs.v1.json", "volume-size-cache.v1.json"]) {
        expect(entries.has(sizing + "/" + name)).toBe(false);
        expect(result.excludedDataPaths).toContain(sizing + "/" + name);
      }
      expect(entries.get(sizing + "/other-state.json")?.toString()).toBe("unrelated retained system state");
    }
    expect(await readFile(join(dataDir, "incus-backup-helpers", "receipt.json"), "utf8")).toContain("host-local");
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
      { name: "source/workspace-copy.txt", type: "link", linkname: "source/workspace.txt" },
      {
        name: "source/.venv/bin/python3",
        type: "symlink",
        linkname: "/usr/bin/python3",
      },
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

test.describe('native instance format boundary', () => {
  let directory: string;
  test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'agentor-native-instance-format-')); });
  test.afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  const data = async (directory: string) => {
    const path = join(directory, 'data.tar.gz'); await writeTarGzip(path, [{ name: 'auth.db', body: 'sqlite snapshot' }]); return path;
  };
  const nativeRaw = async (directory: string, wrapper: string) => {
    const stage = join(directory, 'stage-' + wrapper), path = join(stage, wrapper); await mkdir(path, { recursive: true });
    await writeFile(join(path, 'data'), Buffer.from([0, 255, 128, 10, 61]));
    await link(join(path, 'data'), join(path, 'hard')); await symlink('data', join(path, 'inert'));
    execFileSync('python3', ['-c', 'import os,sys; os.setxattr(sys.argv[1],"user.binary",bytes([0,255,128,10,61,0]))', join(path, 'data')]);
    const raw = join(directory, wrapper + '.tar');
    execFileSync('/usr/bin/tar', ['--format=pax', '--numeric-owner', '--owner=12345', '--group=23456', '--mode=0640',
      '--xattrs', '--xattrs-include=*', '--acls', '-cf', raw, '-C', stage, wrapper]);
    return readFile(raw);
  };

  test('version1 remains legacy-only; version2 role, source, names and portable metadata are strict', async () => {
    const path = await data(directory), volumes = ['workspace', 'agents', 'docker', 'managed'].map(role => nativeVolume(role as any));
    const manifest = await manifestFor(path, { formatVersion: 2, volumes });
    expect(validateInstanceManifest(manifest)).toEqual(manifest);
    const legacy = await manifestFor(path); expect(validateInstanceManifest(legacy)).toEqual(legacy);
    expect(() => validateInstanceManifest({ ...manifest, formatVersion: 1 })).toThrow(/manifest/);
    expect(() => validateInstanceManifest({ ...manifest, formatVersion: 3 })).toThrow(/manifest/);
    for (const mutation of ['kind', 'role', 'missing-source', 'mutable-source', 'source-fingerprint', 'runtime-ip',
      'missing-owner', 'missing-worker', 'group', 'wrong-name', 'wrong-volume-kind', 'managed-fields']) {
      const candidate: any = structuredClone(volumes[0]);
      if (mutation === 'kind') candidate.runtime.kind = 'legacy-docker';
      if (mutation === 'role') candidate.runtime.role = 'root';
      if (mutation === 'missing-source') delete candidate.runtime.source;
      if (mutation === 'mutable-source') candidate.runtime.source.sourceImageId = 'ubuntu:latest';
      if (mutation === 'source-fingerprint') candidate.runtime.source.fingerprint = 'c'.repeat(64);
      if (mutation === 'runtime-ip') candidate.runtime.ip = '10.0.0.1';
      if (mutation === 'missing-owner') delete candidate.ownerId;
      if (mutation === 'missing-worker') delete candidate.workerId;
      if (mutation === 'group') candidate.groupId = 'group';
      if (mutation === 'wrong-name') { candidate.name = 'agentor-worker-other-workspace'; candidate.archive = instanceVolumeArchiveName(candidate.name); }
      if (mutation === 'wrong-volume-kind') candidate.kind = 'admin-workspace';
      if (mutation === 'managed-fields') candidate.runtime.managedVolumeId = nativeManaged;
      expect(() => validateInstanceManifest({ ...manifest, volumes: [candidate] }), mutation).toThrow(/manifest/);
    }
    for (const mutation of ['id', 'target', 'name', 'source', 'missing-owner', 'missing-worker']) {
      const candidate: any = structuredClone(volumes[3]);
      if (mutation === 'id') candidate.runtime.managedVolumeId = 'not-a-uuid';
      if (mutation === 'target') candidate.runtime.target = '/srv/persisted/../foreign';
      if (mutation === 'name') { candidate.name = 'agentor-persist-other'; candidate.archive = instanceVolumeArchiveName(candidate.name); }
      if (mutation === 'source') candidate.runtime.source = nativeSource;
      if (mutation === 'missing-owner') delete candidate.ownerId;
      if (mutation === 'missing-worker') delete candidate.workerId;
      expect(() => validateInstanceManifest({ ...manifest, volumes: [candidate] }), mutation).toThrow(/manifest/);
    }
  });

  test('Docker data presence is descriptive, optional and strictly boolean only on native workspace', async () => {
    const path = await data(directory);
    for (const dockerData of [false, true]) {
      const workspace = nativeVolume('workspace');
      if (workspace.runtime?.role !== 'workspace') throw new Error('Fixture workspace missing');
      workspace.runtime.dockerData = dockerData;
      const manifest = await manifestFor(path, { formatVersion: 2, volumes: [workspace] });
      expect(validateInstanceManifest(manifest)).toEqual(manifest);
      expect(() => validateInstanceManifest({ ...manifest, formatVersion: 1 })).toThrow(/manifest/);
    }
    // Historical v2 still parses; missing presence proof is fenced by restore planning.
    const historical = await manifestFor(path, { formatVersion: 2, volumes: [nativeVolume('workspace')] });
    expect(validateInstanceManifest(historical)).toEqual(historical);
    for (const value of [undefined, null, 0, 1, 'true', 'false', {}, []]) {
      const workspace: any = nativeVolume('workspace'); workspace.runtime.dockerData = value;
      expect(() => validateInstanceManifest({ ...historical, volumes: [workspace] })).toThrow(/manifest/);
    }
    for (const role of ['agents', 'docker', 'managed'] as const) {
      const volume: any = nativeVolume(role); volume.runtime.dockerData = false;
      expect(() => validateInstanceManifest({ ...historical, volumes: [volume] })).toThrow(/manifest/);
    }
  });

  test('cheap live-fixture preflight preserves confined absolute links and rejects external managed links', async () => {
    const volume = nativeVolume('managed');
    const payload = join(directory, 'fixture-volume.tar.gz'), scratch = join(directory, 'fixture-raw');
    await mkdir(scratch, { mode: 0o700 });
    const write = (linkname: string) => writeTarGzip(payload, [
      { name: 'volume/', type: 'directory' },
      { name: 'volume/data', body: Buffer.from([0,255,128,10,61,0]) },
      { name: 'volume/link', type: 'symlink', linkname },
    ]);
    await write('/absolute/inert/link');
    await expect(prepareInstanceNativeVolumeArchive(payload, volume, scratch)).rejects.toThrow('absolute symlink escapes');
    if (volume.runtime?.role !== 'managed') throw new Error('Fixture managed descriptor missing');
    await write(volume.runtime.target + '/data');
    const valid = await prepareInstanceNativeVolumeArchive(payload, volume, scratch);
    expect(valid.entries).toBe(3);
  });

  test('mixed native version2 bundle and private raw decoder preserve GNU binary metadata and exact role wrappers', async () => {
    const path = await data(directory), items = [];
    for (const role of ['workspace', 'agents', 'docker', 'managed'] as const) {
      const raw = await nativeRaw(directory, role === 'agents' ? '.agent-data' : role === 'managed' ? 'volume' : role);
      const archive = join(directory, role + '.gz'); await writeFile(archive, gzipSync(raw));
      const volume = { ...nativeVolume(role), size: (await stat(archive)).size, sha256: await sha256File(archive) };
      const scratch = join(directory, role + '-scratch'); await mkdir(scratch, { mode: 0o700 });
      const decoded = await prepareInstanceNativeVolumeArchive(archive, volume, scratch);
      expect(await readFile(decoded.archivePath)).toEqual(raw); expect(decoded.rawBytes).toBe(raw.length);
      expect(decoded.entries).toBe(4); expect(decoded.expandedBytes).toBe(5);
      expect((await lstat(decoded.archivePath)).mode & 0o777).toBe(0o600);
      items.push({ manifest: volume, path: archive });
    }
    const manifest = await manifestFor(path, { formatVersion: 2, volumes: items.map(item => item.manifest) });
    const bundle = join(directory, 'native.tar'); await packInstanceBundle(manifest, path, items, bundle);
    const inspected = await inspectInstanceBundle(bundle, join(directory, 'unpacked'));
    expect(inspected.manifest).toEqual(manifest); expect(inspected.volumeArchives.size).toBe(4);
    for (const item of items) expect(await readFile(inspected.volumeArchives.get(item.manifest.name)!)).toEqual(await readFile(item.path));
    expect((await readdir(join(directory, 'unpacked'))).some(name => name.startsWith('.native-volume-check-'))).toBe(false);
  });

  test('Docker device bytes are native-only and untagged/version1 cannot reinterpret their archive', async () => {
    const path = await data(directory), archive = join(directory, 'special.gz');
    const raw: Buffer[] = [];
    for (const [name, type] of [['docker/', '5'], ['docker/whiteout', '3'], ['docker/fifo', '6']]) {
      const header = Buffer.alloc(512); header.write(name!, 0, 100);
      for (const [offset, length, value] of [[100, 8, 0o700], [108, 8, 12345], [116, 8, 23456],
        [124, 12, 0], [136, 12, 100], [329, 8, 0], [337, 8, 0]])
        header.write(value!.toString(8).padStart(length! - 1, '0') + '\0', offset!, length!, 'ascii');
      header[156] = type!.charCodeAt(0); header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
      header.fill(32, 148, 156); header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
      raw.push(header);
    }
    const bytes = Buffer.concat([...raw, Buffer.alloc(1024)]); await writeFile(archive, gzipSync(bytes));
    const volume = { ...nativeVolume('docker'), size: (await stat(archive)).size, sha256: await sha256File(archive) };
    const scratch = join(directory, 'special-scratch'); await mkdir(scratch, { mode: 0o700 });
    const decoded = await prepareInstanceNativeVolumeArchive(archive, volume, scratch); expect(await readFile(decoded.archivePath)).toEqual(bytes);
    const manifest = await manifestFor(path, { formatVersion: 2, volumes: [volume] }), bundle = join(directory, 'special.tar');
    await packInstanceBundle(manifest, path, [{ manifest: volume, path: archive }], bundle);
    await expect(inspectInstanceBundle(bundle, join(directory, 'special-unpacked'))).resolves.toMatchObject({ manifest });
    for (const version of [1, 2] as const) {
      const legacy: any = { ...volume }; delete legacy.runtime;
      const legacyManifest = await manifestFor(path, { formatVersion: version, volumes: [legacy] });
      const legacyBundle = join(directory, 'untagged-' + version + '.tar');
      await packInstanceBundle(legacyManifest, path, [{ manifest: legacy, path: archive }], legacyBundle);
      await expect(inspectInstanceBundle(legacyBundle, join(directory, 'untagged-' + version))).rejects.toThrow(/special/);
    }
    // These remain byte fixtures only; no device or FIFO is created/extracted.
  });

  test('native decoder bounds, corrupt gzip, wrong roots and cancellation remove only their own partial scratch', async () => {
    const raw = await nativeRaw(directory, 'workspace'), compressed = join(directory, 'workspace.gz');
    await writeFile(compressed, gzipSync(raw)); const volume = nativeVolume('workspace', await readFile(compressed));
    const scratch = join(directory, 'scratch'); await mkdir(scratch, { mode: 0o700 });
    await writeFile(join(scratch, 'keep'), 'retained');
    await expect(prepareInstanceNativeVolumeArchive(compressed, volume, scratch, { maxRawBytes: 512 })).rejects.toThrow(/raw-byte limit/);
    await expect(prepareInstanceNativeVolumeArchive(compressed, { ...nativeVolume('docker'), size: volume.size }, scratch)).rejects.toThrow(/docker/);
    const corrupt = join(directory, 'corrupt.gz'); await writeFile(corrupt, gzipSync(raw).subarray(0, 16));
    await expect(prepareInstanceNativeVolumeArchive(corrupt, volume, scratch)).rejects.toThrow();
    const cancelled = new AbortController(); cancelled.abort(new Error('native-instance-cancelled'));
    await expect(prepareInstanceNativeVolumeArchive(compressed, volume, scratch, { signal: cancelled.signal })).rejects.toThrow(/cancelled/);
    expect(await readdir(scratch)).toEqual(['keep']); expect(await readFile(join(scratch, 'keep'), 'utf8')).toBe('retained');
    const linked = join(directory, 'linked'); await symlink(scratch, linked);
    await expect(prepareInstanceNativeVolumeArchive(compressed, volume, linked)).rejects.toThrow(/private directory/);
    await expect(prepareInstanceNativeVolumeArchive(compressed, volume, scratch, { maxRawBytes: 0 })).rejects.toThrow(/raw-byte limit/);
  });
});
