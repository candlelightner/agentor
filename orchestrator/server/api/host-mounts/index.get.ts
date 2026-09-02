defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "List approved host paths and owner assignments", operationId: "listHostMounts" } });
import { requireAuth } from "../../utils/auth-helpers";
import { getUserById } from "../../utils/auth";
import { useHostMountStore, useWorkerGroupStore, useWorkerStore } from "../../utils/services";

export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const query = getQuery(event);
  const ownerId = user.role === "admin" && typeof query.ownerId === "string"
    ? query.ownerId
    : user.id;
  if (user.role !== "admin" && query.ownerId && query.ownerId !== user.id)
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  if (!getUserById(ownerId))
    throw createError({ statusCode: 404, statusMessage: "Account not found" });
  const store = useHostMountStore();
  const entitled = new Set(store.listEntitledPaths(ownerId).map((path) => path.id));
  const catalog = (user.role === "admin" ? store.listCatalog() : store.listEntitledPaths(ownerId))
    .map((path) => ({ ...path, entitled: entitled.has(path.id) }));
  const workerId = typeof query.workerId === "string" ? query.workerId : undefined;
  const groupId = typeof query.groupId === "string" ? query.groupId : undefined;
  if (workerId && groupId)
    throw createError({ statusCode: 400, statusMessage: "Choose workerId or groupId, not both" });
  if (workerId) {
    const worker = useWorkerStore().get(ownerId, workerId);
    if (!worker) throw createError({ statusCode: 404, statusMessage: "Worker not found" });
  }
  if (groupId && !useWorkerGroupStore().get(ownerId, groupId))
    throw createError({ statusCode: 404, statusMessage: "Worker group not found" });
  const effectivePaths = workerId
    ? store.effectivePathsForWorker(ownerId, workerId)
    : store.pathsForNewWorker(ownerId, groupId);
  return {
    ownerId,
    canManageCatalog: user.role === "admin",
    catalog,
    grants: store.listGrants(ownerId),
    effectivePathIds: effectivePaths.map((path) => path.id),
    groups: useWorkerGroupStore().listForUser(ownerId).map((group) => ({
      id: group.id,
      name: group.name,
      parentId: group.parentId,
    })),
    workers: useWorkerStore().listForUser(ownerId).map((worker) => ({
      id: worker.id,
      displayName: worker.displayName,
      status: worker.status,
    })),
  };
});
