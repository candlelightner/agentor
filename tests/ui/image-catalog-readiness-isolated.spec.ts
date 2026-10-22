import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');
let server: ReturnType<typeof createServer>, url: string;

test.beforeAll(async () => {
  const bundle = await build({ stdin: { contents: `
import { createApp, ref, reactive, computed, watch, onBeforeUnmount, h, nextTick } from 'vue';
import { useImageCatalog } from './app/composables/useImageCatalog';
import ImageCatalogModal from './app/components/ImageCatalogModal.vue';
import { $fetch } from 'ofetch';
window.$fetch = (url, options = {}) => $fetch(url, { ...options, retry: 0 });
function useWorkerGroups() { return { groups: ref([]) }; }
const shown = ref(false);
window.showImageCatalog = value => { shown.value = value; };
const app = createApp({ setup() { return () => h(ImageCatalogModal, { open: shown.value, 'onUpdate:open': value => { shown.value = value; } }); } });
app.component('UModal', { props: ['open'], setup(props, { slots }) { return () => props.open ? h('main', slots.content?.()) : null; } });
app.component('UButton', { props: ['disabled','loading'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()); } });
app.component('UTooltip', { setup(_props, { slots }) { return () => h('span', slots.default?.()); } });
app.mount('#app'); nextTick(() => { shown.value = true; });`,
    resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' },
    bundle: true, write: false, format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    plugins: [{ name: 'nuxt-autoimports', setup(builder: any) {
      builder.onLoad({ filter: /ImageCatalogModal\.vue$/ }, async (args: any) => {
        const { descriptor } = parse(await readFile(args.path, 'utf8'));
        return { contents: `import { ref, reactive, computed, watch, onBeforeUnmount } from 'vue';\nimport { useImageCatalog } from '../composables/useImageCatalog';\nimport { formatBytes } from '../utils/format';\nconst useWorkerGroups = () => ({ groups: ref([]) });\n` + compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts' };
      });
      builder.onLoad({ filter: /useImageCatalog\.ts$/ }, async (args: any) => ({
        contents: `import { ref } from 'vue';\nconst $fetch = (...args) => window.$fetch(...args);\n` + await readFile(args.path, 'utf8'), loader: 'ts',
      }));
    } }],
  });
  server = createServer((request, response) => {
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); return; }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

async function mockCatalog(page: any) {
  await page.route('**/api/plugins/definitions', route => route.fulfill({ json: [] }));
  await page.route('**/api/image-catalog/definitions', route => route.fulfill({ json: [] }));
  await page.route('**/api/image-catalog/usage', route => route.fulfill({ json: { totalBytes: 0, partialBuildBytes: 0, definitions: [] } }));
  await page.route('**/api/image-catalog/defaults/effective', route => route.fulfill({ json: { source: 'platform', version: null } }));
  await page.route('**/api/image-catalog/git/connection', route => route.fulfill({ json: { connected: false } }));
  await page.route('**/api/image-catalog/git/recovery', route => route.fulfill({ json: null }));
  await page.route('**/api/image-builds', route => route.fulfill({ json: [] }));
}

test('admin can load and save a bounded readiness timeout; failed saves preserve the draft', async ({ page }) => {
  await mockCatalog(page);
  const writes: number[] = [];
  await page.route('**/api/image-builder/settings', async route => {
    if (route.request().method() === 'PUT') {
      const seconds = route.request().postDataJSON().agentReadyTimeoutSeconds;
      writes.push(seconds);
      if (seconds === 600) return route.fulfill({ status: 500, json: { statusMessage: 'Settings write failed.' } });
      return route.fulfill({ json: { agentReadyTimeoutSeconds: seconds } });
    }
    return route.fulfill({ json: { agentReadyTimeoutSeconds: 120 } });
  });
  await page.goto(url);
  const settings = page.getByTestId('converter-readiness-settings');
  const input = settings.getByLabel('Agent readiness timeout in seconds');
  await expect(input).toHaveValue('120');
  const save = settings.getByRole('button', { name: 'Save timeout' });
  await expect(save).toBeDisabled();
  await input.fill('3601');
  await expect(save).toBeDisabled();
  await input.fill('300');
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => writes).toEqual([300]);
  await expect(input).toHaveValue('300');
  await expect(settings.getByRole('status')).toContainText('Readiness timeout saved.');
  await input.fill('600');
  await save.click();
  await expect(settings.getByRole('alert')).toContainText('Settings write failed.');
  await expect(input).toHaveValue('600');
  expect(writes).toEqual([300, 600]);
});

test('failed settings load shows no default and can be retried', async ({ page }) => {
  await mockCatalog(page);
  let reads = 0;
  await page.route('**/api/image-builder/settings', route => {
    if (++reads === 1) return route.fulfill({ status: 503, json: { statusMessage: 'Settings unavailable.' } });
    return route.fulfill({ json: { agentReadyTimeoutSeconds: 240 } });
  });
  await page.goto(url);
  const settings = page.getByTestId('converter-readiness-settings');
  const input = settings.getByLabel('Agent readiness timeout in seconds');
  await expect.poll(() => reads).toBe(1);
  await expect(settings).toContainText('Settings unavailable.');
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue('');
  await settings.getByRole('button', { name: 'Retry load' }).click();
  await expect(input).toHaveValue('240');
  await expect(settings.getByRole('alert')).toHaveCount(0);
});

const nativeBuild = (startedAt: string) => ({ id: 'native-build', definitionId: 'controlled-definition', status: 'running',
  phase: 'waiting-for-agent', startedAt, nativeActivity: { progressMode: 'indeterminate', phase: 'waiting-for-agent', phaseStartedAt: startedAt } });

async function mockNativeBuild(page: any, current: () => any) {
  await mockCatalog(page);
  await page.route('**/api/image-builder/settings', route => route.fulfill({ json: { agentReadyTimeoutSeconds: 120 } }));
  await page.route('**/api/image-builds', route => route.fulfill({ json: [current()] }));
  await page.route('**/api/image-builds/native-build', route => route.fulfill({ json: current() }));
  await page.route('**/api/image-builds/native-build/logs?**', route => route.fulfill({ json: {
    text: '[native converter] Controller still waiting; no measured converter progress is available.', nextCursor: 1,
  } }));
}

test('actual catalog shows trusted stages and waiting separately, refreshes logs, and recovers the same job after reopen', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T12:02:00.000Z') });
  let build: any = nativeBuild('2026-10-22T12:00:00.000Z');
  await mockNativeBuild(page, () => build);
  await page.goto(url);
  const job = page.getByTestId('image-build'), activity = job.getByTestId('native-image-activity');
  await expect(job).toHaveCount(1);
  await expect(activity).toContainText('Elapsed: 2m 0s');
  await expect(activity).toContainText('Current stage: Waiting for converter agent');
  const progress = job.getByRole('progressbar', { name: 'Native image preparation in progress' });
  await expect(progress).toHaveCount(1);
  expect(await progress.getAttribute('value')).toBeNull();
  await expect(activity).toContainText('Progress is indeterminate');
  await expect(activity).not.toContainText('%');
  await page.clock.fastForward(3000);
  await expect(activity).toContainText('Elapsed: 2m 3s');
  build = { ...build, phase: 'converting-disk', nativeActivity: { progressMode: 'indeterminate', phase: 'converting-disk',
    phaseStartedAt: '2026-10-22T12:02:03.000Z', waitingAt: '2026-10-22T12:02:18.000Z' } };
  await page.clock.fastForward(16_000);
  await expect(activity).toContainText('Current stage: Converting worker disk');
  await expect(activity).toContainText('Controller still waiting as of');
  await expect(activity).toContainText('not that conversion advanced');
  await job.getByRole('button', { name: 'Show logs for native-build' }).click();
  await expect(job.locator('pre')).toContainText('no measured converter progress');
  await page.evaluate(() => (window as any).showImageCatalog(false));
  await expect(job).toHaveCount(0);
  build = { ...build, phase: 'importing-vm', nativeActivity: { progressMode: 'indeterminate', phase: 'importing-vm',
    phaseStartedAt: '2026-10-22T12:02:19.000Z' } };
  await page.clock.fastForward(5000);
  await page.evaluate(() => (window as any).showImageCatalog(true));
  await expect(job).toHaveCount(1);
  await expect(activity).toContainText('Current stage: Importing VM image');
  await expect(activity).not.toContainText('Controller still waiting');
  await expect(page.getByTestId('image-build-status-native-build')).toContainText('Importing VM image');
});

test('image success freezes elapsed and does not claim worker readiness; restart failure keeps last stage without a running bar', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-22T12:20:00.000Z') });
  let build: any = { ...nativeBuild('2026-10-22T12:00:00.000Z'), status: 'succeeded', phase: 'complete',
    completedAt: '2026-10-22T12:03:10.000Z', nativeActivity: { progressMode: 'indeterminate', phase: 'publishing-image',
      phaseStartedAt: '2026-10-22T12:03:00.000Z' } };
  await mockNativeBuild(page, () => build);
  await page.goto(url);
  const job = page.getByTestId('image-build'), activity = job.getByTestId('native-image-activity');
  await expect(activity).toContainText('Elapsed: 3m 10s');
  await expect(activity).toContainText('Image prepared. Worker startup is a separate operation.');
  await expect(page.getByTestId('image-build-status-native-build')).toContainText('Image prepared');
  await expect(job.getByRole('progressbar')).toHaveCount(0);
  await page.clock.fastForward(60_000);
  await expect(activity).toContainText('Elapsed: 3m 10s');
  await page.evaluate(() => (window as any).showImageCatalog(false));
  build = { ...build, status: 'failed', phase: 'failed', recovery: 'restart-failed-safe',
    error: 'Native derivation interrupted; acknowledged converter/import authority is retained.',
    nativeActivity: { progressMode: 'indeterminate', phase: 'converting-disk', phaseStartedAt: '2026-10-22T12:01:00.000Z' } };
  await page.evaluate(() => (window as any).showImageCatalog(true));
  await expect(activity).toContainText('Last observed stage: Converting worker disk');
  await expect(activity).toContainText('Interrupted by server restart; refresh status and review logs before recovery.');
  await expect(activity).toContainText('Elapsed: 3m 10s');
  await expect(job.getByRole('progressbar')).toHaveCount(0);
  await expect(activity).not.toContainText('%');
});
