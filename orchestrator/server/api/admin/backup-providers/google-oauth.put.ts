defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Configure installation Google backup OAuth credentials",
    operationId: "configureGoogleBackupOAuthInstallation",
    requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["clientId", "redirectUri", "clientSecret"], properties: { clientId: { type: "string" }, redirectUri: { type: "string", format: "uri" }, clientSecret: { type: "string", writeOnly: true } } } } } },
    responses: { 200: { description: "Redacted configuration status" }, 400: { description: "Invalid configuration" }, 401: { description: "Unauthorized" }, 403: { description: "Administrator required" } },
  },
});
import { requireAdmin } from "../../../utils/auth-helpers";
import { useGoogleBackupOAuthConfigStore } from "../../../utils/google-backup-oauth-config";

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  const input = await readBody<Record<string, unknown>>(event);
  try {
    return await useGoogleBackupOAuthConfigStore().configure({
      clientId: typeof input?.clientId === "string" ? input.clientId : "",
      redirectUri: typeof input?.redirectUri === "string" ? input.redirectUri : "",
      clientSecret: typeof input?.clientSecret === "string" ? input.clientSecret : "",
    });
  } catch (error: any) {
    throw createError({ statusCode: 400, statusMessage: error?.message || "Invalid Google OAuth configuration" });
  }
});
