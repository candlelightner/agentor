import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TMUX_TERMINAL_CLIPBOARD_SETUP } from '../../orchestrator/server/utils/tmux-terminal-clipboard';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');
const { WebSocketServer } = require('ws');
const realCopyText = 'Known isolated Codex response\n' + 'Long multiline é 漢字 😀 text '.repeat(12) + '\n' + 'line of complete response\n'.repeat(1000) + 'END-COPY-RESPONSE';

// Actual TerminalPane + useTerminal + xterm. Deterministic cases substitute
// remote execution; the opt-in case uses a real CLI, tmux and WebSocket.
test.describe.serial('Terminal clipboard through actual xterm', () => {
  let server: ReturnType<typeof createServer>, baseURL: string;
  let sockets: any, cli: ChildProcessWithoutNullStreams | undefined, cliRoot: string | undefined;
  let cliOutput = '', cliErrors = '', providerResponses = 0, cliVersion = '', nativeClipboard: any;
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
if (!new URLSearchParams(location.search).has('realCli')) window.WebSocket = RemoteFixture;
window.emitOutput = data => window.remote.onmessage?.({ data });
`;
    const bundle = await build({ stdin: { contents: prelude + script.content + '\ncreateApp(TerminalPane, { containerId: "fixture-worker" }).component("TmuxTabBar", { render() { return null; } }).mount("#app");', resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' }, plugins: [{ name: 'nuxt-autoimports-fixture', setup(builder: any) { builder.onLoad({ filter: /\/useTerminal\.ts$/ }, async (args: any) => ({ contents: "import { ref, shallowRef, watch } from 'vue';\n" + await readFile(args.path, 'utf8'), loader: 'ts' })); } }] });
    const css = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    server = createServer((req, res) => {
      if (req.url === '/component.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].text); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><style>' + css + ' html,body,#app{height:100%;margin:0}.absolute{position:absolute;inset:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.relative{position:relative}.min-h-0{min-height:0}</style><div id="app"></div><script src="/component.js"></script>'); }
    });
    sockets = new WebSocketServer({ server });
    sockets.on('connection', async (socket: any) => {
      try {
        const binary = process.env.AGENTOR_CODEX_COPY_BINARY;
        if (!binary || cli) { socket.close(); return; }
        cliRoot = await mkdtemp(join(tmpdir(), 'agentor-codex-copy-browser-'));
        cli = spawn('python3', [fileURLToPath(new URL('../fixtures/codex-copy-pty.py', import.meta.url)), binary,
          cliRoot, TMUX_TERMINAL_CLIPBOARD_SETUP, realCopyText], { env: { PATH: '/usr/bin:/bin',
            ...(process.env.AGENTOR_COPY_FIXTURE_DISPLAY ? { AGENTOR_COPY_FIXTURE_DISPLAY: process.env.AGENTOR_COPY_FIXTURE_DISPLAY,
              AGENTOR_COPY_FIXTURE_XCLIP: process.env.AGENTOR_COPY_FIXTURE_XCLIP,
              AGENTOR_COPY_FIXTURE_X11_LIBS: process.env.AGENTOR_COPY_FIXTURE_X11_LIBS } : {}) } });
        cli.stderr.on('data', data => { cliErrors += data.toString(); });
        createInterface({ input: cli.stdout }).on('line', line => {
          const event = JSON.parse(line);
          if (event.type === 'output') { const bytes = Buffer.from(event.data, 'base64'); cliOutput += bytes.toString(); if (socket.readyState === 1) socket.send(bytes); }
          if (event.type === 'response') providerResponses++;
          if (event.type === 'ready') cliVersion = event.version;
          if (event.type === 'clipboard') nativeClipboard = event;
        });
        socket.on('message', (bytes: Buffer) => {
          const data = bytes.toString();
          let message: any;
          try { message = JSON.parse(data); } catch { /* Terminal input remains transparent. */ }
          cli?.stdin.write(JSON.stringify(message?.type === 'resize' ? message :
            { type: 'input', data: bytes.toString('base64') }) + '\n');
        });
        socket.on('close', () => cli?.stdin.end());
      } catch (error) { cliErrors += String(error); socket.close(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  test.afterAll(async () => {
    if (cli) {
      cli.stdin.end();
      await new Promise<void>(resolve => { if (cli!.exitCode !== null) resolve(); else cli!.once('exit', () => resolve()); });
    }
    for (const socket of sockets?.clients ?? []) socket.terminate();
    if (sockets) await new Promise<void>(resolve => sockets.close(() => resolve()));
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (cliRoot) await rm(cliRoot, { recursive: true, force: true });
  });
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

  test('real installed Codex /copy travels through tmux and actual xterm to browser clipboard', async ({ page, context }) => {
    test.skip(!process.env.AGENTOR_CODEX_COPY_BINARY, 'Set AGENTOR_CODEX_COPY_BINARY to an application-only binary and run in an isolated network namespace.');
    test.setTimeout(60_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(baseURL + '?realCli');
    await page.evaluate(() => navigator.clipboard.writeText('Before explicit response copy'));
    await expect.poll(() => cliVersion || cliErrors, { timeout: 20_000 }).toMatch(/^codex-cli /);
    await expect.poll(() => providerResponses).toBeGreaterThan(0);
    await expect(page.locator('.xterm')).toContainText('END-COPY-RESPONSE', { timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toHaveCount(0);
    const input = page.locator('.xterm-helper-textarea');
    await input.pressSequentially('/copy', { delay: 70 });
    await input.press('Enter');
    // Codex 0.163 opens its own copy-target picker. Agentor never intercepts it.
    await expect(page.locator('.xterm')).toContainText('Whole response');
    await input.press('Enter');
    await expect(page.getByRole('button', { name: 'Copy response', exact: true })).toBeVisible();
    expect(cliOutput).toContain('\x1b]52;');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Before explicit response copy');
    await page.getByRole('button', { name: 'Copy response', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Terminal response copied.');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(realCopyText);
    if (process.env.AGENTOR_COPY_FIXTURE_DISPLAY) {
      cli!.stdin.write(JSON.stringify({ type: 'clipboard' }) + '\n');
      await expect.poll(() => nativeClipboard).toMatchObject({ status: 0 });
      expect(Buffer.from(nativeClipboard.data, 'base64').toString()).toBe(realCopyText);
    }
    expect(cliErrors).toBe('');
    test.info().annotations.push({ type: 'real-cli', description: cliVersion + (process.env.AGENTOR_COPY_FIXTURE_DISPLAY ? '; native X11 and tmux forwarding verified' : '; tmux forwarding verified without DISPLAY') });
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
