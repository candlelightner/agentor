defineRouteMeta({
  openAPI: {
    tags: ["Containers"], summary: "Set worker plugin desired state",
    description: "Enable or disable an installation with a bounded lifecycle operation.",
    operationId: "setWorkerPluginEnabled",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "installationId", in: "path", required: true, schema: { type: "string" } },
    ],
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["enabled"], properties: { enabled: { type: "boolean" } } } } } },
    responses: { 200: { description: "Updated installation state" }, 400: { description: "Invalid state" }, 401: { description: "Unauthorized" }, 403: { description: "Forbidden" }, 404: { description: "Not found" }, 502: { description: "Plugin runner failed" }, 504: { description: "Plugin lifecycle timed out" } },
  },
});

import {
  requirePluginWorker,
  requireWorkerInstallation,
} from "../../../../../utils/plugin-api";
import {
  useContainerManager,
  usePluginInstallationStore,
  usePluginRuntimeManager,
} from "../../../../../utils/services";

export default defineEventHandler(async (event) => {
  const worker = requirePluginWorker(event, getRouterParam(event, "id")!);
  const installation = requireWorkerInstallation(
    worker.userId,
    worker.id,
    getRouterParam(event, "installationId")!,
  );
  const enabled = (await readBody(event))?.enabled;
  if (typeof enabled !== "boolean")
    throw createError({
      statusCode: 400,
      statusMessage: "enabled must be boolean",
    });
  const runtime = useContainerManager().get(worker.id);
  if (!runtime || runtime.status !== "running")
    return usePluginInstallationStore().setDesiredEnabled(
      worker.userId,
      installation.id,
      enabled,
    );
  return enabled
    ? usePluginRuntimeManager().enable(
        worker.userId,
        installation.id,
        runtime.containerId,
      )
    : usePluginRuntimeManager().disable(
        worker.userId,
        installation.id,
        runtime.containerId,
      );
});
