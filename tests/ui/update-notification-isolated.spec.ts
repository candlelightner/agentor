import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');
let server: ReturnType<typeof createServer>, url: string;

test.beforeAll(async () => {
  const source = await readFile(new URL('../../orchestrator/app/components/UpdateNotification.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'isolated-update-notification', inlineTemplate: true, genDefaultAs: 'UpdateNotification' });
  const prelude = `import { createApp, ref, computed, h } from 'vue';
    function useUpdates() { const status = ref(JSON.parse(new URLSearchParams(location.search).get('status') || '{}')); return {
      status, isChecking: ref(false), isApplying: ref(false), isPruning: ref(false), isRestarting: ref(false), applyErrors: ref([]),
      workerUpdateDeferred: ref(false), applyingImages: ref(new Set()), lastPruneResult: ref(null), updatesAvailable: ref(0),
      isProductionMode: ref(true), checkNow() {}, applyUpdates() {}, applyImage() {}, pruneImages() {} }; }
  `;
  const suffix = `
    const app = createApp(UpdateNotification);
    app.component('UIcon', { render() { return null; } });
    app.component('UTooltip', { props: ['text'], setup(p, { slots }) { const open = ref(false); return () => h('span', { onMouseenter: () => open.value = true, onMouseleave: () => open.value = false, onFocusin: () => open.value = true, onFocusout: () => open.value = false }, [slots.default?.(), open.value && h('span', { role: 'tooltip' }, p.text)]); } });
    app.component('UButton', { props: ['disabled','loading'], setup(p,{slots,attrs}) { return () => h('button',{...attrs,disabled:p.disabled||p.loading},slots.default?.()); } });
    app.mount('#app');`;
  const bundle = await build({ stdin: { contents: prelude + script.content + suffix, resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  server = createServer((request, response) => {
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); });

function status(image: any) {
  return { isProductionMode: true, orchestrator: { name: 'agentor-orchestrator:latest', localDigest: '', remoteDigest: '', updateAvailable: false, lastChecked: '', ...image } };
}

test('local inspection failures and disabled remote checks are explained on hover and keyboard focus', async ({ page }) => {
  const data = status({ localDigestStatus: 'unavailable', localDigestReason: 'timeout', remoteCheckStatus: 'unavailable' });
  await page.goto(`${url}?status=${encodeURIComponent(JSON.stringify(data))}`);
  await expect(page.getByText('presence unknown')).toBeVisible();
  await expect(page.getByText('update status unavailable')).toBeVisible();
  const details = page.getByRole('button', { name: 'Image status details for orchestrator' });
  await details.hover();
  await expect(page.getByRole('tooltip')).toContainText('Local image presence could not be checked (the check timed out).');
  await expect(page.getByRole('tooltip')).toContainText('remote registry could not be checked');

  const absentTraefik = status({ name: 'traefik:v3', localDigestStatus: 'missing', localDigestReason: 'not-found', remoteCheckStatus: 'disabled' });
  await page.goto(`${url}?status=${encodeURIComponent(JSON.stringify({ ...absentTraefik, orchestrator: null, traefik: absentTraefik.orchestrator }))}`);
  await expect(page.getByText('not present')).toBeVisible();
  const traefikDetails = page.getByRole('button', { name: 'Image status details for traefik' });
  await traefikDetails.focus();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('Agentor pulls it when it needs to start port or domain routing.');
  await expect(tooltip).toContainText('Remote registry checks are disabled');
});

test('legacy empty and local-only payloads remain unknown and never imply current status', async ({ page }) => {
  const data = status({ localDigest: '', remoteDigest: '' });
  await page.goto(`${url}?status=${encodeURIComponent(JSON.stringify(data))}`);
  await expect(page.getByText('status unknown')).toBeVisible();
  await expect(page.getByText('✓')).toHaveCount(0);
  await page.getByRole('button', { name: 'Image status details for orchestrator' }).focus();
  await expect(page.getByRole('tooltip')).toContainText('Local image status is unknown');

  const localOnly = status({ localDigest: 'sha256:123456789abc', remoteDigest: '' });
  await page.goto(`${url}?status=${encodeURIComponent(JSON.stringify(localOnly))}`);
  await expect(page.getByText('123456789abc')).toBeVisible();
  await expect(page.getByText('✓')).toHaveCount(0);
  await page.getByRole('button', { name: 'Image status details for orchestrator' }).hover();
  await expect(page.getByRole('tooltip')).toContainText('Remote check status is unknown');
});

test('native readiness errors with a completed registry check do not imply current status or a registry outage', async ({ page }) => {
  const data = status({ localDigest: 'sha256:123456789abc', remoteDigest: 'sha256:123456789abc', remoteCheckStatus: 'checked', error: 'native diagnostic is private' });
  await page.goto(`${url}?status=${encodeURIComponent(JSON.stringify(data))}`);
  await expect(page.getByText('✓')).toHaveCount(0);
  await expect(page.getByText('update status unavailable')).toBeVisible();
  await page.getByRole('button', { name: 'Image status details for orchestrator' }).focus();
  await expect(page.getByRole('tooltip')).toContainText('Image update status could not be completed.');
  await expect(page.getByRole('tooltip')).not.toContainText('registry could not be checked');
  await expect(page.getByText('native diagnostic is private')).toHaveCount(0);
});
