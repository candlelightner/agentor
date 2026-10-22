import { requireAuth, requireAdmin } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Inspect the controlled image builder and configure converter readiness",
    description:
      "Authenticated diagnostics and fake-provider controls. Platform administrators can GET or PUT settings with agentReadyTimeoutSeconds (integer 1–3600); saved values apply to active readiness waits without restart.",
    responses: {
      200: { description: "Builder response" },
      401: { description: "Unauthorized" },
      400: { description: "Invalid readiness timeout" },
      403: { description: "Platform administrator required for settings" },
      404: { description: "Unknown builder route" },
    },
  },
});

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const path = getRouterParam(event, "path") || "";
  if (path === "settings") requireAdmin(event);
  const manager = useImageCatalogManager();
  await manager.init();
  if (path === "settings" && event.method === "GET") return manager.getConverterSettings();
  if (path === "settings" && event.method === "PUT") return manager.setConverterSettings(await readBody(event));
  if (path === "diagnostics" && event.method === "GET")
    return manager.diagnostics();
  if (path === "fake/faults" && event.method === "POST")
    return manager.setFault(ctx.user.id, await readBody(event));
  if (path === "fake/simulate-restart" && event.method === "POST")
    return manager.simulateRestart();
  throw createError({
    statusCode: 404,
    statusMessage: "Image builder route not found",
  });
});
