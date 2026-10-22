import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createApp, defineEventHandler, toNodeListener } from '../../orchestrator/node_modules/h3/dist/index.mjs';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

test.describe.serial('Configured worker RAM in the actual detail modal', () => {
  let server: ReturnType<typeof createServer>, baseURL: string;

  test.beforeAll(async () => {
    const source = await readFile(new URL('../../orchestrator/app/components/ContainerDetailModal.vue', import.meta.url), 'utf8');
    const { descriptor } = parse(source);
    const script = compileScript(descriptor, { id: 'isolated-worker-ram', inlineTemplate: true, genDefaultAs: 'ContainerDetailModal' });
    const prelude = `
      import { createApp, ref, reactive, computed, toRef, watch, onMounted, h } from 'vue';
      const scenario = new URLSearchParams(location.search).get('case') || 'assigned';
      function useFetch(url) {
        const data = ref(null);
        fetch(url + '?case=' + scenario).then(r => r.ok ? r.json() : Promise.reject()).then(v => data.value = v).catch(() => {});
        return { data };
      }
      function useEnvironments() {
        const environments = ref([]);
        fetch('/api/environments?case=' + scenario).then(r => r.json()).then(v => environments.value = v);
        const defaultEnvironmentId = computed(() => environments.value.find(e => e.builtIn && e.name === 'default')?.id || environments.value[0]?.id || '');
        return { environments, defaultEnvironmentId };
      }
      function useGitProviders() { return { gitProviders: ref([]) }; }
      function useInitScripts() { return { initScripts: ref([]) }; }
      function useHostMounts() { return { effectivePaths: ref([]), refresh: async () => {} }; }
      function useHardwareDevices() { return { effectiveDevices: ref([]), refresh: async () => {} }; }
      function useInitScriptSync() { return { selectedPreset: ref(''), presetOptions: ref([]) }; }
      function shortName(id) { return id; }
      window.$fetch = async url => { const response = await fetch(url); if (!response.ok) throw new Error('request failed'); return response.json(); };
    `;
    const suffix = `
      const container = {
        id: 'worker-id', containerId: 'container-id', containerName: 'worker', displayName: 'RAM fixture',
        imageName: 'worker:latest', imageId: 'sha256:image', status: 'stopped', createdAt: '2026-01-01T00:00:00Z',
        runtimeKind: scenario === 'docker' ? 'legacy-docker' : 'incus-vm',
        ...(scenario === 'assigned' || scenario === 'pending' ? { environmentId: 'custom' } : {}),
        ...(scenario === 'pending' ? { pendingRebuild: true } : {}),
      };
      const app = createApp({ setup() {
        const open = ref(false);
        onMounted(() => { open.value = true; });
        return () => h(ContainerDetailModal, { container, statusColor: 'success', open: open.value, 'onUpdate:open': value => open.value = value });
      }});
      for (const [name, component] of Object.entries({
        UModal: { props: ['open'], setup(props, { slots }) { return () => props.open ? h('div', { role: 'dialog' }, slots.content?.()) : null; } },
        UBadge: { setup(_, { slots }) { return () => h('span', slots.default?.()); } },
        UButton: { props: ['disabled'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled }, slots.default?.()); } },
        UInput: { props: ['modelValue', 'placeholder', 'type'], emits: ['update:modelValue'], setup(props, { emit, attrs }) { return () => h('input', { ...attrs, value: props.modelValue, placeholder: props.placeholder, type: props.type || 'text', onInput: e => emit('update:modelValue', e.target.value) }); } },
        USelect: { props: ['modelValue', 'items'], emits: ['update:modelValue'], setup(props, { emit, attrs }) { return () => h('select', { ...attrs, value: props.modelValue, onChange: e => emit('update:modelValue', e.target.value) }, (props.items || []).map(item => h('option', { value: item.value }, item.label))); } },
        UTextarea: { props: ['modelValue'], emits: ['update:modelValue'], setup(props, { emit, attrs }) { return () => h('textarea', { ...attrs, value: props.modelValue, onInput: e => emit('update:modelValue', e.target.value) }); } },
        UIcon: { render() { return null; } },
      })) app.component(name, component);
      app.mount('#app');
    `;
    const bundle = await build({
      stdin: { contents: prelude + script.content + suffix, resolveDir: new URL('../../orchestrator/app/components', import.meta.url).pathname, loader: 'ts' },
      bundle: true, write: false, format: 'iife',
      define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' },
    });

    const app = createApp();
    app.use('/api/environments', defineEventHandler(event => {
      const scenario = new URL(event.node.req.url || '/', 'http://localhost').searchParams.get('case');
      return [
        { id: 'default', name: 'default', builtIn: true, memoryLimit: scenario === 'docker' ? '0g' : '' },
        { id: 'custom', name: 'custom', builtIn: false, memoryLimit: '2GiB' },
      ];
    }));
    app.use('/api/worker-memory-policy', defineEventHandler(event => {
      const scenario = new URL(event.node.req.url || '/', 'http://localhost').searchParams.get('case');
      if (scenario === 'unavailable') { event.node.res.statusCode = 503; return {}; }
      return { defaultMemoryLimit: '', incusDefaultMemoryLimit: scenario === 'default' ? '6GiB' : '4GiB' };
    }));
    app.use('/api', defineEventHandler(() => []));
    app.use('/component.js', defineEventHandler(event => { event.node.res.setHeader('Content-Type', 'application/javascript'); return bundle.outputFiles[0].text; }));
    app.use('/', defineEventHandler(event => { event.node.res.setHeader('Content-Type', 'text/html'); return '<!doctype html><div id="app"></div><script src="/component.js"></script>'; }));
    server = createServer(toNodeListener(app));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  test.afterAll(async () => { await new Promise<void>(resolve => server?.close(() => resolve())); });

  test('uses the worker saved environment and shows a pending rebuild separately', async ({ page }) => {
    await page.goto(`${baseURL}/?case=pending`);
    const dialog = page.getByRole('dialog');
    const ram = dialog.getByTestId('worker-configured-ram');
    await expect(ram).toContainText('Configured RAM');
    await expect(ram).toContainText('2GiB');
    await expect(ram).toContainText('Saved environment setting; RAM changes apply on create or rebuild.');
    await expect(dialog).toContainText('Settings changes are saved but not yet applied.');
    await expect(ram.locator('input')).toHaveCount(0);
    const environment = dialog.locator('select').nth(1);
    await expect(environment).toHaveValue('custom');
    await environment.selectOption('default');
    await expect(ram).toContainText('2GiB');
  });

  test('uses the default environment and VM default when the worker has no environment id', async ({ page }) => {
    await page.goto(`${baseURL}/?case=default`);
    await expect(page.getByTestId('worker-configured-ram')).toContainText('6GiB');
  });

  test('reports Docker uncapped memory and unavailable policy honestly', async ({ page }) => {
    await page.goto(`${baseURL}/?case=docker`);
    await expect(page.getByTestId('worker-configured-ram')).toContainText('Uncapped');
    await page.goto(`${baseURL}/?case=unavailable`);
    await expect(page.getByTestId('worker-configured-ram')).toContainText('Unavailable');
  });
});
