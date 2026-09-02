defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "Delete approved host path and revoke dependent access", operationId: "deleteHostMountPath" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHostMountStore } from "../../utils/services";
import { enforceHostMountRevocation } from "../../utils/host-mount-revocation";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const deleted = await useHostMountStore().deletePath(getRouterParam(event, "id")!);
  const enforcement = await enforceHostMountRevocation();
  return { deleted: true, ...deleted, enforcement };
});
