import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  return (await useInstanceBackupManager().list(admin.user.id)).remoteBackups;
});
