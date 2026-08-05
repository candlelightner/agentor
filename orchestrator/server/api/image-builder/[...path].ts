import { requireAuth } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Inspect and test the controlled image-builder boundary",
    description:
      "Authenticated diagnostics and fake-provider fault controls used to verify fail-closed build behavior.",
    responses: {
      200: { description: "Builder response" },
      401: { description: "Unauthorized" },
      404: { description: "Unknown builder route" },
    },
  },
});

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const manager = useImageCatalogManager();
  await manager.init();
  const path = getRouterParam(event, "path") || "";
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
