import { requireAdmin } from "../../../utils/auth-helpers";
import { useAdminWorkspaceStore } from "../../../utils/admin-workspace-store";
export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const store = useAdminWorkspaceStore();
  const existed = await store.init().then(() => {
    try {
      store.publicRecord();
      return true;
    } catch {
      return false;
    }
  });
  const result = await store.ensure();
  setResponseStatus(event, existed ? 200 : 201);
  return result;
});
defineRouteMeta({
  openAPI: {
    tags: ["Admin workspace"],
    summary: "Create the trusted persistent administrative workspace",
    responses: {
      200: { description: "Administrative workspace status" },
      403: { description: "Administrator required" },
    },
  },
});
