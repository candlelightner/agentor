import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');
let server: ReturnType<typeof createServer>, url: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
import { createApp, ref, h, nextTick } from 'vue';
import { $fetch } from 'ofetch';
import { useAdminWorkspace } from './app/composables/useAdminWorkspace';
import AdminWorkspaceModal from './app/components/AdminWorkspaceModal.vue';
import AdminMemoryEditor from './app/components/AdminMemoryEditor.vue';
window.$fetch = $fetch; window.useAdminWorkspace = useAdminWorkspace;
const shown = ref(false); window.showAdmin = value => { shown.value = value; };
const app = createApp({ setup() { return () => h(AdminWorkspaceModal, { open: shown.value, 'onUpdate:open': value => { shown.value = value; } }); } });
app.component('UModal', { props: ['open'], setup(props, { slots }) { return () => props.open ? h('main', slots.content?.()) : null; } });
app.component('UButton', { props: ['disabled','loading'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()); } });
app.component('UInput', { props: ['modelValue'], emits: ['update:modelValue'], setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue, onInput: event => emit('update:modelValue', event.target.value) }); } });
app.component('AdminMemoryEditor', AdminMemoryEditor);
for (const name of ['AdminStartupScriptEditor','WorkspaceFilesModal']) app.component(name, { render() { return null; } });
app.mount('#app'); nextTick(() => { shown.value = true; });`, resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' }, plugins: [{ name: 'nuxt-autoimports', setup(builder: any) {
    builder.onLoad({ filter: /\.vue$/ }, async (args: any) => {
      const { descriptor } = parse(await readFile(args.path, 'utf8'));
      return { contents: "import { ref, computed, watch, onMounted } from 'vue';\n" + compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts' };
    });
    builder.onLoad({ filter: /useAdminWorkspace\.ts$/ }, async (args: any) => ({ contents: "import { ref } from 'vue';\n" + await readFile(args.path, 'utf8'), loader: 'ts' }));
  } }] });
  server = createServer((request, response) => {
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const workspace = { id: 'admin-fixture', kind: 'administrative', trusted: true, status: 'running', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), image: { name: 'fixture-image', digest: 'sha256:' + 'a'.repeat(64), promoted: true }, presentation: { environmentMarker: 'AGENTOR_ADMIN_WORKSPACE' }, services: [] };
test.beforeEach(async ({ page }) => {
  await page.route('**/api/admin/workspace', route => route.fulfill({ json: workspace }));
  await page.route('**/api/admin/workspace/resources', route => route.fulfill({ json: { memoryLimit: '4GiB', appliedMemoryLimit: '4GiB', pendingRebuild: false } }));
});
test('lost stop response blocks replay until status reconciliation, including modal reopen', async ({ page }) => {
  let stops = 0;
  await page.route('**/api/admin/workspace/stop', async route => { stops++; await route.abort('connectionreset'); });
  await page.goto(url);
  await page.getByRole('button', { name: 'Stop admin workspace', exact: true }).click();
  await page.getByLabel(/I understand/).check();
  await page.getByRole('button', { name: 'Confirm stop', exact: true }).click();
  await expect(page.getByTestId('admin-action-confirmation')).toHaveCount(0);
  await expect(page.getByText(/no confirmed outcome/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toBeDisabled();
  await page.route('**/api/admin/workspace', route => route.fulfill({ status: 503, json: { statusMessage: 'Operation is still pending. Refresh status before retrying.' } }));
  await page.getByRole('button', { name: 'Refresh status', exact: true }).click();
  await expect(page.getByText(/Operation is still pending/)).toBeVisible();
  expect(stops).toBe(1);
  await page.getByRole('button', { name: 'Close administrative workspace' }).click();
  await page.route('**/api/admin/workspace', route => route.fulfill({ json: { ...workspace, status: 'stopped' } }));
  await page.evaluate(() => (window as any).showAdmin(true));
  await expect(page.getByRole('button', { name: 'Start admin workspace', exact: true })).toBeEnabled();
  expect(stops).toBe(1);
});
test('stalled status times out and offers retry instead of endless loading', async ({ page }) => {
  await page.clock.install();
  await page.route('**/api/admin/workspace', () => {});
  await page.goto(url);
  await expect(page.getByText('Loading administrative workspace…')).toBeVisible();
  await page.clock.runFor(15_100);
  await expect(page.getByText('Loading administrative workspace…')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry status', exact: true })).toBeVisible();
  await page.route('**/api/admin/workspace', route => route.fulfill({ json: workspace }));
  await page.getByRole('button', { name: 'Retry status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toBeEnabled();
});
test('stalled lifecycle has a bounded unknown outcome without automatic replay', async ({ page }) => {
  let stops = 0;
  await page.clock.install();
  await page.route('**/api/admin/workspace/stop', () => { stops++; });
  await page.goto(url);
  await page.getByRole('button', { name: 'Stop admin workspace', exact: true }).click();
  await page.getByLabel(/I understand/).check();
  await page.getByRole('button', { name: 'Confirm stop', exact: true }).click();
  await expect.poll(() => stops).toBe(1);
  await page.clock.runFor(120_100);
  await expect(page.getByText(/no confirmed outcome/)).toBeVisible();
  await expect(page.getByTestId('admin-action-confirmation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toBeDisabled();
  expect(stops).toBe(1);
});
test('memory editor shows desired and applied limits without a lifecycle request', async ({ page }) => {
  const lifecycle: string[] = [];
  page.on('request', request => { if (request.method() === 'POST') lifecycle.push(request.url()); });
  let saved = '';
  await page.route('**/api/admin/workspace/resources', async route => {
    if (route.request().method() === 'PUT') saved = route.request().postDataJSON().memoryLimit;
    await route.fulfill({ json: { memoryLimit: saved || '4GiB', appliedMemoryLimit: '4GiB', pendingRebuild: Boolean(saved) } });
  });
  await page.goto(url);
  await page.getByLabel('Admin VM memory limit').fill('8GiB');
  await page.getByRole('button', { name: 'Save memory limit', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Rebuild required to apply 8GiB');
  await expect(page.getByTestId('admin-memory-editor')).toContainText('Applied: 4GiB');
  expect(saved).toBe('8GiB'); expect(lifecycle).toEqual([]);
});


test('a response from before reopening cannot overwrite a newer settled status', async ({ page }) => {
  let first: any, reads = 0;
  await page.route('**/api/admin/workspace', async route => {
    if (++reads === 1) first = route;
    else await route.fulfill({ json: { ...workspace, status: 'stopped' } });
  });
  await page.goto(url);
  await expect(page.getByText('Loading administrative workspace…')).toBeVisible();
  await page.getByRole('button', { name: 'Close administrative workspace' }).click();
  await page.evaluate(() => (window as any).showAdmin(true));
  await expect(page.getByRole('button', { name: 'Start admin workspace', exact: true })).toBeEnabled();
  const late = page.waitForResponse(response => response.url().endsWith('/api/admin/workspace'));
  await first.fulfill({ json: workspace });
  await late;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('button', { name: 'Start admin workspace', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toHaveCount(0);
});

test('a rejected authoritative status inspection clears the stale running display', async ({ page }) => {
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toBeVisible();
  await page.route('**/api/admin/workspace', route => route.fulfill({ status: 409, json: { statusMessage: 'Host policy rejected inspection' } }));
  await page.evaluate(() => (window as any).showAdmin(false));
  await page.evaluate(() => (window as any).showAdmin(true));
  await expect(page.getByText('Host policy rejected inspection')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop admin workspace', exact: true })).toHaveCount(0);
});
