import { requireAdmin } from "../../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  return useAdminWorkspaceStore().readMarker();
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Read a diagnostic administrative persistence marker",
  },
});
