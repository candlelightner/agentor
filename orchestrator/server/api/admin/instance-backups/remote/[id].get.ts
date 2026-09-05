import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const record = await useInstanceBackupManager().getRemote(getRouterParam(event, "id")!);
  if (!record || record.userId !== admin.user.id)
    throw createError({ statusCode: 404, statusMessage: "Remote instance backup not found" });
  return record;
});
