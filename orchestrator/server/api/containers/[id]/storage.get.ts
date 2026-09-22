import { persistenceActor } from "../../../utils/managed-volume-api";
import { useManagedVolumeManager } from "../../../utils/managed-volume-manager";
import { rethrowAsHttpError } from "../../../utils/http-errors";
defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Inspect worker persistent paths and self-service policy", operationId: "inspectWorkerStorage" } });
export default defineEventHandler(async (event) => {
  try { return await useManagedVolumeManager().inspect(persistenceActor(event, getRouterParam(event, "id")!)); }
  catch (error) { rethrowAsHttpError(error, "Cannot inspect worker storage"); }
});
