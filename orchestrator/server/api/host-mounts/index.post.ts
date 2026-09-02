defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "Approve a raw host path", operationId: "createHostMountPath", responses: { 201: { description: "Approved path" }, 403: { description: "Platform administrator required" } } } });
import { requireAdmin } from "../../utils/auth-helpers";
import { useHostMountStore } from "../../utils/services";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  const created = await useHostMountStore().createPath({
    name: body?.name,
    sourcePath: body?.sourcePath,
    allowWrite: body?.allowWrite,
  });
  setResponseStatus(event, 201);
  return created;
});
