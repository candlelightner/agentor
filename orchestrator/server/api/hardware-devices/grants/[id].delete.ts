defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Revoke a device assignment and its delegations", operationId: "deleteHardwareDeviceGrant" } });
import { requireAuth } from "../../../utils/auth-helpers";
import { getUserById } from "../../../utils/auth";
import { useHardwareDeviceStore } from "../../../utils/services";
import { enforceHardwareDeviceRevocation } from "../../../utils/hardware-device-revocation";
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event); const query = getQuery(event);
  const requestedOwner = typeof query.ownerId === "string" ? query.ownerId : user.id;
  const ownerId = user.role === "admin" ? requestedOwner : user.id;
  if (user.role !== "admin" && requestedOwner !== user.id) throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  if (!getUserById(ownerId)) throw createError({ statusCode: 404, statusMessage: "Account not found" });
  const removed = await useHardwareDeviceStore().deleteGrant(ownerId, getRouterParam(event, "id")!);
  return { deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation(ownerId) };
});
