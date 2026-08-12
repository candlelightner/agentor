import { test, expect } from "@playwright/test";
test("admin storage inventory is protected and conservative cleanup reports a result", async ({ request }) => {
  const unauth = await request.get("/api/admin/storage", { headers: { Cookie: "" } });
  expect(unauth.status()).toBe(401);
  const inventory = await request.get("/api/admin/storage"); expect(inventory.status()).toBe(200);
  const data = await inventory.json(); expect(data.disk.totalBytes).toBeGreaterThan(0); expect(data.disk.warning).toMatch(/ok|warning|critical/);
  const cleanup = await request.post("/api/admin/storage/cleanup", { data: { staleStaging: true } });
  expect(cleanup.status()).toBe(200); expect((await cleanup.json()).reclaimedBytes).toBeGreaterThanOrEqual(0);
});
