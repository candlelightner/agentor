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
    const bundle = await build({ stdin: { contents: prelude + script.content + '\ncreateApp(TerminalPane, { containerId: "fixture-worker" }).component("TmuxTabBar", { render() { return null; } }).mount("#app");', resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' }, plugins: [{ name: 'nuxt-autoimports-fixture', setup(builder: any) { builder.onResolve({ filter: /^~\/utils\/fetch-error$/ }, () => ({ path: new URL('../../orchestrator/app/utils/fetch-error.ts', import.meta.url).pathname })); builder.onLoad({ filter: /\/useTerminal\.ts$/ }, async (args: any) => ({ contents: "import { ref, shallowRef, watch } from 'vue';\n" + await readFile(args.path, 'utf8'), loader: 'ts' })); } }] });
    const css = await readFile(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    server = createServer((req, res) => {
      if (req.url === '/component.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].text); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><style>' + css + ' html,body,#app{height:100%;margin:0}.absolute{position:absolute;inset:0}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1}.relative{position:relative}.min-h-0{min-height:0}.shrink-0{flex-shrink:0}.overflow-x-auto{overflow-x:auto}.mobile-terminal-keys{display:block;position:relative}.mobile-terminal-keys [role=toolbar]{min-height:48px;box-sizing:border-box}@media(min-width:640px){.mobile-terminal-keys{display:none}}</style><div id="app"></div><script src="/component.js"></script>'); }
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

  test('mobile toolbar sends one-shot modifier combinations without duplicate terminal input', async ({ page, context }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(() => navigator.clipboard.writeText('virtual modifier paste'));
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await page.evaluate(() => { (window as any).sent.length = 0; });
    await page.getByRole('button', { name: 'Terminal keys' }).click();
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true });
    await ctrl.click();
    await expect(ctrl).toHaveAttribute('aria-pressed', 'true');
    await input.press('c');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03']);
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');

    await ctrl.click();
    await input.press('l');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03', '\x0c']);
    await input.press('Shift+Enter');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).at(-1))).toBe('\x1b[13;2u');

    await ctrl.click();
    await input.press('v');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).join(''))).toContain('virtual modifier paste');
    await page.evaluate(() => { (window as any).sent.length = 0; });
    await input.press('Control+v');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).join(''))).toContain('virtual modifier paste');

    await ctrl.click();
    await page.getByRole('button', { name: 'Alt', exact: true }).click();
    await input.press('v');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).at(-1))).toBe('\x1b\x16');

    const shift = page.getByRole('button', { name: 'Shift', exact: true });
    await shift.click();
    await page.getByRole('button', { name: 'Tab', exact: true }).click();
    await shift.click();
    await page.getByRole('button', { name: 'Enter', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).join(''))).toContain('\x1b[Z\x1b[13;2u');

    const alt = page.getByRole('button', { name: 'Alt', exact: true });
    await alt.click();
    await input.press('f');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).at(-1))).toBe('\x1bf');
    await expect(page.getByRole('button', { name: 'Hide terminal keys' })).toHaveAttribute('aria-expanded', 'true');
    const mobileLayout = await page.evaluate(() => {
      const terminal = document.querySelector('.terminals-container') ?? document.querySelector('.relative.flex-1.min-h-0')!;
      const toolbar = document.querySelector<HTMLElement>('.mobile-terminal-keys')!;
      const terminalRect = terminal.getBoundingClientRect(), toolbarRect = toolbar.getBoundingClientRect();
      return { terminalBottom: terminalRect.bottom, toolbarTop: toolbarRect.top, toolbarBottom: toolbarRect.bottom, viewportHeight: innerHeight };
    });
    expect(Math.abs(mobileLayout.terminalBottom - mobileLayout.toolbarTop)).toBeLessThan(2);
    expect(mobileLayout.toolbarBottom).toBeLessThanOrEqual(mobileLayout.viewportHeight);
    await page.setViewportSize({ width: 390, height: 500 });
    await expect.poll(() => page.locator('.relative.flex-1.min-h-0').evaluate(el => el.getBoundingClientRect().height)).toBeLessThan(600);
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(page.locator('.mobile-terminal-keys')).toHaveCSS('display', 'none');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await page.getByRole('button', { name: 'Hide terminal keys' }).click();
    await expect(page.getByRole('toolbar', { name: 'Mobile terminal keys' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Terminal keys' }).click();
    await expect(page.getByRole('button', { name: 'Ctrl', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await input.press('c');
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).at(-1))).toBe('c');
  });

  test('Android-style unidentified key input consumes a pending modifier exactly once', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await page.evaluate(() => { (window as any).sent.length = 0; });
    await page.getByRole('button', { name: 'Terminal keys' }).click();
    const ctrl = page.getByRole('button', { name: 'Ctrl', exact: true });
    await ctrl.click();
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
      element.value = 'c';
      element.dispatchEvent(new InputEvent('input', { data: 'c', inputType: 'insertText', composed: true, isComposing: true, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03']);
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');

    await page.getByRole('button', { name: 'Shift', exact: true }).click();
    await input.evaluate(async (element: HTMLTextAreaElement) => {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Process', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
      element.value = 'xy';
      element.dispatchEvent(new InputEvent('input', { data: 'xy', inputType: 'insertText', composed: true, bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03', 'xy']);
    await expect(page.getByRole('button', { name: 'Shift', exact: true })).toHaveAttribute('aria-pressed', 'false');

    await ctrl.click();
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.value = '';
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
      element.value = 'z';
      element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'z', bubbles: true }));
      element.dispatchEvent(new InputEvent('input', { data: 'z', inputType: 'insertCompositionText', composed: true, isComposing: true, bubbles: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { data: 'z', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03', 'xy', '\x1a']);

    await ctrl.click();
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.value = '';
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.value = 'x';
      element.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'x', bubbles: true }));
      element.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertCompositionText', composed: true, isComposing: true, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, isComposing: true, bubbles: true, cancelable: true }));
    });
    const candidateCommit = await page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')).slice(3));
    expect(candidateCommit[0]).toBe('\x18');
    expect(candidateCommit.some((data: string) => data.startsWith('\x1b[13;5u'))).toBe(false);
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.dispatchEvent(new CompositionEvent('compositionend', { data: 'x', bubbles: true }));
      element.dispatchEvent(new InputEvent('input', { data: 'x', inputType: 'insertText', composed: true, bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03', 'xy', '\x1a', ...candidateCommit]);

    await ctrl.click();
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['IME clipboard paste']) }] },
      });
    });
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.value = '';
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
      element.value = 'v';
      element.dispatchEvent(new InputEvent('input', { data: 'v', inputType: 'insertText', composed: true, isComposing: true, bubbles: true }));
      element.dispatchEvent(new CompositionEvent('compositionend', { data: 'v', bubbles: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, which: 229, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toEqual(['\x03', 'xy', '\x1a', ...candidateCommit, 'IME clipboard paste']);
    await expect(ctrl).toHaveAttribute('aria-pressed', 'false');
  });

  test('virtual Ctrl+V uses the clipboard bridge under a Firefox user agent', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Firefox/128.0' });
      let reads = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { read: async () => { reads++; return [{ types: ['text/plain'], getType: async () => new Blob(['Firefox virtual paste']) }]; } },
      });
      (window as any).clipboardReads = () => reads;
    });
    await page.getByRole('button', { name: 'Terminal keys' }).click();
    await page.getByRole('button', { name: 'Ctrl', exact: true }).click();
    await page.locator('.xterm-helper-textarea').press('v');
    await expect.poll(() => page.evaluate(() => (window as any).clipboardReads())).toBe(1);
    await expect.poll(() => page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).toContain('Firefox virtual paste');
    expect(await page.evaluate(() => (window as any).sent.filter((value: string) => !value.startsWith('{')))).not.toContain('\x16');
  });

  test('touch vertical gestures route through xterm mouse-wheel reporting and stay inside the terminal', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const input = page.locator('.xterm-helper-textarea');
    await input.focus();
    await page.evaluate(() => {
      (window as any).sent.length = 0;
      (window as any).emitOutput('\x1b[?1000h\x1b[?1006h\x1b[?1049h');
    });
    await page.waitForTimeout(30);
    const gesture = await page.evaluate(() => {
      const terminal = document.querySelector<HTMLElement>('.xterm')!;
      const terminalRect = terminal.getBoundingClientRect();
      const target = document.elementFromPoint(terminalRect.left + terminalRect.width / 2, terminalRect.top + terminalRect.height / 2)!;
      let bubbledWheel: { x: number; y: number; target: string } | null = null;
      terminal.parentElement!.addEventListener('wheel', event => {
        const wheel = event as WheelEvent;
        bubbledWheel = { x: wheel.clientX, y: wheel.clientY, target: (wheel.target as HTMLElement).className };
      }, { capture: true, once: true });
      const dispatch = (type: string, points: { x: number; y: number }[]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: points.map(point => ({ clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y })) });
        Object.defineProperty(event, 'changedTouches', { value: [] });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const tapPrevented = dispatch('touchstart', [{ x: 100, y: 100 }]);
      dispatch('touchend', []);
      const selectionPointer = new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' });
      let selectionShiftKey = true;
      target.addEventListener('pointerdown', event => { selectionShiftKey = (event as PointerEvent).shiftKey; }, { once: true });
      target.dispatchEvent(selectionPointer);
      const originalNow = Date.now;
      let fakeNow = 1000;
      Date.now = () => fakeNow;
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      fakeNow = 1500;
      const longPressPrevented = dispatch('touchmove', [{ x: 100, y: 130 }]);
      dispatch('touchend', []);
      const sentAfterLongPress = (window as any).sent.filter((value: string) => !value.startsWith('{'));
      fakeNow = 2000;
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      fakeNow = 2100;
      dispatch('touchmove', [{ x: 100, y: 120 }]);
      fakeNow = 2600;
      dispatch('touchmove', [{ x: 100, y: 170 }]);
      dispatch('touchend', []);
      const sentAfterSlowSwipe = (window as any).sent.filter((value: string) => !value.startsWith('{'));
      dispatch('touchstart', [{ x: 100, y: 100 }, { x: 140, y: 100 }]);
      dispatch('touchmove', [{ x: 100, y: 150 }, { x: 140, y: 150 }]);
      dispatch('touchend', []);
      const sentAfterMultiTouch = (window as any).sent.filter((value: string) => !value.startsWith('{'));
      Date.now = originalNow;
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      const verticalPrevented = dispatch('touchmove', [{ x: 100, y: 200 }]);
      dispatch('touchend', []);
      const sentAfterVertical = (window as any).sent.filter((value: string) => !value.startsWith('{'));
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      const horizontalPrevented = dispatch('touchmove', [{ x: 140, y: 100 }]);
      dispatch('touchend', []);
      const sentAfterHorizontal = (window as any).sent.filter((value: string) => !value.startsWith('{'));
      return { tapPrevented, selectionShiftKey, longPressPrevented, sentAfterLongPress, sentAfterSlowSwipe, sentAfterMultiTouch, verticalPrevented, horizontalPrevented, sentAfterVertical, sentAfterHorizontal, bubbledWheel, touchAction: terminal.style.touchAction, overscroll: terminal.style.overscrollBehavior, targetInScreen: !!(target as HTMLElement).closest('.xterm-screen') };
    });
    expect(gesture.tapPrevented).toBe(false);
    expect(gesture.selectionShiftKey).toBe(false);
    expect(gesture.longPressPrevented).toBe(false);
    expect(gesture.sentAfterLongPress).toEqual([]);
    expect(gesture.sentAfterSlowSwipe.some((data: string) => /^\x1b\[<64;\d+;\d+M$/.test(data))).toBe(true);
    expect(gesture.sentAfterMultiTouch).toEqual(gesture.sentAfterSlowSwipe);
    expect(gesture.verticalPrevented).toBe(false);
    expect(gesture.horizontalPrevented).toBe(false);
    expect(gesture.bubbledWheel).toMatchObject({ x: 100, y: 120 });
    expect(gesture.bubbledWheel.target).toContain('xterm');
    expect(gesture.sentAfterVertical.some((data: string) => /^\x1b\[<64;\d+;\d+M$/.test(data))).toBe(true);
    expect(gesture.sentAfterHorizontal).toEqual(gesture.sentAfterVertical);
    expect(gesture.touchAction).toBe('pan-x pinch-zoom');
    expect(gesture.overscroll).toBe('contain');
    expect(gesture.targetInScreen).toBe(true);
  });

  test('touch scrolling uses xterm local scrollback when mouse reporting is off', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => (window as any).emitOutput(Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n')));
    const viewport = page.locator('.xterm-viewport');
    await expect.poll(() => viewport.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    const before = await viewport.evaluate(el => el.scrollTop);
    const result = await viewport.evaluate((el: HTMLElement) => {
      const terminal = el.closest('.xterm')!;
      const rect = terminal.getBoundingClientRect();
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)!;
      const dispatch = (type: string, points: { x: number; y: number }[]) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: points.map(point => ({ clientX: point.x, clientY: point.y, pageX: point.x, pageY: point.y })) });
        Object.defineProperty(event, 'changedTouches', { value: [] });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      const prevented = dispatch('touchmove', [{ x: 100, y: 200 }]);
      dispatch('touchend', []);
      const afterVertical = el.scrollTop;

      const originalNow = Date.now;
      let fakeNow = 1000;
      Date.now = () => fakeNow;
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      fakeNow = 1500;
      dispatch('touchmove', [{ x: 100, y: 130 }]);
      dispatch('touchend', []);
      dispatch('touchstart', [{ x: 100, y: 100 }, { x: 140, y: 100 }]);
      dispatch('touchmove', [{ x: 100, y: 150 }, { x: 140, y: 150 }]);
      dispatch('touchend', []);
      dispatch('touchstart', [{ x: 100, y: 100 }]);
      dispatch('touchmove', [{ x: 140, y: 100 }]);
      dispatch('touchend', []);
      Date.now = originalNow;
      return { prevented, afterVertical, afterGuards: el.scrollTop, targetInScreen: !!(target as HTMLElement).closest('.xterm-screen') };
    });
    expect(result.prevented).toBe(false);
    expect(result.afterVertical).toBeLessThan(before);
    expect(result.afterGuards).toBe(result.afterVertical);
    expect(result.targetInScreen).toBe(true);
  });
});
