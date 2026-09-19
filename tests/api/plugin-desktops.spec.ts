import { test, expect, request as playwrightRequest } from '@playwright/test';
import { desktopFixture, desktopBase, rfbBanner } from '../helpers/plugin-desktops';
import { createTestUser, deleteTestUser } from '../helpers/test-users';
import { ApiClient } from '../helpers/api-client';

test.describe.serial('Managed plugin desktops', () => {
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  test.beforeAll(async ({ request }) => { fixture = await desktopFixture(request, 'Desktop API'); });
  test.afterAll(async ({ request }) => { await fixture?.cleanup(request); });

  test('two isolated displays and the normal shared desktop have separate allocations and authenticated viewers', async ({ request }) => {
    const [first, second, shared] = fixture.installations;
    expect(first.allocations.display).not.toBe(second.allocations.display);
    expect(first.allocations.display).not.toBe(99); expect(second.allocations.display).not.toBe(99); expect(shared.allocations.display).toBe(99);
    for (const index of [0, 1]) {
      expect(fixture.installations[index].allocations.ports).toEqual({});
      expect((await request.get(fixture.path(index))).status()).toBe(200);
      const module = await request.get(`${fixture.path(index)}core/rfb.js`); expect(module.status()).toBe(200); expect(module.headers()['content-type']).toContain('javascript');
      expect((await request.get(`${fixture.path(index)}status`)).status()).toBe(200);
      expect(await rfbBanner(request, `${fixture.path(index)}websockify`)).toBe('RFB 003.008\n');
      expect(await rfbBanner(request, `${fixture.path(index)}websockify`)).toBe('RFB 003.008\n');
    }
    const normal = await request.get(fixture.path(2)); expect(normal.status()).toBe(200); expect(normal.url()).toContain(`/desktop/${fixture.worker.id}/agentor.html`);
    expect(await rfbBanner(request, `/ws/desktop/${fixture.worker.id}`)).toBe('RFB 003.008\n');
  });

  test('HTTP, assets, and WebSockets reject anonymous, cross-user, mismatched installation, and cross-origin access', async ({ request }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL: desktopBase, storageState: { cookies: [], origins: [] } });
    try { for (const suffix of ['', 'core/rfb.js', 'status']) expect((await anonymous.get(`${fixture.path(0)}${suffix}`)).status()).toBe(401); } finally { await anonymous.dispose(); }
    expect(await rfbBanner(null, `${fixture.path(0)}websockify`)).toBe('');
    expect(await rfbBanner(request, `${fixture.path(0)}websockify`, 'https://unrelated.invalid')).toBe('');
    expect(await rfbBanner(request, `${fixture.path(0)}websockify`, 'null')).toBe('');
    for (const path of [fixture.path(0).replace('/primary/', '/other/'), fixture.path(0).replace('/open/', '/unknown/'), fixture.path(0).replace(fixture.worker.id, fixture.installations[1].id)]) {
      expect((await request.get(path)).status()).toBe(404); expect(await rfbBanner(request, `${path}websockify`)).toBe('');
    }
    const user = await createTestUser('Desktop cross-user');
    const other = await playwrightRequest.newContext({ baseURL: desktopBase, extraHTTPHeaders: { Origin: desktopBase }, storageState: { cookies: [], origins: [] } });
    try {
      expect((await other.post('/api/auth/sign-in/email', { data: { email: user.email, password: user.password } })).ok()).toBe(true);
      for (const suffix of ['', 'core/rfb.js', 'status']) expect((await other.get(`${fixture.path(0)}${suffix}`)).status()).toBe(404);
      expect(await rfbBanner(other, `${fixture.path(0)}websockify`)).toBe('');
    } finally { await other.dispose(); await deleteTestUser(user.id); }
  });

  test('worker restart reconciles both desired desktops and preserves their allocations', async ({ request }) => {
    test.setTimeout(180_000);
    const result = await new ApiClient(request).restartContainer(fixture.worker.id); expect(result.status).toBe(200);
    for (const index of [0, 1]) {
      await expect.poll(async () => (await (await request.get(`${fixture.path(index)}status`)).json()).ready, { timeout: 60_000 }).toBe(true);
      const status = await (await request.get(`${fixture.path(index)}status`)).json(); expect(status.display).toBe(fixture.installations[index].allocations.display);
      expect(await rfbBanner(request, `${fixture.path(index)}websockify`)).toBe('RFB 003.008\n');
    }
    expect(await rfbBanner(request, `/ws/desktop/${fixture.worker.id}`)).toBe('RFB 003.008\n');
  });

  test('disable and uninstall revoke one display while other isolated and shared viewers stay operational', async ({ request }) => {
    const endpoint = `/api/containers/${fixture.worker.id}/plugins/${fixture.installations[0].id}`;
    expect((await request.put(`${endpoint}/enabled`, { data: { enabled: false } })).status()).toBe(200);
    expect(await (await request.get(`${fixture.path(0)}status`)).json()).toMatchObject({ state: 'Disabled', ready: false });
    expect(await rfbBanner(request, `${fixture.path(0)}websockify`)).toBe('');
    expect((await request.delete(endpoint)).status()).toBe(204);
    expect((await request.get(fixture.path(0))).status()).toBe(404);
    expect(await rfbBanner(request, `${fixture.path(1)}websockify`)).toBe('RFB 003.008\n');
    expect(await rfbBanner(request, `/ws/desktop/${fixture.worker.id}`)).toBe('RFB 003.008\n');
  });
});
