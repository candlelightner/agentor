import { useManagedVolumeManager, type PersistenceActor } from "./managed-volume-manager";
import { managedVolumeInventory } from "./managed-volume-inventory";
import { publicVolume, volumeError } from "./managed-volume-store";
import { useWorkerStore, useWorkerGroupStore } from "./services";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { strictVolumeInput } from "./managed-volume-api";

type Authority = { scope: "platform" | "group"; ownerId?: string; groupId?: string };
const string = { type: "string", minLength: 1 };
const worker = { workerId: string };
const volume = { volumeId: string };
const mutation = { lockPassword: { type: "string", writeOnly: true } };
const application = { mode: { type: "string", enum: ["deferred", "recreate", "live"] }, acknowledgePrivileged: { type: "boolean" } };

export class ManagementVolumeDomain {
  tools() { return [
    tool("volumes.inventory", "List all positively identified Agentor volumes, their purpose, attachment state and backup selection. Group administrators see only their live subtree. Existing volumes.list workspace semantics are unchanged.", {}, [], true),
    tool("volumes.inspect", "Inspect a custom volume and its bounded asynchronous operation status.", volume, ["volumeId"], true),
    tool("volumes.rename", "Rename a custom volume without changing its target or data.", { ...volume, ...mutation, name: string }, ["volumeId", "name"]),
    tool("volumes.delete", "Permanently delete an unreferenced, detached volume. Explicit confirmation is required. Never accepts a Docker volume name or host path.", { ...volume, ...mutation, confirmed: { type: "boolean" } }, ["volumeId", "confirmed"], false, true),
    tool("workers.storage.inspect", "Inspect desired persistent paths and self-service permissions for one worker.", worker, ["workerId"], true),
    tool("workers.storage.add", "Add an application directory to local persistent storage. Deferred by default; recreation preserves current image/privileges. Live application requires acknowledged privileged helper execution, not a privileged worker.", { ...worker, ...mutation, ...application, target: string, name: string }, ["workerId", "target"]),
    tool("workers.storage.apply", "Apply an existing desired attachment and return its operation ID for polling through volumes.inspect.", { ...volume, ...mutation, ...application }, ["volumeId", "mode"]),
    tool("workers.storage.detach", "Detach a volume while retaining its data. Applying now recreates the worker; otherwise the change waits for recreation. Underlying directory contents become visible.", { ...volume, ...mutation, confirmed: { type: "boolean" }, applyNow: { type: "boolean" } }, ["volumeId", "confirmed"]),
    tool("workers.storage.reattach", "Reattach a retained volume at its original worker/path. Cross-worker sharing and retargeting are not supported.", { ...volume, ...mutation, ...application }, ["volumeId"]),
    tool("workers.storage.policy", "Set independent owner permissions for add-only self-service, self-service recreation, and privileged live-helper execution. All default off.", { ...worker, ...mutation, policy: { type: "object", additionalProperties: false, properties: { selfService: { type: "boolean" }, allowSelfRecreate: { type: "boolean" }, allowLiveMount: { type: "boolean" } } } }, ["workerId", "policy"]),
  ]; }

  async execute(name: string, args: Record<string, any>, authority: Authority = { scope: "platform" }) {
    const definition = this.tools().find((t) => t.name === name);
    if (!definition) return { handled: false };
    strictVolumeInput(args, Object.keys(definition.inputSchema.properties));
    const manager = useManagedVolumeManager(); await manager.init();
    const scope = () => {
      if (authority.scope === "platform") return undefined;
      if (!authority.ownerId || !authority.groupId) throw volumeError(403, "Administrative storage scope is unavailable.");
      return new Set(new WorkerGroupHierarchy(useWorkerGroupStore()).descendants(authority.ownerId, authority.groupId, true).flatMap((g) => g.workerIds));
    };
    if (name === "volumes.inventory") return { handled: true, result: await managedVolumeInventory({ platform: authority.scope === "platform", userId: authority.ownerId, workerIds: scope() }) };
    const v = args.volumeId ? manager.store.list().find((v) => v.id === args.volumeId) : undefined;
    if (v?.retainedAfterAccountDeletion && authority.scope !== "platform") throw volumeError(404, "Storage resource not found.");
    const w = args.workerId ? useWorkerStore().list().find((w) => w.id === args.workerId) : undefined;
    const userId = v?.userId ?? w?.userId, workerId = v?.workerId ?? w?.id;
    if (!userId || !workerId) throw volumeError(404, "Storage resource not found.");
    const authorize = () => {
      const ids = scope();
      if (ids && (userId !== authority.ownerId || !ids.has(workerId))) throw volumeError(404, "Storage resource not found.");
    };
    authorize();
    const actor: PersistenceActor = { userId, workerId, authorize, lockPassword: args.lockPassword, platformAdmin: authority.scope === "platform" };
    let result: unknown;
    switch (name) {
      case "volumes.inspect": result = publicVolume(v!); break;
      case "volumes.rename": result = await manager.rename(actor, v!.id, args.name); break;
      case "volumes.delete": result = await manager.delete(actor, v!.id, args.confirmed === true); break;
      case "workers.storage.inspect": result = await manager.inspect(actor); break;
      case "workers.storage.add": result = await manager.add(actor, { target: args.target, name: args.name, mode: args.mode, acknowledgePrivileged: args.acknowledgePrivileged }); break;
      case "workers.storage.apply": result = await manager.apply(actor, v!.id, args.mode, args.acknowledgePrivileged); break;
      case "workers.storage.detach": result = await manager.detach(actor, v!.id, args.applyNow === true, args.confirmed === true); break;
      case "workers.storage.reattach": result = await manager.reattach(actor, v!.id, args.mode, args.acknowledgePrivileged); break;
      case "workers.storage.policy": result = await manager.policy(actor, strictVolumeInput(args.policy, ["selfService", "allowSelfRecreate", "allowLiveMount"])); break;
    }
    return { handled: true, result };
  }
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly = false, destructive = false) {
  return { name, description, group: "storage-maintenance" as const,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false } };
}
export const VOLUME_MCP_NAMES = new ManagementVolumeDomain().tools().map((t) => t.name);
