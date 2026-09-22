import { requireAuth } from "../../utils/auth-helpers";
import { useManagedVolumeSizingManager } from "../../utils/managed-volume-sizing";
import { authorizeRestVolumeSizeJob } from "../../utils/management-volume-domain";

defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Cancel a volume size job", operationId: "cancelVolumeSizeJob" } });

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event), manager = useManagedVolumeSizingManager();
  const id = getRouterParam(event, "jobId")!;
  return manager.cancel(id, {
    authorize: (job) => authorizeRestVolumeSizeJob(user.id, job),
  });
});
