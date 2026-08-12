defineRouteMeta({
  openAPI: {
    tags: ["Managed networks"],
    summary: "Delete managed network",
    operationId: "deleteManagedNetwork",
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
export default defineEventHandler(async (e) => {
  const id = getRouterParam(e, "id")!,
    s = useManagedNetworkStore(),
    n = s.findById(id);
  requireResourceAccess(e, n, { allowGlobal: false });
  const b: any = await readBody(e).catch(() => ({}));
  const ids =
    n!.scope === "selected"
      ? n!.workerIds
      : n!.scope === "group"
        ? useWorkerGroupStore().get(n!.userId, n!.groupId!)?.workerIds || []
        : useWorkerStore()
            .listForUser(n!.userId)
            .map((w: any) => w.id);
  await verifyWorkerMutationUnlocks(ids, b?.lockPasswords);
  await useManagedNetworkManager().remove(n!);
  await s.remove(n!.userId, id);
  setResponseStatus(e, 204);
  return null;
});
