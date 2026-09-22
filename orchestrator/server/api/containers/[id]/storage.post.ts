import { persistenceActor, runVolumeAction } from "../../../utils/managed-volume-api";
import { rethrowAsHttpError } from "../../../utils/http-errors";
defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Manage persistent paths or worker self-service policy", operationId: "manageWorkerStorage" } });
export default defineEventHandler(async (event) => {
  try { return await runVolumeAction(persistenceActor(event, getRouterParam(event, "id")!), await readBody(event)); }
  catch (error) { rethrowAsHttpError(error, "Storage operation failed"); }
});
