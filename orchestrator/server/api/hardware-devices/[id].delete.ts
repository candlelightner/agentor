defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Delete an approved hardware device and revoke access", operationId: "deleteHardwareDevice" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHardwareDeviceStore } from "../../utils/services";
import { enforceHardwareDeviceRevocation } from "../../utils/hardware-device-revocation";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const removed = await useHardwareDeviceStore().deleteDevice(getRouterParam(event, "id")!);
  return { deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation() };
});
