import Docker from "dockerode";
import { randomUUID } from "node:crypto";
import type { VolumeApplyMode } from "../../shared/managed-volumes";
import type { ContainerInfo } from "../../shared/types";
import { ManagedVolumeStore, PersistencePolicyStore, VolumeRecreationStore, publicVolume, validatePersistenceTarget, volumeError, volumeName, pathsOverlap, type StoredManagedVolume } from "./managed-volume-store";
import { ManagedVolumeRuntime } from "./managed-volume-runtime";
import { useConfig, useContainerManager, useWorkerStore } from "./services";
import { withOwnerWorkerLifecycleMutation as withWorkerMutation } from "./worker-lifecycle-coordinator";
import { instanceSnapshotActive } from "./instance-snapshot-gate";
import { useWorkerProtectionLockStore } from "./worker-protection-lock";
import { requireOrdinaryWorkerSelfAccess } from "./worker-auth";
import { persistentPathVolumeName } from "./persistent-backup-paths";

function withOwnerWorkerLifecycleMutation<T>(userId: string, workerId: string, operation: () => Promise<T>) {
  return withWorkerMutation(userId, workerId, () => {
    if (instanceSnapshotActive()) throw volumeError(409, "Storage changes are unavailable during instance backup or restore. Retry afterwards.");
    return operation();
  });
}

export interface PersistenceActor {
  userId: string;
  workerId: string;
  selfService?: boolean;
  platformAdmin?: boolean;
  lockPassword?: unknown;
  /** Admin adapters recheck delegated scope after entering the lifecycle fence. */
  authorize?: () => void;
}

export class ManagedVolumeManager {
  readonly store: ManagedVolumeStore;
  readonly policies: PersistencePolicyStore;
  readonly runtime: ManagedVolumeRuntime;
  readonly recreations: VolumeRecreationStore;
  private loading?: Promise<void>;
  private operations = new Set<string>();
  private recoveryFailures = new Set<string>();

  constructor(dataDir: string, docker = new Docker({ socketPath: "/var/run/docker.sock" })) {
    this.store = new ManagedVolumeStore(dataDir);
    this.policies = new PersistencePolicyStore(dataDir);
    this.runtime = new ManagedVolumeRuntime(docker, dataDir);
    this.recreations = new VolumeRecreationStore(dataDir);
  }

  init() { return this.loading ??= Promise.all([this.store.init(), this.policies.init(), this.recreations.init()]).then(() => {}); }

  hasActiveOperationsForInstanceSnapshot() { return this.operations.size > 0 || this.recreations.list().length > 0; }
  isRecoveryBlocked(workerId: string) { return this.recoveryFailures.has(workerId); }

  /** Called after deleted-account worker cleanup under the owner's fence.
   * Retains both data and durable administrator handles; deletes no volume. */
  async retainDeletedOwner(userId: string) {
    await this.init();
    for (const v of this.store.listForUser(userId)) {
      if (this.operations.has(v.id) || this.recreations.get(userId, v.workerId) || v.liveContainerId)
        throw volumeError(409, "Complete storage recovery before retaining deleted-account volumes.");
      if ((await this.runtime.docker.listContainers({ all: true, filters: { volume: [v.dockerName] } })).length)
        throw volumeError(409, "A retained account volume still has a runtime reference.");
    }
    await this.store.retainForDeletedOwner(userId);
    await this.policies.removeForUser(userId);
  }

  private worker(actor: PersistenceActor) {
    actor.authorize?.();
    const worker = useWorkerStore().get(actor.userId, actor.workerId);
    if (!worker || worker.deletionPending) throw volumeError(404, "Worker not found.");
    const live = useContainerManager().get(actor.workerId);
    if (live?.administrativeKind) throw volumeError(409, "Custom persistence is currently for ordinary workers only.");
    if (actor.selfService) {
      if (!live || live.userId !== actor.userId) throw volumeError(404, "Worker not found.");
      requireOrdinaryWorkerSelfAccess(live);
      if (!this.policies.policy(actor.userId, actor.workerId).selfService)
        throw volumeError(403, "Worker self-service persistence is disabled.");
    }
    return { record: worker, live };
  }

  private assertDesiredStateEditable(actor: PersistenceActor) {
    if (this.isRecoveryBlocked(actor.workerId) || this.recreations.get(actor.userId, actor.workerId))
      throw volumeError(409, "An interrupted storage recreation must be retried before changing its desired attachments.");
  }

  async inspect(actor: PersistenceActor) {
    await this.init(); this.worker(actor);
    return { policy: this.policies.policy(actor.userId, actor.workerId),
      volumes: this.store.forWorker(actor.userId, actor.workerId).map(publicVolume) };
  }

  async policy(actor: PersistenceActor, input: Record<string, unknown>) {
    if (actor.selfService) throw volumeError(403, "Workers cannot change persistence permissions.");
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      this.worker(actor);
      await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      return this.policies.configure(actor.userId, actor.workerId, input);
    });
  }

  async add(actor: PersistenceActor, input: { target?: unknown; name?: unknown; mode?: unknown; acknowledgePrivileged?: unknown }) {
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      const { live } = this.worker(actor);
      this.assertDesiredStateEditable(actor);
      await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      const target = validatePersistenceTarget(input.target);
      if (!live) throw volumeError(409, "Unarchive the worker before adding persistence.");
      const existing = this.store.forWorker(actor.userId, actor.workerId).find((v) => v.attached && v.target === target);
      if (existing) {
        if (existing.state === "failed" && actor.selfService && !this.operations.has(existing.id)) {
          const mode = this.resolveMode(actor, input.mode, input.acknowledgePrivileged);
          existing.operation = { id: randomUUID(), mode, stage: "queued" };
          await this.store.save(existing);
          if (mode !== "deferred") this.enqueue(actor, existing.id, mode, false);
        }
        return publicVolume(existing);
      }
      await this.runtime.validateTarget(live.containerId, target);
      const mode = this.resolveMode(actor, input.mode, input.acknowledgePrivileged);
      const volume = await this.store.create(actor.userId, actor.workerId, target, input.name as string | undefined);
      volume.operation = { id: randomUUID(), mode, stage: "queued" };
      await this.store.save(volume);
      if (mode !== "deferred") this.enqueue(actor, volume.id, mode, input.acknowledgePrivileged === true);
      return publicVolume(volume);
    });
  }

  private resolveMode(actor: PersistenceActor, raw: unknown, acknowledged: unknown): VolumeApplyMode {
    const policy = this.policies.policy(actor.userId, actor.workerId);
    if (actor.selfService) {
      if (raw !== undefined || acknowledged !== undefined)
        throw volumeError(403, "Workers cannot select a privileged or disruptive application mode.");
      return policy.allowLiveMount ? "live" : policy.allowSelfRecreate ? "recreate" : "deferred";
    }
    const mode = raw ?? "deferred";
    if (mode !== "deferred" && mode !== "recreate" && mode !== "live") throw volumeError(400, "Invalid persistence application mode.");
    if (mode === "live" && !policy.allowLiveMount && acknowledged !== true)
      throw volumeError(409, "Live mounting runs a temporary privileged Agentor helper. Acknowledge this operation or choose recreation.");
    return mode;
  }

  async apply(actor: PersistenceActor, volumeId: string, mode: unknown, acknowledgePrivileged?: unknown) {
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      this.worker(actor);
      await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      if (this.isRecoveryBlocked(actor.workerId)) await this.recoverWorker(actor.userId, actor.workerId);
      const v = this.store.get(actor.userId, volumeId);
      if (!v || v.workerId !== actor.workerId) throw volumeError(404, "Volume not found.");
      if (!v.attached) throw volumeError(409, "Reattach this volume before applying it.");
      if (this.operations.has(volumeId)) return publicVolume(v);
      const selected = this.resolveMode(actor, mode, acknowledgePrivileged);
      v.operation = { id: randomUUID(), mode: selected, stage: "queued" };
      await this.store.save(v);
      if (selected !== "deferred") this.enqueue(actor, v.id, selected, acknowledgePrivileged === true);
      return publicVolume(v);
    });
  }

  private enqueue(actor: PersistenceActor, volumeId: string, mode: VolumeApplyMode, acknowledged: boolean) {
    if (this.operations.has(volumeId)) return;
    this.operations.add(volumeId);
    setImmediate(() => {
      void withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
        const v = this.store.get(actor.userId, volumeId);
        if (!v) return;
        try {
          const { live } = this.worker(actor);
          if (!live) throw volumeError(409, "Worker runtime is unavailable.");
          await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
          // Recheck policy after queueing; a revoke must take effect immediately.
          if (actor.selfService) {
            const policy = this.policies.policy(actor.userId, actor.workerId);
            if ((mode === "live" && !policy.allowLiveMount) || (mode === "recreate" && !policy.allowSelfRecreate))
              throw volumeError(403, "Self-service application authorization was revoked.");
          } else this.resolveMode(actor, mode, acknowledged);
          if (!v.attached && (actor.selfService || mode !== "recreate")) throw volumeError(409, "Attachment was removed before application.");
          v.state = "preparing";
          v.operation!.stage = mode === "live" ? "mounting" : "recreating";
          await this.store.save(v);
          if (mode === "live") await this.live(live, v);
          else await useContainerManager().applyManagedStorageUnlocked(actor.workerId);
          const current = this.store.get(actor.userId, volumeId)!;
          current.state = current.attached ? "ready" : "detached";
          current.operation!.stage = "complete";
          await this.store.save(current);
        } catch (error: any) {
          const current = this.store.get(actor.userId, volumeId);
          if (current) {
            current.state = "failed";
            current.operation = { id: current.operation?.id ?? randomUUID(), mode, stage: "failed",
              error: error?.storageSafeError && typeof error.message === "string" ? error.message.slice(0, 400) : "Persistence operation failed. Original data was retained; inspect the runtime and retry or choose recreation." };
            await this.store.save(current);
          }
        }
      }).catch(() => {}).finally(() => this.operations.delete(volumeId));
    });
  }

  private async live(worker: ContainerInfo, v: StoredManagedVolume) {
    const before = await this.runtime.validateTarget(worker.containerId, v.target, v.seeded ? v.dockerName : undefined);
    if (v.seeded && before.Mounts.some((m) => m.Name === v.dockerName && m.Destination === v.target)) return;
    if (!before.State.Running || before.State.Paused) throw volumeError(409, "Live mounting requires a running, unpaused worker.");
    if (v.liveContainerId) await this.recoverLive(v);
    if (v.seeded && v.liveContainerId === worker.containerId) return;
    if (!v.seeded && await this.runtime.inspectVolume(v)) await this.runtime.removeStaging(v);
    // Durable intent precedes Docker mutation. After daemon restart this worker
    // must be recreated with declared mounts, never run over the old directory.
    v.liveContainerId = worker.containerId;
    v.previousRestartPolicy = before.HostConfig.RestartPolicy;
    await this.store.save(v);
    const container = this.runtime.docker.getContainer(worker.containerId);
    await container.update({ RestartPolicy: { Name: "no" } });
    await container.pause();
    let safeToResume = false;
    try {
      await this.runtime.mountLive(worker.containerId, v);
      v.seeded = true;
      await this.store.save(v);
      safeToResume = true;
    } catch (error) {
      // A syscall may have committed before an HTTP timeout. Stop the helper
      // and prove identity before deciding whether writers may resume.
      await this.runtime.removeHelpers(v);
      if (await this.runtime.mountLive(worker.containerId, v, true)) {
        v.seeded = true;
        await this.store.save(v);
        safeToResume = true;
      } else {
        if (!v.seeded) await this.runtime.removeStaging(v);
        delete v.liveContainerId;
        await this.store.save(v);
        await container.update({ RestartPolicy: v.previousRestartPolicy ?? { Name: "no" } });
        safeToResume = true;
      }
      throw error;
    } finally {
      if (safeToResume) await container.unpause();
    }
  }

  /** Called inside the worker lifecycle fence, before discarding its rootfs. */
  async prepare(worker: Pick<ContainerInfo, "id" | "userId" | "containerId">) {
    await this.init();
    const volumes = this.store.forWorker(worker.userId, worker.id).filter((v) => v.attached);
    if (volumes.some((v) => !v.seeded)) {
      const source = await this.runtime.inspect(worker.containerId);
      if (source.State.Paused) throw volumeError(409, "Interrupted live mount requires recovery before recreation.");
      if (source.State.Running) await this.runtime.docker.getContainer(worker.containerId).stop({ t: 15 });
    }
    for (const v of volumes) {
      if (!v.seeded) {
        await this.runtime.removeHelpers(v);
        if (await this.runtime.inspectVolume(v)) await this.runtime.removeStaging(v);
        await this.runtime.seed(worker.containerId, v);
        v.seeded = true;
        await this.store.save(v);
      }
      await this.runtime.ensureVolume(v);
    }
    return this.mounts(worker.userId, worker.id);
  }

  async mounts(userId: string, workerId: string) {
    await this.init();
    const result = [];
    for (const v of this.store.forWorker(userId, workerId).filter((v) => v.attached)) {
      if (!v.seeded) throw volumeError(409, "Persistence is pending. Apply it before starting a replacement worker.");
      await this.runtime.ensureVolume(v);
      result.push({ source: v.dockerName, target: v.target });
    }
    return result;
  }

  async requiresRecreation(userId: string, workerId: string, containerId?: string) {
    await this.init();
    if (this.isRecoveryBlocked(workerId) || this.recreations.get(userId, workerId)) return true;
    const volumes = this.store.forWorker(userId, workerId);
    if (!volumes.length) return false;
    if (!containerId) return volumes.some((v) => !!v.liveContainerId);
    const actual = await this.runtime.inspect(containerId);
    return volumes.some((v) => {
      const declared = actual.Mounts.some((m) => m.Name === v.dockerName && m.Destination === v.target);
      return v.attached ? v.seeded && !declared || !!v.liveContainerId && !declared : declared || !!v.liveContainerId;
    });
  }

  async detach(actor: PersistenceActor, volumeId: string, applyNow: boolean, confirmed: boolean) {
    if (actor.selfService) throw volumeError(403, "Workers cannot remove persistence.");
    if (!confirmed) throw volumeError(409, "Confirm detachment: the volume is retained, but the path will expose its underlying directory after recreation.");
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      this.worker(actor);
      this.assertDesiredStateEditable(actor);
      await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      const v = this.store.get(actor.userId, volumeId);
      if (!v || v.workerId !== actor.workerId) throw volumeError(404, "Volume not found.");
      v.attached = false;
      v.state = "detached";
      v.operation = { id: randomUUID(), mode: applyNow ? "recreate" : "deferred", stage: "queued" };
      await this.store.save(v);
      if (applyNow) this.enqueue(actor, v.id, "recreate", false);
      return publicVolume(v);
    });
  }

  async reattach(actor: PersistenceActor, volumeId: string, mode: unknown, acknowledgePrivileged?: unknown) {
    if (actor.selfService) throw volumeError(403, "Workers may add new paths, not reassign retained volumes.");
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      const { live } = this.worker(actor);
      this.assertDesiredStateEditable(actor);
      await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      const v = this.store.get(actor.userId, volumeId);
      if (!v || v.workerId !== actor.workerId) throw volumeError(404, "Volume not found.");
      if (v.attached) return publicVolume(v);
      if (!live) throw volumeError(409, "Unarchive the worker before reattaching storage.");
      if (this.store.forWorker(actor.userId, actor.workerId).some((other) => other.id !== v.id && other.attached && pathsOverlap(v.target, other.target)))
        throw volumeError(409, "Another desired attachment overlaps this path.");
      await this.runtime.validateTarget(live.containerId, v.target, v.dockerName);
      if (v.seeded) await this.runtime.ensureVolume(v);
      const selected = this.resolveMode(actor, mode, acknowledgePrivileged);
      v.attached = true; v.state = "pending";
      v.operation = { id: randomUUID(), mode: selected, stage: "queued" };
      await this.store.save(v);
      if (selected !== "deferred") this.enqueue(actor, v.id, selected, acknowledgePrivileged === true);
      return publicVolume(v);
    });
  }

  async rename(actor: PersistenceActor, volumeId: string, name: unknown) {
    if (actor.selfService) throw volumeError(403, "Workers cannot change retained volume metadata.");
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      actor.authorize?.();
      const v = this.store.get(actor.userId, volumeId);
      if (!v || v.workerId !== actor.workerId) throw volumeError(404, "Volume not found.");
      if (v.retainedAfterAccountDeletion && !actor.platformAdmin) throw volumeError(404, "Volume not found.");
      if (!v.retainedAfterAccountDeletion) await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      v.name = volumeName(name, v.name); await this.store.save(v); return publicVolume(v);
    });
  }

  async delete(actor: PersistenceActor, volumeId: string, confirmed: boolean) {
    if (actor.selfService) throw volumeError(403, "Workers cannot delete persistence.");
    if (!confirmed) throw volumeError(409, "Explicit confirmation is required to permanently delete volume data.");
    await this.init();
    return withOwnerWorkerLifecycleMutation(actor.userId, actor.workerId, async () => {
      actor.authorize?.();
      const v = this.store.get(actor.userId, volumeId);
      if (!v || v.workerId !== actor.workerId) throw volumeError(404, "Volume not found.");
      if (v.retainedAfterAccountDeletion && !actor.platformAdmin) throw volumeError(404, "Volume not found.");
      if (!v.retainedAfterAccountDeletion) await useWorkerProtectionLockStore().verify(actor.workerId, actor.lockPassword);
      if (v.attached || v.liveContainerId || this.operations.has(v.id) || this.recreations.get(actor.userId, actor.workerId))
        throw volumeError(409, "Detach and apply the worker configuration before deleting this volume.");
      const references = await this.runtime.docker.listContainers({ all: true, filters: { volume: [v.dockerName] } });
      if (references.length) throw volumeError(409, "Volume is still referenced by a container; it was not deleted.");
      if (await this.runtime.inspectVolume(v)) await this.runtime.docker.getVolume(v.dockerName).remove();
      await this.store.forget(actor.userId, v.id);
      return { id: v.id, deleted: true };
    });
  }

  /** Preserve user-created storage even when its worker is permanently removed. */
  async workerDeleted(userId: string, workerId: string) {
    await this.init();
    for (const v of this.store.forWorker(userId, workerId)) {
      v.attached = false; v.state = "detached";
      delete v.liveContainerId; delete v.previousRestartPolicy;
      await this.store.save(v);
    }
  }

  async markDeclared(userId: string, workerId: string, containerId: string) {
    await this.init();
    if (!this.store.forWorker(userId, workerId).length) return;
    const actual = await this.runtime.inspect(containerId);
    for (const v of this.store.forWorker(userId, workerId)) {
      if (v.attached) await this.runtime.ensureVolume(v);
      if (v.attached && !actual.Mounts.some((m) => m.Name === v.dockerName && m.Destination === v.target))
        throw volumeError(409, "Replacement is missing a required volume attachment.");
      delete v.liveContainerId;
      delete v.previousRestartPolicy;
      if (v.attached && v.seeded) v.state = "ready";
      await this.store.save(v);
    }
  }

  /** Must run before ContainerManager.sync sees duplicate rollback identities. */
  async recoverStartup() {
    await this.init();
    const workers = new Map<string, string>();
    for (const worker of useWorkerStore().list()) workers.set(worker.id, worker.userId);
    for (const v of this.store.list()) workers.set(v.workerId, v.userId);
    for (const journal of this.recreations.list()) workers.set(journal.workerId, journal.userId);
    for (const [workerId, userId] of workers) {
      try { await this.recoverWorker(userId, workerId); }
      catch {
        this.recoveryFailures.add(workerId);
        for (const v of this.store.forWorker(userId, workerId)) {
          v.state = "failed";
          v.operation = { id: v.operation?.id ?? randomUUID(), mode: v.operation?.mode ?? "deferred", stage: "failed",
            error: "Storage recovery needs attention. Data and runtime state were retained. Restore missing storage, then retry application or restart." };
          await this.store.save(v);
        }
        const { useLogger } = await import("./services");
        useLogger().warn(`[storage] recovery quarantined worker ${workerId}; unrelated workers remain available`);
      }
    }
  }

  /** Explicit retries use the same recovery as boot, under the worker fence. */
  async recoverWorker(userId: string, workerId: string) {
    await this.init();
    // Adopt without renaming or recopying before any backup edit can remove
    // the old coupling. Actual mounts also recover paths removed from a legacy
    // backup selection while their volume was still attached.
    const { useBackupManager } = await import("./backup-manager");
    const worker = useWorkerStore().get(userId, workerId);
    if (worker) {
      const config = await useBackupManager().getConfig(worker.userId);
      const paths = [...(config?.selectedPathsByWorkspace?.[worker.id] ?? [])];
      const actual = await this.inspectOptional(useContainerManager().buildContainerName(worker.id));
      if (actual?.Config.Labels?.["agentor.id"] === worker.id)
        for (const mount of actual.Mounts ?? [])
          if (mount.Name === persistentPathVolumeName(worker.id, mount.Destination)) paths.push(mount.Destination);
      await this.adoptLegacy(worker.userId, worker.id, [...new Set(paths)]);
    }
    const journal = this.recreations.get(userId, workerId);
    if (journal) {
      const original = await this.inspectOptional(journal.originalId);
      const next = await this.inspectOptional(journal.replacementId ?? journal.containerName);
      if (next && next.Id !== journal.originalId) {
        if (next.Config.Labels?.["agentor.id"] !== journal.workerId)
          throw volumeError(409, "Storage recovery found an unexpected replacement identity.");
        await this.markDeclared(journal.userId, journal.workerId, next.Id);
        if (original) {
          if (original.State.Running) await this.runtime.docker.getContainer(original.Id).stop({ t: 15 });
          await this.runtime.docker.getContainer(original.Id).remove();
        }
      } else if (original) {
        if (original.Config.Labels?.["agentor.id"] !== journal.workerId)
          throw volumeError(409, "Storage recovery found an unexpected source identity.");
        if (original.Name !== `/${journal.containerName}`)
          await this.runtime.docker.getContainer(original.Id).rename({ name: journal.containerName });
      } else throw volumeError(409, "Storage recovery cannot find either runtime. Volumes were retained.");
      await this.recreations.clear(journal.userId, journal.workerId);
    }
    for (const v of this.store.forWorker(userId, workerId)) {
      if (v.attached && v.seeded) await this.runtime.ensureVolume(v);
      if (v.liveContainerId) await this.recoverLive(v);
      else if (v.state === "preparing" || v.operation?.stage === "queued" && v.operation.mode !== "deferred") {
        v.state = "failed";
        if (v.operation) { v.operation.stage = "failed"; v.operation.error = "Operation was interrupted. Original data is retained; retry application."; }
        await this.store.save(v);
      }
    }
    this.recoveryFailures.delete(workerId);
  }

  private async inspectOptional(id: string) {
    try { return await this.runtime.inspect(id); }
    catch (error: any) { if (error?.statusCode === 404) return undefined; throw error; }
  }

  async recoverLive(v: StoredManagedVolume) {
    if (!v.liveContainerId) return;
    await this.runtime.removeHelpers(v);
    const actual = await this.inspectOptional(v.liveContainerId);
    if (actual && actual.Config.Labels?.["agentor.id"] !== v.workerId)
      throw volumeError(409, "Live-mount source identity no longer matches.");
    if (actual?.State.Running) {
      const container = this.runtime.docker.getContainer(actual.Id);
      if (!actual.State.Paused) await container.pause();
      if (await this.runtime.mountLive(actual.Id, v, true)) {
        v.seeded = true;
        v.state = "ready";
        if (v.operation) v.operation.stage = "complete";
        await this.store.save(v);
        await container.unpause();
        return;
      }
      if (v.seeded) {
        // A previously populated mount vanished. Do not let applications run
        // on the stale directory; normal desired-runtime reconciliation will
        // replace this stopped container with declared mounts.
        // Docker delivers SIGKILL before thawing a paused container. Never
        // unpause first: even a short scheduling window would permit writes
        // into the obsolete underlying directory.
        await container.kill({ signal: "SIGKILL" });
        await container.wait();
        return;
      }
      await this.runtime.removeStaging(v);
      delete v.liveContainerId;
      v.state = "failed";
      if (v.operation) { v.operation.stage = "failed"; v.operation.error = "Live mount was interrupted before commitment. Original data retained; retry."; }
      await this.store.save(v);
      await container.update({ RestartPolicy: v.previousRestartPolicy ?? { Name: "no" } });
      await container.unpause();
    } else if (!v.seeded) {
      await this.runtime.removeStaging(v);
      delete v.liveContainerId;
      v.state = "failed";
      await this.store.save(v);
    }
  }

  async adoptLegacy(userId: string, workerId: string, paths: string[]) {
    await this.init();
    for (const target of paths) {
      if (target === "/" || this.store.forWorker(userId, workerId).some((v) => v.target === target)) continue;
      const stamp = new Date().toISOString();
      const record: StoredManagedVolume = { id: randomUUID(), userId, workerId, target,
        name: target.split("/").pop() || target, dockerName: persistentPathVolumeName(workerId, target),
        purpose: "legacy-backup-path", attached: true, seeded: true, state: "ready", createdAt: stamp, updatedAt: stamp };
      if (await this.runtime.inspectVolume(record)) await this.store.save(record);
    }
  }
}

let singleton: ManagedVolumeManager | undefined;
export function useManagedVolumeManager() { return singleton ??= new ManagedVolumeManager(useConfig().dataDir); }
