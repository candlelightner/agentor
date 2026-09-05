import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const artifact = await useInstanceBackupManager().openArtifact(
    admin.user.id,
    getRouterParam(event, "id")!,
  );
  setResponseHeaders(event, {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${artifact.filename}"`,
    "Content-Length": String(artifact.size),
    "Cache-Control": "private, no-store",
  });
  event.node.res.once("close", () => artifact.stream.destroy());
  return sendStream(event, artifact.stream);
});
