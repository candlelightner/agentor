defineRouteMeta({
  openAPI: {
    tags: ["Containers"], summary: "Install worker plugin",
    description: "Install a visible definition. envKeys and secretKeys are declared key names only; values are never accepted.",
    operationId: "installWorkerPlugin",
    parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["definitionId"], properties: { definitionId: { type: "string" }, desiredEnabled: { type: "boolean", default: true }, envKeys: { type: "array", items: { type: "string" } }, secretKeys: { type: "array", items: { type: "string" } } } } } } },
    responses: { 201: { description: "Created installation" }, 400: { description: "Invalid key reference" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Not found" }, 409: { description: "Lifecycle conflict" }, 502: { description: "Plugin runner failed" }, 504: { description: "Plugin lifecycle timed out" } },
  },
});

import {
  reconcilePluginInstallation,
  requirePluginWorker,
  requireWorkerDefinition,
} from "../../../../utils/plugin-api";
import { usePluginInstallationStore } from "../../../../utils/services";

export default defineEventHandler(async (event) => {
  const worker = requirePluginWorker(event, getRouterParam(event, "id")!);
  const body = await readBody(event);
  const definition = requireWorkerDefinition(worker, body?.definitionId);
  const declaredEnv = new Set(definition.manifest.environment?.envKeys ?? []);
  const declaredSecrets = new Set(
    definition.manifest.environment?.secretKeys ?? [],
  );
  if (
    (body?.envKeys ?? []).some((key: string) => !declaredEnv.has(key)) ||
    (body?.secretKeys ?? []).some((key: string) => !declaredSecrets.has(key))
  )
    throw createError({
      statusCode: 400,
      statusMessage: "Undeclared environment key reference",
    });
  const created = await usePluginInstallationStore().create({
    userId: worker.userId,
    workerId: worker.id,
    definitionId: definition.id,
    definitionVersion: definition.manifest.version,
    definitionHash: definition.definitionHash,
    desiredEnabled: body?.desiredEnabled,
    envKeys: body?.envKeys,
    secretKeys: body?.secretKeys,
  });
  try {
    const result = created.desiredEnabled
      ? await reconcilePluginInstallation(worker.userId, worker.id, created.id)
      : created;
    setResponseStatus(event, 201);
    return result;
  } catch (error) {
    await usePluginInstallationStore()
      .delete(worker.userId, created.id)
      .catch(() => undefined);
    throw error;
  }
});
