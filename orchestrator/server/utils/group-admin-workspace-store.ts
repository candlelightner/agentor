import { randomUUID } from "node:crypto";
import type {
  AdminWorkspaceRuntimeAdapter,
  AdministrativeWorkspaceRecord,
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
  private tails = new Map<string, Promise<void>>();
  setRuntimeAdapter(runtime: AdminWorkspaceRuntimeAdapter) {
    this.runtime = runtime;
  }
  setIdentityMaterializer(
    materializer: (record: GroupAdministrativeWorkspaceRecord) => Promise<void>,
  ) {
    this.identityMaterializer = materializer;
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
  private run<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(groupId) ?? Promise.resolve();
    const result = tail.then(operation, operation);
    this.tails.set(
      groupId,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
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
    await this.ensure(groupId);
    const record = this.record(groupId)!;
    if (this.runtime)
      await this.run(groupId, () =>
        status === "running"
          ? this.runtime!.start(record)
          : this.runtime!.stop(record),
      );
    record.status = status;
    record.updatedAt = new Date().toISOString();
    await this.save(record);
    if (status === "running" && this.identityMaterializer)
      await this.identityMaterializer(record);
    return this.publicRecord(record);
  }
  async rebuild(groupId: string, ownerId?: string) {
    await this.ensure(groupId, ownerId);
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
  async remove(groupId: string) {
    const record = this.record(groupId);
    if (record && this.runtime?.remove)
      await this.run(groupId, () => this.runtime!.remove!(record));
  }
  private async applyImage(
    record: GroupAdministrativeWorkspaceRecord,
    image: any,
  ) {
    if (
      !image ||
      (record.imageName === image.name && record.imageDigest === image.digest)
    )
      return;
    record.imageName = image.name;
    record.imageDigest = image.digest;
    record.updatedAt = new Date().toISOString();
    await this.save(record);
  }
  private publicRecord(record: GroupAdministrativeWorkspaceRecord) {
    return {
      ...record,
      userId: record.ownerId,
      ownerId: undefined,
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
