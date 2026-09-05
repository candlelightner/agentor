import { requireAdmin } from "../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const artifact = await useInstanceBackupManager().getArtifact(
    getRouterParam(event, "id")!,
  );
  if (!artifact || artifact.userId !== admin.user.id)
    throw createError({ statusCode: 404, statusMessage: "Instance backup artifact not found" });
  return artifact;
});
