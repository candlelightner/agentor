import { test, expect, chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import * as wsUtils from '../../orchestrator/server/utils/ws-utils';
import type { ContainerInfo } from '../../orchestrator/shared/types';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const ts = require('typescript');

// Execute the actual handler with bounded auth/runtime doubles, without
// starting an auth database or touching either Docker or Incus.
async function handlerFixture(status: string, role = 'user', owner = 'owner', authenticated = true, attachReady?: Promise<void>) {
  const source = await readFile(new URL('../../orchestrator/server/utils/terminal-handler.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const stream = new PassThrough();
  const calls = { attach: 0, failures: 0, close: 0, lookup: 0 }, resizes: number[][] = [];
  const manager = {
    get: () => { calls.lookup++; return { userId: owner, status }; },
    attachTerminal: async () => { calls.attach++; await attachReady; return { stream, resize(cols: number, rows: number) { resizes.push([cols, rows]); }, close() { calls.close++; } }; },
    reportRuntimeFailure: () => { calls.failures++; },
  };
  const exports: any = {};
  new Function('require', 'exports', 'useLogger', compiled)((name: string) => {
    if (name === './services') return { useContainerManager: () => manager };
    if (name === './auth-helpers') return { authenticateWsPeer: async () => authenticated ? { user: { id: 'owner', role } } : null };
    if (name === './ws-utils') return wsUtils;
    throw new Error('Unexpected handler dependency: ' + name);
  }, exports, () => ({ error() {} }));
  const messages: string[] = [];
  let closed = false;
  const peer = { id: 'terminal-test', request: { url: '/ws/terminal/worker/0' },
    send: (value: unknown) => { messages.push(String(value)); }, close: () => { closed = true; } };
  return { handler: exports.terminalWsHandler, peer, calls, resizes, stream, messages, closed: () => closed };
}

for (const kind of ['legacy-docker', 'incus-vm'] as const) test(`${kind} manager rejects unknown shell without runtime dispatch`, async () => {
  let commands = 0;
  const manager = new ContainerManager({} as any, {} as any);
  manager.registerExternal({ id: 'unknown-worker', containerId: 'captured-incarnation', userId: 'owner',
    runtimeKind: kind, status: 'unknown' } as ContainerInfo);
  manager.workerCommands = () => { commands++; throw new Error('must not dispatch'); };
  await expect(manager.attachTerminal('unknown-worker', 0)).rejects.toThrow('not running');
  expect(commands).toBe(0);
});

for (const role of ['user', 'admin']) test(`WebSocket rejects unknown before exec or recovery for ${role}`, async () => {
  const f = await handlerFixture('unknown', role);
  try {
    f.handler.open(f.peer);
    await expect.poll(f.closed).toBe(true);
    expect(f.messages.join('')).toContain('not confirmed running');
    expect(f.calls).toEqual({ attach: 0, failures: 0, close: 0, lookup: 1 });
  } finally { f.handler.close(f.peer); f.stream.destroy(); }
});

test('unknown status does not bypass authentication or ownership', async () => {
  for (const authenticated of [false, true]) {
    const f = await handlerFixture('unknown', 'user', 'different-owner', authenticated);
    try {
      f.handler.open(f.peer); await expect.poll(f.closed).toBe(true);
      expect(f.messages.join('')).toContain(authenticated ? 'Forbidden' : 'Unauthorized');
      expect(f.messages.join('')).not.toContain('confirmed running');
      expect(f.calls.attach).toBe(0); expect(f.calls.failures).toBe(0);
      expect(f.calls.lookup).toBe(authenticated ? 1 : 0);
    } finally { f.handler.close(f.peer); f.stream.destroy(); }
  }
});

test('running terminal still attaches, forwards output and closes its session', async () => {
  const f = await handlerFixture('running');
  try {
    f.handler.open(f.peer); await expect.poll(() => f.calls.attach).toBe(1);
    f.stream.write('terminal-output');
    await expect.poll(() => f.messages.join('')).toContain('terminal-output');
    f.handler.close(f.peer); expect(f.calls.close).toBe(1); expect(f.calls.failures).toBe(0);
  } finally { f.handler.close(f.peer); f.stream.destroy(); }
});

test('disconnect during authentication does not start a shell', async () => {
  const f = await handlerFixture('running');
  try {
    f.handler.open(f.peer); f.handler.close(f.peer);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.calls.attach).toBe(0);
  } finally { f.stream.destroy(); }
});

test('delayed terminal attachment applies only the latest valid early resize and discards early keystrokes', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = await handlerFixture('running', 'admin', 'owner', true, ready);
  try {
    f.handler.open(f.peer);
    f.handler.message(f.peer, JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    f.handler.message(f.peer, JSON.stringify({ type: 'resize', cols: 132, rows: 42 }));
    f.handler.message(f.peer, JSON.stringify({ type: 'resize', cols: 20000, rows: 50 }));
    f.handler.message(f.peer, 'early-keystrokes');
    await expect.poll(() => f.calls.attach).toBe(1);
    expect(f.resizes).toEqual([]);
    release();
    await expect.poll(() => f.resizes).toEqual([[132, 42]]);
    expect(f.messages.join('')).not.toContain('early-keystrokes');
    f.handler.message(f.peer, JSON.stringify({ type: 'resize', cols: 160, rows: 50 }));
    expect(f.resizes).toEqual([[132, 42], [160, 50]]);
    f.handler.message(f.peer, 'ready-keystrokes');
    expect(f.messages.join('')).toContain('ready-keystrokes');
  } finally { release(); f.handler.close(f.peer); f.stream.destroy(); }
});

test('disconnect during delayed terminal attachment discards the pending resize and closes the late session', async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  const f = await handlerFixture('running', 'user', 'owner', true, ready);
  try {
    f.handler.open(f.peer);
    f.handler.message(f.peer, JSON.stringify({ type: 'resize', cols: 132, rows: 42 }));
    await expect.poll(() => f.calls.attach).toBe(1);
    f.handler.close(f.peer);
    release();
    await expect.poll(() => f.calls.close).toBe(1);
    expect(f.resizes).toEqual([]);
  } finally { release(); f.handler.close(f.peer); f.stream.destroy(); }
});

test('real Vue pane never mounts a restored unknown terminal and disconnects on status loss', async () => {
  const { parse, compileScript } = require('@vue/compiler-sfc');
  const { build } = require('esbuild');
  const source = await readFile(new URL('../../orchestrator/app/components/PaneContent.vue', import.meta.url), 'utf8');
  const component = compileScript(parse(source).descriptor, { id: 'terminal-admission', inlineTemplate: true }).content;
  const entry = `import { computed,ref,watch,createApp,nextTick,h } from 'vue';
    const inventory=ref([{id:'worker',status:'unknown'}]);
    const useNuxtData=(key)=>{if(key!=='workers')throw Error('Wrong inventory key');return {data:inventory}};
    ${component.replace('export default', 'const PaneContent =')}
    window.attaches=0;window.disconnects=0;
    const app=createApp(PaneContent,{group:{id:'leaf',activeTabId:'tab',tabs:[{id:'tab',type:'terminal',containerId:'worker'}]}});
    app.component('TerminalPane',{mounted(){window.attaches++},unmounted(){window.disconnects++},render(){return h('div',{'data-testid':'connected-terminal'},'terminal')}});
    app.mount('#app');
    window.setWorkerStatus=async status=>{inventory.value=status===null?[]:[{id:'worker',status}];await nextTick()};`;
  const bundled = await build({ stdin: { contents: entry, resolveDir: new URL('../../orchestrator', import.meta.url).pathname,
    loader: 'ts' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  const browser = await chromium.launch({ executablePath: process.env.TEST_BROWSER_EXECUTABLE });
  try {
    const page = await browser.newPage(); await page.setContent('<div id="app"></div>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    await expect(page.getByTestId('terminal-unavailable')).toBeVisible();
    expect(await page.evaluate(() => (window as any).attaches)).toBe(0);
    await page.evaluate(() => (window as any).setWorkerStatus('running'));
    await expect(page.getByTestId('connected-terminal')).toBeVisible();
    expect(await page.evaluate(() => (window as any).attaches)).toBe(1);
    await page.evaluate(() => (window as any).setWorkerStatus('unknown'));
    await expect(page.getByTestId('terminal-unavailable')).toBeVisible();
    expect(await page.evaluate(() => (window as any).disconnects)).toBe(1);
    await page.evaluate(() => (window as any).setWorkerStatus(null));
    await expect(page.getByTestId('terminal-unavailable')).toBeVisible();
    expect(await page.evaluate(() => (window as any).attaches)).toBe(1);
    await page.evaluate(() => (window as any).setWorkerStatus('running'));
    await expect(page.getByTestId('connected-terminal')).toBeVisible();
    expect(await page.evaluate(() => (window as any).attaches)).toBe(2);
  } finally { await browser.close(); }
});
