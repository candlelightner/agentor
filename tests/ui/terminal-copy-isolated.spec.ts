import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

// Actual TerminalPane + useTerminal + xterm. Only websocket/worker execution is
// substituted with a remote CLI fixture emitting the standard OSC 52 protocol.
test.describe.serial('Terminal clipboard through actual xterm', () => {
  let server: ReturnType<typeof createServer>, baseURL: string;
  test.beforeAll(async () => {
    const source = await readFile(new URL('../../orchestrator/app/components/TerminalPane.vue', import.meta.url), 'utf8');
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: 'isolated-terminal-pane', inlineTemplate: true, genDefaultAs: 'TerminalPane' });
    const prelude = `import { createApp, ref, shallowReactive, computed, toRef, nextTick, watch, onMounted, onUnmounted } from 'vue';
import { Terminal } from '@xterm/xterm'; import { FitAddon } from '@xterm/addon-fit';
import { useTerminal } from './app/composables/useTerminal';
window.useColorMode = () => ref('dark'); window.useToast = () => ({ add() {} });
window.$fetch = async () => ({ protected: false });
function useNuxtApp() { return { $Terminal: Terminal, $FitAddon: FitAddon }; }
function useTmuxTabs() { const windows = ref([]), activeWindowIndex = ref(null); setTimeout(() => { windows.value = [{ index: 0, name: 'main' }]; activeWindowIndex.value = 0; }, 50); return { windows, activeWindowIndex, defaultWindowIndex: ref(0), createWindow() {}, renameWindow() {}, closeWindow() {}, activateWindow() {}, destroy() {} }; }
window.sent = [];
class RemoteFixture { static OPEN = 1; readyState = 1; constructor() { window.remote = this; setTimeout(() => this.onopen?.(), 0); } send(data) { window.sent.push(data); this.input = (this.input || '') + data; if (this.input.endsWith('/copy\\r')) this.onmessage?.({ data: window.copySequence }); } close() { this.readyState = 3; } }
window.WebSocket = RemoteFixture;
window.emitOutput = data => window.remote.onmessage?.({ data });
`;
    const bundle = await build({ stdin: { contents: prelude + script.content + '\ncreateApp(TerminalPane, { containerId: "fixture-worker" }).component("TmuxTabBar", { render() { return null; } }).mount("#app");', resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' }, plugins: [{ name: 'nuxt-autoimports-fixture', setup(builder: any) { builder.onLoad({ filter: /\/useTerminal\.ts$/ }, async (args: any) => ({ contents: "import { ref, shallowRef, watch } from 'vue';\n" + await readFile(args.path, 'utf8'), loader: 'ts' })); } }] });
    const css = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    server = createServer((req, res) => {
      if (req.url === '/component.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].text); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><style>' + css + ' html,body,#app{height:100%;margin:0}.absolute{position:absolute;inset:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.relative{position:relative}.min-h-0{min-height:0}</style><div id="app"></div><script src="/component.js"></script>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  test.afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); });
  test.beforeEach(async ({ page }) => { await page.goto(baseURL); await expect(page.locator('.xterm')).toBeVisible(); });

  test('remote /copy request reaches browser clipboard unchanged after explicit operator click', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const text = 'Last agent response\n' + 'multiline é 漢字 😀\n'.repeat(2000);
    await page.evaluate(sequence => { (window as any).copySequence = sequence; }, '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07');
    await page.locator('.xterm-helper-textarea').pressSequentially('/copy');
    await page.locator('.xterm-helper-textarea').press('Enter');
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
    expect((await page.evaluate(() => (window as any).sent)).filter((value: string) => !value.startsWith('{')).join('')).toBe('/copy\r');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Terminal response copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  });
  test('clipboard permission failure exposes complete selectable text and dismiss clears it', async ({ page }) => {
    const text = 'fallback multiline\nsecond line é';
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('permission denied'); } } }); });
    await page.evaluate(sequence => (window as any).emitOutput(sequence), '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Clipboard access is unavailable or blocked');
    const fallback = page.getByRole('textbox', { name: 'Terminal response to copy' });
    await expect(fallback).toHaveValue(text);
    await fallback.focus();
    expect(await fallback.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe(text);
    await page.getByRole('button', { name: 'Dismiss terminal copy' }).click();
    await expect(fallback).toHaveCount(0);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
    await page.evaluate(sequence => (window as any).emitOutput(sequence), '\x1b]52;c;' + Buffer.from(text).toString('base64') + '\x07');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    await expect(fallback).toHaveValue(text);
    await page.evaluate(() => (window as any).remote.onclose());
    await expect(fallback).toHaveCount(0);
  });
  test('query/malformed/oversized requests never read the clipboard or send response contents to a worker', async ({ page }) => {
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText() { throw new Error('clipboard query must not run'); }, writeText() { throw new Error('automatic copy must not run'); } } }); });
    await page.evaluate(() => (window as any).emitOutput('\x1b]52;c;?\x07'));
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).emitOutput('\x1b]52;c;not-base64\x07'));
    await expect(page.getByRole('status')).toContainText('invalid copy request');
    await page.evaluate(() => (window as any).emitOutput('\x1b]52;c;' + 'A'.repeat(1_400_000) + '\x07'));
    await expect(page.getByRole('status')).toContainText('exceeds 1 MiB');
    expect((await page.evaluate(() => (window as any).sent)).every((value: string) => value.startsWith('{'))).toBe(true);
  });
});
