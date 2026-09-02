defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "Revoke a host path assignment and its delegations", operationId: "deleteHostMountGrant" } });
import { requireAuth } from "../../../utils/auth-helpers";
import { getUserById } from "../../../utils/auth";
import { useHostMountStore } from "../../../utils/services";
import { enforceHostMountRevocation } from "../../../utils/host-mount-revocation";

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const id = getRouterParam(event, "id")!;
  const query = getQuery(event);
  const requestedOwner = typeof query.ownerId === "string" ? query.ownerId : user.id;
  const ownerId = user.role === "admin" ? requestedOwner : user.id;
  if (user.role !== "admin" && requestedOwner !== user.id)
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  if (!getUserById(ownerId))
    throw createError({ statusCode: 404, statusMessage: "Account not found" });
  const removed = await useHostMountStore().deleteGrant(ownerId, id);
  const enforcement = await enforceHostMountRevocation(ownerId);
  return { deleted: true, ...removed, enforcement };
});
