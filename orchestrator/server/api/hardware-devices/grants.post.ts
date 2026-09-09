defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Assign an entitled device to workers or groups", operationId: "createHardwareDeviceGrant" } });
import { requireAuth } from "../../utils/auth-helpers";
import { getUserById } from "../../utils/auth";
import { useHardwareDeviceStore } from "../../utils/services";
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event); const body = await readBody(event);
  const ownerId = user.role === "admin" && typeof body?.ownerId === "string" ? body.ownerId : user.id;
  if (user.role !== "admin" && body?.ownerId && body.ownerId !== user.id) throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  if (!getUserById(ownerId)) throw createError({ statusCode: 404, statusMessage: "Account not found" });
  if (typeof body?.deviceId !== "string" || typeof body?.targetType !== "string") throw createError({ statusCode: 400, statusMessage: "deviceId and targetType are required" });
  const grant = await useHardwareDeviceStore().createOwnerGrant(ownerId, { deviceId: body.deviceId, targetType: body.targetType, targetId: typeof body.targetId === "string" ? body.targetId : undefined });
  setResponseStatus(event, 201); return grant;
});
