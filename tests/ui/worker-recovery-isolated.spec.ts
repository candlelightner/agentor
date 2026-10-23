import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

test('actual recovery panel warns before unknown-state intent changes and saves a finite retry limit', async ({ page }) => {
  const source = await readFile(new URL('../../orchestrator/app/components/WorkerRecoveryPanel.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'isolated-worker-recovery', inlineTemplate: true, genDefaultAs: 'RecoveryPanel' });
  const prelude = `import { createApp, ref, onMounted, h } from 'vue';
const refreshNuxtData = async () => {};
async function $fetch(url, options) { const response = await fetch(url, { method: options?.method || 'GET', body: options?.body ? JSON.stringify(options.body) : undefined }); const data = await response.json(); if (!response.ok) throw Object.assign(Error('Fixture API failed'), { statusCode: response.status, data }); return data; }
`;
  const suffix = `
const app = createApp({ render: () => h(RecoveryPanel, { workerId: 'fixture-worker' }) });
app.component('UButton', { props: ['disabled'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled }, slots.default?.()); } });
app.component('UFormField', { props: ['label', 'description'], setup(props, { slots }) { return () => h('label', [props.label, slots.default?.(), h('small', props.description)]); } });
app.component('UInput', { props: ['modelValue', 'type', 'disabled'], emits: ['update:modelValue'], setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue, type: props.type, disabled: props.disabled, onInput: event => emit('update:modelValue', props.type === 'number' ? Number(event.target.value) : event.target.value) }); } });
app.component('UCheckbox', { props: ['modelValue', 'label', 'disabled'], emits: ['update:modelValue'], setup(props, { emit }) { return () => h('label', [h('input', { type: 'checkbox', checked: props.modelValue, disabled: props.disabled, onChange: event => emit('update:modelValue', event.target.checked) }), props.label]); } });
app.mount('#app');`;
  const bundle = await build({ stdin: { contents: prelude + script.content + suffix,
    resolveDir: new URL('../../orchestrator/app/components', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  const mutations: any[] = [], errors: string[] = [];
  let state = { maxRetries: 3, attempts: 3, paused: true, desiredRuntimeStatus: 'running' };
  page.on('pageerror', error => errors.push(error.message));
  const server = createServer((request, response) => {
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); return; }
    if (request.url?.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET') { response.end(JSON.stringify(state)); return; }
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        const input = JSON.parse(body); mutations.push(input);
        if (input.desiredRuntimeStatus) state.desiredRuntimeStatus = input.desiredRuntimeStatus;
        else state = { ...state, maxRetries: input.maxRetries, paused: state.attempts >= input.maxRetries };
        response.end(JSON.stringify(input.desiredRuntimeStatus ? { desiredRuntimeStatus: input.desiredRuntimeStatus, status: 'unknown' } : state));
      }); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<div id="app"></div><script src="/component.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(page.getByText('Automatic recovery paused.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Request stopped', exact: true })).toBeDisabled();
    await expect(page.getByText('Current runtime state may be unknown.', { exact: false })).toBeVisible();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Request stopped', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Requested stopped; runtime confirmation is pending.' })).toBeVisible();
    expect(mutations[0]).toMatchObject({ desiredRuntimeStatus: 'stopped', confirmed: true });
    await page.getByRole('spinbutton').fill('0');
    await page.getByRole('button', { name: 'Save limit' }).click();
    await expect(page.getByText('Retry limit saved; attempt count retained.')).toBeVisible();
    expect(mutations[1]).toMatchObject({ maxRetries: 0 });
    expect(state.attempts).toBe(3); expect(errors).toEqual([]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
