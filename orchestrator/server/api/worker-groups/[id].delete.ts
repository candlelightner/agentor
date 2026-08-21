defineRouteMeta({
  openAPI: {
    tags: ["Worker groups"],
    summary: "Delete worker group",
    description:
      "Deletes only the group; member workers are retained. A group referenced by a managed network must be reconfigured or have that network deleted first.",
    operationId: "deleteWorkerGroup",
    responses: {
      204: { description: "Group deleted; workers retained" },
      409: {
        description: "Group is referenced by one or more managed networks",
      },
    },
  },
});
import { requireResourceAccess } from "../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../utils/services";
import { deleteWorkerGroup } from "../../utils/worker-group-manager";
import { useGroupAdminWorkspaceStore } from "../../utils/group-admin-workspace-store";
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id")!,
    store = useWorkerGroupStore(),
    group = store.findById(id);
  requireResourceAccess(event, group, { allowGlobal: false });
  const workspaceStatus=group!.adminWorkspace?.status;
  await deleteWorkerGroup(group!.userId, id, async () => {
    const workspaces=useGroupAdminWorkspaceStore();try{await workspaces.remove(id,true);}catch(error){await workspaces.restoreAfterFailedGroupDelete(id,workspaceStatus,true).catch(()=>undefined);throw error;}
    return async()=>workspaces.restoreAfterFailedGroupDelete(id,workspaceStatus,true);
  });
  setResponseStatus(event, 204);
  return null;
});
