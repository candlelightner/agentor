import { requireAdmin } from "../../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  try {
    return await useAdminWorkspaceStore().writeMarker(
      ((await readBody(e)) as any)?.marker,
    );
  } catch (x) {
    throw createError({
      statusCode: 400,
      statusMessage: x instanceof Error ? x.message : "Invalid marker",
    });
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Write a diagnostic administrative persistence marker",
  },
});
