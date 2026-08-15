import { requireAuth } from "../../utils/auth-helpers";
import { useImageCatalogManager } from "../../utils/image-catalog";

defineRouteMeta({
  openAPI: {
    tags: ["Image catalog"],
    summary: "List recent image builds",
    description: "Returns the latest owner-visible builds, including builds started through MCP.",
    responses: { 200: { description: "Recent owner-scoped image builds" } },
  },
});

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const manager = useImageCatalogManager();
  await manager.init();
  return manager.publicBuilds(user.id, user.role === "admin");
});
