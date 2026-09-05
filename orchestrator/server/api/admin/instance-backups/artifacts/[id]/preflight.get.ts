defineRouteMeta({
  openAPI: {
    tags: ["Instance backups"],
    summary: "Preflight a staged whole-instance restore",
    responses: {
      200: { description: "Restore blockers, warnings, and external dependencies" },
      403: { description: "Administrator required" },
      404: { description: "Verified artifact not found" },
    },
  },
});

import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const query = getQuery(event);
  try {
    return await useInstanceBackupManager().restorePreflight(
      admin.user.id,
      getRouterParam(event, "id")!,
      {
        ...(query.restoreDockerVolumes !== undefined
          ? {
              restoreDockerVolumes: queryBoolean(
                query.restoreDockerVolumes,
                "restoreDockerVolumes",
              ),
            }
          : {}),
        ...(query.restoreHostMountPolicies !== undefined
          ? {
              restoreHostMountPolicies: queryBoolean(
                query.restoreHostMountPolicies,
                "restoreHostMountPolicies",
              ),
            }
          : {}),
      },
    );
  } catch (error: any) {
    throw createError({
      statusCode: error?.statusCode ?? 400,
      statusMessage:
        error instanceof Error ? error.message : "Instance restore preflight failed",
    });
  }
});

function queryBoolean(value: unknown, field: string): boolean {
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  throw createError({ statusCode: 400, statusMessage: `${field} must be true or false` });
}
