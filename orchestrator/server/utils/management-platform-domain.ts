import { useManagedNetworkManager } from "./managed-network-manager";
import {
  useManagedNetworkStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";
import { useStorageVisibilityManager } from "./storage-visibility";
import { verifyWorkerMutationUnlocks } from "./worker-protection-lock";
import { withWorkerNetworkMutation } from "./worker-group-manager";

export interface ManagementPlatformTool {
  name: string;
  group: "networking" | "storage-maintenance";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}
const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutate = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

/** Transport-free MCP adapter for controlled Docker networking and conservative
 * disk cleanup. It exposes no Docker handle or arbitrary network name. */
export class ManagementPlatformDomain {
  tools(): ManagementPlatformTool[] {
    return [
      tool("networks.list", "networking", "List managed worker networks", read),
      tool("networks.inspect", "networking", "Inspect desired and actual membership", read),
      tool("networks.create", "networking", "Create an all, group, or selected worker network", mutate),
      tool("networks.update", "networking", "Rename or change managed network membership", mutate),
      tool("networks.reconcile", "networking", "Apply and validate desired membership", mutate),
      tool("networks.delete", "networking", "Delete a managed worker network", { ...mutate, destructiveHint: true }),
      tool("storage.status", "storage-maintenance", "Inspect disk usage, staging, images, and stale helpers", read),
      tool("storage.cleanup", "storage-maintenance", "Run a named conservative cleanup action", { ...mutate, destructiveHint: true }),
    ];
  }

  async execute(name: string, args: Record<string, unknown>) {
    if (!this.tools().some((candidate) => candidate.name === name)) return { handled: false };
    if (name === "storage.status") return { handled: true, result: await useStorageVisibilityManager().inspect() };
    if (name === "storage.cleanup")
      return { handled: true, result: await useStorageVisibilityManager().cleanup(cleanupInput(required(args.action, "action"))) };
    const store = useManagedNetworkStore();
    const manager = useManagedNetworkManager();
    if (name === "networks.list") {
      const ownerId = optional(args.ownerId);
      return { handled: true, result: ownerId ? store.listForUser(ownerId) : store.list() };
    }
    if (name === "networks.create") {
      const ownerId = required(args.ownerId, "ownerId");
      return { handled: true, result: await withWorkerNetworkMutation(ownerId, async () => {
      const label = required(args.name, "name").trim();
      const scope = required(args.scope, "scope");
      if (!label || label.length > 100 || !["all", "selected", "group"].includes(scope))
        throw error(400, "Invalid managed network definition");
      const groupId = optional(args.groupId);
      if (scope === "group") {
        const group = groupId ? useWorkerGroupStore().get(ownerId, groupId) : undefined;
        if (!group) throw error(400, "Group not found for network owner");
      }
      validateWorkers(ownerId, args.workerIds);
      const prospective={userId:ownerId,scope,groupId,workerIds:strings(args.workerIds)};
      await verifyWorkerMutationUnlocks(await affectedWorkerIds(prospective), args.lockPasswords);
      const network = await store.create(ownerId, label, scope as any, groupId);
      if (scope === "selected")
        await store.update(ownerId, network.id, { workerIds: strings(args.workerIds) });
      const saved = store.get(ownerId, network.id)!;
      try {
        const reconciliation = await manager.reconcile(saved);
        if (reconciliation.partialFailures.length) throw error(409, reconciliation.partialFailures.join("; "));
        return { ...saved, reconciliation };
      } catch (cause) {
        await manager.remove(saved).catch(() => {});
        await store.remove(ownerId, saved.id).catch(() => {});
        throw cause;
      }
      }) };
    }
    const id = required(args.networkId, "networkId");
    const network = store.findById(id);
    if (!network) throw error(404, "Managed network not found");
    if (name === "networks.inspect")
      return { handled: true, result: { ...(await manager.topology(network)), validation: await manager.validate(network) } };
    if (name === "networks.delete") {
      return { handled: true, result: await withWorkerNetworkMutation(network.userId, async () => {
        const current=store.findById(id);if(!current||current.userId!==network.userId)throw error(404,"Managed network not found");
        await verifyWorkerMutationUnlocks(await affectedWorkerIds(current), args.lockPasswords);
        await manager.remove(current);
        await store.remove(current.userId, id);
        return { id, deleted: true };
      }) };
    }
    if (name === "networks.reconcile")
      return { handled: true, result: await withWorkerNetworkMutation(network.userId, async () => {
        const current=store.findById(id);if(!current||current.userId!==network.userId)throw error(404,"Managed network not found");
        await verifyWorkerMutationUnlocks(await affectedWorkerIds(current), args.lockPasswords);
        return manager.reconcile(current);
      }) };
    return { handled: true, result: await withWorkerNetworkMutation(network.userId, async () => {
      const current=store.findById(id);if(!current||current.userId!==network.userId)throw error(404,"Managed network not found");
      const patch: any = {};
      if (args.name !== undefined) {
        const label = required(args.name, "name").trim();
        if (!label || label.length > 100) throw error(400, "Invalid network name");
        patch.name = label;
      }
      if (args.scope !== undefined) {
        const scope = required(args.scope, "scope");
        if (!["all", "selected", "group"].includes(scope)) throw error(400, "Invalid network scope");
        patch.scope = scope;
      }
      if (args.workerIds !== undefined) {
        validateWorkers(current.userId, args.workerIds);
        patch.workerIds = strings(args.workerIds);
      }
      if (args.groupId !== undefined) {
        const groupId = optional(args.groupId);
        if (groupId && !useWorkerGroupStore().get(current.userId, groupId)) throw error(400, "Group not found");
        patch.groupId = groupId;
      }
      const prospective={...current,...patch};
      if(prospective.scope==="group"&&(!prospective.groupId||!useWorkerGroupStore().get(current.userId,prospective.groupId)))throw error(400,"Group not found");
      await verifyWorkerMutationUnlocks([...await affectedWorkerIds(current), ...await affectedWorkerIds(prospective)], args.lockPasswords);
      const updated = await store.update(current.userId, id, patch);
      const reconciliation=await manager.reconcile(updated);
      if(reconciliation.partialFailures.length){await store.update(current.userId,id,{name:current.name,scope:current.scope,groupId:current.groupId||'',workerIds:current.workerIds}).catch(()=>{});await manager.reconcile(current).catch(()=>{});throw error(409,reconciliation.partialFailures.join('; '));}
      return { ...updated, reconciliation };
    }) };
  }
}

async function affectedWorkerIds(network: any): Promise<string[]> {
  if (network.scope === "selected") return network.workerIds || [];
  if (network.scope === "group") return useWorkerGroupStore().get(network.userId, network.groupId)?.workerIds || [];
  return useWorkerStore().listForUser(network.userId).map((worker: any) => worker.id);
}

function tool(name: string, group: ManagementPlatformTool["group"], description: string, annotations: Record<string, boolean>): ManagementPlatformTool {
  return { name, group, description, annotations, inputSchema: { type: "object", additionalProperties: true } };
}
function required(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw error(400, `${name} is required`);
  return value;
}
function optional(value: unknown) { return typeof value === "string" && value ? value : undefined; }
function strings(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw error(400, "workerIds must be strings");
  return [...new Set(value as string[])];
}
function validateWorkers(ownerId: string, value: unknown) {
  for (const id of strings(value))
    if (!useWorkerStore().get(ownerId, id)) throw error(400, "Workers must belong to network owner");
}
function error(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function cleanupInput(action: string) {
  if (action === "dangling-images") return { danglingImages: true };
  if (action === "build-cache") return { buildCache: true };
  if (action === "stale-helpers") return { staleHelpers: true };
  if (action === "stale-staging") return { staleStaging: true };
  throw error(400, "Unknown storage cleanup action");
}
