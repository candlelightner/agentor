defineRouteMeta({ openAPI: { tags: ["Hardware devices"], summary: "Rename an approved hardware device", operationId: "updateHardwareDevice" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHardwareDeviceStore } from "../../utils/services";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  if (body?.selector !== undefined || body?.kind !== undefined)
    throw createError({ statusCode: 400, statusMessage: "Hardware identity and kind are immutable" });
  return { device: await useHardwareDeviceStore().updateDevice(getRouterParam(event, "id")!, { name: body?.name }) };
});
