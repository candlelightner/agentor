import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createApp, defineEventHandler, getCookie, toNodeListener } from '../../orchestrator/node_modules/h3/dist/index.mjs';
import { useLogStore } from '../../orchestrator/server/utils/services';
import { serverLogDownload } from '../../orchestrator/server/utils/server-log-download';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

// Render the actual LogPane SFC with an isolated history provider. The download
// still crosses Chromium -> production handler -> temporary disk log store.
test.describe.serial('Actual LogPane server download in isolation', () => {
  let server: ReturnType<typeof createServer>, baseURL: string;
  const message = 'browser-known-server-entry\n' + 'long multiline content é '.repeat(200);
  test.beforeAll(async () => {
    await useLogStore().init();
    useLogStore().append({ timestamp: '2026-10-17T11:00:00.000Z', source: 'orchestrator', level: 'error', message }, 'orchestrator');
    const source = await readFile(new URL('../../orchestrator/app/components/LogPane.vue', import.meta.url), 'utf8');
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: 'isolated-log-pane', inlineTemplate: true, genDefaultAs: 'LogPane' });
    const prelude = `import { createApp, ref, watch, nextTick } from 'vue';
      function useLogs() { return { filteredEntries: ref([]), connected: ref(true), filters: { sources: [], levels: [], search: '' }, autoScroll: ref(true), loadingMore: ref(false), loadingInitial: ref(false), hasMoreOlder: ref(false), liveTick: ref(0), loadMore: async () => 0, clearLogs() {} }; }\n`;
    const bundle = await build({ stdin: { contents: prelude + script.content + '\ncreateApp(LogPane).component("UIcon", { render() { return null; } }).mount("#app");', resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
    const app = createApp();
    app.use(defineEventHandler(event => {
      const session = getCookie(event, 'isolated-session');
      if (session) event.context.auth = { user: { role: session === 'admin' ? 'admin' : 'user' }, session: {} };
    }));
    app.use('/api/logs/download', serverLogDownload);
    app.use('/component.js', defineEventHandler(() => bundle.outputFiles[0].text));
    app.use('/', defineEventHandler(event => { event.node.res.setHeader('Content-Type', 'text/html'); return '<!doctype html><div id="app"></div><script src="/component.js"></script>'; }));
    server = createServer(toNodeListener(app));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  test.afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); await useLogStore().destroy(); });
  test.beforeEach(async ({ context, page }) => { await context.addCookies([{ name: 'isolated-session', value: 'admin', url: baseURL }]); await page.goto(baseURL); });

  test('clicking the actual action saves matching server-log bytes and a JSONL filename', async ({ page }) => {
    await page.getByPlaceholder('Search logs...').fill('browser-known-server-entry');
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download server logs', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/^agentor-server-logs-.*\.jsonl$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    expect(bytes.length).toBeGreaterThan(0);
    expect(JSON.parse(bytes.toString().trim()).message).toBe(message);
    await expect(page.getByRole('status')).toHaveText('Server logs downloaded.');
  });
  test('empty, unauthorized, and network failures give explicit feedback without downloading', async ({ page, context }) => {
    await page.getByPlaceholder('Search logs...').fill('no-browser-entry-matches');
    await page.getByRole('button', { name: 'Download server logs', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('No server logs match these filters.');
    await context.addCookies([{ name: 'isolated-session', value: 'user', url: baseURL }]);
    await page.getByRole('button', { name: 'Download server logs', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Administrator access is required to download server logs.');
    await page.route('**/api/logs/download?**', route => route.abort('failed'));
    await page.getByRole('button', { name: 'Download server logs', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('Server log download failed. Please retry.');
  });
});
