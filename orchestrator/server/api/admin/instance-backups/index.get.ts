defineRouteMeta({
  openAPI: {
    tags: ["Instance backups"],
    summary: "List whole-instance disaster-recovery jobs and artifacts",
    responses: {
      200: { description: "Owner-scoped instance recovery state" },
      401: { description: "Unauthorized" },
      403: { description: "Administrator required" },
    },
  },
});

import { requireAdmin } from "../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  return useInstanceBackupManager().list(admin.user.id);
});
