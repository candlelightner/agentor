defineRouteMeta({ openAPI: { tags: ["Worker groups"], summary: "Atomically assign a worker to one direct group", operationId: "assignWorkerGroup" } });
import { requireAuth } from "../../utils/auth-helpers";
import { useWorkerGroupStore, useWorkerStore } from "../../utils/services";
import { assignWorkerToGroupWithNetworks } from "../../utils/worker-group-manager";
export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const body = await readBody(event);
  if (typeof body?.workerId !== "string" || (body.groupId !== null && typeof body.groupId !== "string"))
    throw createError({ statusCode: 400, statusMessage: "workerId and groupId (string or null) are required" });
  const worker = useWorkerStore().findById(body.workerId);
  if (!worker || worker.userId !== user.id) throw createError({ statusCode: 404, statusMessage: "Worker not found" });
  if (body.groupId && !useWorkerGroupStore().get(user.id, body.groupId)) throw createError({ statusCode: 404, statusMessage: "Worker group not found" });
  const lockPasswords = body.lockPassword ? { [body.workerId]: body.lockPassword } : body.lockPasswords;
  const group = await assignWorkerToGroupWithNetworks(user.id, body.workerId, body.groupId, lockPasswords);
  return { workerId: body.workerId, groupId: group?.id ?? null };
});
