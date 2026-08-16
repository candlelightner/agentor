import { requireResourceAccess } from "../../../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../../../utils/services";
import { useGroupAdminWorkspaceStore } from "../../../../utils/group-admin-workspace-store";

export default defineEventHandler(async (event) => {
  const group = useWorkerGroupStore().findById(getRouterParam(event, "id")!);
  requireResourceAccess(event, group, { allowGlobal: false });
  const body = await readBody(event);
  return useGroupAdminWorkspaceStore().setStartupScript(
    group!.id,
    body?.startupScript,
  );
});

defineRouteMeta({
  openAPI: {
    tags: ["Worker groups"],
    summary: "Set a group-admin workspace startup script",
    description:
      "Stores a non-secret script without interrupting a running workspace. The next explicit start or rebuild applies it while preserving persistent data.",
    responses: {
      200: { description: "Saved startup script and pending-application status" },
      400: { description: "Invalid or oversized startup script" },
      403: { description: "Group is inaccessible or administrator role required" },
      404: { description: "Administrative workspace not provisioned" },
    },
  },
});
