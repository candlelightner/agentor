defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "List discovered and approved hardware devices", operationId: "listHardwareDevices" } });
import { requireAuth } from "../../utils/auth-helpers";
import { getUserById } from "../../utils/auth";
import { useHardwareDeviceStore, useWorkerGroupStore, useWorkerStore } from "../../utils/services";

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const query = getQuery(event);
  const ownerId = user.role === "admin" && typeof query.ownerId === "string" ? query.ownerId : user.id;
  if (user.role !== "admin" && query.ownerId && query.ownerId !== user.id)
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  if (!getUserById(ownerId)) throw createError({ statusCode: 404, statusMessage: "Account not found" });
  const store = useHardwareDeviceStore();
  const discovered = await store.listDiscoveredDevices();
  const liveSelectors = new Set(discovered.map((item) => item.selector));
  const entitled = new Set(store.listEntitledDevices(ownerId).map((item) => item.id));
  const baseCatalog = user.role === "admin" ? store.listCatalog() : store.listEntitledDevices(ownerId);
  const workerId = typeof query.workerId === "string" ? query.workerId : undefined;
  const groupId = typeof query.groupId === "string" ? query.groupId : undefined;
  if (workerId && groupId) throw createError({ statusCode: 400, statusMessage: "Choose workerId or groupId, not both" });
  if (workerId && !useWorkerStore().get(ownerId, workerId)) throw createError({ statusCode: 404, statusMessage: "Worker not found" });
  if (groupId && !useWorkerGroupStore().get(ownerId, groupId)) throw createError({ statusCode: 404, statusMessage: "Worker group not found" });
  const effective = workerId
    ? store.effectiveDevicesForWorker(ownerId, workerId)
    : store.devicesForNewWorker(ownerId, groupId);
  const approvedSelectors = new Set(store.listCatalog().map((item) => item.selector));
  return {
    ownerId,
    canManageCatalog: user.role === "admin",
    catalog: baseCatalog.map((item) => ({ ...item, entitled: entitled.has(item.id), available: liveSelectors.has(item.selector) })),
    discovered: user.role === "admin" ? discovered.filter((item) => !approvedSelectors.has(item.selector)) : [],
    grants: store.listGrants(ownerId),
    effectiveDeviceIds: effective.map((item) => item.id),
    groups: useWorkerGroupStore().listForUser(ownerId).map(({ id, name, parentId }) => ({ id, name, parentId })),
    workers: useWorkerStore().listForUser(ownerId).map(({ id, displayName, status }) => ({ id, displayName, status })),
  };
});
