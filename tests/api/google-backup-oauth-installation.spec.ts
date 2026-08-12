import { test, expect, request as playwrightRequest } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiClient } from "../helpers/api-client";
import { createTestUser, deleteTestUser } from "../helpers/test-users";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const ADMIN_STORAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".auth", "admin-api.json");
const options = { baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } };

test.describe.serial("Installation Google backup OAuth configuration", () => {
  test("is admin-only, write-only, encrypted-status based, and starts an OAuth challenge", async () => {
    const admin = await playwrightRequest.newContext({ ...options, storageState: ADMIN_STORAGE });
    const regular = await createTestUser("Google OAuth Installation Regular");
    const user = await playwrightRequest.newContext({ ...options, storageState: { cookies: [], origins: [] } });
    try {
      expect((await new ApiClient(user).signInEmail(regular.email, regular.password)).status).toBe(200);
      expect((await user.get("/api/admin/backup-providers/google-oauth")).status()).toBe(403);
      const saved = await admin.put("/api/admin/backup-providers/google-oauth", { data: { clientId: "installation-client", redirectUri: "https://dashboard.example/api/backup-providers/google/oauth/callback", clientSecret: "INSTALLATION_SECRET_MUST_NOT_LEAK" } });
      expect(saved.status()).toBe(200);
      const status = await saved.json();
      expect(status).toMatchObject({ configured: true, source: "installation", clientId: "installation-client", clientSecretConfigured: true });
      expect(JSON.stringify(status)).not.toContain("INSTALLATION_SECRET_MUST_NOT_LEAK");
      const fetched = await admin.get("/api/admin/backup-providers/google-oauth");
      expect(fetched.status()).toBe(200);
      expect(JSON.stringify(await fetched.json())).not.toContain("INSTALLATION_SECRET_MUST_NOT_LEAK");
      const start = await user.post("/api/backup-providers/google/oauth/start", { data: {} });
      expect(start.status()).toBe(200);
      const challenge = await start.json();
      expect(challenge.authorizationUrl).toContain("client_id=installation-client");
      expect(challenge.authorizationUrl).toContain("redirect_uri=https%3A%2F%2Fdashboard.example%2Fapi%2Fbackup-providers%2Fgoogle%2Foauth%2Fcallback");
      expect(JSON.stringify(challenge)).not.toContain("INSTALLATION_SECRET_MUST_NOT_LEAK");
    } finally {
      await admin.dispose(); await user.dispose(); await deleteTestUser(regular.id);
    }
  });
});
