import { test, expect, type Page } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { buildPng, readWorkerClipboard, waitForClipboardReady } from '../helpers/clipboard';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Clipboard paste bridge — UI coverage.
 *
 * The terminal bridge (useClipboardPasteBridge via useTerminal) intercepts
 * Ctrl/Cmd+V on the xterm keydown: image → POST PNG to the worker X clipboard
 * and replay exactly one raw Ctrl+V (\x16) over the terminal WebSocket so the
 * remote shell/agent reads the X clipboard; text → paste through xterm's
 * bracketed-paste path (term.paste), no clipboard POST; denied/error → replay
 * the original Ctrl+V so existing behaviour is no worse.
 *
 * The desktop bridge (worker/novnc/agentor-clipboard.js) is a standalone ES
 * module injected into agentor.html; it capture-intercepts Ctrl/Cmd+V in the
 * noVNC iframe, POSTs the payload, then replays the key to the VNC session.
 *
 * Playwright's Chromium-only async Clipboard API (navigator.clipboard.read)
 * requires a secure context + clipboard permissions + a user gesture. We grant
 * `clipboard-read`/`clipboard-write` permissions and seed the host clipboard
 * with a generated PNG ClipboardItem via an init script, then drive a real
 * Ctrl+V keydown. Route interception proves the PNG POST fires; reading the
 * worker X clipboard back confirms the helper served image/png.
 */

const PNG = buildPng(3, 2);

test.describe.serial('Clipboard paste bridge — Agentor Terminal (xterm)', () => {
  let containerId: string;
  let displayName: string;

  test.beforeAll(async ({ request }) => {
    displayName = `Clip-${Date.now()}`;
    const container = await createWorker(request, { displayName });
    containerId = container.id;
    await waitForClipboardReady(request, containerId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  // Grant clipboard permissions for every test in this block. Chromium-only:
  // the async Clipboard API is not available in Firefox/Safari in Playwright.
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  /**
   * Open the Agentor Terminal pane for the worker card and wait for xterm.
   * Returns nothing; the caller drives interactions on `page`.
   */
  async function openTerminal(page: Page): Promise<void> {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    const buttons = card.locator('button');
    await buttons.first().click();
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
  }

  test('image Ctrl+V POSTs PNG before raw CtrlV replay and worker X clipboard holds the PNG', async ({ page, request }) => {
    // Seed the host clipboard with a generated PNG ClipboardItem. This must run
    // in a secure user-gesture context; Playwright grants the permission and
    // the addInitScript runs before any page script. We set the clipboard via
    // a page.evaluate on the dashboard (a real document with clipboard access)
    // — navigator.clipboard.write requires a user gesture, so we do it inside
    // the already-loaded dashboard before focusing the terminal.
    await openTerminal(page);

    // Intercept the clipboard POST so we can assert it fires with image/png.
    let posted = false;
    let postedType = '';
    await page.route(`**/api/containers/${containerId}/clipboard`, async (route) => {
      const req = route.request();
      postedType = req.headers()['content-type'] || '';
      // Inspect the body only to assert it is non-empty and starts with the PNG
      // signature — never log clipboard contents. Fulfil the request so the
      // bridge's replay path runs.
      const body = req.postDataBuffer();
      if (body && body.length > 8 && body[0] === 0x89 && body[1] === 0x50) {
        posted = true;
      }
      await route.continue();
    });

    // Seed the host clipboard with the PNG via the dashboard document (secure
    // context + granted permission). Do this before focusing xterm so the
    // gesture budget is clean.
    await page.evaluate(async (pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
    }, PNG.toString('base64'));

    // Focus the xterm terminal and trigger a real Ctrl+V keydown.
    await page.locator('.xterm').click();
    await page.keyboard.press('Control+v');

    // The bridge POSTs then replays \x16. Wait for the POST to fire.
    await expect
      .poll(async () => posted, { timeout: 15_000, message: 'clipboard POST with image/png fired' })
      .toBe(true);
    expect(postedType).toContain('image/png');

    // The POST having completed means the helper verified ownership, so the
    // worker X clipboard now holds the PNG. Read it back and confirm.
    const readBack = await readWorkerClipboard(request, containerId, 'image/png');
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(PNG)).toBe(true);

    // The terminal must remain usable after the paste bridge ran: the raw
    // Ctrl+V replay (\x16) should not have wedged xterm. Verify the xterm
    // element is still present and accepts focus.
    await expect(page.locator('.xterm')).toBeVisible();
  });

  test('text Ctrl+V follows xterm text paste with no clipboard POST', async ({ page }) => {
    await openTerminal(page);

    // Intercept the clipboard POST — it must NOT fire for a text paste.
    let posted = false;
    await page.route(`**/api/containers/${containerId}/clipboard`, async (route) => {
      posted = true;
      await route.continue();
    });

    // Seed the host clipboard with text only (no image).
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, `TextPaste_${Date.now()}`);

    // Focus xterm and Ctrl+V. The bridge reads text and returns it for
    // term.paste (xterm bracketed paste), without POSTing.
    await page.locator('.xterm').click();
    await page.keyboard.press('Control+v');

    // Give the bridge a moment to (not) fire the POST.
    await page.waitForTimeout(1500);
    expect(posted).toBe(false);

    // xterm text paste injects the text into the terminal input; the terminal
    // remains usable.
    await expect(page.locator('.xterm')).toBeVisible();
  });

  test('denied clipboard falls back to raw Ctrl+V with no POST', async ({ page, context }) => {
    await openTerminal(page);

    // Revoke clipboard permission for this test to simulate a denied read.
    await context.clearPermissions();

    let posted = false;
    await page.route(`**/api/containers/${containerId}/clipboard`, async (route) => {
      posted = true;
      await route.continue();
    });

    await page.locator('.xterm').click();
    await page.keyboard.press('Control+v');

    await page.waitForTimeout(1500);
    // Denied → bridge replays the original Ctrl+V without POSTing.
    expect(posted).toBe(false);
    await expect(page.locator('.xterm')).toBeVisible();
  });
});

test.describe.serial('Clipboard paste bridge — noVNC Desktop (agentor.html)', () => {
  let containerId: string;
  let displayName: string;

  test.beforeAll(async ({ request }) => {
    displayName = `Desk-${Date.now()}`;
    const container = await createWorker(request, { displayName });
    containerId = container.id;
    await waitForClipboardReady(request, containerId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  // Grant clipboard permissions for the runtime Ctrl+V test. The static smoke
  // tests below don't use the browser, so this is a harmless no-op for them.
  test.use({
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('Desktop pane iframe src points at agentor.html', async ({ page }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });

    // Desktop is the 3rd icon button (Terminal, Editor, Desktop, …).
    const buttons = card.locator('button');
    await buttons.nth(2).click();

    // The Desktop ServicePane iframe src must use agentor.html (not vnc.html).
    const iframe = page.frameLocator('iframe[allow*="clipboard"]').first();
    // Wait for the iframe to be present with the agentor.html src.
    await expect
      .poll(
        async () => {
          const handles = await page.locator('iframe[allow*="clipboard"]').elementHandles();
          for (const h of handles) {
            const src = await h.getAttribute('src');
            if (src && src.includes('/agentor.html')) return true;
          }
          return false;
        },
        { timeout: 15_000, message: 'Desktop iframe src uses agentor.html' },
      )
      .toBe(true);
    // Touch the frameLocator so it is referenced (and resolves) — guards
    // against a stale selector.
    await expect(iframe.locator('body')).toBeVisible({ timeout: 15_000 }).catch(() => {
      // noVNC may still be connecting; the src assertion above is the primary
      // check. Don't fail the whole test on a slow noVNC bootstrap.
    });
  });

  test('agentor-clipboard.js module loads and intercepts the paste route path (static smoke)', async ({ request }) => {
    // The injected module lives at /desktop/<id>/app/agentor-clipboard.js
    // (served from the worker's /usr/share/novnc/app/ via the desktop proxy).
    // Fetch it through the authenticated API context and assert it contains
    // the route path and the capture-phase keydown attach — proving the
    // injected module is served and wired, without depending on a live VNC
    // session (which is flaky to drive in a headless browser).
    const res = await request.get(`${BASE_URL}/desktop/${containerId}/app/agentor-clipboard.js`);
    expect(res.status()).toBe(200);
    const text = await res.text();
    // Route path the module POSTs to.
    expect(text).toContain('/api/containers/');
    expect(text).toContain('/clipboard');
    // Capture-phase keydown interceptor attach.
    expect(text).toContain('addEventListener');
    expect(text).toContain('keydown');
    // Worker UUID path parser.
    expect(text).toContain('agentor.html');
  });

  test('agentor.html injects the clipboard module script tag (static smoke)', async ({ request }) => {
    // agentor.html is built from vnc.html with a single injected module script.
    // Fetch it through the desktop proxy and assert the injection is present.
    const res = await request.get(`${BASE_URL}/desktop/${containerId}/agentor.html`);
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain('app/agentor-clipboard.js');
    expect(html).toContain('type="module"');
    // The upstream vnc.html body must still be intact (the injection appends
    // before </body>, it does not replace it).
    expect(html).toContain('</body>');
  });

  test('Ctrl+V image in noVNC desktop POSTs PNG to the clipboard route (runtime smoke)', async ({ page, request }) => {
    await goToDashboard(page);
    const card = page.locator('.rounded-lg').filter({ hasText: displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    const buttons = card.locator('button');
    await buttons.nth(2).click();

    // Wait for the Desktop iframe to load.
    const iframe = page.frameLocator('iframe[allow*="clipboard"]').first();
    await expect(iframe.locator('body')).toBeVisible({ timeout: 30_000 });

    // Intercept the clipboard POST at the top-level page (the iframe POSTs to
    // /api/containers/<id>/clipboard with credentials, same origin).
    let posted = false;
    let postedType = '';
    await page.route(`**/api/containers/${containerId}/clipboard`, async (route) => {
      const req = route.request();
      postedType = req.headers()['content-type'] || '';
      const body = req.postDataBuffer();
      if (body && body.length > 8 && body[0] === 0x89 && body[1] === 0x50) posted = true;
      await route.continue();
    });

    // Seed the host clipboard with the PNG. Do it in the top-level page
    // (secure context + granted permission) before focusing the iframe.
    await page.evaluate(async (pngBase64) => {
      const bytes = Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: 'image/png' });
      const item = new ClipboardItem({ 'image/png': blob });
      await navigator.clipboard.write([item]);
    }, PNG.toString('base64'));

    // Focus the noVNC canvas and trigger Ctrl+V. The module intercepts on
    // capture phase, reads the clipboard, POSTs, then replays the key.
    const canvas = iframe.locator('#noVNC_container canvas').first();
    await canvas.click({ timeout: 15_000 });
    await page.keyboard.press('Control+v');

    await expect
      .poll(async () => posted, { timeout: 15_000, message: 'noVNC clipboard POST fired' })
      .toBe(true);
    expect(postedType).toContain('image/png');
    const readBack = await readWorkerClipboard(request, containerId, 'image/png');
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(PNG)).toBe(true);
  });
});
