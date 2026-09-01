defineRouteMeta({ openAPI: { tags: ["Backups"], summary: "Reveal current backup recovery key after fresh reauthentication", operationId: "revealBackupRecoveryKey", responses: { 200: { description: "Non-cacheable recovery key response" }, 401: { description: "Fresh reauthentication required" } } } });
import { requireFreshBackupRecoveryAuth } from "../../../utils/backup-recovery-reauth";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  setPrivateNoStore(event);
  const body = await readBody<any>(event) ?? {};
  const auth = await requireFreshBackupRecoveryAuth(event, body);
  // The raw value is intentionally constructed only for this response and is
  // neither persisted in page state nor passed to logs/audit/error handlers.
  const kit = await useBackupManager().exportRecoveryKit(auth.userId);
  return { fingerprint: kit.fingerprint, keyMaterial: kit.keyMaterial };
});

function setPrivateNoStore(event: any) {
  setResponseHeader(event, "Cache-Control", "no-store, private, max-age=0");
  setResponseHeader(event, "Pragma", "no-cache");
  setResponseHeader(event, "X-Content-Type-Options", "nosniff");
}
