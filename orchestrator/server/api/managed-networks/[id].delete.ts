defineRouteMeta({
  openAPI: {
    tags: ["Managed networks"],
    summary: "Delete managed network",
    description: "Serializes removal with worker-group reference checks and removes the controlled Docker bridge.",
    operationId: "deleteManagedNetwork",
    responses: {
      204: { description: "Managed network deleted" },
      409: { description: "Docker network removal failed" },
      423: { description: "A member worker is protected" },
    },
  },
});
import { requireResourceAccess } from "../../utils/auth-helpers";
import {
  useManagedNetworkStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "../../utils/services";
import { useManagedNetworkManager } from "../../utils/managed-network-manager";
import { verifyWorkerMutationUnlocks } from "../../utils/worker-protection-lock";
import { withWorkerNetworkMutation } from "../../utils/worker-group-manager";
export default defineEventHandler(async (e) => {
  const id = getRouterParam(e, "id")!,
    s = useManagedNetworkStore(),
    n = s.findById(id);
  requireResourceAccess(e, n, { allowGlobal: false });
  const b: any = await readBody(e).catch(() => ({}));
  return withWorkerNetworkMutation(n!.userId, async () => {
  const current=s.findById(id);
  if(!current||current.userId!==n!.userId)throw createError({statusCode:404,statusMessage:"Managed network not found"});
  const ids =
    current.scope === "selected"
      ? current.workerIds
      : current.scope === "group"
        ? useWorkerGroupStore().get(current.userId, current.groupId!)?.workerIds || []
        : useWorkerStore()
            .listForUser(current.userId)
            .map((w: any) => w.id);
  await verifyWorkerMutationUnlocks(ids, b?.lockPasswords);
  await useManagedNetworkManager().remove(current);
  await s.remove(current.userId, id);
  setResponseStatus(e, 204);
  return null;
  });
});
