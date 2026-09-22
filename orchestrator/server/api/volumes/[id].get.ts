import { volumeActor } from "../../utils/managed-volume-api";
import { useManagedVolumeManager } from "../../utils/managed-volume-manager";
import { publicVolume } from "../../utils/managed-volume-store";
defineRouteMeta({ openAPI: { tags: ["Storage"], summary: "Inspect a custom managed volume and its current operation", operationId: "inspectManagedVolume" } });
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")!;
  const actor = await volumeActor(event, id);
  return publicVolume(useManagedVolumeManager().store.get(actor.userId, id)!);
});
