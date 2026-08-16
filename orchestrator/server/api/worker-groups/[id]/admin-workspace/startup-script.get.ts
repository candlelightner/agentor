import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";

export default defineEventHandler(async (event) => {
  const group = useWorkerGroupStore().findById(getRouterParam(event, "id")!);
  requireResourceAccess(event, group, { allowGlobal: false });
  return useGroupAdminWorkspaceStore().getStartupScript(group!.id);
});

defineRouteMeta({
  openAPI: {
    tags: ["Worker groups"],
    summary: "Get a group-admin workspace startup script and application status",
    responses: {
      200: { description: "Startup script and namesafe runtime status" },
      403: { description: "Group is inaccessible or administrator role required" },
      404: { description: "Administrative workspace not provisioned" },
    },
  },
});
