defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "Update approved host path policy", operationId: "updateHostMountPath" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHostMountStore } from "../../utils/services";
import { enforceHostMountRevocation } from "../../utils/host-mount-revocation";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const id = getRouterParam(event, "id")!;
  const before = useHostMountStore().getPath(id);
  const body = await readBody(event);
  if (body?.sourcePath !== undefined)
    throw createError({ statusCode: 400, statusMessage: "Approved source paths are immutable; create a new catalog entry instead" });
  const updated = await useHostMountStore().updatePath(id, {
    name: body?.name,
    allowWrite: body?.allowWrite,
  });
  const revocation = before?.allowWrite && !updated.allowWrite
    ? await enforceHostMountRevocation()
    : undefined;
  return { path: updated, revocation };
});
