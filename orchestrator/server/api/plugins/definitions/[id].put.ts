defineRouteMeta({
  openAPI: {
    tags: ["Plugins"], summary: "Replace plugin definition manifest",
    description: "Revalidate and replace a mutable definition. Secret fields are key names only.",
    operationId: "updatePluginDefinition",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["manifest"], properties: { manifest: { type: "object" } } } } } },
    responses: { 200: { description: "Updated definition" }, 400: { description: "Invalid manifest" }, 401: { description: "Unauthorized" }, 404: { description: "Not found" } },
  },
});

import { canAccessResource, requireAuth } from "../../../utils/auth-helpers";
import { usePluginDefinitionStore } from "../../../utils/services";

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event),
    id = getRouterParam(event, "id")!;
  const current = usePluginDefinitionStore().getById(id);
  if (!current)
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin definition not found",
    });
  if (
    !canAccessResource(ctx, current, { allowGlobal: ctx.user.role === "admin" })
  )
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin definition not found",
    });
  return usePluginDefinitionStore().update(
    id,
    (await readBody(event))?.manifest,
  );
});
