import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { withWorkerLifecycleMutation } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const ts = require('typescript'), vue = require('vue');
const panes = [{ index: 0, name: 'main', active: true }];
(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function managerFixture(status: string, probe = async () => panes) {
  const manager = new ContainerManager({} as any, {} as any);
  const info = { id: randomUUID(), userId: 'fixture-owner', containerId: 'fixture-incarnation', runtimeKind: 'incus-vm', status } as any;
  let calls = 0;
  manager.registerExternal(info);
  manager.workerCommands = (() => ({ execListTmuxWindows: async () => { calls++; return probe(); } })) as any;
  return { manager, info, calls: () => calls };
}
for (const [status, statusCode] of [['stopped', 409], ['unknown', 503]] as const) {
  test(`panes reject ${status} without guest execution or rewriting inventory`, async () => {
    const f = managerFixture(status);
    await expect(f.manager.listTmuxWindows(f.info.id)).rejects.toMatchObject({ statusCode,
      data: { code: 'WORKER_PANES_UNAVAILABLE', status } });
    expect(f.info.status).toBe(status);
    expect(f.calls()).toBe(0);
  });
}
test('running panes succeed; a current failed runtime probe becomes unknown with 503', async () => {
  const healthy = managerFixture('running');
  await expect(healthy.manager.listTmuxWindows(healthy.info.id)).resolves.toEqual(panes);
  expect(healthy.calls()).toBe(1);
  const failed = managerFixture('running', async () => { throw Error('fixture guest unavailable'); });
  await expect(failed.manager.listTmuxWindows(failed.info.id)).rejects.toMatchObject({ statusCode: 503 });
  expect(failed.info.status).toBe('unknown');
  expect(failed.info.runtimeDiagnostic.operation).toBe('Worker terminal inspection');
});
test('a delayed pane probe failure cannot erase a completed stop', async () => {
  const probe = deferred<typeof panes>(), f = managerFixture('running', () => probe.promise);
  const rejected = expect(f.manager.listTmuxWindows(f.info.id)).rejects.toMatchObject({ statusCode: 409 });
  await withWorkerLifecycleMutation(f.info.id, async () => { f.info.status = 'stopped'; });
  probe.reject(Error('old probe failed after stop'));
  await rejected;
  expect(f.info.status).toBe('stopped');
  expect(f.info.runtimeDiagnostic).toBeUndefined();
});
for (const outcome of ['success', 'failure']) test(`stop/start invalidates delayed pane ${outcome} without overwriting running state`, async () => {
  const probe = deferred<typeof panes>(), f = managerFixture('running', () => probe.promise);
  const rejected = expect(f.manager.listTmuxWindows(f.info.id)).rejects.toMatchObject({ statusCode: 503 });
  await withWorkerLifecycleMutation(f.info.id, async () => { f.info.status = 'stopped'; });
  await withWorkerLifecycleMutation(f.info.id, async () => { f.info.status = 'running'; });
  if (outcome === 'success') probe.resolve(panes);
  else probe.reject(Error('probe belongs to old lifecycle'));
  await rejected;
  expect(f.info.status).toBe('running');
  expect(f.info.runtimeDiagnostic).toBeUndefined();
});

function tabsFixture(initialStatus: string, fetch: () => Promise<unknown>) {
  const workers = vue.ref([{ id: 'fixture-worker', status: initialStatus }]);
  const timers = new Map<number, { callback: () => Promise<void>, delay: number }>();
  let sequence = 0, requests = 0;
  const source = readFileSync(new URL('../../orchestrator/app/composables/useTmuxTabs.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('exports', 'ref', 'computed', 'watch', 'useNuxtData', 'useUiState', '$fetch', 'setTimeout', 'clearTimeout', compiled)(
    exports, vue.ref, vue.computed, vue.watch, () => ({ data: workers }),
    () => ({ getTmuxActiveWindow: () => null, setTmuxActiveWindow() {} }),
    () => { requests++; return fetch(); },
    (callback: () => Promise<void>, delay: number) => { const id = ++sequence; timers.set(id, { callback, delay }); return id; },
    (id: number) => timers.delete(id));
  const scope = vue.effectScope();
  const tabs = scope.run(() => exports.useTmuxTabs(vue.ref('fixture-worker')));
  const flush = async () => {
    await vue.nextTick();
    for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    await vue.nextTick();
  };
  return { tabs, workers, timers, flush, requests: () => requests,
    async status(status: string) { workers.value[0].status = status; await flush(); },
    async tick() {
      expect(timers.size).toBe(1);
      const [id, timer] = [...timers.entries()][0];
      timers.delete(id);
      await timer.callback();
      await flush();
      return timer.delay;
    },
    dispose() { tabs.destroy(); scope.stop(); },
  };
}

test('pane polling follows shared running inventory and discards late stopped responses', async () => {
  const pending = deferred<typeof panes>();
  let next = () => pending.promise;
  const f = tabsFixture('unknown', () => next());
  try {
    await f.flush();
    expect(f.requests()).toBe(0);
    expect(f.timers.size).toBe(0);
    expect(f.workers.value[0].status).toBe('unknown');
    await f.status('running');
    expect(f.requests()).toBe(1);
    expect(f.timers.size).toBe(0);
    await f.status('stopped');
    pending.resolve(panes);
    await f.flush();
    expect(f.tabs.windows.value).toEqual([]);
    expect(f.timers.size).toBe(0);
    expect(f.workers.value[0].status).toBe('stopped');
    await f.status('unknown');
    expect(f.requests()).toBe(1);
    expect(f.workers.value[0].status).toBe('unknown');
    next = async () => panes;
    await f.status('running');
    expect(f.requests()).toBe(2);
    expect(f.tabs.windows.value).toEqual(panes);
    expect(f.tabs.activeWindowIndex.value).toBe(0);
    expect([...f.timers.values()].map(timer => timer.delay)).toEqual([3000]);
    await f.status('stopped');
    expect(f.timers.size).toBe(0);
    expect(f.tabs.windows.value).toEqual([]);
  } finally { f.dispose(); }
});

test('pane polling waits for each response and backs off to a bounded interval, then recovers', async () => {
  const pending = deferred<typeof panes>();
  let response: () => Promise<unknown> = () => pending.promise;
  let active = 0, maximumActive = 0;
  const f = tabsFixture('running', async () => {
    maximumActive = Math.max(maximumActive, ++active);
    try { return await response(); } finally { active--; }
  });
  try {
    await f.flush();
    expect(f.requests()).toBe(1);
    expect(active).toBe(1);
    expect(f.timers.size).toBe(0);
    pending.reject(Error('expected unavailable'));
    await f.flush();
    response = async () => { throw Error('expected unavailable'); };
    const delays = [];
    for (let index = 0; index < 6; index++) delays.push(await f.tick());
    expect(delays).toEqual([6000, 12000, 24000, 48000, 48000, 48000]);
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(f.workers.value[0].status).toBe('running');
    response = async () => panes;
    await f.tick();
    expect([...f.timers.values()].map(timer => timer.delay)).toEqual([3000]);
    expect(f.tabs.windows.value).toEqual(panes);
    f.tabs.destroy();
    expect(f.timers.size).toBe(0);
  } finally { f.dispose(); }
});
