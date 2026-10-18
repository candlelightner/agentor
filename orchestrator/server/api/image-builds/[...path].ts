import { requireAuth } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "Inspect, cancel, recover a converter, or stream image-build logs",
    description:
      "Owner-scoped build status, cancellation, redacted logs, and explicit cleanup of an acknowledged failed native converter.",
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
    if (parts.length === 2 && parts[1] === "recover-converter" && event.method === "POST") {
      const body = await readBody(event);
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length)
        throw createError({ statusCode: 400, statusMessage: "Converter recovery accepts an empty object only" });
      return await manager.recoverNativeConverter(id, ctx.user.id, admin);
    }
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
