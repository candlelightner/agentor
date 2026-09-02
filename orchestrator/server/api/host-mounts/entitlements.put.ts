defineRouteMeta({ openAPI: { tags: ["Host mounts"], summary: "Entitle an account to an approved host path", operationId: "setHostMountEntitlement" } });
import { requireAdmin } from "../../utils/auth-helpers";
import { getUserById } from "../../utils/auth";
import { useHostMountStore } from "../../utils/services";
import { enforceHostMountRevocation } from "../../utils/host-mount-revocation";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const body = await readBody(event);
  if (typeof body?.ownerId !== "string" || !getUserById(body.ownerId))
    throw createError({ statusCode: 404, statusMessage: "Account not found" });
  if (typeof body?.pathId !== "string" || typeof body?.enabled !== "boolean")
    throw createError({ statusCode: 400, statusMessage: "ownerId, pathId, and enabled are required" });
  const changed = await useHostMountStore().setEntitlement(
    body.ownerId,
    body.pathId,
    body.enabled,
  );
  const enforcement = !body.enabled
    ? await enforceHostMountRevocation(body.ownerId)
    : undefined;
  return { ...changed, enforcement };
});
