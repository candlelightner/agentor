defineRouteMeta({
  openAPI: {
    tags: ["Plugins"], summary: "Create plugin definition",
    description: "Create a scoped validated manifest. Environment and secret fields are key names only.",
    operationId: "createPluginDefinition",
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["manifest"], properties: { scope: { type: "string", enum: ["platform", "owner", "group", "worker"], default: "owner" }, groupId: { type: "string" }, workerId: { type: "string" }, manifest: { type: "object" } } } } } },
    responses: { 201: { description: "Created definition" }, 400: { description: "Invalid scope or manifest" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Target not found" } },
  },
});

import { requireAuth } from "../../../utils/auth-helpers";
import {
  usePluginDefinitionStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "../../../utils/services";
import { resolvePluginTarget } from "../../../utils/plugin-api";

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const body = await readBody(event);
  const scope = body?.scope ?? "owner";
  if (!["platform", "owner", "group", "worker"].includes(scope))
    throw createError({
      statusCode: 400,
      statusMessage: "Invalid plugin scope",
    });
  if (scope === "platform" && user.role !== "admin")
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  let ownerId: string | null = scope === "platform" ? null : user.id;
  if (scope === "owner" && body?.targetWorkerId !== undefined) {
    const worker = resolvePluginTarget(body.targetWorkerId);
    if (!worker || (user.role !== "admin" && worker.userId !== user.id))
      throw createError({ statusCode: 404, statusMessage: "Worker not found" });
    ownerId = worker.userId;
    if ("administrativeKind" in worker && worker.administrativeKind) {
      // Administrative self-registration is always workspace-scoped; never
      // let a dashboard field accidentally create owner-wide definitions.
      const created = await usePluginDefinitionStore().create({
        scope: "worker", ownerId: worker.userId, workerId: worker.id, manifest: body?.manifest,
      });
      setResponseStatus(event, 201);
      return created;
    }
  }
  if (scope === "group") {
    const group = useWorkerGroupStore().findById(body.groupId);
    if (!group || (user.role !== "admin" && group.userId !== user.id))
      throw createError({
        statusCode: 404,
        statusMessage: "Worker group not found",
      });
    ownerId = group.userId;
  }
  if (scope === "worker") {
    const worker = resolvePluginTarget(body.workerId);
    if (!worker || (user.role !== "admin" && worker.userId !== user.id))
      throw createError({ statusCode: 404, statusMessage: "Worker not found" });
    ownerId = worker.userId;
  }
  const created = await usePluginDefinitionStore().create({
    scope,
    ownerId,
    groupId: body?.groupId,
    workerId: body?.workerId,
    manifest: body?.manifest,
  });
  setResponseStatus(event, 201);
  return created;
});
