import { randomUUID } from "node:crypto";
import type {
  AdminWorkspaceRuntimeAdapter,
  AdminWorkspaceStartupScriptRuntimeStatus,
  AdministrativeWorkspaceRecord,
} from "./admin-workspace-store";
import {
  normalizedRevision,
  publicStartupScriptStatus,
  validateAdminWorkspaceStartupScript,
} from "./admin-workspace-store";
import { useWorkerGroupStore } from "./services";
import type { WorkerGroup, WorkerGroupStore } from "./worker-group-store";
import { withWorkerNetworkMutation } from "./worker-group-manager";

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
  private identityMaterializer?: (
    record: GroupAdministrativeWorkspaceRecord,
  ) => Promise<void>;
  private running = new Set<string>();
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
  setIdentityMaterializer(
    materializer: (record: GroupAdministrativeWorkspaceRecord) => Promise<void>,
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
  private async save(record: GroupAdministrativeWorkspaceRecord) {
    await this.groups.update(record.ownerId, record.groupId, {
      adminWorkspace: structuredClone(record),
    });
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
  private async run<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
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
    try {
      return await operation();
    } finally {
      this.running.delete(groupId);
    }
  }
  async ensure(groupId: string, _ownerId?: string, authorize?: () => void) {
    return this.run(groupId, () =>
      this.withGroup(groupId, false, (group) => {
        authorize?.();
        return this.ensureLocked(group);
      }),
    );
  }
  private async ensureLocked(group: WorkerGroup) {
    const pending = await this.flushPendingCommit(group.id, "ensure");
    if (pending?.matched) {
      if (pending.record.status === "running" && this.identityMaterializer)
        await this.identityMaterializer(structuredClone(pending.record));
      return this.publicRecord(pending.record);
    }
    let record = pending?.record ?? this.record(group.id);
    if (!record) {
      const stamp = new Date().toISOString();
      record = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "group-administrative",
        trusted: true,
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
      const changed = this.applyImage(
        record,
        await this.runtime.ensure(structuredClone(record)),
      );
      if (changed) await this.commitExternal("ensure", record);
    }
    if (record.status === "running" && this.identityMaterializer)
      await this.identityMaterializer(structuredClone(record));
    return this.publicRecord(record);
  }
  async setStatus(
    groupId: string,
    status: "running" | "stopped",
    authorize?: () => void,
  ) {
    return this.run(groupId, () =>
      this.withGroup(groupId, false, async (group) => {
        authorize?.();
        const operation = `status:${status}`;
        const pending = await this.flushPendingCommit(groupId, operation);
        if (pending?.matched) {
          if (status === "running" && this.identityMaterializer)
            await this.identityMaterializer(structuredClone(pending.record));
          return this.publicRecord(pending.record);
        }
        // Avoid public ensure(): this operation already owns both lifecycle
        // and hierarchy serialization boundaries.
        if (!this.record(groupId)) await this.ensureLocked(group);
        const record = this.record(groupId)!;
        if (this.runtime) {
          if (status === "running")
            this.applyImage(
              record,
              await this.runtime.start(structuredClone(record)),
            );
          else await this.runtime.stop(structuredClone(record));
        }
        record.status = status;
        record.updatedAt = new Date().toISOString();
        if (this.runtime) await this.commitExternal(operation, record);
        else await this.save(record);
        if (status === "running" && this.identityMaterializer)
          await this.identityMaterializer(structuredClone(record));
        return this.publicRecord(record);
      }),
    );
  }
  async rebuild(groupId: string, ownerId?: string, authorize?: () => void) {
    return this.run(groupId, () =>
      this.withGroup(groupId, false, async (group) => {
        authorize?.();
        const pending = await this.flushPendingCommit(groupId, "rebuild");
        if (pending?.matched) {
          if (this.identityMaterializer)
            await this.identityMaterializer(structuredClone(pending.record));
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
        this.applyImage(
          record,
          await this.runtime.rebuild(structuredClone(record)),
        );
        record.status = "running";
        record.updatedAt = new Date().toISOString();
        await this.commitExternal("rebuild", record);
        if (this.identityMaterializer)
          await this.identityMaterializer(structuredClone(record));
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
        const pending = await this.flushPendingCommit(groupId, "remove");
        const record = pending?.record ?? this.record(groupId);
        if (record && this.runtime?.remove)
          await this.runtime.remove(structuredClone(record));
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
        await this.ensureLocked(group);
        if (status !== "stopped") return;
        const record = this.record(groupId)!;
        if (this.runtime) await this.runtime.stop(structuredClone(record));
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
