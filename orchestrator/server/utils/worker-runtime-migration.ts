import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import type { RuntimeSnapshotIdentity, WorkerRuntimeProfile } from '../../shared/types';
import type { WorkerRecord } from './worker-store';
import { validRuntimeSnapshotIdentity } from './worker-store';
import { UserScopedJsonStore } from './user-scoped-store';
import { assertWorkerRuntimeMatches, resolveWorkerRuntimePolicy, resolveWorkerRuntimeProfile } from './worker-runtime-policy';
import { withOperationDeadline, operationSettlement } from './operation-deadline';
import { runtimeSnapshotEnvironment } from './worker-runtime-snapshot';

export type RuntimeMigrationPhase = 'prepared' | 'stopped' | 'snapshots' | 'replacement' | 'validated' | 'committed' | 'rollback' | 'rolled-back' | 'recovery-required';
export interface RuntimeMigrationMount {
  type: 'volume' | 'bind'; source: string; target: string; backup: string;
  copied: boolean;
}
export interface RuntimeMigrationJournal {
  version: 1; operationId: string; userId: string; workerId: string;
  phase: RuntimeMigrationPhase; createdAt: string; updatedAt: string;
  sourceId: string; sourceName: string; rollbackName: string; replacementId?: string;
  sourceImage: string; sourceImageId: string;
  sourceRunning: boolean; sourceRestartPolicy: Docker.HostRestartPolicy;
  targetProfile: WorkerRuntimeProfile; sourceRecord: WorkerRecord;
  snapshotImage: string; mounts: RuntimeMigrationMount[]; replacementMayHaveRun: boolean;
  snapshotIdentity?: RuntimeSnapshotIdentity;
  helperImage: string;
  uncertainOperation?: boolean;
  inFlightOperation?: string;
  expectedMounts: Array<{ type: string; source: string; target: string; readOnly: boolean }>;
  error?: string;
}

const terminal = (phase: RuntimeMigrationPhase) => phase === 'committed' || phase === 'rolled-back';
export class RuntimeMigrationStore extends UserScopedJsonStore<string, RuntimeMigrationJournal> {
  constructor(dataDir: string) {
    super(dataDir, 'worker-runtime-migrations.v1.json', (j) => {
      if (!j || j.version !== 1 || !/^[a-zA-Z0-9_-]+$/.test(j.workerId) ||
          !/^[a-zA-Z0-9_-]+$/.test(j.operationId) || j.sourceRecord?.id !== j.workerId ||
          j.sourceRecord?.userId !== j.userId || !/^[a-f0-9]{64}$/.test(j.sourceId) ||
          !['prepared', 'stopped', 'snapshots', 'replacement', 'validated', 'committed', 'rollback', 'rolled-back', 'recovery-required'].includes(j.phase) ||
          !['kata-qemu', 'legacy-runc'].includes(j.targetProfile) ||
          j.rollbackName !== `${j.sourceName}-runtime-rollback-${j.operationId}` ||
          j.snapshotImage !== `agentor-import-${j.workerId}:runtime-${j.operationId}` ||
          (j.snapshotIdentity !== undefined && !validRuntimeSnapshotIdentity(j.snapshotIdentity, j.snapshotImage, j.workerId)) ||
          !/^sha256:[a-f0-9]{64}$/.test(j.helperImage) ||
          !Array.isArray(j.expectedMounts) || j.expectedMounts.some((m) => (typeof m.source !== 'string' || (!m.source && m.type !== 'tmpfs')) || !m.target?.startsWith('/') || typeof m.readOnly !== 'boolean') ||
          (j.replacementId !== undefined && !/^[a-f0-9]{64}$/.test(j.replacementId)) ||
          !Array.isArray(j.mounts) || j.mounts.some((m, i) =>
            !['volume', 'bind'].includes(m.type) || !m.source || !m.target.startsWith('/') ||
            m.backup !== `agentor-runtime-backup-${j.operationId}-${i}` || typeof m.copied !== 'boolean'))
        throw new Error('Invalid worker runtime migration journal');
      return j.workerId;
    });
  }
  async save(j: RuntimeMigrationJournal) { this.keyFn(j); await this.setItem(j.userId, { ...j, updatedAt: new Date().toISOString() }); }
  async clear(userId: string, workerId: string) { await this.deleteItem(userId, workerId); }
  pending() { return this.list().filter((j) => !terminal(j.phase)); }
  hasUnavailableOwners() {
    return this.listUserIds().some((userId) => { try { this.listForUser(userId); return false; } catch { return true; } });
  }
  isBlocked(userId: string, workerId: string) { const j = this.get(userId, workerId); return !!j && !terminal(j.phase); }
}

export interface RuntimeMigrationPlan {
  workerId: string; sourceProfile: WorkerRuntimeProfile; targetProfile: WorkerRuntimeProfile;
  downtimeRequired: true; writableRootfs: 'stopped-container-image-snapshot';
  persistentData: 'copy-before-start-and-restore-on-rollback';
  sharedAccountState: 'preserved-shared-bindings-not-rewound';
  capacityAdmission: 'not-yet-implemented';
  mounts: Array<{ target: string; kind: 'worker-owned' | 'shared-account' | 'read-only' | 'ephemeral' }>;
}

export interface RuntimeMigrationInput {
  record: WorkerRecord; sourceId: string; sourceName: string; targetProfile: WorkerRuntimeProfile;
  /** Exact server-derived writable bindings, never request-provided paths. */
  ownedBindings: Array<{ source: string; target: string; type: 'volume' | 'bind' }>;
  sharedBindings: Array<{ source: string; target: string }>;
}
export interface RuntimeMigrationCallbacks {
  trustedHelperImage(): Promise<string>;
  authorize(): Promise<void>;
  assertAvailable(profile: WorkerRuntimeProfile): Promise<void>;
  validate(containerId: string, record: WorkerRecord): Promise<void>;
  commit(journal: RuntimeMigrationJournal, replacementId: string): Promise<void>;
  restore(journal: RuntimeMigrationJournal): Promise<void>;
}

/** All mutations run under the owner/worker lifecycle fence. Journal intent is
 * durable before stop/rename/start. Rollback never deletes the source container,
 * snapshot image, or backup volumes, including after a failed rollback. */
export class WorkerRuntimeMigration {
  readonly docker: Docker;
  private activeJournal?: RuntimeMigrationJournal;
  constructor(docker: Docker, readonly store: RuntimeMigrationStore,
    private readonly callbacks: RuntimeMigrationCallbacks) {
    this.docker = boundedDocker(docker, async (operation) => this.markInFlight(operation), async () => this.clearInFlight());
  }

  private async markInFlight(operation: string) {
    if (!this.activeJournal) return;
    this.activeJournal.inFlightOperation = operation;
    await this.store.save(this.activeJournal);
  }
  private async clearInFlight() {
    if (!this.activeJournal) return;
    const next = { ...this.activeJournal }; delete next.inFlightOperation;
    await this.store.save(next);
    delete this.activeJournal.inFlightOperation;
  }

  async preflight(input: RuntimeMigrationInput): Promise<{ plan: RuntimeMigrationPlan; source: Docker.ContainerInspectInfo; owned: RuntimeMigrationInput['ownedBindings'] }> {
    if (input.record.runtimeRestoreApprovalRequired)
      throw migrationError('Restored worker requires destination runtime approval', 'WORKER_RUNTIME_RESTORE_APPROVAL_REQUIRED');
    if (input.record.status !== 'active' || input.record.deletionPending || input.record.pendingRebuild)
      throw migrationError('Migration requires an active worker with no pending settings or deletion');
    if (this.store.isBlocked(input.record.userId, input.record.id))
      throw migrationError('An interrupted runtime migration requires recovery');
    if (this.store.get(input.record.userId, input.record.id))
      throw migrationError('A previous migration retains rollback evidence; administrator cleanup is required before another migration');
    const profile = resolveWorkerRuntimeProfile(input.record.runtimeProfile);
    if (profile === input.targetProfile) throw migrationError('Worker already uses the requested runtime');
    const source = await this.docker.getContainer(input.sourceId).inspect();
    // Read the immutable source image before downtime. Runtime-injected account
    // values must not become permanent image defaults after a Docker commit.
    const sourceImage = await this.docker.getImage(source.Image).inspect();
    if (!sourceImage.Config) throw migrationError('Source image configuration is unavailable');
    if (source.Id !== input.sourceId || source.Name !== `/${input.sourceName}` || source.Config.Labels?.['agentor.id'] !== input.record.id)
      throw migrationError('Migration source identity changed');
    assertWorkerRuntimeMatches(profile, source.HostConfig.Runtime, source.HostConfig.Privileged === true, input.record.legacyPrivilegeGrant);
    const dockerEnabled = inspectedSourceDockerEnabled(source.Config.Env);
    resolveWorkerRuntimePolicy({ runtimeProfile: input.targetProfile, dockerEnabled,
      ...(input.targetProfile === 'legacy-runc' ? { legacyPrivilegeGrant: 'admin' as const } : {}) });
    await this.callbacks.assertAvailable(input.targetProfile);
    if (source.State.Paused || source.State.Restarting || source.State.Dead)
      throw migrationError('Resolve the source container state before migration');
    const host = source.HostConfig;
    if (host.Devices?.length || host.DeviceRequests?.length || host.VolumesFrom?.length ||
        host.PidMode === 'host' || host.IpcMode === 'host' ||
        host.NetworkMode === 'host' || host.NetworkMode?.startsWith('container:') ||
        host.PidMode?.startsWith('container:') || host.IpcMode?.startsWith('container:'))
      throw migrationError('Migration does not support host devices or shared host/container namespaces');
    if (Object.values(source.NetworkSettings.Networks ?? {}).some((n) => n.IPAMConfig?.IPv4Address || n.IPAMConfig?.IPv6Address))
      throw migrationError('Migration cannot retain an explicit network IP reservation while keeping its rollback source');
    const owned: RuntimeMigrationInput['ownedBindings'] = [];
    const mounts: RuntimeMigrationPlan['mounts'] = [];
    for (const m of source.Mounts ?? []) {
      const sourceRef = m.Type === 'volume' ? m.Name : m.Source;
      if (m.Type === 'tmpfs' && m.Destination === '/run/agentor-secrets' && source.HostConfig.Tmpfs?.[m.Destination]) {
        mounts.push({ target: m.Destination, kind: 'ephemeral' }); continue;
      }
      if (!m.RW) { mounts.push({ target: m.Destination, kind: 'read-only' }); continue; }
      if (m.Type === 'bind' && input.sharedBindings.some((b) => b.source === sourceRef && b.target === m.Destination)) {
        mounts.push({ target: m.Destination, kind: 'shared-account' }); continue;
      }
      const match = input.ownedBindings.find((b) => b.type === m.Type && b.source === sourceRef && b.target === m.Destination);
      if (!match) throw migrationError(`Writable mount ${m.Destination} has no supported worker-owned rollback policy`);
      if (m.Type === 'volume') {
        const volume = await this.docker.getVolume(sourceRef!).inspect();
        if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length)
          throw migrationError(`Volume at ${m.Destination} uses unsupported external storage`);
        const users = await this.docker.listContainers({ all: true, filters: { volume: [sourceRef!] } });
        if (users.some((container) => container.Id !== source.Id))
          throw migrationError(`Volume at ${m.Destination} is shared with another container`);
      }
      owned.push(match);
      mounts.push({ target: m.Destination, kind: 'worker-owned' });
    }
    for (const binding of input.ownedBindings)
      if (!source.Mounts.some((m) => m.Destination === binding.target && (m.Type === 'volume' ? m.Name : m.Source) === binding.source))
        throw migrationError(`Expected persistent mount ${binding.target} is missing`);
    return { source, owned, plan: { workerId: input.record.id, sourceProfile: profile,
      targetProfile: input.targetProfile, downtimeRequired: true,
      writableRootfs: 'stopped-container-image-snapshot', persistentData: 'copy-before-start-and-restore-on-rollback',
      sharedAccountState: 'preserved-shared-bindings-not-rewound', capacityAdmission: 'not-yet-implemented', mounts } };
  }

  async migrate(input: RuntimeMigrationInput): Promise<RuntimeMigrationJournal> {
    const { source, owned } = await this.preflight(input);
    const operationId = randomUUID();
    const j: RuntimeMigrationJournal = {
      version: 1, operationId, userId: input.record.userId, workerId: input.record.id,
      phase: 'prepared', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      sourceId: source.Id, sourceName: input.sourceName,
      sourceImage: source.Config.Image, sourceImageId: source.Image,
      rollbackName: `${input.sourceName}-runtime-rollback-${operationId}`,
      sourceRunning: source.State.Running, sourceRestartPolicy: source.HostConfig.RestartPolicy ?? { Name: 'no' },
      targetProfile: input.targetProfile, sourceRecord: structuredClone(input.record),
      snapshotImage: `agentor-import-${input.record.id}:runtime-${operationId}`,
      helperImage: await this.callbacks.trustedHelperImage(),
      expectedMounts: source.Mounts.map((m) => ({ type: m.Type, source: m.Type === 'volume' ? m.Name! : m.Source,
        target: m.Destination, readOnly: !m.RW })),
      mounts: owned.map((m, i) => ({ ...m, backup: `agentor-runtime-backup-${operationId}-${i}`, copied: false })),
      replacementMayHaveRun: false,
    };
    await this.store.save(j);
    this.activeJournal = j;
    try {
      const old = this.docker.getContainer(j.sourceId);
      await old.update({ RestartPolicy: { Name: 'no' } });
      if (source.State.Running) await old.stop({ t: 30 });
      if ((await old.inspect()).State.Running) throw migrationError('Source did not stop');
      j.phase = 'stopped'; await this.store.save(j);
      const [repo, tag] = j.snapshotImage.split(':');
      const bakedImage = await this.docker.getImage(source.Image).inspect();
      if (!bakedImage.Config) throw migrationError('Source image configuration is unavailable');
      const snapshot = await old.commit({
        _query: { container: j.sourceId, repo, tag, pause: false, comment: `Agentor runtime migration ${operationId}` },
        _body: { Env: runtimeSnapshotEnvironment(bakedImage.Config.Env, source.Config.Env) },
      });
      if (typeof snapshot.Id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(snapshot.Id))
        throw migrationError('Committed runtime snapshot did not return an immutable image ID');
      const snapshotInspect = await this.docker.getImage(j.snapshotImage).inspect();
      if (snapshotInspect.Id !== snapshot.Id)
        throw migrationError('Runtime snapshot reference changed after commit');
      j.snapshotIdentity = { reference: j.snapshotImage, imageId: snapshot.Id };
      await this.store.save(j);
      for (const m of j.mounts) {
        await this.docker.createVolume({ Name: m.backup, Labels: this.labels(j) });
        await this.copy(j, m, false);
        m.copied = true; await this.store.save(j);
      }
      j.phase = 'snapshots'; await this.store.save(j);
      await old.rename({ name: j.rollbackName });
      const policy = resolveWorkerRuntimePolicy({ runtimeProfile: j.targetProfile,
        dockerEnabled: inspectedSourceDockerEnabled(source.Config.Env),
        ...(j.targetProfile === 'legacy-runc' ? { legacyPrivilegeGrant: 'admin' as const } : {}) });
      await this.callbacks.authorize();
      // A committed Docker image preserves writable rootfs changes. Reproduce
      // the inspected Config and mounts exactly; never re-resolve environment
      // defaults during migration. Explicit restart suppression protects both
      // sides during orchestrator/daemon crashes and secret bootstrap.
      const replacement = await this.docker.createContainer({
        ...source.Config, Image: j.snapshotIdentity.imageId, name: j.sourceName,
        Hostname: source.Config.Hostname === source.Id.slice(0, 12) ? undefined : source.Config.Hostname,
        Labels: { ...source.Config.Labels, ...this.labels(j), 'agentor.managed': 'true', 'agentor.id': j.workerId,
          'agentor.runtime-profile': j.targetProfile },
        HostConfig: { ...source.HostConfig, Runtime: policy.runtime, Privileged: policy.privileged,
          RestartPolicy: { Name: 'no' },
          // Include anonymous Dockerfile volumes absent from HostConfig.
          Mounts: [...(source.HostConfig.Mounts ?? []), ...source.Mounts.filter((m) => m.Type === 'volume' && m.Name &&
            !(source.HostConfig.Mounts ?? []).some((d) => d.Target === m.Destination) &&
            !(source.HostConfig.Binds ?? []).some((b) => b.split(':')[1] === m.Destination))
            .map((m) => ({ Type: 'volume' as const, Source: m.Name!, Target: m.Destination, ReadOnly: !m.RW, VolumeOptions: { NoCopy: true } }))] as any,
        },
        NetworkingConfig: { EndpointsConfig: Object.fromEntries(Object.entries(source.NetworkSettings.Networks ?? {}).map(([network, endpoint]) => [network, {
          Aliases: endpoint.Aliases?.filter((a: string) => a !== source.Id && a !== source.Id.slice(0, 12)),
          Links: endpoint.Links, DriverOpts: (endpoint as any).DriverOpts,
        }])) },
      });
      j.replacementId = replacement.id; j.phase = 'replacement'; await this.store.save(j);
      const created = await replacement.inspect();
      if (created.Image !== j.snapshotIdentity.imageId)
        throw migrationError('Replacement container resolved a different snapshot image');
      j.replacementMayHaveRun = true; await this.store.save(j);
      await this.callbacks.authorize();
      await replacement.start();
      const observed = await replacement.inspect();
      assertWorkerRuntimeMatches(j.targetProfile, observed.HostConfig.Runtime, observed.HostConfig.Privileged === true,
        j.targetProfile === 'legacy-runc' ? 'admin' : undefined);
      for (const expected of j.expectedMounts)
        if (!observed.Mounts.some((m) => m.Type === expected.type && m.Destination === expected.target &&
            (m.Type === 'volume' ? m.Name : m.Source) === expected.source && !m.RW === expected.readOnly))
          throw migrationError(`Replacement did not preserve mount ${expected.target} and its access mode`);
      if (observed.Mounts.length !== j.expectedMounts.length)
        throw migrationError('Replacement mounted unexpected storage');
      await this.markInFlight('replacement secret bootstrap and validation');
      await this.callbacks.validate(replacement.id, j.sourceRecord);
      await this.clearInFlight();
      if (!j.sourceRunning) await replacement.stop({ t: 30 });
      j.phase = 'validated'; await this.store.save(j);
      await this.callbacks.authorize();
      await this.callbacks.commit(j, replacement.id);
      j.phase = 'committed'; await this.store.save(j);
      // Retain rollback evidence after success. Explicit operator cleanup is
      // separate; failures never destroy the source rootfs or volume copies.
      return j;
    } catch (cause) {
      await (cause as any)?.[operationSettlement];
      if (ambiguousDockerOutcome(cause)) {
        j.phase = 'recovery-required'; j.uncertainOperation = true;
        j.error = 'Docker mutation outcome is uncertain; operator must establish daemon quiescence before recovery';
        await this.store.save(j);
        throw Object.assign(new Error(j.error), { code: 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN', cause });
      }
      // A completed callback with a definitive error can be rolled back in
      // this process. Crash recovery sees its durable intent and requires
      // explicit daemon quiescence before proceeding.
      await this.clearInFlight();
      await this.rollback(j).catch((rollback) => {
        throw Object.assign(new Error('Runtime migration failed and rollback needs recovery; all rollback data was retained'), {
          code: 'WORKER_RUNTIME_MIGRATION_RECOVERY_REQUIRED', cause, rollback,
        });
      });
      throw Object.assign(new Error('Runtime migration failed; original worker and persistent data were restored'), {
        code: 'WORKER_RUNTIME_MIGRATION_ROLLED_BACK', cause,
      });
    } finally { this.activeJournal = undefined; }
  }

  async recover(j: RuntimeMigrationJournal, daemonOperationsSettled = false) {
    if (j.uncertainOperation || j.inFlightOperation) {
      if (!daemonOperationsSettled)
        throw migrationError('An operator must verify all outstanding Docker operations have settled before recovery', 'WORKER_RUNTIME_MIGRATION_OUTCOME_UNCERTAIN');
      delete j.uncertainOperation;
      delete j.inFlightOperation;
      await this.store.save(j);
    }
    this.activeJournal = j;
    try { if (!terminal(j.phase)) await this.rollback(j); }
    finally { this.activeJournal = undefined; }
  }

  /** Explicitly discard rollback evidence after a committed migration or a
   * completed rollback. Canonical worker volumes and active rootfs are never
   * cleanup targets. Repeated cleanup is safe after partial deletion. */
  async finalize(j: RuntimeMigrationJournal) {
    if (!terminal(j.phase) || j.uncertainOperation || j.inFlightOperation)
      throw migrationError('Complete migration recovery before deleting rollback evidence');
    if (j.phase === 'committed') {
      const active = await this.docker.getContainer(j.replacementId!).inspect();
      if (active.Name !== `/${j.sourceName}` || active.Config.Labels?.['agentor.runtime-migration'] !== j.operationId)
        throw migrationError('Active replacement identity does not match retained rollback evidence');
      try {
        const source = this.docker.getContainer(j.sourceId); const inspected = await source.inspect();
        if (inspected.Name !== `/${j.rollbackName}` || inspected.Config.Labels?.['agentor.id'] !== j.workerId || inspected.State.Running)
          throw migrationError('Retained rollback source must match identity and be stopped');
        await source.remove();
      } catch (error) { if ((error as any)?.statusCode !== 404) throw error; }
    }
    for (const m of j.mounts) {
      await this.removeCopyHelper(j, m);
      try {
        const volume = this.docker.getVolume(m.backup); const inspected = await volume.inspect();
        if (inspected.Labels?.['agentor.runtime-migration'] !== j.operationId ||
            inspected.Labels?.['agentor.runtime-migration-worker'] !== j.workerId ||
            inspected.Labels?.['agentor.runtime-migration-owner'] !== j.userId)
          throw migrationError('Rollback volume identity mismatch during cleanup');
        if ((await this.docker.listContainers({ all: true, filters: { volume: [m.backup] } })).length)
          throw migrationError('Rollback volume remains in use');
        await volume.remove();
      } catch (error) { if ((error as any)?.statusCode !== 404) throw error; }
    }
    // The committed snapshot is the active rebuild image, so keep it. A
    // rolled-back snapshot is no longer referenced by the worker record.
    if (j.phase === 'rolled-back') {
      if (!j.snapshotIdentity) {
        // Older journals have no immutable commit response. Do not let a
        // mutable tag identify a deletion target after rollback.
        useLogger().warn(`Retaining unpinned rolled-back runtime snapshot ${j.operationId}`);
      } else {
        try {
          const tagged = await this.docker.getImage(j.snapshotImage).inspect();
          if (tagged.Id !== j.snapshotIdentity.imageId)
            throw migrationError('Rolled-back snapshot reference changed; retain image for operator review');
          await this.docker.getImage(j.snapshotIdentity.imageId).remove({ force: false });
        } catch (error) { if ((error as any)?.statusCode !== 404) throw error; }
      }
    }
    await this.store.clear(j.userId, j.workerId);
  }

  private labels(j: RuntimeMigrationJournal) {
    return { 'agentor.runtime-migration': j.operationId, 'agentor.runtime-migration-worker': j.workerId,
      'agentor.runtime-migration-owner': j.userId };
  }
  private async rollback(j: RuntimeMigrationJournal) {
    try {
      j.phase = 'rollback'; await this.store.save(j);
      // Resolve deterministic name after ambiguous create, but never touch a
      // foreign container occupying it. Source is checked independently.
      let replacement: Docker.Container | undefined;
      try {
        const candidate = this.docker.getContainer(j.replacementId || j.sourceName);
        const actual = await candidate.inspect();
        if (actual.Id !== j.sourceId) {
          if (actual.Config.Labels?.['agentor.runtime-migration'] !== j.operationId ||
              actual.Config.Labels?.['agentor.runtime-migration-worker'] !== j.workerId)
            throw migrationError('Replacement identity mismatch during rollback');
          replacement = candidate;
          j.replacementMayHaveRun ||= actual.State.Running || !!actual.State.StartedAt && !actual.State.StartedAt.startsWith('0001-');
          await candidate.update({ RestartPolicy: { Name: 'no' } });
          if (actual.State.Running) await candidate.stop({ t: 30 });
          if ((await candidate.inspect()).State.Running) throw migrationError('Replacement did not stop');
        }
      } catch (error) { if ((error as any)?.statusCode !== 404) throw error; }
      const old = this.docker.getContainer(j.sourceId);
      const original = await old.inspect();
      if (original.Config.Labels?.['agentor.id'] !== j.workerId || ![`/${j.sourceName}`, `/${j.rollbackName}`].includes(original.Name))
        throw migrationError('Rollback source identity mismatch');
      await old.update({ RestartPolicy: { Name: 'no' } });
      if (original.State.Running) await old.stop({ t: 30 });
      if ((await old.inspect()).State.Running) throw migrationError('Rollback source did not stop');
      for (const m of j.mounts) await this.removeCopyHelper(j, m);
      if (j.replacementMayHaveRun) {
        if (j.mounts.some((m) => !m.copied)) throw migrationError('Required rollback snapshot is incomplete');
        for (const m of j.mounts) {
          if (!original.Mounts.some((actual) => actual.Type === m.type && actual.Destination === m.target &&
              (actual.Type === 'volume' ? actual.Name : actual.Source) === m.source))
            throw migrationError('Rollback persistent source no longer matches the original container');
          if (m.type === 'volume') {
            const users = await this.docker.listContainers({ all: true, filters: { volume: [m.source] } });
            if (users.some((c) => c.Id !== j.sourceId && c.Id !== j.replacementId))
              throw migrationError('Rollback persistent volume acquired another consumer');
          }
          await this.copy(j, m, true);
        }
      }
      if (replacement) await replacement.remove();
      if ((await old.inspect()).Name !== `/${j.sourceName}`) await old.rename({ name: j.sourceName });
      await this.callbacks.restore(j);
      if (j.sourceRunning) {
        await old.start();
        await this.markInFlight('rollback secret bootstrap and validation');
        await this.callbacks.validate(j.sourceId, j.sourceRecord);
        await this.clearInFlight();
      }
      await old.update({ RestartPolicy: j.sourceRestartPolicy });
      j.phase = 'rolled-back'; delete j.error; await this.store.save(j);
    } catch (error) {
      await (error as any)?.[operationSettlement];
      j.phase = 'recovery-required'; j.error = 'Rollback incomplete; retained source, image and volume snapshots require recovery';
      if (ambiguousDockerOutcome(error)) {
        j.uncertainOperation = true;
        j.error = 'Docker rollback outcome is uncertain; operator must establish daemon quiescence before recovery';
      }
      await this.store.save(j);
      throw error;
    }
  }

  private async copy(j: RuntimeMigrationJournal, mount: RuntimeMigrationMount, restore: boolean) {
    const backup = await this.docker.getVolume(mount.backup).inspect();
    if (backup.Labels?.['agentor.runtime-migration'] !== j.operationId ||
        backup.Labels?.['agentor.runtime-migration-worker'] !== j.workerId ||
        backup.Labels?.['agentor.runtime-migration-owner'] !== j.userId)
      throw migrationError('Rollback volume ownership mismatch');
    const name = `agentor-runtime-copy-${j.operationId}-${j.mounts.indexOf(mount)}`;
    // A previous helper may survive process failure. Remove only one bearing
    // this exact journal identity, before another writer can start.
    await this.removeCopyHelper(j, mount);
    const sourceMount = { Type: mount.type, Source: mount.source, Target: restore ? '/target' : '/source', ReadOnly: !restore };
    const backupMount = { Type: 'volume', Source: mount.backup, Target: restore ? '/source' : '/target', ReadOnly: restore };
    const helper = await this.docker.createContainer({
      name, Image: j.helperImage, User: '0', Entrypoint: ['/bin/sh'],
      Cmd: ['-c', 'set -eu; cp --version | head -1 | grep -q "GNU coreutils"; find /target -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; cp -a --preserve=all /source/. /target/'],
      Labels: this.labels(j),
      HostConfig: { Runtime: 'runc', Privileged: false, NetworkMode: 'none', ReadonlyRootfs: true,
        CapDrop: ['ALL'], CapAdd: ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'FSETID', 'SETFCAP'],
        SecurityOpt: ['no-new-privileges'], RestartPolicy: { Name: 'no' },
        Mounts: [sourceMount, backupMount] as any },
    });
    let uncertain = false;
    try {
      await helper.start();
      const result = await helper.wait();
      if (result.StatusCode !== 0) throw migrationError('Persistent data snapshot or restore failed');
    } catch (error) {
      uncertain = ambiguousDockerOutcome(error);
      throw error;
    } finally { if (!uncertain) await helper.remove({ force: true }); }
  }

  private async removeCopyHelper(j: RuntimeMigrationJournal, mount: RuntimeMigrationMount) {
    const name = `agentor-runtime-copy-${j.operationId}-${j.mounts.indexOf(mount)}`;
    try {
      const stale = this.docker.getContainer(name); const inspect = await stale.inspect();
      if (inspect.Config.Labels?.['agentor.runtime-migration'] !== j.operationId ||
          inspect.Config.Labels?.['agentor.runtime-migration-worker'] !== j.workerId ||
          inspect.Config.Labels?.['agentor.runtime-migration-owner'] !== j.userId)
        throw migrationError('Copy helper identity mismatch');
      await stale.remove({ force: true });
    } catch (error) { if ((error as any)?.statusCode !== 404) throw error; }
  }
}

/** Resolve the immutable source startup payload, never today's environment
 * record. Config.Env does not include shell assignments made by entrypoint.sh:
 * normal workers derive DOCKER_ENABLED from ENVIRONMENT.dockerEnabled at boot.
 * Ambiguity is an admission failure, not evidence that DinD is disabled. */
function inspectedSourceDockerEnabled(env: string[] | undefined | null): boolean {
  const invalid = () => migrationError('Source Docker-in-Docker configuration is missing or ambiguous; resolve it before migration',
    'WORKER_RUNTIME_MIGRATION_DIND_CONFIG_UNCERTAIN');
  if (!Array.isArray(env) || env.some((entry) => typeof entry !== 'string')) throw invalid();
  const value = (key: string): string | undefined => {
    const entries = env.filter((entry) => entry === key || entry.startsWith(`${key}=`));
    if (entries.length > 1 || entries.some((entry) => !entry.startsWith(`${key}=`))) throw invalid();
    return entries[0]?.slice(key.length + 1);
  };
  const payload = value('ENVIRONMENT');
  const historical = value('DOCKER_ENABLED');
  const workerLocal = value('WORKER_LOCAL_ENV');
  if (payload === undefined && historical === undefined) throw invalid();
  if (historical !== undefined && historical !== 'true' && historical !== 'false') throw invalid();
  let configured: boolean | undefined;
  if (payload !== undefined) {
    let parsed: any;
    try { parsed = JSON.parse(payload); } catch { throw invalid(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
    if (parsed.dockerEnabled != null && typeof parsed.dockerEnabled !== 'boolean') throw invalid();
    configured = parsed.dockerEnabled ?? false; // entrypoint: .dockerEnabled // false
    if (parsed.envVars != null && typeof parsed.envVars !== 'string') throw invalid();
    // Phase 0b exports arbitrary values before Phase 2 resolves dockerEnabled.
    // Do not interpret nested runtime-payload overrides as trustworthy defaults.
    if ((parsed.envVars ?? '').split('\n').some((line: string) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('#') && /^(ENVIRONMENT|WORKER_LOCAL_ENV)=/.test(trimmed);
    })) throw invalid();
  }
  if (workerLocal) {
    let entries: any;
    try {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(workerLocal) || workerLocal.length % 4 !== 0) throw invalid();
      entries = JSON.parse(Buffer.from(workerLocal, 'base64').toString('utf8'));
    } catch { throw invalid(); }
    if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.key !== 'string' ||
      !/^[A-Z_][A-Z0-9_]*$/.test(entry.key) || typeof entry.value !== 'string' || entry.key === 'ENVIRONMENT')) throw invalid();
  }
  if (configured !== undefined && historical !== undefined && configured !== (historical === 'true')) throw invalid();
  return configured ?? (historical === 'true');
}

function migrationError(message: string, code = 'WORKER_RUNTIME_MIGRATION_PREFLIGHT_FAILED') {
  return Object.assign(new Error(message), { statusCode: 409, code });
}

function ambiguousDockerOutcome(error: unknown): boolean {
  const value = error as { code?: string; name?: string; statusCode?: number };
  return ['DOCKER_OPERATION_TIMEOUT', 'OPERATION_ABORTED', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET'].includes(value?.code ?? '') ||
    value?.name === 'AbortError' || (value?.statusCode ?? 0) >= 500;
}

/** Abort every Docker request at its deadline, then keep the lifecycle fence
 * until its client promise settles before rollback can issue competing writes.
 * The socket client also has a timeout, bounding settlement after abort. */
function boundedDocker(docker: Docker, beforeMutation: (operation: string) => Promise<void>, afterMutation: () => Promise<void>): Docker {
  const mutating = new Set(['createContainer', 'createVolume', 'commit', 'start', 'stop', 'remove', 'rename', 'update']);
  const wrap = (object: any, kind: string): any => new Proxy(object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      if (key === 'getContainer' || key === 'getVolume' || key === 'getImage')
        return (...args: any[]) => wrap(value.apply(target, args), String(key));
      return async (...args: any[]) => {
        const mutation = mutating.has(String(key));
        if (mutation) await beforeMutation(`${kind} ${String(key)}`);
        try {
          const result = await withOperationDeadline((signal) => {
            const next = args.length ? [...args] : [{}];
            next[0] = { ...(next[0] ?? {}), abortSignal: signal };
            return value.apply(target, next);
          }, key === 'wait' || key === 'commit' ? 120_000 : 30_000, `Docker runtime migration ${kind} ${String(key)}`);
          if (mutation) await afterMutation();
          return key === 'createContainer' || key === 'createVolume' ? wrap(result, String(key)) : result;
        } catch (error) {
          await (error as any)?.[operationSettlement];
          if (mutation && !ambiguousDockerOutcome(error)) await afterMutation();
          throw error;
        }
      };
    },
  });
  return wrap(docker, 'daemon');
}
