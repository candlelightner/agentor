import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createApp, defineEventHandler, getCookie, toNodeListener } from '../../orchestrator/node_modules/h3/dist/index.mjs';
import memoryPolicy from '../../orchestrator/server/api/worker-memory-policy.get';
import { useConfig } from '../../orchestrator/server/utils/services';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

// Actual editor and policy endpoint; only Nuxt form styling and the unrelated
// reference lists/session middleware are supplied by the isolated fixture.
test.describe.serial('Environment VM memory policy in the actual editor', () => {
  let server: ReturnType<typeof createServer>, baseURL: string;
  test.beforeAll(async () => {
    const source = await readFile(new URL('../../orchestrator/app/components/EnvironmentEditor.vue', import.meta.url), 'utf8');
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: 'isolated-environment-memory', inlineTemplate: true, genDefaultAs: 'EnvironmentEditor' });
    const prelude = `import { createApp, ref, reactive, computed, watch, onMounted, h } from 'vue';
function useFetch(url, options) { const data = ref(options?.default?.()); fetch(url).then(r => r.ok ? r.json() : null).then(value => { if (value !== null) data.value = value; }); return { data }; }
window.$fetch = async url => (await fetch(url)).json();
`;
    const suffix = `
const app = createApp(EnvironmentEditor);
app.component('UFormField', { props: ['label','hint'], setup(props, { slots }) { return () => h('div', { 'data-field': props.label }, [h('label', props.label), h('span', props.hint), slots.default?.()]); } });
app.component('UInput', { props: ['modelValue','type','disabled','placeholder'], emits: ['update:modelValue'], setup(props, { emit }) { return () => h('input', { value: props.modelValue, type: props.type || 'text', disabled: props.disabled, placeholder: props.placeholder, onInput: e => emit('update:modelValue', e.target.value) }); } });
for (const name of ['UCheckbox','UIcon','UTextarea','UButton']) app.component(name, { setup(props, { slots }) { return () => h('span', slots.default?.()); } });
app.mount('#app');`;
    const bundle = await build({ stdin: { contents: prelude + script.content + suffix, resolveDir: new URL('../../orchestrator/app/components', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
    const app = createApp();
    app.use(defineEventHandler(event => { if (getCookie(event, 'isolated-session')) event.context.auth = { user: { id: 'ordinary', role: 'user' }, session: {} }; }));
    app.use('/api/worker-memory-policy', memoryPolicy);
    app.use('/api', defineEventHandler(() => []));
    app.use('/component.js', defineEventHandler(event => { event.node.res.setHeader('Content-Type', 'application/javascript'); return bundle.outputFiles[0].text; }));
    app.use('/', defineEventHandler(event => { event.node.res.setHeader('Content-Type', 'text/html'); return '<!doctype html><div id="app"></div><script src="/component.js"></script>'; }));
    server = createServer(toNodeListener(app));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  test.afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); });
  test.beforeEach(async ({ context, page }) => {
    useConfig().defaultMemoryLimit = '';
    useConfig().incusDefaultMemoryLimit = '4GiB';
    await context.addCookies([{ name: 'isolated-session', value: 'ordinary', url: baseURL }]);
    await page.goto(baseURL);
  });

  test('unset and zero caps show finite VM memory rather than unlimited, with explicit caps preserved', async ({ page }) => {
    const output = page.getByTestId('effective-vm-memory');
    await expect(output).toHaveText('VM memory on next create or rebuild: 4GiB.');
    const input = page.locator('[data-field="Memory"] input');
    await input.fill('0g');
    await expect(output).toHaveText('VM memory on next create or rebuild: 4GiB.');
    await input.fill('512m');
    await expect(output).toHaveText('VM memory on next create or rebuild: 512 MiB.');
    await input.fill('2GiB');
    await expect(output).toHaveText('VM memory on next create or rebuild: 2GiB.');
    await input.fill('unlimited');
    await expect(output).toHaveText('Enter a valid memory size for VM workers (e.g. 4g or 512MiB).');
  });
  test('shared positive defaults and operator VM defaults display the exact same precedence as allocation', async ({ page }) => {
    useConfig().defaultMemoryLimit = '2g';
    useConfig().incusDefaultMemoryLimit = '6GiB';
    await page.reload();
    const output = page.getByTestId('effective-vm-memory');
    await expect(output).toHaveText('VM memory on next create or rebuild: 2.0 GiB.');
    await page.locator('[data-field="Memory"] input').fill('0g');
    await expect(output).toHaveText('VM memory on next create or rebuild: 6GiB.');
  });
  test('missing policy gives an unavailable state instead of guessing a configured default', async ({ page }) => {
    await page.route('**/api/worker-memory-policy', route => route.fulfill({ status: 503, body: '{}' }));
    await page.reload();
    await expect(page.getByTestId('effective-vm-memory')).toHaveText('VM memory policy is unavailable.');
  });
});
