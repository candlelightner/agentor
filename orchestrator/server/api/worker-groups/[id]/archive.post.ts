defineRouteMeta({
  openAPI: {
    tags: ["Worker groups"],
    summary: "Archive all workers in a group subtree",
    description:
      "Archives every ordinary worker directly in this group or a descendant group while preserving durable data and group membership. Administrative workspaces are not affected. All protection locks are verified before any worker is changed.",
    operationId: "archiveWorkerGroupSubtree",
    responses: {
      200: { description: "Recursive archive result" },
      409: { description: "Another batch is running or one or more workers failed" },
      423: { description: "A targeted worker is protected" },
    },
  },
});
import { requireResourceAccess } from "../../../utils/auth-helpers";
import { rethrowAsHttpError } from "../../../utils/http-errors";
import { useContainerManager, useWorkerGroupStore } from "../../../utils/services";

export default defineEventHandler(async (event) => {
  const group = useWorkerGroupStore().findById(getRouterParam(event, "id")!);
  requireResourceAccess(event, group, { allowGlobal: false });
  const body = await readBody<Record<string, unknown>>(event).catch(
    (): Record<string, unknown> => ({}),
  );
  try {
    return await useContainerManager().mutateWorkerGroupSubtree(
      group!.userId,
      group!.id,
      "archive",
      body?.lockPasswords,
    );
  } catch (error) {
    rethrowAsHttpError(error);
  }
});
