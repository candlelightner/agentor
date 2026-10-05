import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import * as nativeAdapter from '../../orchestrator/instance-restore-native';
import { createInstanceDataArchive, instanceVolumeArchiveName, sha256File, validateInstanceManifest } from '../../orchestrator/server/utils/instance-backup-bundle';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';

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
    nativeAdapter?: typeof nativeAdapter;
  }): Promise<{
    status: "succeeded" | "failed" | "cancelled";
    code?: string;
    message?: string;
  }>;
}>;

test('Docker-only helper rejects native formats and descriptors before any archive or Docker access', async () => {
  const helper = await importHelper(pathToFileURL(helperPath).href);
  for (const descriptor of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'instance-helper-native-fence-'));
    try {
      const prepared = await fixture(root);
      await writeFile(join(prepared.stage, 'restore-plan.json'), JSON.stringify({ ...prepared.plan,
        ...(descriptor ? { volumes: [{ name: 'worker-data', archive: '/invalid', kind: 'worker-workspace',
          runtime: { kind: 'incus-vm', role: 'workspace' } }] } : { formatVersion: 2 }) }));
      let calls = 0;
      const result = await helper.runInstanceRestoreHelper({ env: prepared.env,
        docker: new Proxy({}, { get() { calls++; throw new Error('Native plan must not touch Docker'); } }) });
      expect(result).toMatchObject({ status: 'failed', code: 'INSTANCE_RESTORE_NATIVE_UNAVAILABLE' });
      expect(calls).toBe(0);
      expect((await readFile(join(prepared.dataDir, 'auth.db'))).subarray(16).toString()).toBe('old');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

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
    type?: "file" | "directory" | "symlink" | "link";
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
  createContainerOptions?: any[];
  containers?: Array<{ Id: string; Labels?: Record<string, string> }>;
  recoveryMode?: boolean;
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
      Config: { Image: "agentor-orchestrator:test", Labels: {},
        ...(options?.recoveryMode ? { Env: ['AGENTOR_INSTANCE_RECOVERY_MODE=true'] } : {}) },
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
      createVolume: async (spec: any) => {
        if (options?.createVolumeError) throw options.createVolumeError;
        if (!options?.createContainerOptions)
          throw new Error("unexpected createVolume");
        options.createContainerOptions.push(spec);
        return {
          inspect: async () => ({ Labels: spec.Labels }),
          remove: async () => undefined,
        };
      },
      createContainer: async (spec: any) => {
        if (!options?.createContainerOptions)
          throw new Error("unexpected createContainer");
        options.createContainerOptions.push(spec);
        return {
          start: async () => undefined,
          putArchive: async () => undefined,
          remove: async () => undefined,
        };
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

async function seedPreservedBackupRecords(prepared: Awaited<ReturnType<typeof fixture>>) {
  const path = join(prepared.dataDir, "admin", "instance-backups.v1.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.artifacts = [{ id: "staging-artifact", userId: prepared.plan.stagingOwnerId },
    { id: "unrelated-artifact", userId: "unrelated-principal" }];
  state.remoteBackups = [{ id: "staging-remote", userId: prepared.plan.stagingOwnerId },
    { id: "unrelated-remote", userId: "unrelated-principal" }];
  await writeFile(path, JSON.stringify(state));
}

async function nativeFixture(root: string, selection: { archived?: boolean; desired?: 'running' | 'stopped'; docker?: boolean; missingKey?: boolean } = {}) {
  const savedKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  const restoreKey = () => {
    if (savedKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
    else process.env.WORKER_CONFIG_ENCRYPTION_KEY = savedKey;
  };
  delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  try {
  const prepared = await fixture(root), sourceDir = join(root, 'source');
  const config = { ...nativeAdapter.loadConfig(), dataDir: sourceDir, containerPrefix: 'agentor-worker' };
  const stamp = '2026-10-05T12:00:00.000Z', installation = randomUUID(), id = randomUUID();
  const worker: WorkerRecord = { id, userId: 'restored-admin', runtimeKind: 'incus-vm',
    displayName: 'Native helper fixture', status: selection.archived ? 'archived' : 'active',
    desiredRuntimeStatus: selection.desired ?? 'stopped', createdAt: stamp, updatedAt: stamp,
    ...(selection.archived ? { archivedAt: stamp } : {}) };
  const workers = new nativeAdapter.WorkerStore(sourceDir); await workers.upsert(worker);
  const originalWorker = workers.get(worker.userId, id)!;
  await writeFile(join(sourceDir, 'backup-installation-id'), installation);
  await writeFile(join(sourceDir, 'auth.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('native-restored')]));
  const configs = new nativeAdapter.WorkerConfigStore(config);
  await configs.markApplied(worker.userId, id, { version: 1, cpuLimit: 1, memoryLimit: '1GiB', dockerEnabled: !!selection.docker,
    userEnv: nativeAdapter.zeroUserEnvVars(worker.userId), capabilitiesJson: [], instructionsJson: [],
    excludedGlobalEnvVarKeys: [], excludedGroupEnvVarKeys: [],
    environmentJson: { dockerEnabled: !!selection.docker, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: worker.displayName, repos: [], initScript: '', gitName: '', gitEmail: '' } });
  if (selection.missingKey) await rm(join(sourceDir, 'worker-config.key'));
  const backupOptions = { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true,
    includeLogs: false, includeLocalBackups: false };
  const data = await createInstanceDataArchive({ dataDir: sourceDir, authSnapshotPath: join(sourceDir, 'auth.db'),
    output: prepared.plan.dataArchive, options: backupOptions });
  const source = { sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64), architecture: 'amd64' as const,
    converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const };
  const descriptors = [];
  for (const role of ['workspace', 'agents'] as const) {
    const name = `agentor-worker-${id}-${role}`, wrapper = role === 'workspace' ? 'workspace' : '.agent-data';
    const stage = join(root, role); await mkdir(join(stage, wrapper), { recursive: true });
    await writeFile(join(stage, wrapper, 'bytes'), Buffer.from([0, 255, 128]));
    const archive = instanceVolumeArchiveName(name), path = join(prepared.unpacked, nativeAdapter.instanceBundleFilename(archive));
    await mkdir(dirname(path), { recursive: true });
    execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-czf', path, wrapper]);
    const size = (await (await import('node:fs/promises')).stat(path)).size;
    descriptors.push({ name, archive, size, sha256: await sha256File(path), ownerId: worker.userId, workerId: id,
      kind: role === 'workspace' ? 'worker-workspace' : 'worker-agent-data',
      runtime: role === 'workspace' ? { kind: 'incus-vm', role, source, dockerData: false } : { kind: 'incus-vm', role, source } });
  }
  const manifest = validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: 2, backupId: 'native-fixture',
    sourceInstallationId: installation, createdByUserId: worker.userId, createdAt: stamp, agentorVersion: 'test',
    storage: { mode: 'volume', containerPrefix: config.containerPrefix }, options: backupOptions,
    dataArchive: { archive: 'data.tar.gz', ...data }, volumes: descriptors,
    plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
    hostMounts: { configuredPaths: [], contentsIncluded: false }, images: { definitions: 0, immutableDigests: [], layersIncluded: false },
    excludedDataPaths: data.excludedDataPaths });
  const plan = { ...prepared.plan, formatVersion: 2, sourceInstallationId: installation, manifest,
    volumes: manifest.volumes.map(volume => ({ ...volume, archive: join(prepared.unpacked, nativeAdapter.instanceBundleFilename(volume.archive)) })) };
  await writeFile(join(prepared.stage, 'restore-plan.json'), JSON.stringify(plan));
  const env = { ...prepared.env, HOSTNAME: 'restore-helper-container', AGENTOR_INSTANCE_RESTORE_NATIVE: 'true',
    CONTAINER_PREFIX: config.containerPrefix, INCUS_ENDPOINT: 'https://native.invalid', INCUS_PROJECT: 'agentor',
    INCUS_CLIENT_CERT_PATH: '/operator/client.crt', INCUS_CLIENT_KEY_PATH: '/operator/client.key', INCUS_SERVER_CERT_PATH: '/operator/server.crt',
    INCUS_NETWORK: 'workers', INCUS_STORAGE_POOL: 'default', INCUS_WORKER_IMAGE: 'approved',
    INCUS_DOCKER_VOLUME_SIZE: '1GiB', INCUS_INTERNAL_GATEWAY_URL: 'http://gateway.invalid:3000' };
  const events: string[] = [], restorers: Array<() => void> = [];
  const patch = (object: any, key: string, value: any) => {
    const old = object[key]; object[key] = value; restorers.push(() => { object[key] = old; });
  };
  const ledger = async () => JSON.parse(await readFile(join(prepared.dataDir, 'admin', 'instance-backups.v1.json'), 'utf8'));
  const installed = async () => { const store = new nativeAdapter.WorkerStore(prepared.dataDir); await store.loadUser(worker.userId); return store.get(worker.userId, id); };
  const incarnation = randomUUID();
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'preflightCanonicalRestore', async (options: any) => {
    expect(options.recreationNonce).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    events.push('preflight');
  });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'createCanonicalRestore', async (options: any) => {
    events.push('create');
    if (!(await installed())?.incusRecreation?.importIncomplete) throw new Error('Missing durable initial import fence');
    return { config: { 'volatile.uuid': incarnation, 'user.agentor.recreation': options.recreationNonce } };
  });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'matchesWorkerIdentity', async () => true);
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'restoreCanonicalArchives', async (_o: unknown, _i: unknown, roots: any, validate: () => Promise<void>) => {
    events.push('extract'); await validate();
    for (const path of Object.values(roots)) if (path) await readFile(path as string);
  });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'finishCanonicalRestore', async (_o: unknown, _i: unknown, validate: () => Promise<void>, mode: string) => {
    events.push('promote-' + mode); await validate();
  });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'remove', async () => { events.push('remove-compute'); });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'rollbackRecreation', async () => {
    events.push('rollback-compute');
    if ((await readFile(join(prepared.dataDir, 'auth.db'))).subarray(16).toString() !== 'native-restored')
      throw new Error('Data rollback preceded native cleanup');
  });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'removeStorage', async () => { events.push('remove-core'); });
  patch(nativeAdapter.IncusWorkerRuntime.prototype, 'start', async () => { events.push('unexpected-worker-start'); throw new Error('No early activation'); });
  return { ...prepared, plan, env, worker: originalWorker, events, patch, ledger, installed,
    run: async (docker: any) => (await importHelper(pathToFileURL(helperPath).href)).runInstanceRestoreHelper({ docker, env, nativeAdapter }),
    cleanup: () => { for (const restore of restorers.reverse()) restore(); restoreKey(); } };
  } catch (error) {
    restoreKey();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
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

  test("applies a verified snapshot, rereads restored job ownership, and restarts the exact container", async () => {
    const prepared = await fixture(root);
    await seedPreservedBackupRecords(prepared);
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
    for (const records of [state.artifacts, state.remoteBackups])
      expect(records.map((record: any) => record.userId)).toEqual(["restored-admin", "unrelated-principal"]);
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

  test("uses a writable constrained helper for volume extraction", async () => {
    const prepared = await fixture(root);
    await writeTarGzip(prepared.plan.dataArchive, [
      {
        name: "auth.db",
        body: Buffer.concat([
          Buffer.from("SQLite format 3\0"),
          Buffer.alloc(128),
        ]),
      },
    ]);
    const volumeArchive = join(prepared.unpacked, "volume-selected.tar.gz");
    await writeTarGzip(volumeArchive, [
      { name: "source/", type: "directory" },
      { name: "source/workspace.txt", body: "workspace" },
    ]);
    prepared.plan.volumes = [{
      name: "agentor-restore-test-volume",
      archive: volumeArchive,
      kind: "worker-workspace",
      workerId: "worker-restore-test",
    }];
    await writeFile(
      join(prepared.stage, "restore-plan.json"),
      JSON.stringify(prepared.plan),
    );
    const createContainerOptions: any[] = [];
    const fake = fakeDocker(
      prepared.dataDir,
      prepared.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR,
      { createContainerOptions },
    );

    const result = await runInjected(prepared, fake.docker);

    expect(result).toMatchObject({ status: "succeeded" });
    const helper = createContainerOptions.find(
      (spec) => spec.Labels?.["agentor.instance-restore-volume-helper"] === "true",
    );
    expect(helper).toBeTruthy();
    expect(helper.HostConfig).toMatchObject({
      NetworkMode: "none",
      ReadonlyRootfs: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 32,
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      Mounts: [{
        Type: "volume",
        Source: "agentor-restore-test-volume",
        Target: "/source",
      }],
    });
    expect(helper.HostConfig.Mounts).toHaveLength(1);
  });

  test("preserves initial staging principal for rollback after migrated ledger reread and failed volume creation", async () => {
    const prepared = await fixture(root);
    await seedPreservedBackupRecords(prepared);
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
      { name: "source/workspace-copy.txt", type: "link", linkname: "source/workspace.txt" },
      {
        name: "source/.venv/bin/python3",
        type: "symlink",
        linkname: "/usr/bin/python3",
      },
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
    // This callback occurs after the post-migration active-job readback. A
    // subsequent failure must not use that observed owner as rollback authority.
    let observedMigratedState: any;
    fake.docker.createVolume = async () => {
      observedMigratedState = JSON.parse(await readFile(join(prepared.dataDir, "admin", "instance-backups.v1.json"), "utf8"));
      throw new Error("synthetic volume creation failure");
    };

    const result = await runInjected(prepared, fake.docker);

    expect(observedMigratedState?.jobs[0].userId).toBe("restored-admin");
    for (const records of [observedMigratedState.artifacts, observedMigratedState.remoteBackups])
      expect(records.map((record: any) => record.userId)).toEqual(["restored-admin", "unrelated-principal"]);
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
    for (const records of [state.artifacts, state.remoteBackups])
      expect(records.map((record: any) => record.userId)).toEqual(["recovery-admin", "unrelated-principal"]);
  });
});

test('native helper uses real encrypted bootstrap/raw codec and commits stopped, running-intent and archived records without activation', async () => {
  for (const selection of [{ desired: 'stopped' }, { desired: 'running' }, { archived: true, desired: 'stopped' }] as const) {
    const root = await mkdtemp(join(tmpdir(), 'native-helper-commit-'));
    const f = await nativeFixture(root, selection);
    try {
      const fake = fakeDocker(f.dataDir, f.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR, { recoveryMode: true });
      const result = await f.run(fake.docker);
      expect(result).toEqual({ status: 'succeeded' });
      expect(fake.state).toMatchObject({ stops: 1, starts: 1, running: true });
      const record = await f.installed();
      expect(record).toEqual(f.worker); expect(record?.incusRecreation).toBeUndefined();
      expect((await f.ledger()).jobs[0]).toMatchObject({ status: 'succeeded', userId: f.worker.userId });
      expect(f.events.filter(event => event === 'preflight')).toHaveLength(3);
      expect(f.events).toContain('create'); expect(f.events).toContain('extract'); expect(f.events).toContain('promote-stopped');
      expect(f.events.includes('remove-compute')).toBe('archived' in selection && selection.archived);
      expect(f.events).not.toContain('unexpected-worker-start'); expect(f.events).not.toContain('rollback-compute');
    } finally { f.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
});

test('native helper rejects missing source config key and omitted enabled-Docker data before stopping or allocating', async () => {
  for (const selection of [{ missingKey: true }, { docker: true }]) {
    const root = await mkdtemp(join(tmpdir(), 'native-helper-preflight-'));
    const f = await nativeFixture(root, selection);
    try {
      const fake = fakeDocker(f.dataDir, f.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR, { recoveryMode: true });
      const result = await f.run(fake.docker);
      expect(result.status).toBe('failed'); expect(fake.state).toMatchObject({ stops: 0, starts: 0, running: true });
      expect(f.events).toEqual([]);
      expect((await readFile(join(f.dataDir, 'auth.db'))).subarray(16).toString()).toBe('old');
      if (selection.missingKey) await expect(readFile(join(f.stage, 'prepared-data', 'worker-config.key')))
        .rejects.toMatchObject({ code: 'ENOENT' });
      else expect(result.code).toBe('INSTANCE_RESTORE_INVALID_ARCHIVE');
    } finally { f.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
});

test('acknowledged native cleanup precedes control-plane rollback after a later legacy-volume failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-helper-rollback-'));
  const f = await nativeFixture(root);
  try {
    const name = 'legacy-worker-volume', archive = instanceVolumeArchiveName(name), path = join(f.unpacked, nativeAdapter.instanceBundleFilename(archive));
    await writeTarGzip(path, [{ name: 'source', type: 'directory' }, { name: 'source/data', body: 'legacy' }]);
    const descriptor = { name, archive, kind: 'worker-workspace' as const, sha256: await sha256File(path), size: 100, workerId: 'legacy-worker' };
    f.plan.manifest.volumes.push(descriptor);
    f.plan.volumes.push({ ...descriptor, archive: path } as any);
    await writeFile(join(f.stage, 'restore-plan.json'), JSON.stringify(f.plan));
    const fake = fakeDocker(f.dataDir, f.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR,
      { recoveryMode: true, createVolumeError: new Error('Synthetic later legacy-volume failure') });
    const result = await f.run(fake.docker);
    expect(result).toMatchObject({ status: 'failed', code: 'INSTANCE_RESTORE_APPLY_FAILED' });
    expect(f.events.indexOf('rollback-compute')).toBeGreaterThan(f.events.indexOf('promote-stopped'));
    expect(f.events.indexOf('remove-core')).toBeGreaterThan(f.events.indexOf('rollback-compute'));
    expect((await readFile(join(f.dataDir, 'auth.db'))).subarray(16).toString()).toBe('old');
    expect(await f.installed()).toBeUndefined();
    expect((await f.ledger()).jobs[0]).toMatchObject({ status: 'failed', userId: 'recovery-admin' });
    expect(fake.state).toMatchObject({ starts: 1, running: true });
  } finally { f.cleanup(); await rm(root, { recursive: true, force: true }); }
});

test('uncertain completion clear is refenced; uncertain refence acknowledgement leaves exact target stopped', async () => {
  for (const lostRefence of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), 'native-helper-refence-'));
    const f = await nativeFixture(root);
    try {
      const original = nativeAdapter.WorkerStore.prototype.upsert;
      let completionLost = false, committedBeforeClear = false, refenceObserved = false;
      f.patch(nativeAdapter.WorkerStore.prototype, 'upsert', async function(this: any, record: WorkerRecord) {
        const completion = this.dataDir === f.dataDir && record.id === f.worker.id && !record.incusRecreation;
        if (completion) committedBeforeClear = (await f.ledger()).jobs[0].status === 'succeeded';
        await original.call(this, record);
        if (completion && !completionLost) { completionLost = true; throw new Error('Lost clear acknowledgement'); }
        if (completionLost && record.incusRecreation) {
          refenceObserved = true;
          if (lostRefence) throw new Error('Lost refence acknowledgement');
        }
      });
      const fake = fakeDocker(f.dataDir, f.env.AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR, { recoveryMode: true });
      const result = await f.run(fake.docker);
      expect(result.status).toBe('failed'); expect(committedBeforeClear).toBe(true);
      expect(completionLost).toBe(true); expect(refenceObserved).toBe(true);
      expect((await f.installed())?.incusRecreation).toMatchObject({ initialCreate: true, importIncomplete: true });
      expect(fake.state).toMatchObject({ stops: 1, starts: lostRefence ? 0 : 1, running: !lostRefence });
      expect(f.events).not.toContain('unexpected-worker-start');
    } finally { f.cleanup(); await rm(root, { recursive: true, force: true }); }
  }
});
