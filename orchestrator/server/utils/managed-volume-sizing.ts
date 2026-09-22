import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  PublicVolumeSizeJob,
  VolumeSizeJobStatus,
  VolumeSizeMeasurement,
} from "../../shared/managed-volumes";
import { UserScopedJsonStore } from "./user-scoped-store";
import { useConfig } from "./services";
import { ManagedVolumeRuntime } from "./managed-volume-runtime";
import {
  resolveManagedVolumeSizingResource,
  type ManagedVolumeSizingResource,
} from "./managed-volume-inventory";
import { instanceSnapshotActive } from "./instance-snapshot-gate";
import { withOwnerWorkerLifecycleMutation } from "./worker-lifecycle-coordinator";
import {
  operationSettlement,
  type OperationFailureWithSettlement,
  withOperationDeadline,
} from "./operation-deadline";
import { isOperationHelperActive, registerOperationHelper } from "./operation-helper-registry";
import { volumeError } from "./managed-volume-store";

const CACHE_FRESH_MS = 15 * 60 * 1000;
const SCAN_TIMEOUT_MS = 60_000;
const DOCKER_TIMEOUT_MS = 8_000;
const MAX_RUNNING = 2;
const MAX_QUEUED_PER_OWNER = 10;
const HELPER_LABEL = "agentor.volume-size-helper";
const OUTPUT_MARKER = "AGENTOR_VOLUME_SIZE ";
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Fixed helper program: no request value is interpolated. It never follows a
 * symlink, counts hard-linked inodes once, and emits one bounded JSON record. */
export const VOLUME_SIZE_SCANNER = String.raw`
const fs=require('node:fs');
const ROOT='/volume',MAX=1000000,MAX_DEPTH=1024,END=Date.now()+55000,seen=new Set();
const O_PATH=0x200000,OPEN=O_PATH|fs.constants.O_NOFOLLOW;
let entries=0,allocated=0n,logical=0n;
const finish=(value)=>process.stdout.write('AGENTOR_VOLUME_SIZE '+JSON.stringify(value)+'\n');
const count=(st)=>{if(++entries>MAX)throw new Error('entry-limit');const key=st.dev+':'+st.ino;if(!seen.has(key)){seen.add(key);allocated+=st.blocks*512n;if(st.isFile())logical+=st.size;}};
const frames=[];
try {
  const rootFd=fs.openSync(ROOT,OPEN|fs.constants.O_DIRECTORY);
  count(fs.fstatSync(rootFd,{bigint:true}));
  frames.push({fd:rootFd,dir:fs.opendirSync('/proc/self/fd/'+rootFd)});
  while(frames.length){
    if(Date.now()>END) throw new Error('time-limit');
    const frame=frames[frames.length-1];
    const item=frame.dir.readSync();
    if(item===null){
      frame.dir.closeSync();
      fs.closeSync(frame.fd);
      frames.pop();
      continue;
    }
    let childFd;
    try {
      childFd=fs.openSync('/proc/self/fd/'+frame.fd+'/'+item.name,OPEN);
      const st=fs.fstatSync(childFd,{bigint:true});
      count(st);
      if(st.isDirectory()){
        if(frames.length>=MAX_DEPTH) throw new Error('entry-limit');
        const dir=fs.opendirSync('/proc/self/fd/'+childFd);
        frames.push({fd:childFd,dir});
        childFd=undefined;
      }
    } finally {
      if(childFd!==undefined) fs.closeSync(childFd);
    }
  }
  if(allocated>9007199254740991n||logical>9007199254740991n) throw new Error('size-overflow');
  finish({ok:true,allocatedBytes:allocated.toString(),logicalBytes:logical.toString(),entriesScanned:entries});
} catch(error) {
  while(frames.length){const frame=frames.pop();try{frame.dir.closeSync();}catch{}try{fs.closeSync(frame.fd);}catch{}}
  const code=['time-limit','entry-limit','size-overflow'].includes(error?.message)?error.message:'scan-error';
  finish({ok:false,error:code}); process.exitCode=2;
}
`;

type VolumeSizePhase = PublicVolumeSizeJob["phase"];

interface StoredVolumeSizeJob {
  id: string;
  userId: string;
  requesterId: string;
  ownerKey: string;
  volumeId: string;
  incarnation: string;
  status: VolumeSizeJobStatus;
  phase: VolumeSizePhase;
  progress: number;
  entriesScanned: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  measurement?: VolumeSizeMeasurement;
}

interface StoredVolumeSizeMeasurement {
  id: string;
  userId: string;
  ownerKey: string;
  volumeId: string;
  incarnation: string;
  allocatedBytes: number;
  logicalBytes: number;
  measuredAt: string;
  consistency: "offline-read-only" | "live-approximate";
}

function validSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

class VolumeSizeJobStore extends UserScopedJsonStore<string, StoredVolumeSizeJob> {
  constructor(dataDir: string) {
    super(join(dataDir, "system-state"), "volume-size-jobs.v1.json", (job) => {
      if (!job || typeof job.id !== "string" || typeof job.userId !== "string" ||
          job.userId !== "volume-sizing" || typeof job.requesterId !== "string" ||
          typeof job.ownerKey !== "string" || typeof job.volumeId !== "string" ||
          !/^[a-f0-9]{64}$/.test(job.incarnation) ||
          !["queued", "running", "succeeded", "failed", "cancelled"].includes(job.status) ||
          !["queued", "validating", "scanning", "complete", "failed", "cancelled"].includes(job.phase) ||
          !validSafeInteger(job.progress) || !validSafeInteger(job.entriesScanned))
        throw new Error("Invalid volume size job record");
      return job.id;
    });
  }
  async save(job: StoredVolumeSizeJob) { await this.setItem("volume-sizing", { ...job, userId: "volume-sizing" }); }
  find(id: string) { return this.findWithOwner((job) => job.id === id)?.item; }
  async removeAffected(userId: string) { return this.removeWhere((job) => job.requesterId === userId || job.ownerKey === userId); }
}

class VolumeSizeCacheStore extends UserScopedJsonStore<string, StoredVolumeSizeMeasurement> {
  constructor(dataDir: string) {
    super(join(dataDir, "system-state"), "volume-size-cache.v1.json", (item) => {
      if (!item || typeof item.id !== "string" || typeof item.userId !== "string" ||
          item.userId !== "volume-sizing" || typeof item.ownerKey !== "string" ||
          typeof item.volumeId !== "string" || !/^[a-f0-9]{64}$/.test(item.incarnation) ||
          !validSafeInteger(item.allocatedBytes) || !validSafeInteger(item.logicalBytes) ||
          !Number.isFinite(Date.parse(item.measuredAt)) ||
          !["offline-read-only", "live-approximate"].includes(item.consistency))
        throw new Error("Invalid volume size cache record");
      return item.id;
    });
  }
  async save(item: StoredVolumeSizeMeasurement) { await this.setItem("volume-sizing", { ...item, userId: "volume-sizing" }); }
  find(volumeId: string) { return this.findWithOwner((item) => item.volumeId === volumeId)?.item; }
  async removeOwner(ownerKey: string) { return this.removeWhere((item) => item.ownerKey === ownerKey); }
  async removeVolume(volumeId: string) { return this.removeWhere((item) => item.volumeId === volumeId); }
}

export type VolumeSizeAuthorizer = () => Promise<ManagedVolumeSizingResource>;

export interface VolumeSizeControlJob {
  volumeId: string;
  ownerKey: string;
}

export interface VolumeSizeControlOptions {
  authorize?: (job: VolumeSizeControlJob) => void | Promise<void>;
}

export interface ManagedVolumeSizingOptions {
  docker?: Docker;
  scan?: (resource: ManagedVolumeSizingResource, signal: AbortSignal) => Promise<{ allocatedBytes: number; logicalBytes: number; entriesScanned: number }>;
  now?: () => number;

}
interface TrackedSizeHelper {
  release: () => void;
  ownerKey: string;
  volumeId: string;
  pendingCreate: boolean;
  cleanupRequired: boolean;
}
const UNKNOWN_HELPER_OWNER = "*";
const UNKNOWN_HELPER_VOLUME = "*";


export class ManagedVolumeSizingManager {
  private readonly docker: Docker;
  private readonly runtime: ManagedVolumeRuntime;
  private readonly jobs: VolumeSizeJobStore;
  private readonly cache: VolumeSizeCacheStore;
  private readonly authorizers = new Map<string, VolumeSizeAuthorizer>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private readonly activeTasks = new Map<string, Promise<void>>();
  private readonly helpers = new Map<string, Docker.Container>();
  private readonly closedOwners = new Set<string>();
  private readonly unresolvedHelpers = new Map<string, TrackedSizeHelper>();
  private cleanupUncertain = false;
  private stateTail: Promise<void> = Promise.resolve();
  private admissions = 0;

  private initPromise?: Promise<void>;
  private readonly scanOverride?: ManagedVolumeSizingOptions["scan"];
  private readonly now: () => number;

  constructor(private readonly dataDir: string, options: ManagedVolumeSizingOptions = {}) {
    this.docker = options.docker ?? new Docker({ socketPath: "/var/run/docker.sock" });
    this.runtime = new ManagedVolumeRuntime(this.docker, dataDir);
    this.jobs = new VolumeSizeJobStore(dataDir);
    this.cache = new VolumeSizeCacheStore(dataDir);
    this.scanOverride = options.scan;
    this.now = options.now ?? Date.now;
  }

  init() { return this.initPromise ??= this.initialize(); }

  private async initialize() {
    await Promise.all([this.jobs.init(), this.cache.init()]);
    for (const job of this.jobs.list()) {
      if (job.status !== "queued" && job.status !== "running") continue;
      const stamp = new Date(this.now()).toISOString();
      await this.jobs.save({ ...job, status: "failed", phase: "failed", progress: 0,
        error: "Size scan was interrupted by an orchestrator restart. Start a new scan.",
        updatedAt: stamp, completedAt: stamp });
    }
    await this.cleanupStaleHelpers();
  }

  async cleanupStaleHelpers() {
    let found: Docker.ContainerInfo[];
    try {
      found = await withOperationDeadline(
        (signal) => this.docker.listContainers({ all: true, filters: { label: [`${HELPER_LABEL}=true`] }, abortSignal: signal }),
        DOCKER_TIMEOUT_MS, "List stale volume size helpers",
      );
    } catch {
      this.cleanupUncertain = true;
      return 0;
    }
    let removed = 0, failures = 0;
    const present = new Set<string>();
    for (const item of found) {
      const names = this.helperNames(item);
      for (const name of names) present.add(name);
      const tracked = names.map((name) => this.unresolvedHelpers.get(name)).find(Boolean);
      const operationId = item.Labels?.["agentor.helper.operation-id"];
      if (item.State === "running" && !tracked?.cleanupRequired && isOperationHelperActive(operationId)) continue;
      const cleaned = await withOperationDeadline(
        (signal) => this.docker.getContainer(item.Id).remove({ force: true, abortSignal: signal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
        DOCKER_TIMEOUT_MS, "Remove stale volume size helper",
      ).then(() => true).catch(() => false);
      if (!cleaned) {
        failures += 1;
        this.trackRecoveredHelper(item, names[0]);
        continue;
      }
      removed += 1;
      for (const name of names) { present.delete(name); this.releaseResolvedHelper(name); }
    }
    for (const [name, tracked] of this.unresolvedHelpers)
      if (tracked.cleanupRequired && !tracked.pendingCreate && !present.has(name)) this.releaseResolvedHelper(name);
    this.cleanupUncertain = failures > 0;
    return removed;
  }

  private helperNames(item: Docker.ContainerInfo) {
    const names = new Set((item.Names ?? []).map((name) => name.replace(/^\//, "")).filter(Boolean));
    const operationId = item.Labels?.["agentor.helper.operation-id"];
    if (operationId) names.add(`agentor-volume-size-${operationId}`);
    return [...names];
  }

  private trackRecoveredHelper(item: Docker.ContainerInfo, fallbackName?: string) {
    const names = this.helperNames(item);
    const name = names.find((candidate) => this.unresolvedHelpers.has(candidate)) ?? fallbackName ?? names[0];
    if (!name) return;
    const existing = this.unresolvedHelpers.get(name);
    if (existing) {
      existing.cleanupRequired = true;
      return;
    }
    this.unresolvedHelpers.set(name, {
      release: () => {},
      ownerKey: item.Labels?.["agentor.helper.owner-id"] || UNKNOWN_HELPER_OWNER,
      volumeId: item.Labels?.["agentor.helper.volume-id"] || UNKNOWN_HELPER_VOLUME,
      pendingCreate: false,
      cleanupRequired: true,
    });
  }

  private cleanupReservations() {
    return [...this.unresolvedHelpers.values()].filter((tracked) => tracked.cleanupRequired);
  }

  private reservationConflicts(ownerKey: string, volumeId?: string) {
    return this.cleanupReservations().some((tracked) =>
      tracked.ownerKey === UNKNOWN_HELPER_OWNER ||
      tracked.ownerKey === ownerKey ||
      volumeId !== undefined && (
        tracked.volumeId === UNKNOWN_HELPER_VOLUME || tracked.volumeId === volumeId
      ));
  }

  hasActiveOperationsForInstanceSnapshot() {
    return this.cleanupUncertain || this.admissions > 0 || this.unresolvedHelpers.size > 0 ||
      this.jobs.list().some((job) => job.status === "queued" || job.status === "running") || this.activeTasks.size > 0;
  }

  measurementFor(volumeId: string, incarnation: string | undefined, dockerAvailable = true): VolumeSizeMeasurement {
    if (!dockerAvailable) return unknownMeasurement("volume-unavailable");
    if (!incarnation) return unknownMeasurement("incarnation-changed");
    const cached = this.cache.find(volumeId);
    if (!cached) return unknownMeasurement("not-measured");
    if (cached.incarnation !== incarnation) return unknownMeasurement("incarnation-changed");
    const stale = this.now() - Date.parse(cached.measuredAt) > CACHE_FRESH_MS;
    return { state: stale ? "stale" : "known", allocatedBytes: cached.allocatedBytes,
      logicalBytes: cached.logicalBytes, measuredAt: cached.measuredAt, source: "bounded-read-only-scan",
      consistency: cached.consistency, ...(stale ? { reason: "stale" as const } : {}) };
  }

  latestJobFor(volumeId: string): PublicVolumeSizeJob | undefined {
    const job = this.jobs.list().filter((item) => item.volumeId === volumeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return job ? publicJob(job) : undefined;
  }
  private withState<T>(callback: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(callback, callback);
    this.stateTail = result.then(() => undefined, () => undefined);
    return result;
  }


  async create(requesterId: string, authorize: VolumeSizeAuthorizer, force = false): Promise<PublicVolumeSizeJob> {
    this.admissions += 1;
    try {
      await this.init();
      const result = await this.withState(async () => {
        if (instanceSnapshotActive()) throw volumeError(409, "Volume sizing is unavailable during instance backup or restore. Retry afterwards.");
        if (this.cleanupUncertain) throw volumeError(503, "Volume sizing helper cleanup is incomplete. Retry after storage cleanup.");
        const resource = await authorize();
        if (instanceSnapshotActive()) throw volumeError(409, "Volume sizing is unavailable during instance backup or restore. Retry afterwards.");
        if (!resource.incarnation) throw volumeError(409, "Volume identity cannot be verified safely.");
        if (this.closedOwners.has(resource.ownerKey)) throw volumeError(409, "Storage owner cleanup is in progress.");
        if (this.reservationConflicts(resource.ownerKey, resource.id))
          throw volumeError(409, "A previous volume size helper still requires cleanup.");
        const active = this.jobs.list().find((job) => job.volumeId === resource.id &&
          (job.status === "queued" || job.status === "running"));
        if (active) return active;
        const cached = this.measurementFor(resource.id, resource.incarnation);
        if (!force && cached.state === "known") {
          const stamp = new Date(this.now()).toISOString();
          const hit: StoredVolumeSizeJob = { id: randomUUID(), userId: "volume-sizing", requesterId, ownerKey: resource.ownerKey,
            volumeId: resource.id, incarnation: resource.incarnation, status: "succeeded", phase: "complete",
            progress: 100, entriesScanned: 0, createdAt: stamp, updatedAt: stamp, completedAt: stamp,
            measurement: cached };
          await this.jobs.save(hit); return hit;
        }
        const pendingForOwner = this.jobs.list().filter((job) => job.ownerKey === resource.ownerKey &&
          (job.status === "queued" || job.status === "running")).length;
        const reservedForOwner = this.cleanupReservations().filter((tracked) =>
          tracked.ownerKey === resource.ownerKey || tracked.ownerKey === UNKNOWN_HELPER_OWNER).length;
        if (pendingForOwner + reservedForOwner >= MAX_QUEUED_PER_OWNER)
          throw volumeError(429, "Too many volume size jobs are queued for this owner.");
        const stamp = new Date(this.now()).toISOString();
        const job: StoredVolumeSizeJob = { id: randomUUID(), userId: "volume-sizing", requesterId, ownerKey: resource.ownerKey,
          volumeId: resource.id, incarnation: resource.incarnation, status: "queued", phase: "queued",
          progress: 0, entriesScanned: 0, createdAt: stamp, updatedAt: stamp };
        this.authorizers.set(job.id, authorize);
        try { await this.jobs.save(job); }
        catch (error) { this.authorizers.delete(job.id); throw error; }
        return job;
      });
      if (result.status === "queued") setImmediate(() => this.dispatch());
      return publicJob(result);
    } finally {
      this.admissions -= 1;
    }
  }

  async get(id: string, options: VolumeSizeControlOptions = {}) {
    await this.init();
    const job = this.jobs.find(id);
    if (!job) return undefined;
    if (options.authorize) await options.authorize(job);
    return publicJob(job);
  }
  getStored(id: string) { return this.jobs.find(id); }

  async cancel(id: string, options: VolumeSizeControlOptions = {}): Promise<PublicVolumeSizeJob> {
    await this.init();
    const initial = this.jobs.find(id);
    if (!initial) throw volumeError(404, "Volume size job not found.");
    if (options.authorize) await options.authorize(initial);
    // Interrupt publication after a live check, even when publication is
    // currently awaiting its own final authorization inside the state fence.
    this.controllers.get(id)?.abort();
    const cancelled = await this.withState(async () => {
      const job = this.jobs.find(id);
      if (!job) throw volumeError(404, "Volume size job not found.");
      // The state queue itself may have awaited. Recheck immediately before
      // invoking the durable mutation so a revoked principal cannot cancel.
      if (options.authorize) await options.authorize(job);
      if (["succeeded", "failed", "cancelled"].includes(job.status)) return job;
      const stamp = new Date(this.now()).toISOString();
      const value = { ...job, status: "cancelled" as const, phase: "cancelled" as const,
        progress: 0, updatedAt: stamp, completedAt: stamp };
      await this.jobs.save(value);
      if (job.status === "queued") this.authorizers.delete(id);
      return value;
    });
    const helper = this.helpers.get(id);
    if (cancelled.status === "cancelled" && helper) await withOperationDeadline(
      (signal) => helper.remove({ force: true, abortSignal: signal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
      DOCKER_TIMEOUT_MS, "Cancel volume size helper",
    ).catch(() => {});
    this.dispatch();
    return publicJob(cancelled);
  }

  async forgetUser(userId: string) {
    await this.init(); this.closedOwners.add(userId);
    const helpers = await this.withState(async () => {
      const affected = this.jobs.list().filter((job) => job.requesterId === userId || job.ownerKey === userId);
      const stamp = new Date(this.now()).toISOString();
      for (const job of affected) {
        if (job.status !== "queued" && job.status !== "running") continue;
        const cancelled = { ...job, status: "cancelled" as const, phase: "cancelled" as const,
          progress: 0, updatedAt: stamp, completedAt: stamp };
        await this.jobs.save(cancelled);
        this.controllers.get(job.id)?.abort();
        if (job.status === "queued") this.authorizers.delete(job.id);
      }
      await this.jobs.removeAffected(userId);
      await this.cache.removeOwner(userId);
      return affected.map((job) => this.helpers.get(job.id)).filter(Boolean) as Docker.Container[];
    });
    // Account cleanup already holds the owner fence. A just-dispatched scan
    // may be waiting for that same fence, so do not await its task here. The
    // durable cancellation plus closed-owner marker makes the later task exit
    // without publishing or recreating an owner partition.
    for (const helper of helpers) await withOperationDeadline(
      (signal) => helper.remove({ force: true, abortSignal: signal } as Docker.ContainerRemoveOptions & { abortSignal: AbortSignal }),
      DOCKER_TIMEOUT_MS, "Cancel deleted-owner volume size helper",
    ).catch(() => {});
  }

  private dispatch() {
    const reservations = this.cleanupReservations();
    if (this.cleanupUncertain || this.running.size + reservations.length >= MAX_RUNNING) return;
    const busyOwners = new Set([...this.running].map((id) => this.jobs.find(id)?.ownerKey).filter(Boolean));
    for (const tracked of reservations) busyOwners.add(tracked.ownerKey);
    const unknownOwnerBusy = busyOwners.has(UNKNOWN_HELPER_OWNER);
    const next = this.jobs.list().find((job) => job.status === "queued" && !unknownOwnerBusy &&
      !busyOwners.has(job.ownerKey) && !reservations.some((tracked) =>
        tracked.volumeId === UNKNOWN_HELPER_VOLUME || tracked.volumeId === job.volumeId) &&
      this.authorizers.has(job.id) && !this.closedOwners.has(job.ownerKey));
    if (!next) return;
    this.running.add(next.id);
    const task = this.run(next.id).catch(() => {}).finally(() => {
      this.running.delete(next.id); this.activeTasks.delete(next.id); this.controllers.delete(next.id);
      this.helpers.delete(next.id); this.authorizers.delete(next.id); this.dispatch();
    });
    this.activeTasks.set(next.id, task);
    if (this.running.size < MAX_RUNNING) this.dispatch();
  }

  private async run(id: string) {
    const queued = this.jobs.find(id), authorize = this.authorizers.get(id);
    if (!queued || queued.status !== "queued" || !authorize) return;
    const controller = new AbortController(); this.controllers.set(id, controller);
    try {
      const started = await this.withState(async () => {
        const current = this.jobs.find(id);
        if (!current || current.status !== "queued") return false;
        const stamp = new Date(this.now()).toISOString();
        await this.jobs.save({ ...current, status: "running", phase: "validating", progress: 10,
          startedAt: stamp, updatedAt: stamp });
        return true;
      });
      if (!started) return;
      if (instanceSnapshotActive()) throw volumeError(409, "Instance backup or restore started before the size scan.");
      const admitted = await authorize();
      this.assertSameIncarnation(queued, admitted);
      const execute = async () => {
        controller.signal.throwIfAborted();
        if (instanceSnapshotActive()) throw volumeError(409, "Instance backup or restore started before the size scan.");
        const before = await authorize(); this.assertSameIncarnation(queued, before);
        const scanning = await this.withState(async () => {
          const current = this.jobs.find(id);
          if (!current || current.status !== "running") return false;
          await this.jobs.save({ ...current, phase: "scanning", progress: 35,
            updatedAt: new Date(this.now()).toISOString() });
          return true;
        });
        if (!scanning) throw volumeError(409, "Volume size job is no longer active.");
        const result = this.scanOverride
          ? await this.scanOverride(before, controller.signal)
          : await this.scanVolume(id, before, controller.signal);
        controller.signal.throwIfAborted();
        const after = await authorize(); this.assertSameIncarnation(queued, after);
        await this.withState(async () => {
          controller.signal.throwIfAborted();
          if (instanceSnapshotActive()) throw volumeError(409, "Instance backup or restore started before the size result was published.");
          const current = this.jobs.find(id);
          if (!current || current.status !== "running" || this.closedOwners.has(current.ownerKey)) return;
          const publish = await authorize(); this.assertSameIncarnation(queued, publish);
          if (this.closedOwners.has(current.ownerKey)) return;
          controller.signal.throwIfAborted();
          if (instanceSnapshotActive()) throw volumeError(409, "Instance backup or restore started before the size result was published.");
          const measuredAt = new Date(this.now()).toISOString();
          const cached: StoredVolumeSizeMeasurement = { id: publish.id, userId: "volume-sizing", ownerKey: publish.ownerKey,
            volumeId: publish.id, incarnation: publish.incarnation!, allocatedBytes: result.allocatedBytes,
            logicalBytes: result.logicalBytes, measuredAt,
            consistency: publish.live ? "live-approximate" : "offline-read-only" };
          const measurement: VolumeSizeMeasurement = { state: "known", allocatedBytes: result.allocatedBytes,
            logicalBytes: result.logicalBytes, measuredAt, source: "bounded-read-only-scan",
            consistency: cached.consistency };
          await this.cache.save(cached);
          try {
            await this.jobs.save({ ...current, status: "succeeded", phase: "complete", progress: 100,
              entriesScanned: result.entriesScanned, completedAt: measuredAt, measurement,
              updatedAt: measuredAt });
          } catch (error) {
            await this.cache.removeVolume(publish.id);
            throw error;
          }
        });
      };
      if (admitted.userId && admitted.workerId)
        await withOwnerWorkerLifecycleMutation(admitted.userId, admitted.workerId, execute);
      else await execute();
    } catch (error: any) {
      const stamp = new Date(this.now()).toISOString();
      await this.withState(async () => {
        const current = this.jobs.find(id);
        if (!current || ["succeeded", "failed", "cancelled"].includes(current.status)) return;
        await this.jobs.save({ ...current, status: "failed", phase: "failed", progress: 0,
          completedAt: stamp, error: safeSizingError(error), updatedAt: stamp });
      });
    }
  }

  private assertSameIncarnation(job: StoredVolumeSizeJob, resource: ManagedVolumeSizingResource) {
    if (resource.id !== job.volumeId || !resource.incarnation || resource.incarnation !== job.incarnation)
      throw volumeError(409, "Volume identity changed before the size scan completed.");
  }

  private releaseResolvedHelper(name: string) {
    const tracked = this.unresolvedHelpers.get(name);
    if (!tracked) return;
    this.unresolvedHelpers.delete(name);
    tracked.release();
  }

  private async removeTrackedHelper(name: string, label: string) {
    const tracked = this.unresolvedHelpers.get(name);
    try {
      await withOperationDeadline(
        async (operationSignal) => { await this.docker.getContainer(name).remove({ force: true, abortSignal: operationSignal } as any); },
        DOCKER_TIMEOUT_MS, label,
      );
    } catch (error: any) {
      if (error?.statusCode !== 404) {
        if (tracked) tracked.cleanupRequired = true;
        throw error;
      }
    }
    if (!tracked?.pendingCreate) this.releaseResolvedHelper(name);
  }


  private async scanVolume(jobId: string, resource: ManagedVolumeSizingResource, signal: AbortSignal) {
    await withOperationDeadline(
      (operationSignal) => this.docker.getVolume(resource.dockerName).inspect({ abortSignal: operationSignal }),
      DOCKER_TIMEOUT_MS, "Inspect volume before size scan", signal,
    ).catch((error: any) => {
      if (error?.statusCode === 404) throw volumeError(409, "Volume disappeared before the size scan; no replacement was created.");
      throw error;
    });
    // Resolve the immutable helper image before registering a possible Docker
    // create. A failure here definitively means no helper can exist, so it must
    // not leave a pending-create reservation behind.
    const image = await this.runtime.trustedImage();
    const operationId = randomUUID(), name = `agentor-volume-size-${operationId}`;
    const releaseOperation = registerOperationHelper(operationId);
    const tracked: TrackedSizeHelper = { release: releaseOperation, ownerKey: resource.ownerKey,
      volumeId: resource.id, pendingCreate: true, cleanupRequired: false };
    this.unresolvedHelpers.set(name, tracked);
    let helper: Docker.Container | undefined;
    try {
      try {
        helper = await withOperationDeadline((operationSignal) => this.docker.createContainer({
          name, Image: image, Entrypoint: ["node", "-e", VOLUME_SIZE_SCANNER], Cmd: [],
          User: "0:0", Env: [], NetworkDisabled: true,
          Labels: { [HELPER_LABEL]: "true", "agentor.helper.operation-id": operationId,
            "agentor.helper.owner-id": resource.ownerKey, "agentor.helper.volume-id": resource.id,
            "agentor.helper.created-at": new Date(this.now()).toISOString() },
          HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"],
            // Read-only traversal must include mode-000 files. This single
            // capability bypasses read/search DAC only; there is no write mount,
            // network, host namespace, device, or privilege escalation path.
            CapAdd: ["DAC_READ_SEARCH"], SecurityOpt: ["no-new-privileges:true"],
            PidsLimit: 16, Memory: 128 * 1024 * 1024, NanoCpus: 500_000_000, Init: true,
            Mounts: [{ Type: "volume", Source: resource.dockerName, Target: "/volume", ReadOnly: true,
              VolumeOptions: { NoCopy: true } }] as any,
            Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=1048576" },
            LogConfig: { Type: "json-file", Config: { "max-size": "32k", "max-file": "1" } },
          }, abortSignal: operationSignal,
        } as Docker.ContainerCreateOptions & { abortSignal: AbortSignal }), DOCKER_TIMEOUT_MS, "Create volume size helper", signal);
        tracked.pendingCreate = false;
      } catch (error) {
        const settlement = (error as OperationFailureWithSettlement)[operationSettlement];
        if (!settlement) tracked.pendingCreate = false;
        await this.removeTrackedHelper(name, "Clean ambiguous volume size helper").catch(() => {});
        if (settlement) {
          await settlement;
          tracked.pendingCreate = false;
          await this.removeTrackedHelper(name, "Clean settled volume size helper");
        }
        throw error;
      }
      this.helpers.set(jobId, helper);
      // Re-resolve after Docker accepted the mount but before executing code.
      const authorize = this.authorizers.get(jobId)!;
      this.assertSameIncarnation(this.jobs.find(jobId)!, await authorize());
      await withOperationDeadline((operationSignal) => helper!.start({ abortSignal: operationSignal }), DOCKER_TIMEOUT_MS, "Start volume size helper", signal);
      const result = await withOperationDeadline<{ StatusCode: number }>(async (operationSignal) =>
        await helper!.wait({ condition: "not-running", abortSignal: operationSignal } as any) as any, SCAN_TIMEOUT_MS, "Run volume size scan", signal);
      const output = await withOperationDeadline<Buffer>(async (operationSignal) =>
        await helper!.logs({ stdout: true, stderr: true, tail: 8, abortSignal: operationSignal } as any) as any, DOCKER_TIMEOUT_MS, "Read volume size result", signal);
      if (output.length > MAX_OUTPUT_BYTES) throw volumeError(409, "Volume size helper returned excessive output.");
      const parsed = parseScannerOutput(output.toString());
      if (result.StatusCode !== 0 || !parsed.ok) throw volumeError(409,
        parsed.error === "entry-limit" ? "Volume contains more than 1,000,000 entries; size remains unknown." :
        parsed.error === "time-limit" ? "Volume scan exceeded 60 seconds; size remains unknown." :
        "Volume size scan could not complete; size remains unknown.");
      return { allocatedBytes: parseBoundedInteger(parsed.allocatedBytes), logicalBytes: parseBoundedInteger(parsed.logicalBytes),
        entriesScanned: parseBoundedInteger(String(parsed.entriesScanned), 1_000_000) };
    } finally {
      this.helpers.delete(jobId);
      await this.removeTrackedHelper(name, "Remove volume size helper");
    }
  }
}

export function parseBoundedInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value))
    throw volumeError(409, "Volume size helper returned an invalid integer.");
  const parsed = BigInt(value);
  if (parsed > MAX_SAFE || parsed > BigInt(maximum)) throw volumeError(409, "Volume size helper integer exceeded its bound.");
  return Number(parsed);
}

export function parseScannerOutput(output: string): any {
  const marker = output.lastIndexOf(OUTPUT_MARKER);
  if (marker < 0) throw volumeError(409, "Volume size helper returned no result.");
  const raw = output.slice(marker + OUTPUT_MARKER.length).split(/[\r\n]/, 1)[0]!;
  if (Buffer.byteLength(raw) > 2048) throw volumeError(409, "Volume size helper result is too large.");
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { throw volumeError(409, "Volume size helper returned malformed output."); }
  if (!parsed || typeof parsed.ok !== "boolean" || Object.keys(parsed).some((key) => !["ok", "allocatedBytes", "logicalBytes", "entriesScanned", "error"].includes(key)))
    throw volumeError(409, "Volume size helper returned malformed output.");
  if (!parsed.ok && !["time-limit", "entry-limit", "size-overflow", "scan-error"].includes(parsed.error))
    throw volumeError(409, "Volume size helper returned an unknown error.");
  return parsed;
}

function unknownMeasurement(reason: VolumeSizeMeasurement["reason"]): VolumeSizeMeasurement {
  return { state: "unknown", allocatedBytes: null, logicalBytes: null, reason };
}

function safeSizingError(error: any) {
  if (error?.storageSafeError && typeof error.message === "string") return error.message.slice(0, 300);
  if (error?.name === "AbortError" || error?.code === "OPERATION_ABORTED") return "Volume size scan was cancelled.";
  return "Volume size scan failed. No volume data was changed.";
}

function publicJob(job: StoredVolumeSizeJob): PublicVolumeSizeJob {
  const { userId: _user, requesterId: _requester, ownerKey: _owner, incarnation: _incarnation, ...result } = job;
  return result;
}

let singleton: ManagedVolumeSizingManager | undefined;
export function useManagedVolumeSizingManager() {
  return singleton ??= new ManagedVolumeSizingManager(useConfig().dataDir);
}

export interface RestVolumeSizeAuthorizerDependencies {
  resolve?: typeof resolveManagedVolumeSizingResource;
  getUserById?: (userId: string) => unknown;
  isPlatformAdminUser?: (userId: string) => boolean;
}

/** Ordinary REST authorization is evaluated from authoritative current state
 * at admission, dequeue, and publication—not from the initiating session. */
export function restVolumeSizeAuthorizer(
  requesterId: string,
  volumeId: string,
  dependencies: RestVolumeSizeAuthorizerDependencies = {},
): VolumeSizeAuthorizer {
  return async () => {
    const auth = dependencies.getUserById && dependencies.isPlatformAdminUser
      ? undefined
      : await import("./auth");
    const getUserById = dependencies.getUserById ?? auth!.getUserById;
    const isPlatformAdminUser = dependencies.isPlatformAdminUser ?? auth!.isPlatformAdminUser;
    if (!getUserById(requesterId)) throw volumeError(404, "Volume not found.");
    const platform = isPlatformAdminUser(requesterId);
    const resolve = dependencies.resolve ?? resolveManagedVolumeSizingResource;
    const resource = await resolve(volumeId, { userId: requesterId, platform });
    if (!resource) throw volumeError(404, "Volume not found.");
    if (!getUserById(requesterId) || isPlatformAdminUser(requesterId) !== platform)
      throw volumeError(404, "Volume not found.");
    if (!platform && (
      resource.userId !== requesterId ||
      resource.ownerKey !== requesterId ||
      resource.classification === "orphan"
    ))
      throw volumeError(404, "Volume not found.");
    return resource;
  };
}
