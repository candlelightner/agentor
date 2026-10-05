import Docker from "dockerode";
import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
} from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { createGunzip } from "node:zlib";
import * as tar from "tar-stream";

// This file intentionally is not part of the running Nitro application.  The
// orchestrator launches it in a short-lived, network-disabled container so it
// can stop and restart the exact orchestrator container without asking a live
// process to replace its own database and DATA_DIR underneath itself.

const MAX_PLAN_BYTES = 4 * 1024 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024 * 1024;
const MAX_ENTRIES = 2_000_000;
const MAX_VOLUMES = 100_000;
const VOLUME_KINDS = new Set([
  "worker-workspace",
  "worker-agent-data",
  "worker-dind",
  "admin-workspace",
  "admin-agent-data",
  "persistent-path",
  "traefik-certificates",
]);
const RESERVED_TOP_LEVEL = new Set([
  "instance-backup-artifacts",
  "instance-restore-staging",
  "instance-restore-rollback",
]);
const JOB_STORE_RELATIVE = "admin/instance-backups.v1.json";
const HOST_MOUNT_CATALOG_RELATIVE = "admin/host-mount-paths.v1.json";

// Initialize before the CLI's top-level await invokes the helper. Module
// import tests alone do not exercise this entrypoint ordering.
const NATIVE_OPERATOR_FIELDS = {
  containerPrefix: 'CONTAINER_PREFIX', incusEndpoint: 'INCUS_ENDPOINT', incusProject: 'INCUS_PROJECT',
  incusClientCertPath: 'INCUS_CLIENT_CERT_PATH', incusClientKeyPath: 'INCUS_CLIENT_KEY_PATH',
  incusServerCertPath: 'INCUS_SERVER_CERT_PATH', incusNetwork: 'INCUS_NETWORK', incusStoragePool: 'INCUS_STORAGE_POOL',
  incusWorkerImage: 'INCUS_WORKER_IMAGE', incusDockerVolumeSize: 'INCUS_DOCKER_VOLUME_SIZE',
  incusInternalGatewayUrl: 'INCUS_INTERNAL_GATEWAY_URL', incusNetworkHostEndpoint: 'INCUS_NETWORK_HOST_ENDPOINT',
  incusNetworkHostServerCertPath: 'INCUS_NETWORK_HOST_SERVER_CERT_PATH',
};

class SafeRestoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "SafeRestoreError";
    this.code = code;
  }
}

let context;
let jobState;
let target;
let targetStopped = false;
let mutationStarted = false;
let restoreApplied = false;
let originalDataNames = [];
let movedOriginalNames = [];
let installedDataNames = [];
let createdVolumes = [];
let backupStateOwnerMigrated = false;
let finalFailure;
let failureCode;
let retryable = true;
let operationCancelled = false;
let activeEnvironment = process.env;
let nativeRestore;

/** Execute one restore. The injected Docker facade exists only to make the
 * stop/apply/restart and rollback boundaries testable without granting the
 * test runner a real Docker socket; the production entrypoint always uses a
 * fresh dockerode client and an explicit four-variable launch environment. */
export async function runInstanceRestoreHelper(options = {}) {
  resetRunState();
  activeEnvironment = options.env ?? process.env;
  let docker;
  try {
    context = await loadContext();
    jobState = await readJobStore(context.dataDir, context.jobId);
    if (jobState.job.userId !== context.plan.stagingOwnerId)
      throw new SafeRestoreError("Restore job ownership does not match its launch plan", "INSTANCE_RESTORE_JOB_STATE_INVALID");
    await assertJobStillActive();
    await updateJob("running", "restore-preparing", 72, "Restore helper is validating the staged snapshot before stopping Agentor.");

    await prepareDataArchive(context);
    for (const volume of context.plan.volumes.filter(volume => !volume.runtime))
      await validateVolumeArchive(volume.archive);

    if (context.plan.formatVersion === 2)
      nativeRestore = await prepareNativeRestore(options.nativeAdapter);

    docker = options.docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
    target = docker.getContainer(context.orchestratorId);
    const targetMount = await validateContainerBoundary(docker, target, context.dataDir);
    await assertVolumesAbsent(docker, context.plan.volumes.filter(volume => !volume.runtime));
    if (nativeRestore) {
      nativeRestore.targetMount = targetMount;
      await preflightNativeRestore();
    }
    await assertJobStillActive();

    await updateJob("running", "restore-stopping", 76, "Staged snapshot validated. Stopping the exact orchestrator container for atomic restore.");
    await assertJobStillActive();
    // Set the restart obligation before the Docker call. A transport failure
    // can occur after Docker has already stopped the container; assigning only
    // after the response would strand Agentor offline in that ambiguity.
    targetStopped = true;
    await target.stop({ t: 30 });
    const stopped = await target.inspect();
    if (stopped.State?.Running)
      throw new SafeRestoreError("The orchestrator did not stop cleanly", "INSTANCE_RESTORE_STOP_FAILED");

    // A named volume could have appeared after preflight while the orchestrator
    // was still live. Recheck after shutdown, immediately before mutation.
    await assertJobStillActive();
    await assertRecoveryDestinationStillEmpty(
      docker,
      context.dataDir,
      context.orchestratorId,
    );
    await assertVolumesAbsent(docker, context.plan.volumes.filter(volume => !volume.runtime));
    if (nativeRestore) await preflightNativeRestore();
    await updateJob("running", "restore-applying", 82, "Orchestrator stopped. Applying the verified control-plane snapshot and selected volumes.");

    mutationStarted = true;
    originalDataNames = await readdir(context.dataDir);
    await moveCurrentDataToRollback(context, originalDataNames, movedOriginalNames);
    await installPreparedData(context, installedDataNames);
    reassignPreservedBackupState(
      jobState,
      jobState.job.userId,
      context.plan.restoredOwnerId,
    );
    backupStateOwnerMigrated = true;
    await writeJobStore(context.dataDir, jobState.state);
    await assertJobStillActive();

    if (nativeRestore) await applyNativeRestore(docker);
    for (const volume of context.plan.volumes.filter(volume => !volume.runtime))
      await restoreVolume(docker, target, context, volume);

    await updateJob("succeeded", "complete", 100, "Instance restore completed. Agentor is restarting with the restored control plane.");
    if (nativeRestore) {
      nativeRestore.completionStarted = true;
      await completeNativeRestore();
    }
    restoreApplied = true;
    if (nativeRestore) {
      // Canonical data, original intent and terminal ledger are committed.
      // A cleanup-only failure must not undo a successful native restore.
      await removeRollback(context).catch(() => {
        console.warn('[instance-restore] Restore committed; rollback-directory cleanup requires operator follow-up.');
      });
    } else await removeRollback(context);
  } catch (error) {
    operationCancelled =
      error instanceof SafeRestoreError &&
      error.code === "INSTANCE_RESTORE_CANCELLED" &&
      !mutationStarted;
    if (operationCancelled) {
      finalFailure = undefined;
      failureCode = undefined;
    } else {
      finalFailure = safeFailureMessage(error);
      failureCode = error instanceof SafeRestoreError
        ? error.code
        : "INSTANCE_RESTORE_APPLY_FAILED";
    }

    if (!operationCancelled && mutationStarted && context) {
      const rollbackErrors = [];
      let dataRolledBack = false;
      // Restored records carry the native import fence and exact installed
      // authority. Never remove them while a native acknowledgement is unknown.
      let nativeSettled = true;
      try {
        if (nativeRestore?.completionStarted) await refenceNativeCompletion();
        if (nativeRestore) await rollbackNativeRestore();
      }
      catch (rollbackError) {
        nativeSettled = false;
        rollbackErrors.push(safeFailureMessage(rollbackError));
      }
      try {
        if (!nativeSettled) throw new Error('Unsettled native authority retains installed control-plane and rollback data');
        await rollbackData(
          context,
          originalDataNames,
          movedOriginalNames,
          installedDataNames,
        );
        dataRolledBack = true;
      } catch (rollbackError) {
        rollbackErrors.push(safeFailureMessage(rollbackError));
      }
      try {
        if (!docker) throw new Error("Docker restore client is unavailable");
        await rollbackVolumes(docker, context, createdVolumes);
      } catch (rollbackError) {
        rollbackErrors.push(safeFailureMessage(rollbackError));
      }
      if (rollbackErrors.length) {
        failureCode = "INSTANCE_RESTORE_ROLLBACK_INCOMPLETE";
        retryable = false;
        finalFailure = `${finalFailure} Automatic rollback was incomplete; inspect the destination before retrying.`;
      }
      if (dataRolledBack && backupStateOwnerMigrated) {
        reassignPreservedBackupState(
          jobState,
          context.plan.restoredOwnerId,
          jobState.originalOwnerId,
        );
        backupStateOwnerMigrated = false;
      }
    }

    if (!operationCancelled && context && jobState) {
      await updateJob(
        "failed",
        failureCode === "INSTANCE_RESTORE_ROLLBACK_INCOMPLETE"
          ? "rollback-incomplete"
          : "failed",
        100,
        finalFailure,
        failureCode,
        retryable,
      ).catch(() => undefined);
    }
  } finally {
    if (targetStopped && target && nativeRestore?.restartSafe !== false) {
      try {
        const current = await target.inspect().catch(() => undefined);
        if (!current?.State?.Running) {
          try {
            await target.start();
          } catch (error) {
            // Docker reports 304 when the target became running between the
            // inspect and start calls. That satisfies the restart obligation.
            if (error?.statusCode !== 304) throw error;
          }
        }
        targetStopped = false;
      } catch {
        restoreApplied = false;
        finalFailure = "The restore helper could not restart the exact orchestrator container. Start that container manually after inspecting the restore state.";
        failureCode = "INSTANCE_RESTORE_RESTART_FAILED";
        retryable = false;
        if (context && jobState)
          await updateJob(
            "failed",
            "restart-failed",
            100,
            finalFailure,
            failureCode,
            retryable,
          ).catch(() => undefined);
      }
    }
  }

  if (operationCancelled) return { status: "cancelled" };
  if (finalFailure)
    return {
      status: "failed",
      code: failureCode ?? "INSTANCE_RESTORE_FAILED",
      message: finalFailure,
      retryable,
    };
  return { status: "succeeded" };
}

function resetRunState() {
  context = undefined;
  jobState = undefined;
  target = undefined;
  targetStopped = false;
  mutationStarted = false;
  restoreApplied = false;
  originalDataNames = [];
  movedOriginalNames = [];
  installedDataNames = [];
  createdVolumes = [];
  backupStateOwnerMigrated = false;
  finalFailure = undefined;
  failureCode = undefined;
  retryable = true;
  operationCancelled = false;
  nativeRestore = undefined;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const outcome = await runInstanceRestoreHelper();
  if (outcome.status === "failed") {
    // Keep helper output deliberately terse: plans, environment variables,
    // provider metadata, archive contents, and recovery material are never
    // written to Docker logs.
    console.error(`[instance-restore] ${outcome.code}: ${outcome.message}`);
    process.exitCode = 1;
  } else if (outcome.status === "succeeded") {
    console.log("[instance-restore] Restore applied and orchestrator restart requested.");
  }
}

async function loadContext() {
  const jobId = requiredEnv("AGENTOR_INSTANCE_RESTORE_JOB");
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(jobId))
    throw new SafeRestoreError("Invalid restore job identity", "INSTANCE_RESTORE_INVALID_CONTEXT");
  const dataDir = canonicalAbsolute(requiredEnv("AGENTOR_INSTANCE_RESTORE_DATA_DIR"));
  if (dataDir === "/")
    throw new SafeRestoreError("The host root cannot be used as Agentor DATA_DIR", "INSTANCE_RESTORE_INVALID_CONTEXT");
  const expectedStage = join(dataDir, "instance-restore-staging", `restore-${jobId}`);
  const stage = canonicalAbsolute(requiredEnv("AGENTOR_INSTANCE_RESTORE_STAGE"));
  if (stage !== expectedStage)
    throw new SafeRestoreError("Restore staging is outside the expected job boundary", "INSTANCE_RESTORE_INVALID_CONTEXT");
  const orchestratorId = requiredEnv("AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR");
  if (!/^[a-f0-9]{64}$/i.test(orchestratorId))
    throw new SafeRestoreError("Invalid orchestrator container identity", "INSTANCE_RESTORE_INVALID_CONTEXT");

  await assertDirectoryNoFollow(dataDir);
  await assertDirectoryNoFollow(join(dataDir, "instance-restore-staging"));
  await assertDirectoryNoFollow(stage);
  if ((await realpath(stage)) !== stage)
    throw new SafeRestoreError("Restore staging resolves outside its expected boundary", "INSTANCE_RESTORE_INVALID_CONTEXT");

  const planPath = join(stage, "restore-plan.json");
  const parsed = await readBoundedJson(planPath, MAX_PLAN_BYTES, "restore plan");
  const plan = validatePlan(parsed, { jobId, stage });
  const unpacked = join(stage, "unpacked");
  await assertDirectoryNoFollow(unpacked);
  if ((await realpath(unpacked)) !== unpacked)
    throw new SafeRestoreError("Restore payload staging resolves outside its expected boundary", "INSTANCE_RESTORE_INVALID_CONTEXT");
  return {
    jobId,
    dataDir,
    stage,
    orchestratorId: orchestratorId.toLowerCase(),
    plan,
    preparedData: join(stage, "prepared-data"),
    rollbackRoot: join(dataDir, "instance-restore-rollback", jobId),
  };
}

function validatePlan(value, expected) {
  if (!value || value.version !== 1 || value.jobId !== expected.jobId)
    throw new SafeRestoreError("Invalid restore plan", "INSTANCE_RESTORE_INVALID_PLAN");
  // Missing format preserves historical v1 plans. A native control-plane-only
  // bundle must never pass through this Docker-only helper either.
  const native = value.formatVersion === 2 && activeEnvironment.AGENTOR_INSTANCE_RESTORE_NATIVE === 'true';
  if (!native && (value.formatVersion !== undefined && value.formatVersion !== 1 ||
      Array.isArray(value.volumes) && value.volumes.some(entry => entry && entry.runtime !== undefined)))
    throw new SafeRestoreError("Native whole-instance restore requires the native controlled helper", "INSTANCE_RESTORE_NATIVE_UNAVAILABLE");
  if (typeof value.restoreHostMountPolicies !== "boolean")
    throw new SafeRestoreError("Invalid host-mount restore selection", "INSTANCE_RESTORE_INVALID_PLAN");
  if (typeof value.sourceInstallationId !== "string" || !value.sourceInstallationId || value.sourceInstallationId.length > 200)
    throw new SafeRestoreError("Invalid source installation identity", "INSTANCE_RESTORE_INVALID_PLAN");
  if (!safeId(value.restoredOwnerId))
    throw new SafeRestoreError("Invalid restored owner identity", "INSTANCE_RESTORE_INVALID_PLAN");
  if (!safeId(value.stagingOwnerId))
    throw new SafeRestoreError("Invalid staging owner identity", "INSTANCE_RESTORE_INVALID_PLAN");
  const unpacked = join(expected.stage, "unpacked");
  if (value.dataArchive !== join(unpacked, "data.tar.gz"))
    throw new SafeRestoreError("Data archive is outside restore staging", "INSTANCE_RESTORE_INVALID_PLAN");
  if (!Array.isArray(value.volumes) || value.volumes.length > MAX_VOLUMES)
    throw new SafeRestoreError("Invalid restore volume selection", "INSTANCE_RESTORE_INVALID_PLAN");
  const names = new Set();
  const archives = new Set();
  const volumes = value.volumes.map((entry) => {
    if (
      !entry ||
      !dockerVolumeName(entry.name) ||
      typeof entry.archive !== "string" ||
      !VOLUME_KINDS.has(entry.kind) ||
      (entry.workerId !== undefined && !safeId(entry.workerId))
    )
      throw new SafeRestoreError("Invalid restore volume entry", "INSTANCE_RESTORE_INVALID_PLAN");
    const archive = canonicalAbsolute(entry.archive);
    if (!inside(unpacked, archive) || !/^volume-[A-Za-z0-9_-]{1,512}\.tar\.gz$/.test(archive.slice(unpacked.length + 1)))
      throw new SafeRestoreError("Volume archive is outside restore staging", "INSTANCE_RESTORE_INVALID_PLAN");
    if (names.has(entry.name) || archives.has(archive))
      throw new SafeRestoreError("Restore plan contains duplicate volumes", "INSTANCE_RESTORE_INVALID_PLAN");
    names.add(entry.name);
    archives.add(archive);
    return {
      name: entry.name,
      archive,
      kind: entry.kind,
      ...(entry.workerId ? { workerId: entry.workerId } : {}),
      ...(native && entry.runtime ? { runtime: entry.runtime, ownerId: entry.ownerId } : {}),
    };
  });
  return {
    version: 1,
    jobId: expected.jobId,
    dataArchive: value.dataArchive,
    volumes,
    restoreHostMountPolicies: value.restoreHostMountPolicies,
    sourceInstallationId: value.sourceInstallationId,
    restoredOwnerId: value.restoredOwnerId,
    stagingOwnerId: value.stagingOwnerId,
    ...(native ? { formatVersion: 2, manifest: value.manifest } : {}),
  };
}

// Operator launch values only. The authenticated archive is descriptive and
// cannot choose a daemon, project, credential, host source or current VM IP.
async function prepareNativeRestore(injectedAdapter) {
  const adapter = injectedAdapter ?? await import(new URL('./instance-restore-native/index.mjs', import.meta.url).href);
  const config = { ...adapter.loadConfig(), dataDir: context.preparedData, incusEnabled: true };
  for (const [field, key] of Object.entries(NATIVE_OPERATOR_FIELDS)) config[field] = activeEnvironment[key] ?? '';
  if (config.containerPrefix !== context.plan.manifest?.storage?.containerPrefix ||
      context.plan.manifest?.sourceInstallationId !== context.plan.sourceInstallationId ||
      await adapter.readBackupInstallationId(context.preparedData) !== context.plan.sourceInstallationId)
    throw new SafeRestoreError('Native source installation or naming authority disagrees with the staged snapshot', 'INSTANCE_RESTORE_INVALID_PLAN');
  // Never let ordinary decrypt's first-use key generation substitute for a
  // missing source key. The override is passed only from current operator config.
  if (!activeEnvironment.WORKER_CONFIG_ENCRYPTION_KEY)
    await assertRegularNoFollow(join(context.preparedData, 'worker-config.key'), 1024);
  if ((activeEnvironment.WORKER_CONFIG_ENCRYPTION_KEY ?? '') !== (process.env.WORKER_CONFIG_ENCRYPTION_KEY ?? ''))
    throw new SafeRestoreError('Worker configuration key launch boundary disagrees', 'INSTANCE_RESTORE_INVALID_CONTEXT');
  const workers = new adapter.WorkerStore(context.preparedData), managed = new adapter.ManagedVolumeStore(context.preparedData);
  await Promise.all([workers.init(), managed.init()]);
  // Store init isolates bad owners for normal startup. Restore must reject
  // them rather than treating quarantined records as an empty source.
  const owners = await readdir(join(context.preparedData, 'users')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const owner of owners) {
    if (!safeId(owner)) throw new SafeRestoreError('Invalid staged account identity', 'INSTANCE_RESTORE_INVALID_ARCHIVE');
    await Promise.all([workers.loadUser(owner), managed.loadUser(owner)]);
  }
  const groups = adapter.planInstanceNativeRestore(context.plan.manifest, workers.list(), managed.list(), true);
  const configStore = new adapter.WorkerConfigStore(config);
  const archives = new Map(), prepared = [];
  const scratch = join(context.stage, 'native-archives');
  await mkdir(scratch, { mode: 0o700, recursive: false });
  for (const volume of context.plan.volumes.filter(volume => volume.runtime)) {
    const descriptor = context.plan.manifest.volumes.find(item => item.name === volume.name);
    if (!descriptor || !isDeepStrictEqual(descriptor.runtime, volume.runtime) || descriptor.ownerId !== volume.ownerId ||
        descriptor.kind !== volume.kind || descriptor.workerId !== volume.workerId ||
        volume.archive !== join(context.stage, 'unpacked', adapter.instanceBundleFilename(descriptor.archive)))
      throw new SafeRestoreError('Native payload does not match its authenticated descriptor', 'INSTANCE_RESTORE_INVALID_PLAN');
    const raw = await adapter.prepareInstanceNativeVolumeArchive(volume.archive, descriptor, scratch);
    archives.set(volume.name, raw.archivePath);
  }
  if (context.plan.manifest.volumes.filter(volume => volume.runtime).some(volume => !archives.has(volume.name)))
    throw new SafeRestoreError('Canonical native payload selection is incomplete', 'INSTANCE_RESTORE_INVALID_PLAN');
  for (const group of groups) {
    await assertJobStillActive();
    const nonce = randomBytes(16).toString('hex');
    const bootstrap = group.worker ? await configStore.resolveAppliedBootstrap(group.userId, group.workerId) : undefined;
    if (group.worker && !bootstrap) throw new SafeRestoreError('Applied native worker configuration is unavailable', 'INSTANCE_RESTORE_NATIVE_CONFIG_MISSING');
    if (bootstrap && (bootstrap.dockerEnabled || bootstrap.environmentJson.dockerEnabled) && !group.core.docker)
      throw new SafeRestoreError('Docker-enabled native worker has no canonical Docker payload', 'INSTANCE_RESTORE_INVALID_ARCHIVE');
    const options = {
      ...(bootstrap ?? { userEnv: adapter.zeroUserEnvVars(group.userId), capabilitiesJson: [], instructionsJson: [], dockerEnabled: false,
        environmentJson: { dockerEnabled: false, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
          exposeApis: { portMappings: false, domainMappings: false, usage: false } },
        workerJson: { id: group.workerId, displayName: '', repos: [], initScript: '', gitName: '', gitEmail: '' } }),
      id: group.workerId, userId: group.userId, containerName: config.containerPrefix + '-' + group.workerId,
      start: false, recreationNonce: nonce, mounts: group.worker?.mounts,
      managedVolumes: group.managed.filter(item => item.record.attached).map(item => {
        const pending = { ...item.record, seeded: false, state: 'pending' }; delete pending.operation; return pending;
      }),
    };
    prepared.push({ group, options, receipt: { attempted: false, unsettled: false,
      marker: { nonce, initialCreate: true, importIncomplete: true }, volumes: new Map() } });
  }
  return { adapter, config, archives, prepared };
}

async function preflightNativeRestore() {
  await assertJobStillActive();
  const runtime = new nativeRestore.adapter.IncusWorkerRuntime(nativeRestore.config);
  for (const item of nativeRestore.prepared) {
    const detached = item.group.managed.filter(entry => !entry.record.attached).map(entry => {
      const pending = { ...entry.record, seeded: false, state: 'pending' }; delete pending.operation; return pending;
    });
    await runtime.preflightCanonicalRestore(item.options, item.group.source, detached);
    await assertJobStillActive();
  }
}

async function applyNativeRestore(docker) {
  const { adapter } = nativeRestore;
  // Do not reuse the preflight runtime: its installation identity belonged to
  // prepared-data, which has now moved. No identity/key is manufactured here.
  nativeRestore.config = { ...nativeRestore.config, dataDir: context.dataDir };
  if (await adapter.readBackupInstallationId(context.dataDir) !== context.plan.sourceInstallationId)
    throw new SafeRestoreError('Installed native identity changed', 'INSTANCE_RESTORE_INVALID_CONTEXT');
  const storage = new adapter.StorageManager(docker, nativeRestore.config);
  const mount = nativeRestore.targetMount;
  if (!mount?.Source || !isAbsolute(mount.Source))
    throw new SafeRestoreError('Authoritative host data path is unavailable', 'INSTANCE_RESTORE_INVALID_CONTEXT');
  storage.dataHostPath = mount.Source; storage.dataRef = mount.Type === 'bind' ? mount.Source : mount.Name;
  storage.mode = mount.Type === 'bind' ? 'directory' : 'volume';
  for (const item of nativeRestore.prepared) {
    if (item.group.worker) item.options.storageManager = storage;
    await adapter.applyInstanceNativeRestoreGroup({ config: nativeRestore.config, group: item.group, options: item.options,
      archives: nativeRestore.archives, receipt: item.receipt, validateJob: assertJobStillActive });
  }
}

async function completeNativeRestore() {
  const { adapter, config } = nativeRestore;
  for (const item of nativeRestore.prepared) {
    if (!item.group.worker) continue;
    const state = await readBoundedJson(join(context.dataDir, JOB_STORE_RELATIVE), MAX_STORE_BYTES, 'restore job store');
    const job = state.jobs?.find(entry => entry?.id === context.jobId);
    if (job?.userId !== context.plan.restoredOwnerId || job.operation !== 'restore' || job.status !== 'succeeded' || job.phase !== 'complete')
      throw new SafeRestoreError('Native terminal completion ledger changed', 'INSTANCE_RESTORE_JOB_STATE_INVALID');
    const store = new adapter.WorkerStore(config.dataDir); await store.loadUser(item.group.userId);
    if (!isDeepStrictEqual(store.get(item.group.userId, item.group.workerId), item.receipt.worker) || item.receipt.unsettled)
      throw new SafeRestoreError('Native completion authority changed', 'INSTANCE_RESTORE_NATIVE_UNSETTLED');
    // Exclusive helper owns this stopped whole-job fence. Preserve original
    // archive/desired intent, not initial-import rollback's deletion semantics.
    await store.upsert(item.group.worker);
    item.receipt.worker = store.get(item.group.userId, item.group.workerId);
  }
}

async function refenceNativeCompletion() {
  // Completion failure may have cleared only a prefix of ordinary worker
  // fences. Restore the SAME acknowledged import marker before restarting.
  // If even that write is uncertain, leave the exact orchestrator stopped.
  nativeRestore.restartSafe = false;
  const { adapter, config } = nativeRestore;
  for (const item of nativeRestore.prepared) {
    if (!item.group.worker) continue;
    const store = new adapter.WorkerStore(config.dataDir); await store.loadUser(item.group.userId);
    const current = store.get(item.group.userId, item.group.workerId);
    if (!isDeepStrictEqual(current, item.receipt.worker) && !isDeepStrictEqual(current, item.group.worker))
      throw new SafeRestoreError('Native completion recovery record changed', 'INSTANCE_RESTORE_NATIVE_UNSETTLED');
    await store.upsert({ ...item.group.worker, status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: item.receipt.marker });
    const verified = new adapter.WorkerStore(config.dataDir); await verified.loadUser(item.group.userId);
    item.receipt.worker = verified.get(item.group.userId, item.group.workerId);
    if (!isDeepStrictEqual(item.receipt.worker?.incusRecreation, item.receipt.marker))
      throw new SafeRestoreError('Native completion recovery fence is unconfirmed', 'INSTANCE_RESTORE_NATIVE_UNSETTLED');
  }
  nativeRestore.restartSafe = true;
}

async function rollbackNativeRestore() {
  for (const item of [...nativeRestore.prepared].reverse())
    await nativeRestore.adapter.rollbackInstanceNativeRestoreGroup(nativeRestore.config, item.group, item.options,
      item.receipt, assertJobStillActive);
}

async function prepareDataArchive(input) {
  await assertRegularNoFollow(input.plan.dataArchive, MAX_ARCHIVE_BYTES);
  await rm(input.preparedData, { recursive: true, force: true });
  await mkdir(input.preparedData, { recursive: false, mode: 0o700 });
  try {
    const result = await extractDataArchive(input.plan.dataArchive, input.preparedData);
    if (!result.authDb)
      throw new SafeRestoreError("The instance data archive has no authentication database", "INSTANCE_RESTORE_INVALID_ARCHIVE");
    await verifySqliteHeader(join(input.preparedData, "auth.db"));
    if (!input.plan.restoreHostMountPolicies)
      await omitHostMountPolicies(input.preparedData);
  } catch (error) {
    await rm(input.preparedData, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function extractDataArchive(archive, destination) {
  let expandedBytes = 0;
  let entries = 0;
  let totalPayloadBytes = 0;
  let authDb = false;
  const kinds = new Map();
  const directoryMetadata = [];
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += chunk.length;
      callback(
        expandedBytes > MAX_EXPANDED_BYTES
          ? new SafeRestoreError("Instance data archive exceeds the expanded-size limit", "INSTANCE_RESTORE_INVALID_ARCHIVE")
          : null,
        chunk,
      );
    },
  });
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    void handleDataEntry(header, stream, destination, kinds, directoryMetadata)
      .then((result) => {
        entries += 1;
        totalPayloadBytes += result.size;
        if (entries > MAX_ENTRIES || totalPayloadBytes > MAX_EXPANDED_BYTES)
          throw new SafeRestoreError("Instance data archive exceeds its extraction limits", "INSTANCE_RESTORE_INVALID_ARCHIVE");
        if (result.name === "auth.db" && result.kind === "file") authDb = true;
        next();
      })
      .catch((error) => {
        stream.resume();
        next(error instanceof Error ? error : new Error("Invalid instance archive entry"));
      });
  });
  await pipeline(createReadStream(archive), createGunzip(), counter, extract);
  for (const item of directoryMetadata.sort((left, right) => right.name.split("/").length - left.name.split("/").length))
    await applyMetadata(join(destination, ...item.name.split("/")), item.header, false);
  return { authDb };
}

async function handleDataEntry(header, stream, destination, kinds, directoryMetadata) {
  const name = safeTarName(header.name);
  const kind = entryKind(header.type);
  if (!kind || kind === "hardlink")
    throw new SafeRestoreError("Instance data archive contains a special entry", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  if (RESERVED_TOP_LEVEL.has(name.split("/")[0]) || name === JOB_STORE_RELATIVE)
    throw new SafeRestoreError("Instance data archive uses a reserved recovery path", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  assertTreeSafe(kinds, name, kind);
  assertHeader(header, kind);
  kinds.set(name, kind);
  const targetPath = join(destination, ...name.split("/"));
  await ensureParentsNoFollow(destination, name);

  if (kind === "directory") {
    await mkdir(targetPath, { mode: safeMode(header.mode), recursive: false }).catch(async (error) => {
      if (error?.code !== "EEXIST") throw error;
      await assertDirectoryNoFollow(targetPath);
    });
    directoryMetadata.push({ name, header });
    await consume(stream);
    return { name, kind, size: 0 };
  }
  await assertAbsent(targetPath);
  if (kind === "symlink") {
    assertContainedSymlink(name, header.linkname);
    await symlink(header.linkname, targetPath);
    if (validOwner(header.uid) && validOwner(header.gid))
      await lchown(targetPath, header.uid, header.gid);
    await consume(stream);
    return { name, kind, size: 0 };
  }

  const size = safeSize(header.size);
  const file = await open(
    targetPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    safeMode(header.mode),
  );
  try {
    let written = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await file.write(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (!result.bytesWritten)
          throw new SafeRestoreError("Instance archive file write made no progress", "INSTANCE_RESTORE_APPLY_FAILED");
        offset += result.bytesWritten;
        written += result.bytesWritten;
        if (written > size)
          throw new SafeRestoreError("Instance archive entry exceeded its declared size", "INSTANCE_RESTORE_INVALID_ARCHIVE");
      }
    }
    if (written !== size)
      throw new SafeRestoreError("Instance archive entry did not match its declared size", "INSTANCE_RESTORE_INVALID_ARCHIVE");
    await file.sync();
  } finally {
    await file.close().catch(() => undefined);
  }
  await applyMetadata(targetPath, header, false);
  return { name, kind, size };
}

async function validateVolumeArchive(archive) {
  await assertRegularNoFollow(archive, MAX_ARCHIVE_BYTES);
  let expandedBytes = 0;
  let entries = 0;
  let payloadBytes = 0;
  let sourceRoot = false;
  const kinds = new Map();
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += chunk.length;
      callback(
        expandedBytes > MAX_EXPANDED_BYTES
          ? new SafeRestoreError("Volume archive exceeds the expanded-size limit", "INSTANCE_RESTORE_INVALID_ARCHIVE")
          : null,
        chunk,
      );
    },
  });
  const extract = tar.extract();
  extract.on("entry", (header, stream, next) => {
    try {
      const name = safeTarName(header.name);
      const kind = entryKind(header.type);
      if (!kind || (name !== "source" && !name.startsWith("source/")))
        throw new SafeRestoreError("Volume archive escapes its mounted source root", "INSTANCE_RESTORE_INVALID_ARCHIVE");
      assertTreeSafe(kinds, name, kind);
      assertHeader(header, kind);
      if (kind === "symlink") assertContainedSymlink(name, header.linkname, "source");
      if (kind === "hardlink") assertContainedHardlink(kinds, header.linkname, "source");
      kinds.set(name, kind);
      entries += 1;
      payloadBytes += kind === "file" ? safeSize(header.size) : 0;
      if (entries > MAX_ENTRIES || payloadBytes > MAX_EXPANDED_BYTES)
        throw new SafeRestoreError("Volume archive exceeds its extraction limits", "INSTANCE_RESTORE_INVALID_ARCHIVE");
      if (name === "source" && kind === "directory") sourceRoot = true;
      stream.on("end", next);
      stream.resume();
    } catch (error) {
      stream.on("end", () => next(error instanceof Error ? error : new Error("Invalid volume archive entry")));
      stream.resume();
    }
  });
  await pipeline(createReadStream(archive), createGunzip(), counter, extract);
  if (!sourceRoot)
    throw new SafeRestoreError("Volume archive has no mounted source root", "INSTANCE_RESTORE_INVALID_ARCHIVE");
}

async function validateContainerBoundary(docker, container, dataDir) {
  const [containerInfo, helperInfo] = await Promise.all([
    container.inspect(),
    docker.getContainer(requiredEnv("HOSTNAME")).inspect(),
  ]);
  if (containerInfo.Id.toLowerCase() !== context.orchestratorId || !containerInfo.State?.Running)
    throw new SafeRestoreError("The exact orchestrator container is not running", "INSTANCE_RESTORE_CONTAINER_CHANGED");
  if (containerInfo.Config?.Labels?.["agentor.instance-restore-helper"] === "true")
    throw new SafeRestoreError("Restore helper cannot target itself", "INSTANCE_RESTORE_INVALID_CONTEXT");
  const targetMount = containerInfo.Mounts?.find((mount) => mount.Destination === dataDir);
  const helperMount = helperInfo.Mounts?.find((mount) => mount.Destination === dataDir);
  if (!sameMount(targetMount, helperMount))
    throw new SafeRestoreError("Restore helper does not share the orchestrator DATA_DIR mount", "INSTANCE_RESTORE_INVALID_CONTEXT");
  if (nativeRestore && !containerInfo.Config?.Env?.includes('AGENTOR_INSTANCE_RECOVERY_MODE=true'))
    throw new SafeRestoreError('Native controlled restore requires an explicit recovery-mode target', 'INSTANCE_RESTORE_INVALID_CONTEXT');
  return targetMount;
}

function sameMount(left, right) {
  if (!left || !right || left.Type !== right.Type) return false;
  if (left.Type === "volume") return Boolean(left.Name) && left.Name === right.Name;
  if (left.Type === "bind") return Boolean(left.Source) && left.Source === right.Source;
  return false;
}

async function moveCurrentDataToRollback(input, originalNames, moved) {
  const rollbackParent = dirname(input.rollbackRoot);
  await mkdir(rollbackParent, { recursive: true, mode: 0o700 });
  await assertDirectoryNoFollow(rollbackParent);
  await assertAbsent(input.rollbackRoot);
  const current = join(input.rollbackRoot, "current");
  await mkdir(current, { recursive: true, mode: 0o700 });
  for (const name of originalNames) {
    if (RESERVED_TOP_LEVEL.has(name)) continue;
    await rename(join(input.dataDir, name), join(current, name));
    moved.push(name);
  }
}

async function installPreparedData(input, installed) {
  for (const name of await readdir(input.preparedData)) {
    if (RESERVED_TOP_LEVEL.has(name))
      throw new SafeRestoreError("Prepared restore contains a reserved path", "INSTANCE_RESTORE_INVALID_ARCHIVE");
    await assertAbsent(join(input.dataDir, name));
    await rename(join(input.preparedData, name), join(input.dataDir, name));
    installed.push(name);
  }
  await assertRegularNoFollow(join(input.dataDir, "auth.db"), MAX_ARCHIVE_BYTES);
}

async function restoreVolume(docker, orchestrator, input, volume) {
  if (await volumeExists(docker, volume.name))
    throw new SafeRestoreError("A destination Docker volume appeared after preflight", "INSTANCE_RESTORE_VOLUME_CONFLICT");
  const marker = `${input.jobId}:${randomBytes(16).toString("hex")}`;
  const managedLabels = volume.kind === "persistent-path"
    ? {
        "agentor.persistent-backup-path": "true",
        ...(volume.workerId ? { "agentor.worker-id": volume.workerId } : {}),
      }
    : {};
  const created = await docker.createVolume({
    Name: volume.name,
    Labels: {
      "agentor.instance-restore-job": input.jobId,
      "agentor.instance-restore-marker": marker,
      ...managedLabels,
    },
  });
  const info = await created.inspect();
  if (info.Labels?.["agentor.instance-restore-marker"] !== marker)
    throw new SafeRestoreError("A destination Docker volume was created concurrently", "INSTANCE_RESTORE_VOLUME_CONFLICT");

  // Record ownership immediately. If helper-container creation or extraction
  // fails, the caller can remove this exact, marked volume safely.
  createdVolumes.push(volume.name);
  const helper = await docker.createContainer({
    Image: (await orchestrator.inspect()).Config.Image,
    name: `agentor-instance-volume-${input.jobId}-${createHash("sha256").update(volume.name).digest("hex").slice(0, 12)}`,
    Entrypoint: ["sleep"],
    Cmd: ["300"],
    NetworkDisabled: true,
    Labels: {
      "agentor.instance-restore-volume-helper": "true",
      "agentor.instance-restore-job": input.jobId,
    },
    HostConfig: {
      NetworkMode: "none",
      // Docker putArchive rejects a read-only rootfs even with writable /source;
      // prevalidation confines extracted entries to /source.
      ReadonlyRootfs: false,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Mounts: [{ Type: "volume", Source: volume.name, Target: "/source" }],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16777216" },
      PidsLimit: 32,
      Memory: 128 * 1024 * 1024,
      NanoCpus: 500_000_000,
      LogConfig: { Type: "none", Config: {} },
    },
  });
  try {
    await helper.start();
    await helper.putArchive(createReadStream(volume.archive).pipe(createGunzip()), { path: "/" });
  } finally {
    await helper.remove({ force: true }).catch(() => undefined);
  }
  // The outer caller tracks completed volumes too; avoid a duplicate entry.
  createdVolumes = [...new Set(createdVolumes)];
}

async function rollbackData(input, originalNames, movedOriginal, installed) {
  const current = join(input.rollbackRoot, "current");
  await assertDirectoryNoFollow(current);
  const original = new Set(originalNames);
  const replace = new Set([...movedOriginal, ...installed]);
  for (const name of await readdir(input.dataDir))
    if (!RESERVED_TOP_LEVEL.has(name) && (!original.has(name) || replace.has(name)))
      await rm(join(input.dataDir, name), { recursive: true, force: true });
  for (const name of movedOriginal) {
    const source = join(current, name);
    await lstat(source);
    await assertAbsent(join(input.dataDir, name));
    await rename(source, join(input.dataDir, name));
  }
  await rm(input.rollbackRoot, { recursive: true, force: true });
}

async function rollbackVolumes(docker, input, names) {
  const failures = [];
  for (const name of [...new Set(names)].reverse()) {
    try {
      const volume = docker.getVolume(name);
      const info = await volume.inspect();
      if (info.Labels?.["agentor.instance-restore-job"] !== input.jobId)
        throw new Error("restore ownership marker changed");
      await volume.remove();
    } catch (error) {
      if (error?.statusCode !== 404) failures.push(name);
    }
  }
  if (failures.length)
    throw new SafeRestoreError("One or more newly created volumes could not be removed", "INSTANCE_RESTORE_ROLLBACK_INCOMPLETE");
}

async function removeRollback(input) {
  await rm(input.rollbackRoot, { recursive: true, force: true });
}

async function assertVolumesAbsent(docker, volumes) {
  for (const volume of volumes)
    if (await volumeExists(docker, volume.name))
      throw new SafeRestoreError("A destination Docker volume already exists", "INSTANCE_RESTORE_VOLUME_CONFLICT");
}

/** Repeat the manager's empty-installation invariant after the exact target is
 * stopped. This is intentionally independent of in-memory stores: an
 * operation that began immediately before the restore barrier may have
 * committed records or created a container after the first preflight. */
async function assertRecoveryDestinationStillEmpty(
  docker,
  dataDir,
  orchestratorId,
) {
  const platformWorkspace = join(dataDir, "admin", "workspace.v1.json");
  try {
    await lstat(platformWorkspace);
    throw new SafeRestoreError(
      "The destination gained an administrative workspace after restore preflight",
      "INSTANCE_RESTORE_DESTINATION_CHANGED",
    );
  } catch (error) {
    if (error instanceof SafeRestoreError) throw error;
    if (error?.code !== "ENOENT") throw error;
  }

  const users = join(dataDir, "users");
  let ownerNames = [];
  try {
    await assertDirectoryNoFollow(users);
    ownerNames = await readdir(users);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const ownerName of ownerNames) {
    if (!safeId(ownerName))
      throw new SafeRestoreError(
        "The destination user store changed after restore preflight",
        "INSTANCE_RESTORE_DESTINATION_CHANGED",
      );
    const ownerPath = join(users, ownerName);
    await assertDirectoryNoFollow(ownerPath);
    const workers = await readOptionalBoundedJson(
      join(ownerPath, "workers.json"),
      MAX_STORE_BYTES,
      "destination worker store",
    );
    if (workers !== undefined && (!Array.isArray(workers) || workers.length))
      throw new SafeRestoreError(
        "The destination gained a worker after restore preflight",
        "INSTANCE_RESTORE_DESTINATION_CHANGED",
      );
    const groups = await readOptionalBoundedJson(
      join(ownerPath, "worker-groups.json"),
      MAX_STORE_BYTES,
      "destination worker-group store",
    );
    if (
      groups !== undefined &&
      (!Array.isArray(groups) || groups.some((group) => group?.adminWorkspace))
    )
      throw new SafeRestoreError(
        "The destination gained a group administrative workspace after restore preflight",
        "INSTANCE_RESTORE_DESTINATION_CHANGED",
      );
  }

  const containers = await docker.listContainers({ all: true });
  for (const container of containers ?? []) {
    if (String(container.Id ?? "").toLowerCase() === orchestratorId) continue;
    const labels = container.Labels ?? {};
    if (labels["agentor.id"] || labels["agentor.admin"] === "true")
      throw new SafeRestoreError(
        "The destination gained an Agentor worker container after restore preflight",
        "INSTANCE_RESTORE_DESTINATION_CHANGED",
      );
  }
}

async function volumeExists(docker, name) {
  try {
    await docker.getVolume(name).inspect();
    return true;
  } catch (error) {
    if (error?.statusCode === 404) return false;
    throw error;
  }
}

async function omitHostMountPolicies(root) {
  await removeRegularIfPresent(join(root, ...HOST_MOUNT_CATALOG_RELATIVE.split("/")));
  const users = join(root, "users");
  let usersInfo;
  try {
    usersInfo = await lstat(users);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!usersInfo.isDirectory() || usersInfo.isSymbolicLink())
    throw new SafeRestoreError("Restored users path is not a safe directory", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  for (const name of await readdir(users)) {
    const owner = join(users, name);
    const info = await lstat(owner);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    await removeRegularIfPresent(join(owner, "host-mount-grants.json"));
  }
}

async function removeRegularIfPresent(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new SafeRestoreError("Host-mount policy path is not a regular file", "INSTANCE_RESTORE_INVALID_ARCHIVE");
    await rm(path, { force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function readJobStore(dataDir, jobId) {
  const state = await readBoundedJson(join(dataDir, ...JOB_STORE_RELATIVE.split("/")), MAX_STORE_BYTES, "instance backup job store");
  if (state?.schemaVersion !== 1 || !Array.isArray(state.jobs))
    throw new SafeRestoreError("Invalid instance backup job store", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  const job = state.jobs.find((entry) => entry?.id === jobId);
  if (!job || job.operation !== "restore" || !["queued", "running"].includes(job.status) || !Array.isArray(job.logs))
    throw new SafeRestoreError("Restore job is absent or no longer active", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  return { state, job, originalOwnerId: job.userId };
}

async function assertJobStillActive() {
  const latest = await readJobStoreAllowCancelled(context.dataDir, context.jobId);
  const expectedOwnerId = backupStateOwnerMigrated
    ? context.plan.restoredOwnerId
    : context.plan.stagingOwnerId;
  if (latest.job.userId !== expectedOwnerId)
    throw new SafeRestoreError("Restore job ownership changed unexpectedly", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  // Later reads observe the restored owner, not the initial rollback principal.
  latest.originalOwnerId = jobState.originalOwnerId;
  if (latest.job.status === "cancelled") {
    jobState = latest;
    throw new SafeRestoreError("Instance restore was cancelled before mutation", "INSTANCE_RESTORE_CANCELLED");
  }
  jobState = latest;
}

async function readJobStoreAllowCancelled(dataDir, jobId) {
  const state = await readBoundedJson(join(dataDir, ...JOB_STORE_RELATIVE.split("/")), MAX_STORE_BYTES, "instance backup job store");
  if (state?.schemaVersion !== 1 || !Array.isArray(state.jobs))
    throw new SafeRestoreError("Invalid instance backup job store", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  const job = state.jobs.find((entry) => entry?.id === jobId);
  if (!job || job.operation !== "restore" || !["queued", "running", "cancelled"].includes(job.status) || !Array.isArray(job.logs))
    throw new SafeRestoreError("Restore job is absent or no longer active", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  return { state, job };
}

/** The job ledger and encrypted artifacts belong to the temporary recovery
 * installation, so they are intentionally excluded from the restored data
 * archive. Once auth.db is replaced, move only records owned by that staging
 * admin to the restored owner. Records for any other principal remain
 * untouched and no secret or provider credential is copied into the ledger. */
function reassignPreservedBackupState(record, fromOwnerId, toOwnerId) {
  if (!safeId(fromOwnerId) || !safeId(toOwnerId))
    throw new SafeRestoreError("Instance backup ownership cannot be migrated safely", "INSTANCE_RESTORE_JOB_STATE_INVALID");
  for (const collection of [record.state.jobs, record.state.artifacts, record.state.remoteBackups]) {
    if (!Array.isArray(collection))
      throw new SafeRestoreError("Invalid instance backup job store", "INSTANCE_RESTORE_JOB_STATE_INVALID");
    for (const item of collection)
      if (item?.userId === fromOwnerId) item.userId = toOwnerId;
  }
}

async function updateJob(status, phase, progress, message, errorCode, canRetry) {
  const stamp = new Date().toISOString();
  const job = jobState.job;
  job.status = status;
  job.phase = phase;
  job.progress = progress;
  job.updatedAt = stamp;
  job.startedAt ??= stamp;
  job.logs = [...job.logs, message].slice(-1000);
  if (status === "succeeded" || status === "failed") {
    job.completedAt = stamp;
    job.durationMs = Math.max(0, Date.parse(stamp) - Date.parse(job.startedAt));
  }
  if (status === "failed") {
    job.error = message;
    job.errorCode = errorCode;
    job.retryable = canRetry;
  } else {
    delete job.error;
    delete job.errorCode;
    delete job.retryable;
  }
  await writeJobStore(context.dataDir, jobState.state);
}

async function writeJobStore(dataDir, state) {
  const admin = join(dataDir, "admin");
  await mkdir(admin, { recursive: true, mode: 0o700 });
  await assertDirectoryNoFollow(admin);
  const path = join(admin, "instance-backups.v1.json");
  const temporary = join(admin, `.instance-backups.${process.pid}.${Date.now()}.tmp`);
  let file;
  try {
    file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readBoundedJson(path, limit, label) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (!info.isFile() || info.size < 2 || info.size > limit)
      throw new SafeRestoreError(`Invalid ${label}`, "INSTANCE_RESTORE_INVALID_CONTEXT");
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) {
    if (error instanceof SafeRestoreError) throw error;
    throw new SafeRestoreError(`Unable to read the ${label}`, "INSTANCE_RESTORE_INVALID_CONTEXT");
  } finally {
    await file?.close().catch(() => undefined);
  }
}

async function readOptionalBoundedJson(path, limit, label) {
  try {
    return await readBoundedJson(path, limit, label);
  } catch (error) {
    if (error?.cause?.code === "ENOENT") return undefined;
    // readBoundedJson deliberately normalizes errors, so probe only the exact
    // path without following links to distinguish absence from invalid input.
    try {
      await lstat(path);
    } catch (probe) {
      if (probe?.code === "ENOENT") return undefined;
    }
    throw error;
  }
}

async function verifySqliteHeader(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(16);
    const result = await file.read(header, 0, header.length, 0);
    if (result.bytesRead !== 16 || !header.equals(Buffer.from("SQLite format 3\0")))
      throw new SafeRestoreError("The restored authentication database is not a SQLite database", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  } finally {
    await file.close().catch(() => undefined);
  }
}

function assertHeader(header, kind) {
  if (kind !== "file" && header.size !== 0)
    throw new SafeRestoreError("Instance archive contains an invalid non-file payload", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  if (kind !== "symlink" && kind !== "hardlink" && header.linkname)
    throw new SafeRestoreError("Instance archive contains an unexpected link target", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  if (kind === "file") safeSize(header.size);
  safeMode(header.mode);
  if (header.uid !== undefined && !validOwner(header.uid))
    throw new SafeRestoreError("Instance archive contains an invalid uid", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  if (header.gid !== undefined && !validOwner(header.gid))
    throw new SafeRestoreError("Instance archive contains an invalid gid", "INSTANCE_RESTORE_INVALID_ARCHIVE");
}

function assertTreeSafe(kinds, name, kind) {
  if (kinds.has(name))
    throw new SafeRestoreError("Instance archive contains a duplicate entry", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = kinds.get(parts.slice(0, index).join("/"));
    if (ancestor && ancestor !== "directory")
      throw new SafeRestoreError("Instance archive traverses a non-directory entry", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  }
  for (const existing of kinds.keys())
    if (existing.startsWith(`${name}/`) && kind !== "directory")
      throw new SafeRestoreError("Instance archive replaces an existing parent", "INSTANCE_RESTORE_INVALID_ARCHIVE");
}

async function ensureParentsNoFollow(root, name) {
  const parts = name.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    await assertDirectoryNoFollow(current);
  }
}

async function applyMetadata(path, header, symlinkEntry) {
  if (validOwner(header.uid) && validOwner(header.gid)) {
    if (symlinkEntry) await lchown(path, header.uid, header.gid);
    else await chown(path, header.uid, header.gid);
  }
  if (!symlinkEntry) await chmod(path, safeMode(header.mode));
  if (!symlinkEntry && header.mtime instanceof Date && Number.isFinite(header.mtime.getTime()))
    await utimes(path, header.mtime, header.mtime);
}

function safeTarName(value) {
  if (typeof value !== "string")
    throw new SafeRestoreError("Instance archive contains an invalid path", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  const raw = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!raw || raw.startsWith("/") || raw.includes("\0") || raw.split("/").includes(".."))
    throw new SafeRestoreError("Instance archive contains an unsafe path", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  const normalized = posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.length > 4096)
    throw new SafeRestoreError("Instance archive contains an unsafe path", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  return normalized;
}

function assertContainedHardlink(kinds, linkname, requiredRoot) {
  if (typeof linkname !== "string")
    throw new SafeRestoreError("Instance archive contains an unsafe hard link", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  const target = safeTarName(linkname);
  if (
    (target !== requiredRoot && !target.startsWith(`${requiredRoot}/`)) ||
    kinds.get(target) !== "file"
  )
    throw new SafeRestoreError(
      "Instance archive hard link must target a prior regular file inside its archive root",
      "INSTANCE_RESTORE_INVALID_ARCHIVE",
    );
}

function assertContainedSymlink(entryName, linkname, requiredRoot) {
  if (
    typeof linkname !== "string" ||
    !linkname ||
    linkname.includes("\0") ||
    linkname.length > 4096
  )
    throw new SafeRestoreError("Instance archive contains an unsafe symlink", "INSTANCE_RESTORE_INVALID_ARCHIVE");

  // Docker volume payloads are restored into an isolated helper container.
  // Their prevalidated entry tree cannot write through a symlink, while the
  // preserved link may legitimately target the eventual worker filesystem.
  if (posix.isAbsolute(linkname)) {
    if (requiredRoot) return;
    throw new SafeRestoreError("Instance archive contains an unsafe symlink", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  }
  const resolvedTarget = posix.normalize(
    posix.join(posix.dirname(entryName), linkname),
  );
  if (
    !resolvedTarget ||
    resolvedTarget === ".." ||
    resolvedTarget.startsWith("../") ||
    (requiredRoot &&
      resolvedTarget !== requiredRoot &&
      !resolvedTarget.startsWith(`${requiredRoot}/`))
  )
    throw new SafeRestoreError("Instance archive contains a symlink outside its archive root", "INSTANCE_RESTORE_INVALID_ARCHIVE");
}

function entryKind(value) {
  if (value === "file" || value === "directory" || value === "symlink") return value;
  if (value === "link") return "hardlink";
  return undefined;
}

function safeMode(value) {
  if (value === undefined) return 0o600;
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777)
    throw new SafeRestoreError("Instance archive contains an invalid mode", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  return value;
}

function safeSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EXPANDED_BYTES)
    throw new SafeRestoreError("Instance archive entry exceeds the size limit", "INSTANCE_RESTORE_INVALID_ARCHIVE");
  return value;
}

function validOwner(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

async function assertRegularNoFollow(path, limit) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit)
    throw new SafeRestoreError("Restore input is not a bounded regular file", "INSTANCE_RESTORE_INVALID_CONTEXT");
}

async function assertDirectoryNoFollow(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new SafeRestoreError("Restore boundary is not a real directory", "INSTANCE_RESTORE_INVALID_CONTEXT");
}

async function assertAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new SafeRestoreError("Restore destination already exists", "INSTANCE_RESTORE_DESTINATION_CONFLICT");
}

async function consume(stream) {
  await new Promise((resolvePromise, rejectPromise) => {
    stream.once("error", rejectPromise);
    stream.once("end", resolvePromise);
    stream.resume();
  });
}

function canonicalAbsolute(value) {
  if (!isAbsolute(value) || value.includes("\0") || value.length > 4096 || resolve(value) !== value)
    throw new SafeRestoreError("Restore path is not canonical and absolute", "INSTANCE_RESTORE_INVALID_CONTEXT");
  return value;
}

function inside(parent, child) {
  const result = relative(parent, child);
  return Boolean(result) && result !== ".." && !result.startsWith(`..${sep}`) && !isAbsolute(result);
}

function dockerVolumeName(value) {
  return typeof value === "string" && value.length <= 255 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value);
}

function safeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,200}$/.test(value);
}

function requiredEnv(name) {
  const value = activeEnvironment[name];
  if (!value)
    throw new SafeRestoreError("Restore helper context is incomplete", "INSTANCE_RESTORE_INVALID_CONTEXT");
  return value;
}

function safeFailureMessage(error) {
  const fallback = "The controlled instance restore failed.";
  if (!(error instanceof SafeRestoreError)) {
    if (error?.code === "ENOSPC")
      return "The controlled instance restore ran out of destination storage.";
    if (error?.code === "EACCES" || error?.code === "EPERM")
      return "The controlled instance restore encountered a destination permission error.";
    return fallback;
  }
  const value = error.message;
  if (!value || value.length > 1024) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim() || fallback;
}
