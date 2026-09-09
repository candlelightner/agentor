defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Approve a discovered host hardware device", operationId: "approveHardwareDevice" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHardwareDeviceStore } from "../../utils/services";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  const device = await useHardwareDeviceStore().approveDevice({ selector: body?.selector, name: body?.name });
  setResponseStatus(event, 201);
  return device;
});
