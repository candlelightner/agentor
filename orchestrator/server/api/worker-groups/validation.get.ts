defineRouteMeta({ openAPI: { tags: ["Worker groups"], summary: "Validate worker-group hierarchy and direct memberships", operationId: "validateWorkerGroups" } });
import { requireAuth } from "../../utils/auth-helpers";
import { useWorkerGroupStore } from "../../utils/services";
import { WorkerGroupHierarchy } from "../../utils/worker-group-hierarchy";
export default defineEventHandler((event) => {
  const { user } = requireAuth(event);
  const hierarchy = new WorkerGroupHierarchy(useWorkerGroupStore());
  const membershipConflicts = hierarchy.membershipConflicts(user.id);
  const hierarchyErrors = hierarchy.hierarchyErrors(user.id);
  return { valid: membershipConflicts.length === 0 && hierarchyErrors.length === 0, membershipConflicts, hierarchyErrors };
});
