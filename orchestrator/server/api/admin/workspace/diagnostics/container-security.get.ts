import { requireAdmin } from "../../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../../utils/admin-workspace-store";
export default defineEventHandler(async (e) => {
  requireAdmin(e);
  const q = getQuery(e);
  return useAdminWorkspaceStore().security(
    typeof q.workerId === "string" ? q.workerId : undefined,
  );
});
defineRouteMeta({
  openAPI: {
    tags: ["Internal"],
    summary: "Inspect administrative workspace container hardening",
  },
});
