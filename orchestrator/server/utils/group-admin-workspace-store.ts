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

export interface GroupAdministrativeWorkspaceRecord
  extends AdministrativeWorkspaceRecord {
  kind: "group-administrative";
  groupId: string;
  ownerId: string;
  services: string[];
}

export class GroupAdminWorkspaceStore {
  private runtime?: AdminWorkspaceRuntimeAdapter;
  private identityMaterializer?: (
    record: GroupAdministrativeWorkspaceRecord,
  ) => Promise<void>;
  private running = new Set<string>();
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
    await this.runtime.setClipboard(mime, bytes, record);
  }
  private group(groupId: string) {
    const group = useWorkerGroupStore().findById(groupId);
    if (!group)
      throw Object.assign(new Error("Worker group not found"), {
        statusCode: 404,
      });
    return group;
  }
  private record(groupId: string) {
    return this.group(groupId).adminWorkspace as
      | GroupAdministrativeWorkspaceRecord
      | undefined;
  }
  private async save(record: GroupAdministrativeWorkspaceRecord) {
    await useWorkerGroupStore().update(record.ownerId, record.groupId, {
      adminWorkspace: record,
    });
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
  async ensure(groupId: string, _ownerId?: string) {
    const group = this.group(groupId);
    let record = this.record(groupId);
    if (!record) {
      const stamp = new Date().toISOString();
      record = {
        schemaVersion: 1,
        id: randomUUID(),
        kind: "group-administrative",
        trusted: true,
        groupId,
        ownerId: group.userId,
        services: ["terminal", "editor", "desktop"],
        status: "running",
        createdAt: stamp,
        updatedAt: stamp,
      };
      await this.save(record);
    } else if (!record.services) {
      record.services = ["terminal", "editor", "desktop"];
      await this.save(record);
    }
    if (this.runtime)
      await this.run(groupId, async () =>
        this.applyImage(record!, await this.runtime!.ensure(record!)),
      );
    if (record.status === "running" && this.identityMaterializer)
      await this.identityMaterializer(record);
    return this.publicRecord(record);
  }
  async setStatus(groupId: string, status: "running" | "stopped") {
    // Avoid ensure() for an existing record: it reconciles the persisted
    // running state and could execute an old startup-script revision before
    // the explicit start operation replaces the container.
    if (!this.record(groupId)) await this.ensure(groupId);
    const record = this.record(groupId)!;
    if (this.runtime)
      await this.run(groupId, async () => {
        if (status === "running")
          await this.applyImage(record, await this.runtime!.start(record));
        else await this.runtime!.stop(record);
      });
    record.status = status;
    record.updatedAt = new Date().toISOString();
    await this.save(record);
    if (status === "running" && this.identityMaterializer)
      await this.identityMaterializer(record);
    return this.publicRecord(record);
  }
  async rebuild(groupId: string, ownerId?: string) {
    // Rebuild must not first auto-start stale disposable compute. Provisioning
    // is still retained for a genuinely new administrative workspace.
    if (!this.record(groupId)) await this.ensure(groupId, ownerId);
    const record = this.record(groupId)!;
    if (!this.runtime)
      throw Object.assign(
        new Error("Administrative workspace runtime is unavailable"),
        { statusCode: 503 },
      );
    await this.run(groupId, async () =>
      this.applyImage(record, await this.runtime!.rebuild(record)),
    );
    record.status = "running";
    record.updatedAt = new Date().toISOString();
    await this.save(record);
    if (this.identityMaterializer) await this.identityMaterializer(record);
    return this.publicRecord(record);
  }
  findByWorkspaceId(workspaceId: string) {
    for (const group of useWorkerGroupStore().list()) {
      const record = group.adminWorkspace as
        | GroupAdministrativeWorkspaceRecord
        | undefined;
      if (record?.id === workspaceId) return record;
    }
  }
  async getStartupScript(groupId: string) {
    const record = this.record(groupId);
    if (!record)
      throw Object.assign(
        new Error("Group administrative workspace not provisioned"),
        { statusCode: 404 },
      );
    return this.startupScriptRecord(record);
  }
  async setStartupScript(groupId: string, value: unknown) {
    const record = this.record(groupId);
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
  async remove(groupId: string) {
    const record = this.record(groupId);
    if (record && this.runtime?.remove)
      await this.run(groupId, () => this.runtime!.remove!(record));
  }
  /** Recreate the runtime removed during a group-delete attempt whose final
   * group-store persistence failed. The group record (including workspace
   * identity and volumes) has already been restored by WorkerGroupStore. */
  async restoreAfterFailedGroupDelete(groupId:string,status:"running"|"stopped"|"error"|"creating"="running") {
    await this.ensure(groupId);
    if(status==="stopped") await this.setStatus(groupId,"stopped");
  }
  private async applyImage(
    record: GroupAdministrativeWorkspaceRecord,
    image: any,
  ) {
    if (!image) return;
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
      await this.save(record);
    }
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
