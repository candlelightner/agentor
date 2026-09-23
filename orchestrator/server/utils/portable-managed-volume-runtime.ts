import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import Docker from "dockerode";
import {
  MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES,
  validateAndExtractPortableManagedVolumePayload,
  writePortableManagedVolumePayload,
} from "./portable-managed-volume-archive";
import {
  planPortableManagedVolumeImport,
  planPortableManagedVolumeCapture,
  type PortableManagedVolumeImportConflicts,
  type PortableManagedVolumeImportIntent,
  type PortableManagedVolumeCaptureExclusion,
} from "./portable-managed-volume-plan";
import type { PortableManagedVolumeEntry } from "./portable-managed-volume-format";
import {
  createPortableManagedVolumeImportJournal,
  isPortableManagedVolumeImportJournalTerminal,
  parsePortableManagedVolumeImportJournal,
  transitionPortableManagedVolumeJournalPhase,
  transitionPortableManagedVolumeResource,
  transitionPortableManagedVolumeWorker,
  type PortableManagedVolumeImportJournal,
} from "./portable-managed-volume-journal";
import { useManagedVolumeManager } from "./managed-volume-manager";
import type { StoredManagedVolume } from "./managed-volume-store";
import { UserScopedJsonStore } from "./user-scoped-store";
import { instanceSnapshotActive } from "./instance-snapshot-gate";
import { withOwnerWorkerLifecycleMutation } from "./worker-lifecycle-coordinator";
import {
  operationSettlement,
  withOperationDeadline,
  type OperationFailureWithSettlement,
} from "./operation-deadline";
import { registerOperationHelper } from "./operation-helper-registry";
import { useConfig } from "./services";
import { MAX_LOCAL_PERSISTENCE_COVERAGE_ENTRIES } from "./worker-export";

const DOCKER_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 10 * 60_000;
export const PORTABLE_VOLUME_HELPER_LABEL = "agentor.portable-volume-helper";
const PORTABLE_VOLUME_HELPER_NAME_PATTERN =
  /^agentor-portable-volume-(capture|probe|restore)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isCanonicalIsoTimestamp(value: string | undefined): value is string {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function portableManagedVolumeImportConflicts(input: {
  hostGrantPaths?: readonly string[];
  destinationMountPaths?: readonly string[];
  selectedBackupPaths?: readonly string[];
}): PortableManagedVolumeImportConflicts {
  return {
    protectedPaths: [
      "/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/root",
      "/bin", "/sbin", "/lib", "/lib64", "/usr", "/var/lib/containerd",
      "/home/agent/.ssh", "/home/agent/.claude", "/home/agent/.codex",
      "/home/agent/.gemini", "/home/agent/.agents", "/home/agent/.config/kilo",
      "/home/agent/.local/share/kilo", "/run/agentor-secrets",
    ],
    workspacePaths: ["/workspace"],
    agentDataPaths: ["/home/agent/.agent-data"],
    dockerDataPaths: ["/var/lib/docker"],
    hostGrantPaths: [...(input.hostGrantPaths ?? [])],
    destinationMountPaths: [...(input.destinationMountPaths ?? [])],
    selectedBackupPaths: [...(input.selectedBackupPaths ?? [])],
  };
}

export interface PortableManagedVolumeCaptureInput {
  userId: string;
  workerId: string;
  state: "running" | "stopped" | "archived";
  containerId?: string;
  outputPath: string;
  signal?: AbortSignal;
}

export interface PortableManagedVolumeCaptureResult {
  entries: PortableManagedVolumeEntry[];
  exclusions: PortableManagedVolumeCaptureExclusion[];
  localPersistence: Array<{ path: string; included: boolean }>;
  consistency: "best-effort" | "offline-read-only";
  bytes: number;
}

export interface PortableManagedVolumeImportInput {
  userId: string;
  workerId: string;
  entries: PortableManagedVolumeEntry[];
  payloadPath: string;
  stagingDir: string;
  conflicts: PortableManagedVolumeImportConflicts;
  /** Final image reference used by the worker. The probe is never started. */
  image: string;
  signal?: AbortSignal;
}

export interface PreparedPortableManagedVolumeImport {
  readonly operationId: string;
  readonly mounts: Array<{ source: string; target: string }>;
  markWorkerCreatePending(): Promise<void>;
  confirmWorkerCreated(containerId: string): Promise<void>;
  commit(): Promise<void>;
  rollback(removeProvisionalWorker: () => Promise<void>): Promise<void>;
}

class PortableManagedVolumeJournalStore extends UserScopedJsonStore<
  string,
  PortableManagedVolumeImportJournal
> {
  constructor(dataDir: string) {
    super(dataDir, "portable-managed-volume-imports.v1.json", (value) =>
      parsePortableManagedVolumeImportJournal(value).operationId,
    );
  }

  async save(value: PortableManagedVolumeImportJournal): Promise<void> {
    const parsed = parsePortableManagedVolumeImportJournal(value);
    await this.setItem(parsed.userId, parsed);
  }

  async forget(userId: string, operationId: string): Promise<void> {
    await this.deleteItem(userId, operationId);
  }

  read(userId: string, operationId: string): PortableManagedVolumeImportJournal | undefined {
    return this.get(userId, operationId);
  }
}

/** Docker-facing coordinator for portable custom-volume capture and restore.
 * Pure format/archive/plan/journal policy remains in the sibling modules. */
export class PortableManagedVolumeRuntime {
  private readonly activeOperations = new Set<string>();
  private readonly cleanupDebt = new Set<string>();
  private readonly journals: PortableManagedVolumeJournalStore;
  private initialization?: Promise<void>;

  constructor(
    private readonly dataDir: string,
    readonly docker = new Docker({ socketPath: "/var/run/docker.sock" }),
    private readonly options: {
      trustedImage?: () => Promise<string>;
      containerPrefix?: () => string;
    } = {},
  ) {
    this.journals = new PortableManagedVolumeJournalStore(dataDir);
  }

  async init(): Promise<void> {
    this.initialization ??= Promise.all([
      useManagedVolumeManager().init(),
      this.journals.init(),
    ]).then(() => undefined);
    await this.initialization;
  }

  hasActiveOperationsForInstanceSnapshot(): boolean {
    return this.activeOperations.size > 0 || this.cleanupDebt.size > 0 ||
      this.journals.list().some((journal) =>
        !isPortableManagedVolumeImportJournalTerminal(journal),
      );
  }

  /** Account for the complete import, including validation and ordinary
   * image/environment/worker mutations around the volume transaction. */
  async withInstanceSnapshotAccounting<T>(operation: () => Promise<T>): Promise<T> {
    this.assertSnapshotAvailable();
    const operationId = randomUUID();
    this.activeOperations.add(operationId);
    try {
      // Close the narrow gate race between the first check and registration.
      this.assertSnapshotAvailable();
      return await operation();
    } finally {
      this.activeOperations.delete(operationId);
    }
  }

  /** Settle stale positively-labelled helpers before ordinary worker sync. */
  async recoverStartup(
    removeProvisionalWorker?: (journal: PortableManagedVolumeImportJournal) => Promise<void>,
  ): Promise<void> {
    await this.init();
    const helpers = await withOperationDeadline(
      (operationSignal) => this.docker.listContainers({
        all: true,
        filters: { label: [`${PORTABLE_VOLUME_HELPER_LABEL}=true`] },
        abortSignal: operationSignal,
      }),
      DOCKER_TIMEOUT_MS,
      "List portable volume recovery helpers",
    );
    for (const helper of helpers) {
      const operationId = helper.Labels?.["agentor.helper.operation-id"];
      const name = helper.Names?.[0]?.replace(/^\//, "") || helper.Id;
      if (!operationId) {
        this.cleanupDebt.add(name);
        continue;
      }
      try {
        await this.removeOwnedHelper(helper.Id, operationId);
        this.cleanupDebt.delete(name);
      } catch {
        this.cleanupDebt.add(name);
      }
    }
    for (const candidate of this.journals.list()) {
      const journal = parsePortableManagedVolumeImportJournal(candidate);
      if (journal.phase === "committed") {
        await this.journals.forget(journal.userId, journal.operationId);
        continue;
      }
      try {
        await this.rollbackImportJournal(
          journal,
          () => removeProvisionalWorker?.(journal) ?? Promise.resolve(),
        );
        this.cleanupDebt.delete(journal.operationId);
      } catch {
        // Durable cleanup-debt state remains visible and blocks instance
        // snapshots; unrelated workers may still reconcile normally.
        this.cleanupDebt.add(journal.operationId);
      }
    }
  }

  async capture(input: PortableManagedVolumeCaptureInput): Promise<PortableManagedVolumeCaptureResult> {
    return withOwnerWorkerLifecycleMutation(input.userId, input.workerId, () =>
      this.captureWithLifecycleFenceHeld(input),
    );
  }

  async captureWithLifecycleFenceHeld(
    input: PortableManagedVolumeCaptureInput,
  ): Promise<PortableManagedVolumeCaptureResult> {
    this.assertSnapshotAvailable();
    const operationId = randomUUID();
    this.activeOperations.add(operationId);
    const workDir = join(this.dataDir, "tmp", `portable-volume-capture-${operationId}`);
    try {
      input.signal?.throwIfAborted();
      await this.init();
      const managed = useManagedVolumeManager();
      const records = managed.store.forWorker(input.userId, input.workerId);
      if (records.length > MAX_LOCAL_PERSISTENCE_COVERAGE_ENTRIES)
        throw Object.assign(
          new Error("Portable managed-volume coverage exceeds the supported record limit"),
          { statusCode: 409 },
        );
      const worker = input.state === "archived"
        ? undefined
        : await this.inspectCaptureWorker(input);
      const observations = [];
      for (const record of records) {
        input.signal?.throwIfAborted();
        let physical: Docker.VolumeInspectInfo | undefined;
        try {
          physical = await withOperationDeadline(
            (operationSignal) => this.docker.getVolume(record.dockerName).inspect({ abortSignal: operationSignal }),
            DOCKER_TIMEOUT_MS,
            "Inspect portable managed volume",
            input.signal,
          );
        } catch (error: any) {
          if (error?.statusCode !== 404) throw error;
        }
        const labels = physical?.Labels ?? {};
        const mounted = worker?.Mounts?.find((mount) => mount.Name === record.dockerName);
        observations.push({
          volumeId: record.id,
          dockerName: record.dockerName,
          target: record.target,
          name: record.name,
          purpose: record.purpose,
          attached: record.attached,
          seeded: record.seeded,
          state: record.state,
          physicalExists: Boolean(physical),
          labelsVerified: Boolean(
            physical &&
            labels["agentor.volume-id"] === record.id &&
            labels["agentor.owner-id"] === record.userId &&
            labels["agentor.worker-id"] === record.workerId
          ),
          driver: physical?.Driver ?? "",
          options: physical?.Options ?? null,
          mountSourceVerified: input.state === "archived" || mounted?.Name === record.dockerName,
          mountDestinationVerified: input.state === "archived" || mounted?.Destination === record.target,
          operationDrift: Boolean(record.liveContainerId || record.operation && record.operation.stage !== "complete"),
          recoveryDrift: managed.isRecoveryBlocked(input.workerId) || Boolean(managed.recreations.get(input.userId, input.workerId)),
        });
      }
      const plan = planPortableManagedVolumeCapture(observations);
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      await mkdir(dirname(input.outputPath), { recursive: true, mode: 0o700 });
      const archives: Array<{ entry: PortableManagedVolumeEntry; archivePath: string }> = [];
      let stagedBytes = 0;
      for (const [index, item] of plan.items.entries()) {
        const archivePath = join(workDir, `${index}.tar`);
        stagedBytes += await this.captureOneVolume({
          operationId,
          index,
          dockerName: item.source.dockerName,
          archivePath,
          maxBytes: MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES - stagedBytes,
          signal: input.signal,
          userId: input.userId,
          workerId: input.workerId,
          volumeId: item.source.volumeId,
        });
        archives.push({ entry: item.entry, archivePath });
      }
      const { bytes } = await writePortableManagedVolumePayload(
        archives,
        input.outputPath,
        { signal: input.signal },
      );
      const includedTargets = new Set(plan.items.map((item) => item.entry.target));
      const coverage = new Map<string, boolean>();
      for (const record of records)
        coverage.set(record.target, Boolean(coverage.get(record.target)) || includedTargets.has(record.target));
      return {
        entries: plan.items.map((item) => item.entry),
        exclusions: plan.exclusions,
        localPersistence: [...coverage]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, included]) => ({ path, included })),
        consistency: input.state === "running" ? "best-effort" : "offline-read-only",
        bytes,
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
      this.activeOperations.delete(operationId);
    }
  }

  /** Validate the entire nested payload and static target plan before creating
   * the durable journal or touching Docker. The returned transaction remains
   * snapshot-active until commit or positively confirmed rollback. */
  async prepareImportWithLifecycleFenceHeld(
    input: PortableManagedVolumeImportInput,
  ): Promise<PreparedPortableManagedVolumeImport> {
    this.assertSnapshotAvailable();
    const operationId = randomUUID();
    // Registration is synchronous with the admission check: no init,
    // extraction, journal write, or Docker mutation can occur in between.
    this.activeOperations.add(operationId);
    let extracted: Awaited<ReturnType<typeof validateAndExtractPortableManagedVolumePayload>>;
    let intents: PortableManagedVolumeImportIntent[];
    try {
      await this.init();
      input.signal?.throwIfAborted();
      extracted = await validateAndExtractPortableManagedVolumePayload(
        input.payloadPath,
        input.entries,
        input.stagingDir,
        { signal: input.signal },
      );
      intents = planPortableManagedVolumeImport({
        operationId,
        userId: input.userId,
        workerId: input.workerId,
        entries: input.entries,
        conflicts: input.conflicts,
      });
    } catch (error) {
      this.activeOperations.delete(operationId);
      throw error;
    }

    // An explicit empty v6 payload is still fully validated, but needs no
    // probe, journal, helper, or policy mutation.
    if (!intents.length) {
      let settled = false;
      const requireOpen = () => {
        if (settled) throw new Error("Portable managed-volume import transaction is already settled");
      };
      return {
        operationId,
        mounts: [],
        markWorkerCreatePending: async () => { requireOpen(); },
        confirmWorkerCreated: async () => { requireOpen(); },
        commit: async () => {
          requireOpen();
          settled = true;
          this.activeOperations.delete(operationId);
        },
        rollback: async (removeProvisionalWorker) => {
          requireOpen();
          await removeProvisionalWorker();
          settled = true;
          this.activeOperations.delete(operationId);
        },
      };
    }

    let journal = createPortableManagedVolumeImportJournal({
      operationId,
      userId: input.userId,
      workerId: input.workerId,
      resources: intents,
    });
    const extractedByArchive = new Map(extracted.map((item) => [item.entry.archive, item.archivePath]));
    try {
      await this.journals.save(journal);
      journal = transitionPortableManagedVolumeJournalPhase(journal, "provisioning");
      await this.journals.save(journal);
      await this.validateImageTargetsWithProbe(input, operationId, intents);
      for (const [index, intent] of intents.entries()) {
        journal = await this.createAndRestoreVolume(
          journal,
          index,
          intent,
          extractedByArchive.get(intent.archive)!,
          input.signal,
        );
      }
      journal = transitionPortableManagedVolumeJournalPhase(journal, "worker-pending");
      await this.journals.save(journal);
    } catch (error) {
      try {
        // A Docker mutation can succeed and its transition can be persisted
        // inside createAndRestoreVolume before that method ultimately throws
        // (including a late timeout settlement). Roll back from the durable
        // high-water mark, never the caller's older pre-call snapshot.
        const durable = this.journals.read(input.userId, operationId);
        if (durable) {
          journal = durable;
          await this.rollbackImportJournal(journal, async () => {});
        }
      } finally {
        this.activeOperations.delete(operationId);
      }
      throw error;
    }

    let settled = false;
    const requireOpen = () => {
      if (settled) throw new Error("Portable managed-volume import transaction is already settled");
    };
    return {
      operationId,
      mounts: intents.map((intent) => ({ source: intent.dockerName, target: intent.target })),
      markWorkerCreatePending: async () => {
        requireOpen();
        journal = transitionPortableManagedVolumeWorker(journal, "create-pending");
        await this.journals.save(journal);
      },
      confirmWorkerCreated: async (containerId) => {
        requireOpen();
        const worker = await withOperationDeadline(
          (operationSignal) => this.docker.getContainer(containerId).inspect({ abortSignal: operationSignal }),
          DOCKER_TIMEOUT_MS,
          "Confirm portable import worker",
          input.signal,
        );
        const labels = worker.Config?.Labels ?? {};
        if (
          labels["agentor.id"] !== input.workerId ||
          Object.entries(journal.provisionalWorker.expectedLabels)
            .some(([key, value]) => labels[key] !== value)
        )
          throw new Error("Portable import worker identity does not match its journal");
        journal = transitionPortableManagedVolumeWorker(journal, "created");
        await this.journals.save(journal);
        journal = transitionPortableManagedVolumeJournalPhase(journal, "worker-created");
        await this.journals.save(journal);
      },
      commit: async () => {
        requireOpen();
        journal = transitionPortableManagedVolumeJournalPhase(journal, "committed");
        await this.journals.save(journal);
        settled = true;
        this.activeOperations.delete(operationId);
        // The committed record is itself terminal. A failed compaction/delete
        // is retried at startup and must never roll back a successful worker.
        await this.journals.forget(journal.userId, journal.operationId).catch(() => {});
      },
      rollback: async (removeProvisionalWorker) => {
        requireOpen();
        try {
          journal = await this.rollbackImportJournal(journal, removeProvisionalWorker);
          settled = isPortableManagedVolumeImportJournalTerminal(journal);
        } finally {
          if (settled) this.activeOperations.delete(operationId);
        }
      },
    };
  }

  private async validateImageTargetsWithProbe(
    input: PortableManagedVolumeImportInput,
    operationId: string,
    intents: PortableManagedVolumeImportIntent[],
  ): Promise<void> {
    const helperOperationId = randomUUID();
    const helperName = `agentor-portable-volume-probe-${helperOperationId}`;
    const releaseHelper = registerOperationHelper(helperOperationId);
    let probe: Docker.Container | undefined;
    try {
      probe = await this.createHelperWithSettlement(helperName, helperOperationId, input.signal, {
        Image: input.image,
        name: helperName,
        Env: [],
        NetworkDisabled: true,
        Labels: this.helperLabels(helperOperationId, {
          operationId,
          userId: input.userId,
          workerId: input.workerId,
          volumeId: "probe",
        }),
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 8,
          Memory: 64 * 1024 * 1024,
          NanoCpus: 250_000_000,
          LogConfig: { Type: "none", Config: {} },
        },
      });
      try {
        // Deliberately never start this container and never give it any mount.
        for (const intent of intents) await this.validateProbeTarget(probe, intent.target, input.signal);
      } catch (error) {
        await this.awaitOperationSettlement(error);
        throw error;
      }
    } finally {
      try {
        if (probe) await this.removeOwnedHelper(probe.id, helperOperationId);
        else await this.removeOwnedHelper(helperName, helperOperationId);
        this.cleanupDebt.delete(helperName);
      } catch (error) {
        this.cleanupDebt.add(helperName);
        throw error;
      } finally {
        releaseHelper();
      }
    }
  }

  private async validateProbeTarget(
    probe: Docker.Container,
    target: string,
    signal?: AbortSignal,
  ): Promise<void> {
    let current = "";
    for (const component of target.slice(1).split("/")) {
      if (!component) continue;
      current += `/${component}`;
      try {
        const response: any = await withOperationDeadline(
          (operationSignal) => (probe as any).infoArchive({ path: current, abortSignal: operationSignal }),
          DOCKER_TIMEOUT_MS,
          "Validate portable import target ancestor",
          signal,
        );
        const encoded = response.headers?.["x-docker-container-path-stat"];
        response.resume?.();
        if (typeof encoded !== "string") throw new Error("Docker did not return target metadata");
        const metadata = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
        if (metadata.linkTarget || !(Number(metadata.mode) & 0x80000000))
          throw Object.assign(new Error("Portable managed-volume targets require directory ancestors without symlinks"), { statusCode: 409 });
      } catch (error: any) {
        if (error?.statusCode === 404) break;
        throw error;
      }
    }
  }

  private async createAndRestoreVolume(
    journalInput: PortableManagedVolumeImportJournal,
    index: number,
    intent: PortableManagedVolumeImportIntent,
    archivePath: string,
    signal?: AbortSignal,
  ): Promise<PortableManagedVolumeImportJournal> {
    let journal = journalInput;
    const existing = await this.inspectVolumeOptional(intent.dockerName, signal);
    if (existing)
      throw Object.assign(new Error("Portable import destination volume already exists"), { statusCode: 409 });
    journal = transitionPortableManagedVolumeResource(journal, index, "create-pending");
    await this.journals.save(journal);
    try {
      await withOperationDeadline(
        async (operationSignal) => { await this.docker.createVolume({
          Name: intent.dockerName,
          Driver: "local",
          Labels: intent.labels,
          abortSignal: operationSignal,
        } as any); },
        DOCKER_TIMEOUT_MS,
        "Create portable managed volume",
        signal,
      );
    } catch (error) {
      journal = transitionPortableManagedVolumeResource(journal, index, "create-uncertain");
      await this.journals.save(journal);
      const settlement = (error as OperationFailureWithSettlement)[operationSettlement];
      if (settlement) await settlement;
      const found = await this.inspectVolumeOptional(intent.dockerName, signal);
      if (found && this.volumeMatchesIntent(found, intent)) {
        journal = transitionPortableManagedVolumeResource(journal, index, "created");
        await this.journals.save(journal);
      }
      throw error;
    }
    const created = await this.inspectVolumeOptional(intent.dockerName, signal);
    if (!created || !this.volumeMatchesIntent(created, intent)) {
      journal = transitionPortableManagedVolumeResource(journal, index, "create-uncertain");
      await this.journals.save(journal);
      throw new Error("Portable import could not confirm fresh volume ownership");
    }
    journal = transitionPortableManagedVolumeResource(journal, index, "created");
    await this.journals.save(journal);
    journal = transitionPortableManagedVolumeResource(journal, index, "restore-pending");
    await this.journals.save(journal);
    try {
      await this.restoreOneVolume(journal.operationId, intent, archivePath, signal);
    } catch (error) {
      journal = transitionPortableManagedVolumeResource(journal, index, "restore-uncertain");
      await this.journals.save(journal);
      const settlement = (error as OperationFailureWithSettlement)[operationSettlement];
      if (settlement) await settlement;
      throw error;
    }
    journal = transitionPortableManagedVolumeResource(journal, index, "restored");
    await this.journals.save(journal);
    const stamp = new Date().toISOString();
    const record: StoredManagedVolume = {
      id: intent.id,
      userId: journal.userId,
      workerId: journal.workerId,
      target: intent.target,
      name: intent.name,
      dockerName: intent.dockerName,
      purpose: "persistent-path",
      attached: true,
      seeded: true,
      state: "ready",
      createdAt: stamp,
      updatedAt: stamp,
    };
    await useManagedVolumeManager().store.save(record);
    return journal;
  }

  private async restoreOneVolume(
    operationId: string,
    intent: PortableManagedVolumeImportIntent,
    archivePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const helperOperationId = randomUUID();
    const helperName = `agentor-portable-volume-restore-${helperOperationId}`;
    const releaseHelper = registerOperationHelper(helperOperationId);
    let helper: Docker.Container | undefined;
    try {
      helper = await this.createHelperWithSettlement(helperName, helperOperationId, signal, {
        Image: await this.trustedImage(),
        name: helperName,
        Entrypoint: ["tail"],
        Cmd: ["-f", "/dev/null"],
        User: "0:0",
        Env: [],
        NetworkDisabled: true,
        Labels: this.helperLabels(helperOperationId, {
          operationId,
          userId: intent.labels["agentor.owner-id"],
          workerId: intent.labels["agentor.worker-id"],
          volumeId: intent.id,
        }),
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 16,
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500_000_000,
          Init: true,
          // Moby validates the putArchive destination before inspecting tar
          // members. Give the validated volume/-rooted payload a writable
          // tmpfs extraction point while keeping the helper rootfs read-only;
          // the nested fresh-volume mount receives every durable member.
          Mounts: [
            {
              Type: "tmpfs", Source: "", Target: "/restore",
              TmpfsOptions: { SizeBytes: 1024 * 1024, Mode: 0o700 },
            },
            {
              Type: "volume", Source: intent.dockerName, Target: "/restore/volume",
              VolumeOptions: { NoCopy: true },
            },
          ] as any,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1048576" },
          LogConfig: { Type: "none", Config: {} },
        },
      });
      try {
        await withOperationDeadline(
          (operationSignal) => helper!.start({ abortSignal: operationSignal }),
          DOCKER_TIMEOUT_MS,
          "Start portable volume restore helper",
          signal,
        );
        await withOperationDeadline(
          (operationSignal) => helper!.putArchive(createReadStream(archivePath) as any, { path: "/restore", abortSignal: operationSignal } as any),
          CAPTURE_TIMEOUT_MS,
          "Restore portable managed volume",
          signal,
        );
      } catch (error) {
        await this.awaitOperationSettlement(error);
        throw error;
      }
    } finally {
      try {
        if (helper) await this.removeOwnedHelper(helper.id, helperOperationId);
        else await this.removeOwnedHelper(helperName, helperOperationId);
        this.cleanupDebt.delete(helperName);
      } catch (error) {
        this.cleanupDebt.add(helperName);
        throw error;
      } finally {
        releaseHelper();
      }
    }
  }

  private async rollbackImportJournal(
    journalInput: PortableManagedVolumeImportJournal,
    removeProvisionalWorker: () => Promise<void>,
  ): Promise<PortableManagedVolumeImportJournal> {
    let journal = journalInput;
    // Convert an interrupted in-flight mutation to its durable ambiguous form
    // while the pure journal still permits the provisioning/create transition.
    if (journal.phase === "provisioning") {
      for (let index = 0; index < journal.resources.length; index += 1) {
        if (journal.resources[index]!.state === "create-pending") {
          journal = transitionPortableManagedVolumeResource(journal, index, "create-uncertain");
          await this.journals.save(journal);
        } else if (journal.resources[index]!.state === "restore-pending") {
          journal = transitionPortableManagedVolumeResource(journal, index, "restore-uncertain");
          await this.journals.save(journal);
        }
      }
    }
    if (journal.phase === "worker-pending" && journal.provisionalWorker.state === "create-pending") {
      journal = transitionPortableManagedVolumeWorker(journal, "create-uncertain");
      await this.journals.save(journal);
    }
    if (journal.phase !== "rollback" && journal.phase !== "cleanup-debt") {
      journal = transitionPortableManagedVolumeJournalPhase(journal, "rollback");
      await this.journals.save(journal);
    } else if (journal.phase === "cleanup-debt") {
      journal = transitionPortableManagedVolumeJournalPhase(journal, "rollback");
      await this.journals.save(journal);
    }

    try {
      if (journal.provisionalWorker.state === "intent") {
        // ContainerManager persists the fresh worker record before it marks
        // Docker creation pending. A crash in that narrow window leaves the
        // journal at intent but still requires idempotent generic cleanup of
        // the durable record, imported image/environment, and storage. There
        // cannot legitimately be a Docker container before create-pending.
        const containerName = `${this.containerPrefix()}-${journal.workerId}`;
        if (await this.inspectContainerOptional(containerName))
          throw new Error("Portable import found a worker container before creation was journaled");
        await removeProvisionalWorker();
        if (await this.inspectContainerOptional(containerName))
          throw new Error("Portable import worker cleanup could not be confirmed");
      } else if (journal.provisionalWorker.state !== "deleted-confirmed") {
        if (journal.provisionalWorker.state === "created" ||
            journal.provisionalWorker.state === "create-uncertain") {
          journal = transitionPortableManagedVolumeWorker(journal, "delete-pending");
          await this.journals.save(journal);
        } else if (journal.provisionalWorker.state === "cleanup-debt") {
          journal = transitionPortableManagedVolumeWorker(journal, "delete-pending");
          await this.journals.save(journal);
        }
        const containerName = `${this.containerPrefix()}-${journal.workerId}`;
        const before = await this.inspectContainerOptional(containerName);
        if (before) {
          const labels = before.Config?.Labels ?? {};
          if (
            labels["agentor.id"] !== journal.workerId ||
            Object.entries(journal.provisionalWorker.expectedLabels)
              .some(([key, value]) => labels[key] !== value)
          ) throw new Error("Portable import rollback found an unexpected worker identity");
        }
        await removeProvisionalWorker();
        if (await this.inspectContainerOptional(containerName))
          throw new Error("Portable import worker deletion could not be confirmed");
        journal = transitionPortableManagedVolumeWorker(journal, "deleted-confirmed");
        await this.journals.save(journal);
      }

      for (let index = journal.resources.length - 1; index >= 0; index -= 1) {
        let state = journal.resources[index]!.state;
        if (state === "intent" || state === "deleted-confirmed") continue;
        if (state === "created" || state === "restored" ||
            state === "create-uncertain" || state === "restore-uncertain" ||
            state === "cleanup-debt") {
          journal = transitionPortableManagedVolumeResource(journal, index, "delete-pending");
          await this.journals.save(journal);
        }
        const resource = journal.resources[index]!;
        const volume = await this.inspectVolumeOptional(resource.dockerName);
        if (volume) {
          if (!this.volumeMatchesIntent(volume, resource))
            throw new Error("Portable import rollback refused an unexpected volume identity");
          const references = await withOperationDeadline(
            (operationSignal) => this.docker.listContainers({
              all: true,
              filters: { volume: [resource.dockerName] },
              abortSignal: operationSignal,
            }),
            DOCKER_TIMEOUT_MS,
            "Check portable import volume references",
          );
          if (references.length)
            throw new Error("Portable import volume is still referenced by a container");
          await withOperationDeadline(
            async (operationSignal) => { await this.docker.getVolume(resource.dockerName).remove({ abortSignal: operationSignal } as any); },
            DOCKER_TIMEOUT_MS,
            "Delete portable import volume",
          );
        }
        if (await this.inspectVolumeOptional(resource.dockerName))
          throw new Error("Portable import volume deletion could not be confirmed");
        await useManagedVolumeManager().store.forget(journal.userId, resource.id);
        journal = transitionPortableManagedVolumeResource(journal, index, "deleted-confirmed");
        await this.journals.save(journal);
      }
    } catch (error) {
      const workerState = journal.provisionalWorker.state;
      if (workerState === "delete-pending") {
        journal = transitionPortableManagedVolumeWorker(journal, "cleanup-debt");
        await this.journals.save(journal);
      }
      for (let index = 0; index < journal.resources.length; index += 1) {
        if (journal.resources[index]!.state === "delete-pending") {
          journal = transitionPortableManagedVolumeResource(journal, index, "cleanup-debt");
          await this.journals.save(journal);
        }
      }
      if (
        journal.phase === "rollback" &&
        (
          journal.provisionalWorker.state === "cleanup-debt" ||
          journal.resources.some((resource) => resource.state === "cleanup-debt")
        )
      ) {
        journal = transitionPortableManagedVolumeJournalPhase(journal, "cleanup-debt");
        await this.journals.save(journal);
      }
      throw Object.assign(
        new Error("Portable managed-volume cleanup requires operator attention"),
        { cause: error, code: "PORTABLE_VOLUME_IMPORT_CLEANUP_DEBT" },
      );
    }

    if (isPortableManagedVolumeImportJournalTerminal(journal))
      await this.journals.forget(journal.userId, journal.operationId);
    return journal;
  }

  private async inspectVolumeOptional(name: string, signal?: AbortSignal): Promise<Docker.VolumeInspectInfo | undefined> {
    try {
      return await withOperationDeadline(
        (operationSignal) => this.docker.getVolume(name).inspect({ abortSignal: operationSignal }),
        DOCKER_TIMEOUT_MS,
        "Inspect portable import volume",
        signal,
      );
    } catch (error: any) {
      if (error?.statusCode === 404) return undefined;
      throw error;
    }
  }

  private async inspectContainerOptional(name: string): Promise<Docker.ContainerInspectInfo | undefined> {
    try {
      return await withOperationDeadline(
        (operationSignal) => this.docker.getContainer(name).inspect({ abortSignal: operationSignal }),
        DOCKER_TIMEOUT_MS,
        "Inspect portable import worker rollback",
      );
    } catch (error: any) {
      if (error?.statusCode === 404) return undefined;
      throw error;
    }
  }

  private volumeMatchesIntent(
    volume: Docker.VolumeInspectInfo,
    intent: PortableManagedVolumeImportIntent,
  ): boolean {
    const labels = volume.Labels ?? {};
    return volume.Name === intent.dockerName && volume.Driver === "local" &&
      Object.keys(volume.Options ?? {}).length === 0 &&
      Object.entries(intent.labels).every(([key, value]) => labels[key] === value);
  }

  private async inspectCaptureWorker(input: PortableManagedVolumeCaptureInput) {
    if (!input.containerId)
      throw Object.assign(new Error("Portable managed-volume capture requires the source container"), { statusCode: 409 });
    const worker = await withOperationDeadline(
      (operationSignal) => this.docker.getContainer(input.containerId!).inspect({ abortSignal: operationSignal }),
      DOCKER_TIMEOUT_MS,
      "Inspect portable capture worker",
      input.signal,
    );
    if (worker.Config?.Labels?.["agentor.id"] !== input.workerId)
      throw Object.assign(new Error("Portable capture source identity does not match the worker"), { statusCode: 409 });
    if (input.state === "running" ? !worker.State.Running : worker.State.Running)
      throw Object.assign(new Error("Worker state changed before portable volume capture"), { statusCode: 409 });
    return worker;
  }

  private async captureOneVolume(input: {
    operationId: string;
    index: number;
    dockerName: string;
    archivePath: string;
    maxBytes: number;
    signal?: AbortSignal;
    userId: string;
    workerId: string;
    volumeId: string;
  }): Promise<number> {
    const helperOperationId = randomUUID();
    const helperName = `agentor-portable-volume-capture-${helperOperationId}`;
    const releaseHelper = registerOperationHelper(helperOperationId);
    let helper: Docker.Container | undefined;
    try {
      helper = await this.createHelperWithSettlement(helperName, helperOperationId, input.signal, {
        Image: await this.trustedImage(),
        name: helperName,
        Entrypoint: ["tail"],
        Cmd: ["-f", "/dev/null"],
        User: "65534:65534",
        Env: [],
        NetworkDisabled: true,
        Labels: this.helperLabels(helperOperationId, input),
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          PidsLimit: 16,
          Memory: 128 * 1024 * 1024,
          NanoCpus: 500_000_000,
          Init: true,
          Mounts: [{
            Type: "volume",
            Source: input.dockerName,
            Target: "/volume",
            ReadOnly: true,
            VolumeOptions: { NoCopy: true },
          }] as any,
          Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1048576" },
          LogConfig: { Type: "none", Config: {} },
        },
      });
      try {
        await withOperationDeadline(
          (operationSignal) => helper!.start({ abortSignal: operationSignal }),
          DOCKER_TIMEOUT_MS,
          "Start portable volume capture helper",
          input.signal,
        );
        const archive = await withOperationDeadline<Readable>(
          async (operationSignal) => await helper!.getArchive({ path: "/volume", abortSignal: operationSignal } as any) as unknown as Readable,
          DOCKER_TIMEOUT_MS,
          "Open portable volume capture archive",
          input.signal,
        );
        const timeout = AbortSignal.timeout(CAPTURE_TIMEOUT_MS);
        const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
        let bytes = 0;
        const bound = new Transform({
          transform(chunk, _encoding, callback) {
            bytes += Buffer.byteLength(chunk);
            callback(
              bytes > input.maxBytes
                ? new Error("Portable managed-volume capture exceeds the staging size limit")
                : null,
              chunk,
            );
          },
        });
        await pipeline(
          archive,
          bound,
          createWriteStream(input.archivePath, { mode: 0o600, flags: "wx" }),
          { signal },
        );
        return bytes;
      } catch (error) {
        await this.awaitOperationSettlement(error);
        throw error;
      }
    } finally {
      try {
        if (helper) await this.removeOwnedHelper(helper.id, helperOperationId);
        else await this.removeOwnedHelper(helperName, helperOperationId);
        this.cleanupDebt.delete(helperName);
      } catch (error) {
        this.cleanupDebt.add(helperName);
        throw error;
      } finally {
        releaseHelper();
      }
    }
  }

  private async createHelperWithSettlement(
    helperName: string,
    helperOperationId: string,
    signal: AbortSignal | undefined,
    options: Docker.ContainerCreateOptions,
  ): Promise<Docker.Container> {
    try {
      return await withOperationDeadline(
        (operationSignal) => this.docker.createContainer({ ...options, abortSignal: operationSignal }),
        DOCKER_TIMEOUT_MS,
        "Create portable volume helper",
        signal,
      );
    } catch (error) {
      const settlement = (error as OperationFailureWithSettlement)[operationSettlement];
      if (settlement) await settlement;
      await this.removeOwnedHelper(helperName, helperOperationId);
      throw error;
    }
  }

  private async removeOwnedHelper(idOrName: string, helperOperationId: string): Promise<void> {
    let inspection: Docker.ContainerInspectInfo;
    try {
      inspection = await withOperationDeadline(
        (operationSignal) => this.docker.getContainer(idOrName).inspect({ abortSignal: operationSignal }),
        DOCKER_TIMEOUT_MS,
        "Inspect portable volume helper cleanup",
      );
    } catch (error: any) {
      if (error?.statusCode === 404) return;
      throw error;
    }
    if (!this.hasOwnedHelperIdentity(inspection, helperOperationId))
      throw new Error("Portable volume helper cleanup found an unexpected identity");
    await withOperationDeadline(
      async (operationSignal) => { await this.docker.getContainer(inspection.Id).remove({ force: true, abortSignal: operationSignal } as any); },
      DOCKER_TIMEOUT_MS,
      "Remove portable volume helper",
    );
  }

  private hasOwnedHelperIdentity(
    inspection: Docker.ContainerInspectInfo,
    helperOperationId: string,
  ): boolean {
    const name = inspection.Name?.replace(/^\//, "");
    const nameMatch = name?.match(PORTABLE_VOLUME_HELPER_NAME_PATTERN);
    const labels = inspection.Config?.Labels;
    const createdAt = labels?.["agentor.helper.created-at"];
    const helperKind = nameMatch?.[1];
    const volumeId = labels?.["agentor.helper.volume-id"];
    return Boolean(
      UUID_V4_PATTERN.test(helperOperationId) &&
      nameMatch?.[2] === helperOperationId &&
      labels?.[PORTABLE_VOLUME_HELPER_LABEL] === "true" &&
      labels?.["agentor.helper.operation-id"] === helperOperationId &&
      labels?.["agentor.helper.owner-id"] &&
      UUID_V4_PATTERN.test(labels?.["agentor.helper.worker-id"] ?? "") &&
      (helperKind === "probe" ? volumeId === "probe" : UUID_V4_PATTERN.test(volumeId ?? "")) &&
      UUID_V4_PATTERN.test(labels?.["agentor.portable-operation-id"] ?? "") &&
      isCanonicalIsoTimestamp(createdAt)
    );
  }

  private helperLabels(
    helperOperationId: string,
    input: { operationId: string; userId: string; workerId: string; volumeId: string },
  ) {
    return {
      [PORTABLE_VOLUME_HELPER_LABEL]: "true",
      "agentor.helper.operation-id": helperOperationId,
      "agentor.helper.owner-id": input.userId,
      "agentor.helper.worker-id": input.workerId,
      "agentor.helper.volume-id": input.volumeId,
      "agentor.portable-operation-id": input.operationId,
      "agentor.helper.created-at": new Date().toISOString(),
    };
  }

  private trustedImage(): Promise<string> {
    return this.options.trustedImage?.() ??
      useManagedVolumeManager().runtime.trustedImage();
  }

  private containerPrefix(): string {
    return this.options.containerPrefix?.() ?? useConfig().containerPrefix;
  }

  private async awaitOperationSettlement(error: unknown): Promise<void> {
    const settlement = (error as OperationFailureWithSettlement)?.[operationSettlement];
    if (settlement) await settlement;
  }

  private assertSnapshotAvailable(): void {
    if (instanceSnapshotActive())
      throw Object.assign(
        new Error("Portable volume operations are unavailable during instance backup or restore."),
        { statusCode: 409, code: "INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE" },
      );
  }
}

let singleton: PortableManagedVolumeRuntime | undefined;
export function usePortableManagedVolumeRuntime(): PortableManagedVolumeRuntime {
  return singleton ??= new PortableManagedVolumeRuntime(useConfig().dataDir);
}
