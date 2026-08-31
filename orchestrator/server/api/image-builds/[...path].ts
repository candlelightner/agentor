import { requireAuth } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Inspect, cancel, or stream logs for an image build",
    description:
      "Owner-scoped asynchronous build status, cancellation, and redacted incremental logs.",
    responses: {
      200: { description: "Image build response" },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
      404: { description: "Build not found" },
    },
  },
});

export default defineEventHandler(async (event) => {
  const ctx = requireAuth(event);
  const manager = useImageCatalogManager();
  await manager.init();
  const admin = ctx.user.role === "admin";
  const parts = (getRouterParam(event, "path") || "")
    .split("/")
    .filter(Boolean);
  const id = parts[0]!;
  try {
    if (parts.length === 1 && event.method === "GET")
      return manager.publicBuild(id, ctx.user.id, admin);
    if (parts.length === 1 && event.method === "DELETE")
      return manager.cancelBuild(id, ctx.user.id, admin);
    if (parts[1] === "logs" && event.method === "GET") {
      const query = getQuery(event);
      if (query.limit !== undefined || query.format === "json")
        return manager.logPage(id, ctx.user.id, admin, {
          after: Number(query.after) || 0,
          limit: Number(query.limit) || 200,
        });
      setResponseHeader(event, "Content-Type", "text/plain; charset=utf-8");
      return manager.logs(
        id,
        ctx.user.id,
        admin,
        Number(query.after) || 0,
      );
    }
    throw createError({
      statusCode: 404,
      statusMessage: "Image build route not found",
    });
  } catch (err) {
    const e = err as Error & { statusCode?: number };
    throw createError({
      statusCode: e.statusCode || 500,
      statusMessage: e.statusCode ? e.message : "Image build operation failed",
    });
  }
});
