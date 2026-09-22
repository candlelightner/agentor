import { volumeActor, runVolumeAction, strictVolumeInput } from "../../utils/managed-volume-api";
import { rethrowAsHttpError } from "../../utils/http-errors";
defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Manage an owned retained volume", operationId: "manageRetainedVolume" } });
export default defineEventHandler(async (event) => {
  try {
    const id = getRouterParam(event, "id")!;
    const actor = await volumeActor(event, id);
    const body = strictVolumeInput(await readBody(event), ["action", "name", "confirmed", "lockPassword", "mode", "acknowledgePrivileged", "applyNow"]);
    return await runVolumeAction(actor, body, id);
  } catch (error) { rethrowAsHttpError(error, "Volume operation failed"); }
});
