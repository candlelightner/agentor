defineRouteMeta({ openAPI: { tags: ['Plugins'], summary: 'Delete plugin definition', description: 'Deletes a mutable definition only when no installation references it.', operationId: 'deletePluginDefinition', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 204: { description: 'Definition deleted' }, 400: { description: 'Built-in definitions are immutable' }, 401: { description: 'Unauthorized' }, 404: { description: 'Definition not found or not accessible' }, 409: { description: 'Definition is installed' } } } });

import { canAccessResource, requireAuth } from "../../../utils/auth-helpers";
import {
  usePluginDefinitionStore,
  usePluginInstallationStore,
} from "../../../utils/services";

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event),
    id = getRouterParam(event, "id")!;
  const current = usePluginDefinitionStore().getById(id);
  if (
    !current ||
    !canAccessResource(ctx, current, { allowGlobal: ctx.user.role === "admin" })
  )
    throw createError({
      statusCode: 404,
      statusMessage: "Plugin definition not found",
    });
  if (
    usePluginInstallationStore()
      .list()
      .some((item) => item.definitionId === id)
  )
    throw createError({
      statusCode: 409,
      statusMessage: "Plugin definition is installed",
    });
  await usePluginDefinitionStore().delete(id);
  setResponseStatus(event, 204);
});
