defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Download recovery kit after fresh reauthentication", operationId: "exportBackupRecoveryKit", responses: { 200: { description: "Non-cacheable recovery-kit attachment" }, 401: { description: "Fresh reauthentication required" } } } });
import { requireFreshBackupRecoveryAuth } from "../../../utils/backup-recovery-reauth";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  setPrivateNoStore(event);
  const body = await readBody<any>(event) ?? {};
  const auth = await requireFreshBackupRecoveryAuth(event, body);
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : undefined;
  const kit = await useBackupManager().exportRecoveryKit(auth.userId, fingerprint);
  setResponseHeader(event, "Content-Type", "application/json; charset=utf-8");
  setResponseHeader(event, "Content-Disposition", 'attachment; filename="agentor-backup-recovery-kit.json"');
  return kit;
});

function setPrivateNoStore(event: any) {
  setResponseHeader(event, "Cache-Control", "no-store, private, max-age=0");
  setResponseHeader(event, "Pragma", "no-cache");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
}
