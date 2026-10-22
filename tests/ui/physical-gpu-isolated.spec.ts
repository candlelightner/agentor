import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');
let server: ReturnType<typeof createServer>, url: string;
test.beforeAll(async () => {
  const bundle = await build({ stdin: { resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts', contents: `
import { createApp, ref, h } from 'vue';
import { $fetch } from 'ofetch';
import PhysicalGpuAssignments from './app/components/PhysicalGpuAssignments.vue';
import HardwareDeviceInput from './app/components/HardwareDeviceInput.vue';
window.$fetch = $fetch;
window.useAuth = () => ({ isAdmin: ref(!location.search.includes('owner')) });
const app = createApp({ render() { return h('main', [h(PhysicalGpuAssignments),
  h(HardwareDeviceInput, { modelValue:'intel', devices:[{id:'intel',kind:'gpu',name:'Intel mediated',selector:'drm:pci:0000:00:02.0'}], onRemove:() => { window.intelRemoved=true; } })]); } });
app.component('USelect', { props:['modelValue','items','disabled'], emits:['update:modelValue'], setup(p,{emit,attrs}) { return () => h('select',{...attrs,value:p.modelValue,disabled:p.disabled,onChange:e=>emit('update:modelValue',e.target.value)},p.items.map(i=>h('option',{value:i.value,disabled:i.disabled},i.label))); } });
app.component('UButton', {props:['disabled','loading'],setup(p,{slots,attrs}){return()=>h('button',{...attrs,disabled:p.disabled||p.loading},slots.default?.());}});
app.component('UBadge',{setup(p,{slots}){return()=>h('span',slots.default?.());}});
app.mount('#app');` }, bundle: true, write: false, format: 'iife', define: {
    'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  }, plugins: [{ name: 'vue-autoimports', setup(builder: any) {
    builder.onLoad({ filter: /\.vue$/ }, async (args: any) => {
      const { descriptor } = parse(await readFile(args.path, 'utf8'));
      return { contents: "import { ref, reactive, computed, onMounted, onUnmounted } from 'vue';\n" + compileScript(descriptor, { id: args.path, inlineTemplate: true }).content, loader: 'ts' };
    });
  } }] });
  server = createServer((request, response) => {
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); }
    else { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
const initial = () => ({ devices: [{ id: 'nvidia', name: 'NVIDIA fixture', available: true, reason: 'Physical passthrough', status: 'unassigned', pendingRebuild: false }],
  workers: [{ id: 'a', displayName: 'Worker A', status: 'stopped', pendingRebuild: false }, { id: 'b', displayName: 'Worker B', status: 'running', pendingRebuild: false }] });
test('admin assigns and releases a stopped VM; Intel control retains its ordinary behavior', async ({ page }) => {
  const view: any = initial(), writes: any[] = [];
  await page.route('**/api/hardware-devices/gpu', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body);
      view.devices[0].workerId = body.workerId ?? undefined;
      view.devices[0].status = body.workerId ? 'stopped' : 'unassigned';
      await route.fulfill({ json: { stopped: true } });
    } else await route.fulfill({ json: view });
  });
  await page.goto(url);
  const picker = page.getByLabel('Assigned VM for NVIDIA fixture');
  await expect(picker.locator('option[value="b"]')).toBeDisabled();
  await picker.selectOption('a'); await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('stopped', { exact: true })).toBeVisible();
  await picker.selectOption('none'); await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect.poll(() => writes).toEqual([{ deviceId: 'nvidia', workerId: 'a' }, { deviceId: 'nvidia', workerId: null }]);
  await expect(page.getByLabel('Assigned hardware device')).toBeEnabled();
  await page.getByLabel('Remove hardware device').click();
  expect(await page.evaluate(() => (window as any).intelRemoved)).toBe(true);
});
test('owners have no physical assignment UI or administrative requests', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/hardware-devices/gpu', route => { requests++; return route.fulfill({ json: initial() }); });
  await page.goto(url + '?owner');
  await expect(page.getByTestId('physical-gpu-assignments')).toHaveCount(0);
  await expect(page.getByLabel('Assigned hardware device')).toBeEnabled();
  expect(requests).toBe(0);
});
test('running assignments cannot be released by the control', async ({ page }) => {
  let writes = 0;
  const view: any = initial(); view.devices[0].workerId = 'b'; view.devices[0].status = 'running';
  await page.route('**/api/hardware-devices/gpu', route => {
    if (route.request().method() === 'PUT') writes++;
    return route.fulfill({ json: view });
  });
  await page.goto(url);
  await page.getByLabel('Assigned VM for NVIDIA fixture').selectOption('none');
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Stop the selected VM');
  expect(writes).toBe(0);
});

test('vGPU controls show framebuffer, capacity and active VM, and assign/change/release an explicit stopped allocation', async ({ page }) => {
  const view: any = initial(), writes: any[] = [];
  Object.assign(view.devices[0], { mode: 'gpu-mdev', physicalSupported: false, physicalReason: 'Host driver owns device',
    profiles: [{ id: 'vendor-small', name: 'Small vGPU', framebufferMiB: 1024, available: 2, total: 2, active: 0, reserved: 0, compatible: true },
      { id: 'vendor-large', name: 'Large vGPU', framebufferMiB: 2048, available: 1, total: 1, active: 0, reserved: 0, compatible: true }], allocations: [] });
  await page.route('**/api/hardware-devices/gpu', async route => {
    if (route.request().method() === 'PUT') {
      const body = route.request().postDataJSON(); writes.push(body);
      view.devices[0].allocations = body.workerId ? [{ workerId: body.workerId, displayName: 'Worker A', profile: body.profile, status: 'stopped' }] : [];
      await route.fulfill({ json: { stopped: true } });
    } else await route.fulfill({ json: view });
  });
  await page.goto(url); await expect(page.getByText('1024 MiB')).toBeVisible(); await expect(page.getByText('2 / 2', { exact: true })).toBeVisible();
  const vm = page.getByLabel('Assigned VM for NVIDIA fixture'), profile = page.getByLabel('GPU profile for NVIDIA fixture');
  await expect(profile.locator('option[value="physical"]')).toBeDisabled();
  await vm.selectOption('a'); await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('Worker A · vendor-small · stopped')).toBeVisible();
  await profile.selectOption('vendor-large'); await page.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(page.getByText('Worker A · vendor-large · stopped')).toBeVisible();
  await page.getByRole('button', { name: 'Release Worker A', exact: true }).click();
  await expect.poll(() => writes).toEqual([{ deviceId: 'nvidia', workerId: 'a', profile: 'vendor-small' },
    { deviceId: 'nvidia', workerId: 'a', profile: 'vendor-large' }, { deviceId: 'nvidia', workerId: null, releaseWorkerId: 'a' }]);
});
