defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Start Google OAuth test flow",
    operationId: "startGoogleBackupOAuth",
    responses: {
      200: { description: "Authorization challenge" },
      401: { description: "Unauthorized" },
    },
  },
});
import { requireAuth } from "../../../../utils/auth-helpers";
import { useBackupManager } from "../../../../utils/backup-manager";
import { useGoogleBackupOAuthConfigStore } from "../../../../utils/google-backup-oauth-config";
export default defineEventHandler(async (e) => {
  const u = requireAuth(e).user,
    b = await readBody<{ redirectUri?: string }>(e);
  const fakeAllowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_FAKE_BACKUP_PROVIDER === "true";
  const installation = await useGoogleBackupOAuthConfigStore().credentials();
  const clientId = installation?.clientId || process.env.GOOGLE_BACKUP_CLIENT_ID || (fakeAllowed ? "fake-test-client" : "");
  const redirectUri = installation?.redirectUri || process.env.GOOGLE_BACKUP_REDIRECT_URI || (fakeAllowed ? b?.redirectUri : "") || "";
  if (!clientId || !redirectUri) throw createError({ statusCode: 503, statusMessage: "Google Drive backup OAuth is not configured" });
  const x = await useBackupManager().beginGoogleOAuth(u.id, clientId, redirectUri);
  return {
    state: x.state,
    authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.file")}&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(x.state)}`,
  };
});
