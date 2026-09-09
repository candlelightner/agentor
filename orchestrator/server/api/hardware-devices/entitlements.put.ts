defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Entitle an account to a hardware device", operationId: "setHardwareDeviceEntitlement" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { getUserById } from "../../utils/auth";
import { useHardwareDeviceStore } from "../../utils/services";
import { enforceHardwareDeviceRevocation } from "../../utils/hardware-device-revocation";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  if (typeof body?.ownerId !== "string" || !getUserById(body.ownerId)) throw createError({ statusCode: 404, statusMessage: "Account not found" });
  if (typeof body?.deviceId !== "string" || typeof body?.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "ownerId, deviceId, and enabled are required" });
  const changed = await useHardwareDeviceStore().setEntitlement(body.ownerId, body.deviceId, body.enabled);
  return { ...changed, enforcement: body.enabled ? undefined : await enforceHardwareDeviceRevocation(body.ownerId) };
});
