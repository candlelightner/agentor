import { useHostMountStore } from "./services";
import { enforceHostMountRevocation } from "./host-mount-revocation";
import { getUserById } from "./auth";

type Authority = {
  scope: "platform" | "group";
  ownerId?: string;
  groupId?: string;
};

const read = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, idempotentHint: false, openWorldHint: false };

export class ManagementHostMountDomain {
  tools() {
    return [
      tool("host-mounts.catalog.list", "List globally approved host paths. Platform administration only.", {}, read),
      tool("host-mounts.catalog.create", "Approve a canonical host directory. This never mounts it until an account entitlement and worker/group assignment also exist.", {
        name: stringSchema(), sourcePath: stringSchema(), allowWrite: { type: "boolean" },
      }, mutate, ["name", "sourcePath"]),
      tool("host-mounts.catalog.update", "Rename an approved path or change whether writable worker mounts are allowed. Source paths are immutable.", {
        pathId: stringSchema(), name: stringSchema(), allowWrite: { type: "boolean" },
      }, mutate, ["pathId"]),
      tool("host-mounts.catalog.delete", "Delete an approved path, revoke every dependent grant, stop affected workers, and require rebuild before restart.", {
        pathId: stringSchema(),
      }, { ...mutate, destructiveHint: true }, ["pathId"]),
      tool("host-mounts.entitlements.list", "List approved paths and entitlements for an account.", {
        ownerId: stringSchema(),
      }, read, ["ownerId"]),
      tool("host-mounts.entitlements.set", "Grant or revoke an account's ability to assign one approved path.", {
        ownerId: stringSchema(), pathId: stringSchema(), enabled: { type: "boolean" },
      }, mutate, ["ownerId", "pathId", "enabled"]),
      tool("host-mounts.grants.list", "List an account's all-worker, group, worker, and delegated host-path assignments.", {
        ownerId: stringSchema(),
      }, read, ["ownerId"]),
      tool("host-mounts.grants.create", "Assign an entitled path to all workers, one direct group, or one worker. Raw source paths are never accepted.", {
        ownerId: stringSchema(), pathId: stringSchema(), targetType: { type: "string", enum: ["all", "group", "worker"] }, targetId: stringSchema(),
      }, mutate, ["ownerId", "pathId", "targetType"]),
      tool("host-mounts.grants.delete", "Revoke an owner assignment and all group delegations derived from it.", {
        ownerId: stringSchema(), grantId: stringSchema(),
      }, { ...mutate, destructiveHint: true }, ["ownerId", "grantId"]),
      tool("host-mounts.delegations.list", "List host-path identities usable by this administrative group's workers, the narrower set explicitly delegable further, and this group's own downward delegations. Raw host paths are neither returned nor accepted.", {}, read),
      tool("host-mounts.delegations.create", "Delegate a path already granted to this administrative group to a descendant group or worker in its subtree.", {
        pathId: stringSchema(), targetType: { type: "string", enum: ["group", "worker"] }, targetId: stringSchema(),
      }, mutate, ["pathId", "targetType", "targetId"]),
      tool("host-mounts.delegations.delete", "Revoke a downward delegation created by this administrative group.", {
        grantId: stringSchema(),
      }, { ...mutate, destructiveHint: true }, ["grantId"]),
    ];
  }

  async execute(
    name: string,
    args: Record<string, any>,
    authority?: Authority,
  ): Promise<{ handled: boolean; result?: unknown }> {
    if (!name.startsWith("host-mounts.")) return { handled: false };
    if (!authority) throw failure(401, "Administrative identity required");
    const store = useHostMountStore();
    const groupTool = name.startsWith("host-mounts.delegations.");
    if (authority.scope === "group" && !groupTool)
      throw failure(
        403,
        "Group administrative workspaces cannot approve raw host paths or create account-wide assignments. Ask the account owner or platform administrator to grant a path to this group first.",
      );
    if (authority.scope === "platform" && groupTool)
      throw failure(400, "Group delegation tools require a group administrative workspace");

    if (name === "host-mounts.catalog.list") return handled(store.listCatalog());
    if (name === "host-mounts.catalog.create")
      return handled(await store.createPath({
        name: args.name,
        sourcePath: args.sourcePath,
        allowWrite: args.allowWrite,
      }));
    if (name === "host-mounts.catalog.update") {
      if (args.sourcePath !== undefined)
        throw failure(400, "Approved source paths are immutable");
      const before = store.getPath(args.pathId);
      const path = await store.updatePath(args.pathId, args);
      const enforcement = before?.allowWrite && !path.allowWrite
        ? await enforceHostMountRevocation()
        : undefined;
      return handled({ path, enforcement });
    }
    if (name === "host-mounts.catalog.delete") {
      const removed = await store.deletePath(args.pathId);
      return handled({ deleted: true, ...removed, enforcement: await enforceHostMountRevocation() });
    }
    if (name === "host-mounts.entitlements.list") {
      assertOwner(args.ownerId);
      const entitled = new Set(store.listEntitledPaths(args.ownerId).map((path) => path.id));
      return handled({
        ownerId: args.ownerId,
        catalog: store.listCatalog().map((path) => ({ ...path, entitled: entitled.has(path.id) })),
      });
    }
    if (name === "host-mounts.entitlements.set") {
      assertOwner(args.ownerId);
      const changed = await store.setEntitlement(args.ownerId, args.pathId, args.enabled);
      return handled({
        ...changed,
        enforcement: args.enabled ? undefined : await enforceHostMountRevocation(args.ownerId),
      });
    }
    if (name === "host-mounts.grants.list") {
      assertOwner(args.ownerId);
      return handled({ ownerId: args.ownerId, grants: store.listGrants(args.ownerId) });
    }
    if (name === "host-mounts.grants.create") {
      assertOwner(args.ownerId);
      return handled(await store.createOwnerGrant(args.ownerId, {
        pathId: args.pathId,
        targetType: args.targetType,
        targetId: args.targetId,
      }));
    }
    if (name === "host-mounts.grants.delete") {
      assertOwner(args.ownerId);
      const removed = await store.deleteGrant(args.ownerId, args.grantId);
      return handled({ deleted: true, ...removed, enforcement: await enforceHostMountRevocation(args.ownerId) });
    }

    const ownerId = authority.ownerId!;
    const groupId = authority.groupId!;
    if (name === "host-mounts.delegations.list") {
      const publicPath = ({ id, name, allowWrite }: { id: string; name: string; allowWrite: boolean }) => ({
        id,
        name,
        allowWrite,
      });
      const available = store
        .listEntitledPaths(ownerId)
        .filter((path) => store.canWorkerUsePath(ownerId, "__group_scope__", path.id, groupId))
        .map(publicPath);
      const delegable = store
        .delegablePathsForGroup(ownerId, groupId)
        .map(publicPath);
      const grants = store.listGrants(ownerId).filter(
        (grant) =>
          (grant.targetType === "group" && grant.targetId === groupId) ||
          (grant.grantorType === "group" && grant.grantorGroupId === groupId),
      );
      return handled({
        ownerId,
        authorityGroupId: groupId,
        availablePaths: available,
        delegablePaths: delegable,
        grants,
      });
    }
    if (name === "host-mounts.delegations.create")
      return handled(await store.createGroupDelegation(ownerId, groupId, args as any));
    if (name === "host-mounts.delegations.delete") {
      const removed = await store.deleteGrant(ownerId, args.grantId, groupId);
      return handled({ deleted: true, ...removed, enforcement: await enforceHostMountRevocation(ownerId) });
    }
    throw failure(404, "Unknown host mount management operation");
  }
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  annotations: Record<string, boolean>,
  required: string[] = [],
) {
  return {
    name,
    group: "configuration" as const,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      ...(required.length ? { required } : {}),
      properties,
    },
    annotations,
  };
}
function stringSchema() { return { type: "string", minLength: 1 }; }
function handled(result: unknown) { return { handled: true, result }; }
function failure(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
function assertOwner(ownerId: unknown): asserts ownerId is string {
  if (typeof ownerId !== "string" || !getUserById(ownerId))
    throw failure(404, "Account not found");
}
