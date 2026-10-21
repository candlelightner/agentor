defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Delete an approved hardware device and revoke access", operationId: "deleteHardwareDevice" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHardwareDeviceStore } from "../../utils/services";
import { assertPhysicalGpuPolicyRemovalSafe, enforceHardwareDeviceRevocation } from "../../utils/hardware-device-revocation";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const deviceId = getRouterParam(event, "id")!;
  assertPhysicalGpuPolicyRemovalSafe(deviceId);
  const removed = await useHardwareDeviceStore().deleteDevice(deviceId);
  return { deleted: true, ...removed, enforcement: await enforceHardwareDeviceRevocation() };
});
