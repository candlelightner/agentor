import { getAuthDb } from './auth';
import { instanceSnapshotActive } from './instance-snapshot-gate';
import type { UserEnvVarStore } from './user-env-store';
import type { UserCredentialManager } from './user-credentials';
import type { UsageChecker } from './usage-checker';
import type { WorkerStore } from './worker-store';
import type { PortMappingStore } from './port-mapping-store';
import type { DomainMappingStore } from './domain-mapping-store';
import type { EnvironmentStore } from './environments';
import type { CapabilityStore } from './capability-store';
import type { InstructionStore } from './instruction-store';
import type { InitScriptStore } from './init-script-store';
import type { ExportJobManager } from './export-jobs';
import { listWorkspaceTombstones, removeWorkspaceTombstonesForUser } from './workspace-tombstones';
import { useGitImageCatalogManager } from './git-image-manager';
import { withOwnerLifecycleMutation } from './worker-lifecycle-coordinator';

/** Acquire the owner mutation fence before the final existence check and any
 * destructive cleanup. Returning false means the owner was recreated while a
 * stale sweep candidate waited for the fence and nothing was touched. */
export function withDeletedOwnerCleanupFence(
  userId: string,
  ownerExists: () => boolean | Promise<boolean>,
  cleanup: () => Promise<void>,
): Promise<boolean> {
  return withOwnerLifecycleMutation(userId, async () => {
    if (await ownerExists()) return false;
    await cleanup();
    return true;
  });
}

/** Remove per-user data whose owning user has been deleted from the auth DB.
 * Called once at startup and on a 10-minute interval so orphaned per-user
 * records (env vars, credentials, usage, workers, mappings, environments,
 * capabilities, instructions, init scripts) eventually go away after an admin
 * deletes a user. No middleware — avoids any risk of interfering with
 * better-auth's body parsing on the delete-user endpoint. */
export class OrphanSweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweepInFlight?: Promise<void>;
  private preCleanupHooks: Array<(userId: string) => Promise<void>> = [];
  private lifecycleCleanupHooks: Array<(userId: string) => Promise<void>> = [];
  private cleanupHooks: Array<(userId: string) => Promise<void>> = [];
  private candidateSources: Array<() => string[] | Promise<string[]>> = [];

  constructor(
    private envStore: UserEnvVarStore,
    private credMgr: UserCredentialManager,
    private usage: UsageChecker,
    private workerStore: WorkerStore,
    private portStore: PortMappingStore,
    private domainStore: DomainMappingStore,
    private environmentStore: EnvironmentStore,
    private capabilityStore: CapabilityStore,
    private instructionStore: InstructionStore,
    private initScriptStore: InitScriptStore,
    private exportJobs: ExportJobManager,
  ) {}

  addPreCleanupHook(hook: (userId: string) => Promise<void>) { this.preCleanupHooks.push(hook); }
  /** Destructive runtime cleanup that must succeed before durable owner stores
   * are removed. Runs while the shared owner lifecycle fence is held. */
  addLifecycleCleanupHook(hook: (userId: string) => Promise<void>) { this.lifecycleCleanupHooks.push(hook); }
  addCleanupHook(hook: (userId: string) => Promise<void>) { this.cleanupHooks.push(hook); }
  addCandidateSource(source: () => string[] | Promise<string[]>) { this.candidateSources.push(source); }

  start(intervalMs = 10 * 60 * 1000): void {
    this.sweep().catch((err) => {
      useLogger().error(`[orphan-sweeper] initial sweep failed: ${err instanceof Error ? err.message : err}`);
    });
    this.timer = setInterval(() => {
      this.sweep().catch((err) => {
        useLogger().error(`[orphan-sweeper] sweep failed: ${err instanceof Error ? err.message : err}`);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  sweep(): Promise<void> {
    if (instanceSnapshotActive()) return Promise.resolve();
    if (this.sweepInFlight) return this.sweepInFlight;
    const task = this.doSweep().finally(() => {
      if (this.sweepInFlight === task) this.sweepInFlight = undefined;
    });
    this.sweepInFlight = task;
    return task;
  }

  hasActiveOperationsForInstanceSnapshot(): boolean {
    return Boolean(this.sweepInFlight);
  }

  private async doSweep(): Promise<void> {
    const existingIds = new Set<string>();
    try {
      const rows = getAuthDb().prepare('SELECT id FROM user').all() as { id: string }[];
      for (const r of rows) existingIds.add(r.id);
    } catch {
      // Auth DB not ready yet — nothing to sweep.
      return;
    }

    // Collect every user id that has any per-user state on disk. Scanning all
    // of the stores (env vars, workers, mappings, environments, etc.) ensures
    // we clean up even if a user was created but never saved env vars.
    const candidates = new Set<string>();
    for (const entry of this.envStore.list()) candidates.add(entry.userId);
    for (const userId of await this.credMgr.listUserIds()) candidates.add(userId);
    for (const entry of await listWorkspaceTombstones()) candidates.add(entry.userId);
    for (const userId of useGitImageCatalogManager().ownerIds()) candidates.add(userId);
    for (const source of this.candidateSources) for (const userId of await source()) candidates.add(userId);
    for (const store of [
      this.workerStore,
      this.portStore,
      this.domainStore,
      this.environmentStore,
      this.capabilityStore,
      this.instructionStore,
      this.initScriptStore,
      this.exportJobs,
    ]) {
      for (const userId of store.listUserIds()) candidates.add(userId);
    }

    let removed = 0;
    for (const userId of candidates) {
      if (existingIds.has(userId)) continue;
      let ownerCleanupSucceeded = false;
      await withDeletedOwnerCleanupFence(
        userId,
        () => Boolean(
          getAuthDb()
            .prepare('SELECT 1 FROM user WHERE id = ?')
            .get(userId),
        ),
        async () => {
          // Pre-cleanup hooks are destructive mutation barriers (for example,
          // aborting and deleting owner backups). They must run only after the
          // final owner revalidation and while the same owner fence remains
          // held, otherwise a stale candidate can erase a recreated account.
          for (const hook of this.preCleanupHooks) await hook(userId);

          // Runtime resources are authoritative and must be removed before their
          // WorkerStore handles. A Docker failure keeps all owner records intact
          // so the next sweep can retry instead of leaking an untracked worker.
          for (const hook of this.lifecycleCleanupHooks) await hook(userId);

          await this.envStore.delete(userId);
          await this.workerStore.removeForUser(userId);
          await this.portStore.removeForUser(userId);
          await this.domainStore.removeForUser(userId);
          await this.environmentStore.removeForUser(userId);
          await this.capabilityStore.removeForUser(userId);
          await this.instructionStore.removeForUser(userId);
          await this.initScriptStore.removeForUser(userId);
          await this.exportJobs.removeForUser(userId);
          await removeWorkspaceTombstonesForUser(userId);
          await useGitImageCatalogManager().forgetOwner(userId);
          for (const hook of this.cleanupHooks) await hook(userId);
          await this.usage.forgetUser(userId);
          // Removing the user's top-level dir cleans up any remaining files
          // (workspaces/, agents/, credentials/) that the stores don't manage.
          await this.credMgr.removeUserData(userId);
          removed++;
          ownerCleanupSucceeded = true;
        },
      ).catch((error) => {
        useLogger().warn(
          `[orphan-sweeper] deferred runtime cleanup for ${userId}: ${error instanceof Error ? error.message : error}`,
        );
      });
      if (!ownerCleanupSucceeded) continue;
    }
    if (removed > 0) {
      useLogger().info(`[orphan-sweeper] cleaned up ${removed} orphaned per-user record(s)`);
    }
  }
}
