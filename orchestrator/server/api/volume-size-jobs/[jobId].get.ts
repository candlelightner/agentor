import { requireAuth } from "../../utils/auth-helpers";
import { useManagedVolumeSizingManager } from "../../utils/managed-volume-sizing";
import { authorizeRestVolumeSizeJob } from "../../utils/management-volume-domain";

defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Inspect a volume size job", operationId: "inspectVolumeSizeJob" } });

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event), manager = useManagedVolumeSizingManager();
  const id = getRouterParam(event, "jobId")!;
  const result = await manager.get(id, {
    authorize: (job) => authorizeRestVolumeSizeJob(user.id, job),
  });
  if (!result)
    throw createError({ statusCode: 404, statusMessage: "Volume size job not found" });
  return result;
});
