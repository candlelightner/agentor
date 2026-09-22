import { useManagedVolumeManager, type PersistenceActor } from "./managed-volume-manager";
import { managedVolumeInventory } from "./managed-volume-inventory";
import { publicVolume, volumeError } from "./managed-volume-store";
import { useWorkerStore, useWorkerGroupStore } from "./services";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { strictVolumeInput } from "./managed-volume-api";
import { resolveManagedVolumeControlTarget, resolveManagedVolumeSizingResource, type ManagedVolumeSizingResource } from "./managed-volume-inventory";
import {
  useManagedVolumeSizingManager,
  type VolumeSizeAuthorizer,
  type VolumeSizeControlJob,
} from "./managed-volume-sizing";

export type ManagementVolumePrincipal = { scope: "platform" | "group"; ownerId?: string; groupId?: string; workspaceId?: string };
export type ManagementVolumeAuthority = ManagementVolumePrincipal & {
  /** Management MCP supplies a live credential/policy recheck. Ordinary direct
   * domain callers retain their existing synchronous authority contract. */
  reauthorize?: () => Promise<ManagementVolumePrincipal>;
};
type SizingAuthorityDependencies = {
  resolve?: (volumeId: string, scope: { userId?: string; workerIds?: Set<string>; platform?: boolean }) => Promise<ManagedVolumeSizingResource | undefined>;
  workerIds?: (ownerId: string, groupId: string) => Set<string>;
};
const string = { type: "string", minLength: 1 };
const worker = { workerId: string };
const volume = { volumeId: string };
const mutation = { lockPassword: { type: "string", writeOnly: true } };
const application = { mode: { type: "string", enum: ["deferred", "recreate", "live"] }, acknowledgePrivileged: { type: "boolean" } };

export class ManagementVolumeDomain {
  tools() { return [
    tool("volumes.inventory", "List all positively identified Agentor volumes, their purpose, attachment state and backup selection. Group administrators see only their live subtree. Existing volumes.list workspace semantics are unchanged.", {}, [], true),
    tool("volumes.inspect", "Inspect a custom volume and its bounded asynchronous operation status.", volume, ["volumeId"], true),
    tool("volumes.size.start", "Start a bounded read-only size scan for a positively identified named volume. Returns allocated disk bytes and logical file bytes; live-volume results are approximate.", { ...volume, force: { type: "boolean" } }, ["volumeId"], true),
    tool("volumes.size.inspect", "Inspect a bounded volume size job. Inventory reads never start scans.", { jobId: string }, ["jobId"], true),
    tool("volumes.size.cancel", "Cancel a queued or running read-only volume size scan.", { jobId: string }, ["jobId"]),
    tool("volumes.rename", "Rename a custom volume without changing its target or data.", { ...volume, ...mutation, name: string }, ["volumeId", "name"]),
    tool("volumes.delete", "Permanently delete an unreferenced, detached volume. Explicit confirmation is required. Never accepts a Docker volume name or host path.", { ...volume, ...mutation, confirmed: { type: "boolean" } }, ["volumeId", "confirmed"], false, true),
    tool("workers.storage.inspect", "Inspect desired persistent paths and self-service permissions for one worker.", worker, ["workerId"], true),
    tool("workers.storage.add", "Add an application directory to local persistent storage. Deferred by default; recreation preserves current image/privileges. Live application requires acknowledged privileged helper execution, not a privileged worker.", { ...worker, ...mutation, ...application, target: string, name: string }, ["workerId", "target"]),
    tool("workers.storage.apply", "Apply an existing desired attachment and return its operation ID for polling through volumes.inspect.", { ...volume, ...mutation, ...application }, ["volumeId", "mode"]),
    tool("workers.storage.detach", "Detach a volume while retaining its data. Applying now recreates the worker; otherwise the change waits for recreation. Underlying directory contents become visible.", { ...volume, ...mutation, confirmed: { type: "boolean" }, applyNow: { type: "boolean" } }, ["volumeId", "confirmed"]),
    tool("workers.storage.reattach", "Reattach a retained volume at its original worker/path. Cross-worker sharing and retargeting are not supported.", { ...volume, ...mutation, ...application }, ["volumeId"]),
    tool("workers.storage.policy", "Set independent owner permissions for add-only self-service, self-service recreation, and privileged live-helper execution. All default off.", { ...worker, ...mutation, policy: { type: "object", additionalProperties: false, properties: { selfService: { type: "boolean" }, allowSelfRecreate: { type: "boolean" }, allowLiveMount: { type: "boolean" } } } }, ["workerId", "policy"]),
  ]; }

  async execute(name: string, args: Record<string, any>, authority: ManagementVolumeAuthority = { scope: "platform" }) {
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
    const sizeAuthorize = (volumeId: string) => managementVolumeSizeAuthorizer(volumeId, authority);
    if (name === "volumes.size.start") {
      const authorize = sizeAuthorize(args.volumeId), resource = await authorize();
      return { handled: true, result: await useManagedVolumeSizingManager().create(resource.ownerKey, authorize, args.force === true) };
    }
    if (name === "volumes.size.inspect" || name === "volumes.size.cancel") {
      const sizing = useManagedVolumeSizingManager(); await sizing.init();
      const job = sizing.getStored(args.jobId);
      if (!job) throw volumeError(404, "Storage resource not found.");
      const options = { authorize: (current: VolumeSizeControlJob) => authorizeManagementVolumeSizeJob(current, authority) };
      return { handled: true, result: name === "volumes.size.cancel"
        ? await sizing.cancel(job.id, options)
        : await sizing.get(job.id, options) };
    }
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

export interface VolumeSizeControlTarget {
  id: string;
  userId?: string;
  workerId?: string;
  ownerKey: string;
  platformOnly: boolean;
}

interface VolumeSizeControlDependencies {
  initialize?: () => Promise<void>;
  /** Synchronous durable lookup, after initialization and live authorization. */
  resolve?: (volumeId: string) => VolumeSizeControlTarget | undefined;
}

function ownedControlTarget(job: VolumeSizeControlJob, userId: string, resolve: NonNullable<VolumeSizeControlDependencies["resolve"]>) {
  const target = resolve(job.volumeId);
  if (!target || target.id !== job.volumeId || target.platformOnly ||
      target.userId !== userId || target.ownerKey !== userId || job.ownerKey !== userId)
    throw volumeError(404, "Storage resource not found.");
  return target;
}

/** Existing-job controls use current durable ownership even when Docker is
 * unavailable. No permission is inferred from the job's original requester. */
export async function authorizeRestVolumeSizeJob(
  requesterId: string,
  job: VolumeSizeControlJob,
  dependencies: VolumeSizeControlDependencies & {
    getUserById?: (userId: string) => unknown;
    isPlatformAdminUser?: (userId: string) => boolean;
  } = {},
) {
  await (dependencies.initialize ?? (() => useManagedVolumeManager().init()))();
  const auth = dependencies.getUserById && dependencies.isPlatformAdminUser
    ? undefined : await import("./auth");
  const getUserById = dependencies.getUserById ?? auth!.getUserById;
  const isPlatformAdminUser = dependencies.isPlatformAdminUser ?? auth!.isPlatformAdminUser;
  if (!getUserById(requesterId)) throw volumeError(404, "Storage resource not found.");
  if (isPlatformAdminUser(requesterId)) return;
  ownedControlTarget(job, requesterId, dependencies.resolve ?? resolveManagedVolumeControlTarget);
}

export async function authorizeManagementVolumeSizeJob(
  job: VolumeSizeControlJob,
  authority: ManagementVolumeAuthority,
  dependencies: VolumeSizeControlDependencies & {
    workerIds?: (ownerId: string, groupId: string) => Set<string>;
  } = {},
) {
  await (dependencies.initialize ?? (() => useManagedVolumeManager().init()))();
  // MCP rechecks the original credential, policy and workspace binding after
  // asynchronous preparation. Durable target and descendant reads are then synchronous.
  const current = authority.reauthorize ? await authority.reauthorize() : authority;
  if (current.scope !== authority.scope || current.ownerId !== authority.ownerId ||
      current.groupId !== authority.groupId || current.workspaceId !== authority.workspaceId)
    throw volumeError(403, "Administrative storage scope is unavailable.");
  if (current.scope === "platform") return;
  if (!current.ownerId || !current.groupId)
    throw volumeError(403, "Administrative storage scope is unavailable.");
  const target = ownedControlTarget(job, current.ownerId, dependencies.resolve ?? resolveManagedVolumeControlTarget);
  const workerIds = dependencies.workerIds ?? ((ownerId: string, groupId: string) =>
    new Set(new WorkerGroupHierarchy(useWorkerGroupStore()).descendants(ownerId, groupId, true).flatMap((group) => group.workerIds)));
  if (!target.workerId || !workerIds(current.ownerId, current.groupId).has(target.workerId))
    throw volumeError(404, "Storage resource not found.");
}

/** The sizing manager deliberately calls this authorizer at admission, dequeue,
 * helper start, and publication. Re-resolve both the management principal and
 * its current group subtree on every call; never reduce a durable async job to
 * the descendant set captured by the initiating request. */
export function managementVolumeSizeAuthorizer(
  volumeId: string,
  authority: ManagementVolumeAuthority,
  dependencies: SizingAuthorityDependencies = {},
): VolumeSizeAuthorizer {
  const resolve = dependencies.resolve ?? resolveManagedVolumeSizingResource;
  const workerIds = dependencies.workerIds ?? ((ownerId: string, groupId: string) =>
    new Set(new WorkerGroupHierarchy(useWorkerGroupStore()).descendants(ownerId, groupId, true).flatMap((group) => group.workerIds)));
  return async () => {
    const reauthorize = () => authority.reauthorize ? authority.reauthorize() : Promise.resolve(authority);
    const initial = await reauthorize();
    let initialWorkers: Set<string> | undefined;
    if (initial.scope === "group") {
      if (!initial.ownerId || !initial.groupId)
        throw volumeError(403, "Administrative storage scope is unavailable.");
      initialWorkers = workerIds(initial.ownerId, initial.groupId);
    }
    const resource = await resolve(volumeId, {
      platform: initial.scope === "platform",
      userId: initial.ownerId,
      workerIds: initialWorkers,
    });
    if (!resource) throw volumeError(404, "Storage resource not found.");

    // Discovery talks to Docker and can take seconds. Treat its result as an
    // untrusted snapshot until the credential, policy, workspace binding, and
    // group subtree have all been checked again. Do not repeat discovery: the
    // already-resolved server-private resource contains everything needed for
    // this final authorization decision.
    const current = await reauthorize();
    if (
      current.scope !== initial.scope ||
      current.ownerId !== initial.ownerId ||
      current.groupId !== initial.groupId ||
      current.workspaceId !== initial.workspaceId
    )
      throw volumeError(403, "Administrative storage scope is unavailable.");
    if (current.scope === "group") {
      if (!current.ownerId || !current.groupId)
        throw volumeError(403, "Administrative storage scope is unavailable.");
      const allowedWorkers = workerIds(current.ownerId, current.groupId);
      if (
        resource.userId !== current.ownerId ||
        !resource.workerId ||
        !allowedWorkers.has(resource.workerId)
      )
        throw volumeError(404, "Storage resource not found.");
    }
    return resource;
  };
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[], readOnly = false, destructive = false) {
  return { name, description, group: "storage-maintenance" as const,
    inputSchema: { type: "object", additionalProperties: false, properties, required },
    annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: false } };
}
export const VOLUME_MCP_NAMES = new ManagementVolumeDomain().tools().map((t) => t.name);
