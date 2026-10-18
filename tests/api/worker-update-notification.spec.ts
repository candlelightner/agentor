import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const requireApp = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const ts = requireApp('typescript');
const vue = requireApp('vue');

async function fixture() {
  const source = await readFile(new URL('../../orchestrator/app/composables/useUpdates.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {}, requests: string[] = [];
  let tick: (() => Promise<void>) | undefined, statusChecks = 0, first = true;
  const before = { worker: { updateAvailable: true }, orchestrator: { updateAvailable: true }, isProductionMode: true };
  const after = { worker: { updateAvailable: true, nativeUpdateRequired: true }, orchestrator: { updateAvailable: false }, isProductionMode: true };
  const fetch = async (path: string) => {
    requests.push(path);
    if (path === '/api/updates') return ++statusChecks === 1 ? before : after;
    if (path === '/api/health') return {};
    if (path === '/api/updates/apply') { const defer = first; first = false; return { errors: [], workerDeferred: defer, orchestratorRestarting: defer }; }
    throw new Error('Unexpected test request');
  };
  new Function('exports', 'ref', 'computed', 'onMounted', 'onUnmounted', '$fetch', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'fetchErrorMessage', code)(exports, vue.ref, vue.computed, () => {}, () => {}, fetch,
      (callback: () => Promise<void>) => { tick = callback; return 1; }, () => {}, () => { throw new Error('No real intervals in fixture'); }, () => {}, () => 'Update failed');
  const api = exports.useUpdates(); await Promise.resolve();
  return { api, requests, reconnect: async () => { expect(tick).toBeDefined(); await tick!(); } };
}

test('actual update composable retains deferred worker notice and fetches new readiness after reconnect', async () => {
  const f = await fixture();
  await f.api.applyUpdates();
  expect(f.api.workerUpdateDeferred.value).toBe(true); expect(f.api.isRestarting.value).toBe(true);
  await f.reconnect();
  expect(f.api.isRestarting.value).toBe(false); expect(f.api.status.value.worker.nativeUpdateRequired).toBe(true);
  expect(f.requests).toEqual(['/api/updates', '/api/updates/apply', '/api/health', '/api/updates']);
});

test('explicit worker Apply clears the deferred notice after the new package is ready', async () => {
  const f = await fixture(); await f.api.applyUpdates(); await f.reconnect();
  await f.api.applyImage('worker'); expect(f.api.workerUpdateDeferred.value).toBe(false);
  expect(f.api.applyErrors.value).toEqual([]); expect(f.api.applyingImages.value.size).toBe(0);
});
