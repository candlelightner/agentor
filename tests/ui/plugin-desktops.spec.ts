import { test, expect } from '@playwright/test';
import { desktopFixture } from '../helpers/plugin-desktops';
import { goToDashboard } from '../helpers/ui-helpers';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { desktopBase } from '../helpers/plugin-desktops';
import type { Socket } from 'node:net';

test.describe.serial('Native plugin desktop actions', () => {
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  test.beforeAll(async ({ request }) => { fixture = await desktopFixture(request, 'Desktop UI'); });
  test.afterAll(async ({ request }) => { await fixture?.cleanup(request); });

  test('dashboard button opens a pane and simultaneous tabs render only their own display through real noVNC', async ({ page, context }) => {
    await goToDashboard(page);
    const actions = page.getByTestId('worker-plugin-actions').filter({ hasText: 'Desktop UI Red' });
    await actions.getByRole('button', { name: /Desktop UI Red/ }).click();
    const frame = page.frameLocator('[data-testid="plugin-application-frame"]');
    await expect(frame.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    const tabPromise = context.waitForEvent('page');
    await actions.getByRole('link', { name: 'Open Desktop UI Blue in tab', exact: true }).click();
    const blue = await tabPromise;
    await expect(blue.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    const red = frame.locator('canvas'), blueCanvas = blue.locator('canvas');
    await expect(red).toHaveAttribute('width', '800'); await expect(blueCanvas).toHaveAttribute('width', '960');
    const color = (canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0, blue = 0;
      for (let i = 0; i < pixels.length; i += 4) { if (pixels[i]! > 140 && pixels[i + 2]! < 70) red++; if (pixels[i + 2]! > 140 && pixels[i]! < 70) blue++; }
      return { red, blue };
    };
    await expect.poll(async () => (await red.evaluate(color)).red).toBeGreaterThan(20_000);
    expect((await red.evaluate(color)).blue).toBeLessThan(1000);
    await expect.poll(async () => (await blueCanvas.evaluate(color)).blue).toBeGreaterThan(20_000);
    expect((await blueCanvas.evaluate(color)).red).toBeLessThan(1000);
    await blue.reload(); await expect(blue.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    await blue.getByRole('button', { name: 'Reconnect', exact: true }).click();
    await expect(blue.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    await expect(frame.locator('body')).toHaveAttribute('data-desktop-state', 'ready');
    await blue.close();
  });

  test('disabled desktop shows an actionable state, revokes its active viewer, and leaves its neighbor ready', async ({ page, context, request }) => {
    await page.goto(fixture.path(0));
    const blue = await context.newPage(); await blue.goto(fixture.path(1));
    await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    await expect(blue.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    const result = await request.put(`/api/containers/${fixture.worker.id}/plugins/${fixture.installations[0].id}/enabled`, { data: { enabled: false } });
    expect(result.status()).toBe(200);
    await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'disabled', { timeout: 15_000 });
    await expect(blue.locator('body')).toHaveAttribute('data-desktop-state', 'ready');
    await goToDashboard(page);
    const actions = page.getByTestId('worker-plugin-actions').filter({ hasText: 'Desktop UI Red' });
    await expect(actions.getByRole('button', { name: /Desktop UI Red/ })).toBeDisabled();
    await expect(actions).toContainText('Disabled');
    await blue.close();
  });

  test('viewer modules and authenticated WebSockets survive a reverse-proxy base path', async ({ page }) => {
    const upstream = new URL(desktopBase);
    const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
    const sockets = new Set<Socket>();
    const server = createServer((req, res) => {
      if (!req.url?.startsWith('/mounted/')) { res.writeHead(404).end(); return; }
      const proxy = send(new URL(req.url.slice('/mounted'.length), upstream), { method: req.method, headers: req.headers, rejectUnauthorized: false }, response => {
        res.writeHead(response.statusCode!, response.headers); response.pipe(res);
      });
      proxy.on('error', () => res.writeHead(502).end()); req.pipe(proxy);
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, client, head) => {
      if (!req.url?.startsWith('/mounted/')) { client.destroy(); return; }
      const proxy = send(new URL(req.url.slice('/mounted'.length), upstream), { headers: req.headers, rejectUnauthorized: false });
      proxy.on('upgrade', (response, backend, backendHead) => {
        client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${Object.entries(response.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
        if (backendHead.length) client.write(backendHead); if (head.length) backend.write(head);
        client.pipe(backend); backend.pipe(client); client.on('close', () => backend.destroy()); backend.on('error', () => client.destroy()); client.on('error', () => backend.destroy());
      });
      proxy.on('error', () => client.destroy()); proxy.end();
    });
    await new Promise<void>(resolve => server.listen(0, '0.0.0.0', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      await page.goto(`http://${upstream.hostname}:${port}/mounted${fixture.path(1)}`);
      await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
      await expect(page.locator('canvas')).toHaveAttribute('width', '960');
      await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    } finally { await page.goto('about:blank'); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
