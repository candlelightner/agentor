import { requireAuth } from "../../../utils/auth-helpers";
import { restVolumeSizeAuthorizer, useManagedVolumeSizingManager } from "../../../utils/managed-volume-sizing";
import { rethrowAsHttpError } from "../../../utils/http-errors";

defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Start a bounded read-only volume size scan", operationId: "startVolumeSizeJob" } });

export default defineEventHandler(async (event) => {
  try {
    const { user } = requireAuth(event), volumeId = getRouterParam(event, "id")!;
    const body: { force?: unknown } = await readBody<{ force?: unknown }>(event).catch(() => ({}));
    if (body.force !== undefined && typeof body.force !== "boolean")
      throw createError({ statusCode: 400, statusMessage: "force must be a boolean" });
    const job = await useManagedVolumeSizingManager().create(user.id, restVolumeSizeAuthorizer(user.id, volumeId), body.force === true);
    setResponseStatus(event, job.status === "succeeded" ? 200 : 202);
    return job;
  } catch (error) { rethrowAsHttpError(error, "Cannot start volume size scan"); }
});
