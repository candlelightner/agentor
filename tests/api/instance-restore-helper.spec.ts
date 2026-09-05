import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const orchestratorRoot = new URL("../../orchestrator/", import.meta.url);
const helperPath = new URL(
  "../../orchestrator/instance-restore-helper.mjs",
  import.meta.url,
).pathname;
const orchestratorRequire = createRequire(
  new URL("../../orchestrator/package.json", import.meta.url),
);
const tar = orchestratorRequire("tar-stream") as { pack(): any };
const importHelper = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<{
  runInstanceRestoreHelper(options: {
    env: Record<string, string>;
    docker: any;
  }): Promise<{
    status: "succeeded" | "failed" | "cancelled";
    code?: string;
    message?: string;
  }>;
}>;

async function runHelper(env: Record<string, string> = {}) {
  return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [helperPath], {
        cwd: orchestratorRoot.pathname,
        // Deliberately do not inherit operator credentials into the helper
        // subprocess. Production also passes a four-variable allowlist.
        env: { NODE_ENV: "test", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
}

async function writeTarGzip(
  path: string,
  entries: Array<{
    name: string;
    body?: string | Buffer;
    type?: "file" | "directory" | "symlink";
    linkname?: string;
  }>,
) {
  const pack = tar.pack();
  const writing = pipeline(pack, createGzip(), createWriteStream(path));
  for (const item of entries) {
    const type = item.type ?? "file";
    const body = Buffer.isBuffer(item.body)
      ? item.body
      : Buffer.from(item.body ?? "");
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: item.name,
          type,
          size: type === "file" ? body.length : 0,
          uid: process.getuid?.() ?? 1000,
          gid: process.getgid?.() ?? 1000,
          ...(item.linkname ? { linkname: item.linkname } : {}),
        },
        type === "file" ? body : undefined,
        (error?: Error | null) => (error ? reject(error) : resolve()),
      );
    });
  }
  pack.finalize();
  await writing;
}

async function fixture(root: string, options?: { hostPolicies?: boolean }) {
  const dataDir = join(root, "data");
  const jobId = "restore-job-1";
  const stage = join(
    dataDir,
    "instance-restore-staging",
    `restore-${jobId}`,
  );
  const unpacked = join(stage, "unpacked");
  await mkdir(join(dataDir, "admin"), { recursive: true });
  await mkdir(unpacked, { recursive: true });
  const job = {
    schemaVersion: 1,
    id: jobId,
    userId: "recovery-admin",
    operation: "restore",
    provider: "local",
    status: "running",
    phase: "applying",
    progress: 70,
    bytesProcessed: 0,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    logs: [],
  };
  await writeFile(
    join(dataDir, "admin", "instance-backups.v1.json"),
    JSON.stringify({
      schemaVersion: 1,
      jobs: [job],
      artifacts: [],
      remoteBackups: [],
    }),
  );
  await writeFile(
    join(dataDir, "auth.db"),
    Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.from("old")]),
  );
  const plan = {
    version: 1,
    jobId,
    dataArchive: join(unpacked, "data.tar.gz"),
    volumes: [] as Array<{
      name: string;
      archive: string;
      kind: string;
      workerId?: string;
    }>,
    restoreHostMountPolicies: options?.hostPolicies ?? false,
    sourceInstallationId: "source-installation",
    restoredOwnerId: "restored-admin",
    stagingOwnerId: "recovery-admin",
  };
  await writeFile(join(stage, "restore-plan.json"), JSON.stringify(plan));
  return {
    dataDir,
    jobId,
    stage,
    unpacked,
    plan,
    env: {
      AGENTOR_INSTANCE_RESTORE_JOB: jobId,
      AGENTOR_INSTANCE_RESTORE_STAGE: stage,
      AGENTOR_INSTANCE_RESTORE_DATA_DIR: dataDir,
      AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR: "0".repeat(64),
    },
  };
}

function fakeDocker(dataDir: string, orchestratorId: string, options?: {
  createVolumeError?: Error;
  containers?: Array<{ Id: string; Labels?: Record<string, string> }>;
}) {
  let running = true;
  let stops = 0;
  let starts = 0;
  const mount = {
    Type: "bind",
    Source: "/test-host/agentor-data",
    Destination: dataDir,
  };
  const target = {
    inspect: async () => ({
      Id: orchestratorId,
      State: { Running: running },
      Config: { Image: "agentor-orchestrator:test", Labels: {} },
      Mounts: [mount],
    }),
    stop: async () => {
      stops += 1;
      running = false;
    },
    start: async () => {
      starts += 1;
      running = true;
    },
  };
  const helper = { inspect: async () => ({ Mounts: [mount] }) };
  const missingVolume = () => ({
    inspect: async () => {
      throw Object.assign(new Error("missing volume"), { statusCode: 404 });
    },
    remove: async () => {
      throw Object.assign(new Error("missing volume"), { statusCode: 404 });
    },
  });
  return {
    docker: {
      getContainer: (id: string) =>
        id === orchestratorId ? target : helper,
      getVolume: () => missingVolume(),
      listContainers: async () => options?.containers ?? [],
      createVolume: async () => {
        throw options?.createVolumeError ?? new Error("unexpected createVolume");
      },
      createContainer: async () => {
        throw new Error("unexpected createContainer");
      },
    },
    state: {
      get running() {
        return running;
      },
      get stops() {
        return stops;
      },
      get starts() {
        return starts;
      },
    },
  };
}

async function runInjected(
  prepared: Awaited<ReturnType<typeof fixture>>,
  docker: any,
) {
  const module = await importHelper(pathToFileURL(helperPath).href);
  return module.runInstanceRestoreHelper({
    docker,
    env: { ...prepared.env, HOSTNAME: "restore-helper-container" },
  });
}

test.describe("controlled instance restore helper", () => {
  let root = "";

  test.beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentor-instance-restore-helper-"));
  });

  test.afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("fails closed without a complete launch context", async () => {
    const result = await runHelper({
      AGENTOR_INSTANCE_RESTORE_JOB: "",
      AGENTOR_INSTANCE_RESTORE_STAGE: "",
      AGENTOR_INSTANCE_RESTORE_DATA_DIR: "",
      AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR: "",
    });
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("INSTANCE_RESTORE_INVALID_CONTEXT");
    expect(result.stderr).not.toContain("raw-recovery-material-sentinel");
  });

  test("rejects an archive path outside the exact job staging directory", async () => {
    const prepared = await fixture(root);
    const outside = join(root, "outside.tar.gz");
    await writeFile(
      join(prepared.stage, "restore-plan.json"),
      JSON.stringify({ ...prepared.plan, dataArchive: outside }),
    );
    const result = await runHelper(prepared.env);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("INSTANCE_RESTORE_INVALID_PLAN");
    expect(result.stderr).toContain("outside restore staging");
  });

  test("rejects traversal before Docker is contacted and records only a safe error", async () => {
    const prepared = await fixture(root);
    const marker = "raw-archive-value-must-not-enter-logs";
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "../escape", body: marker },
    ]);

    const result = await runHelper(prepared.env);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("INSTANCE_RESTORE_INVALID_ARCHIVE");
    expect(result.stderr).not.toContain(marker);
    await expect(readFile(join(root, "escape"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const state = JSON.parse(
      await readFile(
        join(prepared.dataDir, "admin", "instance-backups.v1.json"),
        "utf8",
      ),
    );
    expect(state.jobs[0]).toMatchObject({
      status: "failed",
      errorCode: "INSTANCE_RESTORE_INVALID_ARCHIVE",
    });
    expect(JSON.stringify(state)).not.toContain(marker);
  });

  test("rejects a data symlink that resolves outside the archive root", async () => {
    const prepared = await fixture(root);
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(128, 0),
    ]);
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "auth.db", body: sqlite },
      {
        name: "users/source-owner/escape",
        type: "symlink",
        linkname: "../../../outside",
      },
    ]);

    const result = await runHelper(prepared.env);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("INSTANCE_RESTORE_INVALID_ARCHIVE");
    expect(result.stderr).toContain("outside its archive root");
  });

  test("removes generated host-mount policies from prepared data unless explicitly selected", async () => {
    const prepared = await fixture(root);
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.alloc(128, 0),
    ]);
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "auth.db", body: sqlite },
      { name: "admin/host-mount-paths.v1.json", body: "[]" },
      { name: "users/source-owner/host-mount-grants.json", body: "[]" },
      {
        name: "users/source-owner/plugin-definitions.json",
        body: "[]",
      },
    ]);

    // The all-zero target ID cannot name the running orchestrator. The helper
    // therefore stops after preparation and before any destination mutation.
    const result = await runHelper(prepared.env);
    expect(result.code, result.stderr).toBe(1);
    const staged = join(prepared.stage, "prepared-data");
    await expect(
      readFile(join(staged, "admin", "host-mount-paths.v1.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          staged,
          "users",
          "source-owner",
          "host-mount-grants.json",
        ),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(
        join(
          staged,
          "users",
          "source-owner",
          "plugin-definitions.json",
        ),
        "utf8",
      ),
      result.stderr,
    ).resolves.toBe("[]");
  });

  test("applies a verified data snapshot, transfers job ownership, and restarts the exact container", async () => {
    const prepared = await fixture(root);
    await writeFile(join(prepared.dataDir, "old-control-plane.txt"), "old");
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("restored-auth-database"),
    ]);
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "auth.db", body: sqlite },
      { name: "plugin-definitions.platform.json", body: "restored-plugins" },
    ]);
    const fake = fakeDocker(
      prepared.dataDir,
      prepared.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR,
    );

    const result = await runInjected(prepared, fake.docker);

    expect(result).toEqual({ status: "succeeded" });
    expect(fake.state).toMatchObject({ running: true, stops: 1, starts: 1 });
    await expect(
      readFile(join(prepared.dataDir, "plugin-definitions.platform.json"), "utf8"),
    ).resolves.toBe("restored-plugins");
    await expect(
      readFile(join(prepared.dataDir, "old-control-plane.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(
      await readFile(
        join(prepared.dataDir, "admin", "instance-backups.v1.json"),
        "utf8",
      ),
    );
    expect(state.jobs[0]).toMatchObject({
      status: "succeeded",
      phase: "complete",
      userId: "restored-admin",
    });
    await expect(
      readFile(
        join(
          prepared.dataDir,
          "instance-restore-rollback",
          prepared.jobId,
          "current",
          "auth.db",
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rechecks destination emptiness after stop before replacing control-plane data", async () => {
    const prepared = await fixture(root);
    await writeFile(join(prepared.dataDir, "old-control-plane.txt"), "old");
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("restored-auth-database"),
    ]);
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "auth.db", body: sqlite },
      { name: "new-control-plane.txt", body: "new" },
    ]);
    const owner = join(prepared.dataDir, "users", "new-owner");
    await mkdir(owner, { recursive: true });
    await writeFile(
      join(owner, "workers.json"),
      JSON.stringify([{ id: "worker-created-after-preflight" }]),
    );
    const fake = fakeDocker(
      prepared.dataDir,
      prepared.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR,
    );

    const result = await runInjected(prepared, fake.docker);

    expect(result).toMatchObject({
      status: "failed",
      code: "INSTANCE_RESTORE_DESTINATION_CHANGED",
    });
    expect(fake.state).toMatchObject({ running: true, stops: 1, starts: 1 });
    await expect(
      readFile(join(prepared.dataDir, "old-control-plane.txt"), "utf8"),
    ).resolves.toBe("old");
    await expect(
      readFile(join(prepared.dataDir, "new-control-plane.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(
      await readFile(
        join(prepared.dataDir, "admin", "instance-backups.v1.json"),
        "utf8",
      ),
    );
    expect(state.jobs[0]).toMatchObject({
      status: "failed",
      errorCode: "INSTANCE_RESTORE_DESTINATION_CHANGED",
      userId: "recovery-admin",
    });
  });

  test("rolls data and ownership back when a selected volume cannot be created", async () => {
    const prepared = await fixture(root);
    await writeFile(join(prepared.dataDir, "old-control-plane.txt"), "old");
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0"),
      Buffer.from("replacement"),
    ]);
    await writeTarGzip(prepared.plan.dataArchive, [
      { name: "auth.db", body: sqlite },
      { name: "new-control-plane.txt", body: "new" },
    ]);
    const volumeArchive = join(prepared.unpacked, "volume-selected.tar.gz");
    await writeTarGzip(volumeArchive, [
      { name: "source/", type: "directory" },
      { name: "source/workspace.txt", body: "workspace" },
    ]);
    prepared.plan.volumes = [
      {
        name: "agentor-worker-restore-test-workspace",
        archive: volumeArchive,
        kind: "worker-workspace",
        workerId: "worker-restore-test",
      },
    ];
    await writeFile(
      join(prepared.stage, "restore-plan.json"),
      JSON.stringify(prepared.plan),
    );
    const fake = fakeDocker(
      prepared.dataDir,
      prepared.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR,
      { createVolumeError: new Error("synthetic volume creation failure") },
    );

    const result = await runInjected(prepared, fake.docker);

    expect(result).toMatchObject({
      status: "failed",
      code: "INSTANCE_RESTORE_APPLY_FAILED",
    });
    expect(result.message).toBe("The controlled instance restore failed.");
    expect(result.message).not.toContain("synthetic volume creation failure");
    expect(fake.state).toMatchObject({ running: true, stops: 1, starts: 1 });
    await expect(
      readFile(join(prepared.dataDir, "old-control-plane.txt"), "utf8"),
    ).resolves.toBe("old");
    await expect(
      readFile(join(prepared.dataDir, "new-control-plane.txt"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const state = JSON.parse(
      await readFile(
        join(prepared.dataDir, "admin", "instance-backups.v1.json"),
        "utf8",
      ),
    );
    expect(state.jobs[0]).toMatchObject({
      status: "failed",
      userId: "recovery-admin",
      errorCode: "INSTANCE_RESTORE_APPLY_FAILED",
      retryable: true,
    });
  });
});
