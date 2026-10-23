import { effectiveGroupVcpuLimit, assertGroupVcpuLimit } from './worker-vcpu-policy';
import { adminMemorySettings, validateAdminMemoryLimit } from '../../shared/admin-workspace-memory';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from "node:crypto";
import { withWorkerRuntimeSetup, withWorkerLifecycleMutation } from "./worker-lifecycle-coordinator";
import { applyAdminNativePatch, type AdminNativeAcknowledge } from './admin-native-authority';
import { validateVcpuCount, type VcpuSettings } from '../../shared/vcpu-count';
import type {
  AdminWorkspaceIdentityMaterializationIntent,
  AdminWorkspaceRuntimeAdapter,
  AdminWorkspaceEmergencyRuntime,
  AdminWorkspaceStartupScriptRuntimeStatus,
  AdministrativeWorkspaceRecord,
} from "./admin-workspace-store";
import {
  normalizedRevision,
  publicStartupScriptStatus,
  validateAdminWorkspaceStartupScript,
} from "./admin-workspace-store";
import { useWorkerGroupStore, useLogger } from "./services";
import type { WorkerGroup, WorkerGroupStore } from "./worker-group-store";
import { withWorkerNetworkMutation } from "./worker-group-manager";
import {
  operationSettlement,
  withOperationDeadline,
  type OperationFailureWithSettlement,
} from "./operation-deadline";

export interface GroupAdministrativeWorkspaceRecord
  extends AdministrativeWorkspaceRecord {
  kind: "group-administrative";
  groupId: string;
  ownerId: string;
  services: string[];
}

type OwnerSerializer = <T>(
  ownerId: string,
  operation: () => Promise<T>,
) => Promise<T>;

export class GroupAdminWorkspaceStore {
  private runtime?: AdminWorkspaceRuntimeAdapter;
  private emergencyRuntime?: AdminWorkspaceEmergencyRuntime;
  private identityMaterializer?: (
    record: GroupAdministrativeWorkspaceRecord,
    intent: AdminWorkspaceIdentityMaterializationIntent,
  ) => Promise<void>;
  private running = new Set<string>();
  private stopRequested = new Set<string>();
  private stateWrites = new Map<string, Promise<void>>();
  private pendingCommits = new Map<
    string,
    { operation: string; record: GroupAdministrativeWorkspaceRecord }
  >();
  constructor(
    private readonly groups: Pick<
      WorkerGroupStore,
      "findById" | "list" | "update"
    > = useWorkerGroupStore(),
    private readonly serializeOwner: OwnerSerializer = withWorkerNetworkMutation,
  ) {}
  setRuntimeAdapter(runtime: AdminWorkspaceRuntimeAdapter) {
    this.runtime = runtime;
  }
  setEmergencyRuntimeAdapter(runtime: AdminWorkspaceEmergencyRuntime) {
    this.emergencyRuntime = runtime;
  }
  setIdentityMaterializer(
    materializer: (
      record: GroupAdministrativeWorkspaceRecord,
      intent: AdminWorkspaceIdentityMaterializationIntent,
    ) => Promise<void>,
  ) {
    this.identityMaterializer = materializer;
  }
  async setClipboard(
    record: GroupAdministrativeWorkspaceRecord,
    mime: "image/png" | "text/plain",
    bytes: Buffer,
  ) {
    if (!this.runtime?.setClipboard)
      throw Object.assign(new Error("Administrative clipboard unavailable"), {
        statusCode: 503,
      });
    await this.runtime.setClipboard(mime, bytes, structuredClone(record));
  }
  private group(groupId: string) {
    const group = this.groups.findById(groupId);
    if (!group)
      throw Object.assign(new Error("Worker group not found"), {
        statusCode: 404,
      });
    return structuredClone(group);
  }
  private record(groupId: string) {
    const record = this.group(groupId).adminWorkspace as
      | GroupAdministrativeWorkspaceRecord
      | undefined;
    return record ? structuredClone(record) : undefined;
  }
  private async save(record: GroupAdministrativeWorkspaceRecord, intentOnly = false) {
    const write = (this.stateWrites.get(record.groupId) ?? Promise.resolve()).then(async () => {
      if (intentOnly) {
        const current = this.record(record.groupId);
        if (current?.id !== record.id) throw Object.assign(new Error("Group administrative workspace identity changed"), { statusCode: 409 });
        record = { ...current, status: "stopped", updatedAt: record.updatedAt };
      }
      if (this.stopRequested.has(record.groupId)) record = { ...record, status: "stopped" };
      await this.groups.update(record.ownerId, record.groupId, { adminWorkspace: structuredClone(record) });
    });
    this.stateWrites.set(record.groupId, write.catch(() => {}));
    return write;
  }
  private async withGroup<T>(
    groupId: string,
    serialized: boolean,
    operation: (group: WorkerGroup) => Promise<T>,
  ) {
    const snapshot = this.group(groupId);
    const execute = async () => {
      const live = this.group(groupId);
      if (live.userId !== snapshot.userId)
        throw Object.assign(new Error("Worker group not found"), {
          statusCode: 404,
        });
      return operation(live);
    };
    return serialized
      ? execute()
      : this.serializeOwner(snapshot.userId, execute);
  }
  private async flushPendingCommit(groupId: string, operation: string) {
    const pending = this.pendingCommits.get(groupId);
    if (!pending) return undefined;
    await this.save(pending.record);
    this.pendingCommits.delete(groupId);
    return {
      matched: pending.operation === operation,
      record: structuredClone(pending.record),
    };
  }
  private async commitExternal(
    operation: string,
    record: GroupAdministrativeWorkspaceRecord,
  ) {
    try {
      await this.save(record);
    } catch (error) {
      // The runtime has already accepted this lifecycle action. Preserve its
      // exact resulting control-plane record so a retry persists the outcome
      // rather than rebuilding or restarting the workspace a second time.
      this.pendingCommits.set(record.groupId, {
        operation,
        record: structuredClone(record),
      });
      throw error;
    }
  }
  private async run<T>(groupId: string, operation: () => Promise<T>, queue = false): Promise<T> {
    if (queue) {
      const snapshot = this.group(groupId);
      return this.serializeOwner(snapshot.userId, () => withWorkerLifecycleMutation(
        snapshot.adminWorkspace?.id ?? `admin-group-bootstrap:${groupId}`, operation));
    }
    // Lifecycle operations can rebuild images and take longer than an HTTP
    // proxy timeout. Never queue retries behind an operation whose client has
    // disconnected: a burst of clicks/MCP retries would otherwise destroy and
    // recreate the same workspace repeatedly long after the first rebuild
    // completed. Callers receive a prompt, retryable conflict instead.
    if (this.running.has(groupId))
      throw Object.assign(
        new Error("Group administrative workspace operation already in progress"),
        { statusCode: 409 },
      );
    this.running.add(groupId);
    let deferredRelease = false;
    try {
      const snapshot = this.group(groupId);
      return await this.serializeOwner(snapshot.userId, () => withWorkerLifecycleMutation(
        snapshot.adminWorkspace?.id ?? `admin-group-bootstrap:${groupId}`, operation));
    } catch (error) {
      const settlement = (error as OperationFailureWithSettlement)?.[
        operationSettlement
      ];
      if (settlement) {
        deferredRelease = true;
        void settlement.finally(() => this.running.delete(groupId));
      }
      throw error;
    } finally {
      if (!deferredRelease) this.running.delete(groupId);
    }
  }
  private nativeAcknowledge(record: GroupAdministrativeWorkspaceRecord): AdminNativeAcknowledge {
    return async patch => {
      if (this.stopRequested.has(record.groupId) && patch.nativeRuntime?.pending?.kind === 'start' && !patch.nativeRuntime.pending.operation)
        throw Object.assign(new Error('Administrative start cancelled by emergency stop; stopped intent retained'), { statusCode: 409 });
      if (applyAdminNativePatch(record, patch)) await this.commitExternal('native-runtime', record);
    };
  }
  async withNativeRuntimeTransaction<T>(groupId: string,
    operation: (record: GroupAdministrativeWorkspaceRecord, acknowledge: AdminNativeAcknowledge, refreshRunningIdentity: () => Promise<void>) => Promise<T>, authorize?: () => void): Promise<T> {
    return this.run(groupId, () => this.withGroup(groupId, false, async () => {
      authorize?.();
      await this.flushPendingCommit(groupId, 'native-runtime');
      const record = this.record(groupId);
      if (!record) throw Object.assign(new Error('Group administrative workspace is not provisioned'), { statusCode: 404 });
      let active = true, refresh: Promise<void> | undefined;
      const refreshRunningIdentity = () => {
        if (!active || record.runtimeKind !== 'incus-vm' || record.status !== 'running' || record.nativeRuntime?.pending || record.nativeRuntime?.deleting || record.nativeRuntime?.selectedOperation || !this.identityMaterializer)
          return Promise.reject(Object.assign(new Error('Group administrative running identity refresh is unavailable'), { statusCode: 503 }));
        this.requireRuntime();
        return refresh ??= this.identityMaterializer(structuredClone(record), 'refresh-running').finally(() => { refresh = undefined; });
      };
      try { return await operation(record, this.nativeAcknowledge(record), refreshRunningIdentity); }
      finally { active = false; await refresh?.catch(() => {}); }
    }));
  }
  /** Credential-only refresh: no owner network lock or provisioning. */
  async refreshRunningIdentity(groupId: string) {
    this.requireRuntime();
    const before = this.record(groupId);
    if (!before || before.runtimeKind !== 'incus-vm') throw Object.assign(new Error('Native group administrative identity is unavailable'), { statusCode: 409 });
    return withWorkerRuntimeSetup(before.id, async () => {
      const record = this.record(groupId);
      if (!record || !isDeepStrictEqual(record, before) || this.pendingCommits.has(groupId) ||
          record.nativeRuntime?.pending || record.nativeRuntime?.deleting || record.nativeRuntime?.selectedOperation)
        throw Object.assign(new Error('Group administrative identity changed'), { statusCode: 409 });
      if (record.status !== 'running') return;
      if (!this.identityMaterializer) throw Object.assign(new Error('Group administrative identity materializer is unavailable'), { statusCode: 503 });
      await this.identityMaterializer(structuredClone(record), 'refresh-running');
      if (!isDeepStrictEqual(this.record(groupId), record)) throw Object.assign(new Error('Group administrative identity changed'), { statusCode: 409 });
    });
  }
  async ensure(groupId: string, _ownerId?: string, authorize?: () => void) {
    return this.run(groupId, () =>
      this.withGroup(groupId, false, (group) => {
        authorize?.();
        return this.ensureLocked(group);
      }),
    );
  }
  async getStatus(groupId: string, authorize?: () => void) {
    return this.withGroup(groupId, false, async () => {
      authorize?.();
      const record = this.record(groupId);
      if (this.running.has(groupId) || this.pendingCommits.has(groupId) || record?.nativeRuntime?.pending ||
          record?.nativeRuntime?.deleting || record?.nativeRuntime?.selectedOperation ||
          record?.nativeMigration && record.nativeMigration.phase !== 'retained')
        throw Object.assign(new Error('Group administrative workspace operation is not settled; retry'), { statusCode: 503 });
      if (!record)
        throw Object.assign(new Error('Group administrative workspace not provisioned'), { statusCode: 404 });
      const runtime = this.runtime ?? this.emergencyRuntime;
      if (!runtime) this.requireRuntime();
      const status = await runtime?.observeStatus?.(record) ?? record.status;
      authorize?.();
      if (this.running.has(groupId) || this.pendingCommits.has(groupId) || !isDeepStrictEqual(record, this.record(groupId)))
        throw Object.assign(new Error('Group administrative workspace changed during status inspection; refresh status'), { statusCode: 503 });
      return { ...this.publicRecord(record), status };
    });
  }
  private requireRuntime() {
    if (!this.runtime) throw Object.assign(new Error('Group administrative workspace runtime is not ready'), { statusCode: 503 });
  }
  private async ensureLocked(group: WorkerGroup) {
    this.requireRuntime();
    const pending = await this.flushPendingCommit(group.id, "ensure");
    if (pending?.matched) {
      if (pending.record.status === "running" && this.identityMaterializer)
        await this.identityMaterializer(
          structuredClone(pending.record),
          "refresh-running",
        );
      return this.publicRecord(pending.record);
    }
    let record = pending?.record ?? this.record(group.id);
    if (!record) {
      const maximum = effectiveGroupVcpuLimit(group.userId, group.id, this.groups.list().filter(item => item.userId === group.userId));
      const stamp = new Date().toISOString();
      record = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "group-administrative",
        trusted: true,
        runtimeKind: "incus-vm",
        ...(maximum === null ? {} : { vcpuCount: Math.min(2, maximum) }),
        groupId: group.id,
        ownerId: group.userId,
        services: ["terminal", "editor", "desktop"],
        status: "running",
        createdAt: stamp,
        updatedAt: stamp,
      };
      // Commit the stable group/workspace identity before provisioning its
      // disposable runtime.
      await this.save(record);
    } else if (!record.services) {
      record.services = ["terminal", "editor", "desktop"];
      await this.save(record);
    }
    if (this.runtime) {
      if (record.status === "running" && this.identityMaterializer)
        await this.identityMaterializer(
          structuredClone(record),
          "prepare-start",
        );
      const changed = this.applyImage(
        record,
        await this.runtime.ensure(structuredClone(record), this.nativeAcknowledge(record)),
      );
      if (changed) await this.commitExternal("ensure", record);
      if (record.status === "running" && this.identityMaterializer)
        await this.identityMaterializer(
          structuredClone(record),
          "refresh-running",
        );
    }
    return this.publicRecord(record);
  }
  async setStatus(
    groupId: string,
    status: "running" | "stopped",
    authorize?: () => void,
    force = false,
    expectedId?: string,
  ) {
    const emergency = force && status === "stopped";
    if (emergency) {
      authorize?.();
      if (!this.runtime && !this.emergencyRuntime) this.requireRuntime();
      const record = this.record(groupId);
      if (!record || expectedId && record.id !== expectedId)
        throw Object.assign(new Error("Group administrative workspace identity is unavailable or changed"), { statusCode: record ? 409 : 404 });
      this.stopRequested.add(groupId);
      await this.save({ ...record, status: "stopped", updatedAt: new Date().toISOString() }, true);
      useLogger().warn(`[group-admin-workspace] emergency stop intent saved; ${this.running.has(groupId) ? "waiting for in-flight mutation settlement" : "shutdown confirmation pending"}`);
    }
    const result = this.run(groupId, () =>
      this.withGroup(groupId, false, async (group) => {
        authorize?.();
        const runtime = this.runtime ?? (emergency ? this.emergencyRuntime : undefined);
        if (!runtime) this.requireRuntime();
        if (expectedId && this.record(groupId)?.id !== expectedId)
          throw Object.assign(new Error("Group administrative workspace identity changed"), { statusCode: 409 });
        const operation = force ? "emergency-stop" : `status:${status}`;
        const pending = await this.flushPendingCommit(groupId, operation);
        if (pending?.matched) {
          if (status === "running" && this.identityMaterializer)
            await this.identityMaterializer(
              structuredClone(pending.record),
              "refresh-running",
            );
          return this.publicRecord(pending.record);
        }
        // Avoid public ensure(): this operation already owns both lifecycle
        // and hierarchy serialization boundaries.
        if (!this.record(groupId) && force)
          throw Object.assign(new Error("Group administrative workspace is not provisioned"), { statusCode: 404 });
        if (!this.record(groupId)) await this.ensureLocked(group);
        const record = this.record(groupId)!;
        if (runtime) {
          if (status === "running") {
            this.stopRequested.delete(groupId);
            if (this.identityMaterializer)
              await this.identityMaterializer(
                structuredClone(record),
                "prepare-start",
              );
            this.applyImage(
              record,
              await (runtime as AdminWorkspaceRuntimeAdapter).start(structuredClone(record), this.nativeAcknowledge(record)),
            );
            await this.identityMaterializer?.(
              structuredClone(record),
              "refresh-running",
            );
          } else await runtime.stop(structuredClone(record), this.nativeAcknowledge(record), force);
        }
        record.status = status;
        record.updatedAt = new Date().toISOString();
        if (runtime) await this.commitExternal(operation, record);
        else await this.save(record);
        if (emergency) useLogger().info('[group-admin-workspace] emergency stop confirmed; persistent data retained');
        return this.publicRecord(record);
      }), emergency,
    );
    if (!emergency) return result;
    try { return await withOperationDeadline(result, 15_000, "Group administrative emergency stop; stopped intent retained, shutdown confirmation pending"); }
    catch (error) { useLogger().warn('[group-admin-workspace] emergency stop unconfirmed; stopped intent retained, recovery still required'); throw error; }
  }
  async rebuild(groupId: string, ownerId?: string, authorize?: () => void) {
    return this.run(groupId, () =>
      this.withGroup(groupId, false, async (group) => {
        authorize?.();
        this.requireRuntime();
        const pending = await this.flushPendingCommit(groupId, "rebuild");
        if (pending?.matched) {
          if (this.identityMaterializer)
            await this.identityMaterializer(
              structuredClone(pending.record),
              "refresh-running",
            );
          return this.publicRecord(pending.record);
        }
        // Rebuild must not first auto-start stale disposable compute.
        if (!this.record(groupId)) await this.ensureLocked(group);
        const record = this.record(groupId)!;
        if (ownerId && ownerId !== record.ownerId)
          throw Object.assign(new Error("Worker group not found"), {
            statusCode: 404,
          });
        if (!this.runtime)
          throw Object.assign(
            new Error("Administrative workspace runtime is unavailable"),
            { statusCode: 503 },
          );
        if (this.identityMaterializer)
          await this.identityMaterializer(
            structuredClone(record),
            "prepare-start",
          );
        this.applyImage(
          record,
          await this.runtime.rebuild(structuredClone(record), this.nativeAcknowledge(record)),
        );
        await this.identityMaterializer?.(
          structuredClone(record),
          "refresh-running",
        );
        record.status = "running";
        record.updatedAt = new Date().toISOString();
        await this.commitExternal("rebuild", record);
        return this.publicRecord(record);
      }),
    );
  }
  findByWorkspaceId(workspaceId: string) {
    for (const group of this.groups.list()) {
      const record = group.adminWorkspace as
        | GroupAdministrativeWorkspaceRecord
        | undefined;
      if (record?.id === workspaceId) return structuredClone(record);
    }
  }
  async getResources(groupId: string, authorize?: () => void) {
    return this.withGroup(groupId, false, async () => {
      authorize?.();
      const record = this.record(groupId);
      if (this.running.has(groupId) || this.pendingCommits.has(groupId) || record?.nativeRuntime?.pending ||
          record?.nativeRuntime?.deleting || record?.nativeRuntime?.selectedOperation ||
          record?.nativeMigration && record.nativeMigration.phase !== 'retained')
        throw Object.assign(new Error('Administrative workspace operation is in progress'), { statusCode: 503 });
      if (!record) throw Object.assign(new Error('Group administrative workspace not provisioned'), { statusCode: 404 });
      return adminMemorySettings(record);
    });
  }
  async getCpuSettings(groupId: string, authorize?: () => void): Promise<VcpuSettings> {
    return this.withGroup(groupId, false, async () => {
      authorize?.(); this.requireRuntime();
      const record = this.record(groupId);
      if (!record) throw Object.assign(new Error('Group administrative workspace not provisioned'), { statusCode: 404 });
      if (this.running.has(groupId) || this.pendingCommits.has(groupId) || !this.runtime!.getCpuSettings)
        throw Object.assign(new Error('Group administrative CPU settings are unavailable; refresh before retrying'), { statusCode: 503 });
      const result = await this.runtime!.getCpuSettings(record);
      authorize?.();
      if (this.running.has(groupId) || this.pendingCommits.has(groupId) || !isDeepStrictEqual(record, this.record(groupId)))
        throw Object.assign(new Error('Group administrative workspace changed; refresh CPU settings'), { statusCode: 503 });
      const maximum = effectiveGroupVcpuLimit(record.ownerId, groupId, this.groups.list().filter(group => group.userId === record.ownerId));
      return { ...result, maxVcpuCount: Math.min(result.maxVcpuCount, maximum ?? result.maxVcpuCount) };
    });
  }
  async setCpuCount(groupId: string, value: unknown, authorize?: () => void, expectedWorkspaceId?: string, reconcileOnly = false): Promise<VcpuSettings> {
    const count = validateVcpuCount(value);
    return this.withNativeRuntimeTransaction(groupId, async (record, acknowledge) => {
      if (expectedWorkspaceId !== undefined && record.id !== expectedWorkspaceId)
        throw Object.assign(new Error('Group administrative workspace changed; refresh before retrying'), { statusCode: 409 });
      this.requireRuntime();
      if (!this.runtime!.setCpuCount) throw Object.assign(new Error('Group administrative CPU settings are unavailable'), { statusCode: 503 });
      authorize?.();
      const pending = record.nativeRuntime?.pending?.kind === 'cpu';
      if (reconcileOnly && !pending) {
        useLogger().warn('[vcpu] Group reconciliation has no recorded CPU operation; request stopped without submitting a resize.');
        throw Object.assign(new Error('No pending CPU change remains to reconcile; refresh CPU settings.'), { statusCode: 409 });
      }
      if (!pending && count !== (record.vcpuCount ?? 2))
        assertGroupVcpuLimit(record.ownerId, groupId, count, false, this.groups.list().filter(group => group.userId === record.ownerId));
      const result = await this.runtime!.setCpuCount(record, count, acknowledge, authorize);
      authorize?.();
      const maximum = effectiveGroupVcpuLimit(record.ownerId, groupId, this.groups.list().filter(group => group.userId === record.ownerId));
      return { ...result, maxVcpuCount: Math.min(result.maxVcpuCount, maximum ?? result.maxVcpuCount) };
    }, authorize);
  }
  async setResources(groupId: string, value: unknown, authorize?: () => void) {
    const memoryLimit = validateAdminMemoryLimit(value);
    return this.run(groupId, () => this.withGroup(groupId, true, async () => {
      authorize?.();
      const record = this.record(groupId);
      if (this.pendingCommits.has(groupId) || record?.nativeRuntime?.pending || record?.nativeRuntime?.deleting || record?.nativeRuntime?.selectedOperation ||
          record?.nativeMigration && record.nativeMigration.phase !== 'retained')
        throw Object.assign(new Error('Administrative workspace operation is not settled'), { statusCode: 503 });
      if (!record) throw Object.assign(new Error('Group administrative workspace not provisioned'), { statusCode: 404 });
      if (record.runtimeKind !== 'incus-vm') throw Object.assign(new Error('Migrate the administrative workspace to a native VM before changing memory'), { statusCode: 409 });
      record.memoryLimit = memoryLimit;
      record.updatedAt = new Date().toISOString();
      await this.save(record);
      return adminMemorySettings(record);
    }));
  }
  async getStartupScript(groupId: string, authorize?: () => void) {
    return this.withGroup(groupId, false, async () => {
      authorize?.();
      const pending = await this.flushPendingCommit(
        groupId,
        "startup-script:get",
      );
      const record = pending?.record ?? this.record(groupId);
      if (!record)
        throw Object.assign(
          new Error("Group administrative workspace not provisioned"),
          { statusCode: 404 },
        );
      return this.startupScriptRecord(record);
    });
  }
  async setStartupScript(
    groupId: string,
    value: unknown,
    authorize?: () => void,
  ) {
    return this.withGroup(groupId, false, async () => {
      authorize?.();
      const pending = await this.flushPendingCommit(
        groupId,
        "startup-script:set",
      );
      const record = pending?.record ?? this.record(groupId);
      if (!record)
        throw Object.assign(
          new Error("Group administrative workspace not provisioned"),
          { statusCode: 404 },
        );
      const script = validateAdminWorkspaceStartupScript(value);
      if ((record.startupScript || "") !== script) {
        record.startupScript = script;
        record.startupScriptRevision =
          normalizedRevision(record.startupScriptRevision) + 1;
        record.updatedAt = new Date().toISOString();
        await this.save(record);
      }
      return this.startupScriptRecord(record);
    });
  }
  private async startupScriptRecord(record: GroupAdministrativeWorkspaceRecord) {
    const revision = normalizedRevision(record.startupScriptRevision);
    const appliedRevision = normalizedRevision(
      record.appliedStartupScriptRevision,
    );
    let runtime: AdminWorkspaceStartupScriptRuntimeStatus = {
      state: record.startupScript
        ? revision === appliedRevision
          ? ("unavailable" as const)
          : ("pending-rebuild" as const)
        : ("not-configured" as const),
      revision,
    };
    if (revision === appliedRevision && record.startupScript && this.runtime?.startupScriptStatus)
      runtime = await this.runtime.startupScriptStatus(record).catch(() => ({
        state: "unavailable" as const,
        revision,
      }));
    return {
      script: record.startupScript || "",
      configured: Boolean(record.startupScript),
      revision,
      appliedRevision,
      pendingRebuild: revision !== appliedRevision,
      lastAppliedAt: record.startupScriptLastAppliedAt,
      runtime,
    };
  }
  async remove(groupId: string, serialized = false) {
    const operation = () =>
      this.withGroup(groupId, serialized, async () => {
        if (this.record(groupId) || this.pendingCommits.has(groupId)) this.requireRuntime();
        const pending = await this.flushPendingCommit(groupId, "remove");
        const record = pending?.record ?? this.record(groupId);
        if (record && this.runtime?.remove)
          await this.runtime.remove(structuredClone(record), this.nativeAcknowledge(record));
      });
    return serialized ? operation() : this.run(groupId, operation);
  }
  /** Recreate the runtime removed during a group-delete attempt whose final
   * group-store persistence failed. The group record (including workspace
   * identity and volumes) has already been restored by WorkerGroupStore. */
  async restoreAfterFailedGroupDelete(
    groupId: string,
    status: "running" | "stopped" | "error" | "creating" = "running",
    serialized = false,
  ) {
    const operation = () =>
      this.withGroup(groupId, serialized, async (group) => {
        if (!this.record(groupId) && !this.pendingCommits.has(groupId)) return;
        await this.ensureLocked(group);
        if (status !== "stopped") return;
        const record = this.record(groupId)!;
        if (this.runtime) await this.runtime.stop(structuredClone(record), this.nativeAcknowledge(record));
        record.status = "stopped";
        record.updatedAt = new Date().toISOString();
        if (this.runtime)
          await this.commitExternal("status:stopped", record);
        else await this.save(record);
      });
    return serialized ? operation() : this.run(groupId, operation);
  }
  private applyImage(
    record: GroupAdministrativeWorkspaceRecord,
    image: any,
  ) {
    if (!image) return false;
    let changed = false;
    if (record.imageName !== image.name || record.imageDigest !== image.digest) {
      record.imageName = image.name;
      record.imageDigest = image.digest;
      changed = true;
    }
    if (
      image.appliedStartupScriptRevision !== undefined &&
      normalizedRevision(record.appliedStartupScriptRevision) !==
        image.appliedStartupScriptRevision
    ) {
      record.appliedStartupScriptRevision =
        image.appliedStartupScriptRevision;
      record.startupScriptLastAppliedAt = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      record.updatedAt = new Date().toISOString();
    }
    return changed;
  }
  private publicRecord(record: GroupAdministrativeWorkspaceRecord) {
    return {
      ...record,
      userId: record.ownerId,
      ownerId: undefined,
      nativeRuntime: undefined,
      nativeMigration: undefined,
      startupScript: undefined,
      startupScriptRevision: undefined,
      appliedStartupScriptRevision: undefined,
      startupScriptLastAppliedAt: undefined,
      startupScriptStatus: publicStartupScriptStatus(record),
      image: {
        name: record.imageName,
        digest: record.imageDigest,
        promoted: true,
      },
      presentation: {
        terminalTheme: "administrative-red",
        banner: "GROUP ADMIN",
        promptMarker: "[GROUP ADMIN]",
        browserTitle: "GROUP ADMIN",
        environmentMarker: "AGENTOR_GROUP_ADMIN_WORKSPACE",
        warningBeforePrivilegedActions: true,
      },
      services: ["terminal", "editor", "desktop"],
    };
  }
}
let singleton: GroupAdminWorkspaceStore | undefined;
export function useGroupAdminWorkspaceStore() {
  return (singleton ??= new GroupAdminWorkspaceStore());
}
