import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc'), { build } = require('esbuild');

test('actual portable backup modal retains the daily admin ID using account-scoped options', async ({ page }) => {
  const source = await readFile(new URL('../../orchestrator/app/components/BackupManagementModal.vue', import.meta.url), 'utf8');
  const composable = await readFile(new URL('../../orchestrator/app/composables/useBackups.ts', import.meta.url), 'utf8');
  const script = compileScript(parse(source).descriptor, { id: 'isolated-admin-portable', inlineTemplate: true, genDefaultAs: 'BackupModal' });
  const prelude = `import { formatBytes } from './app/utils/format';
import { createApp, ref, reactive, computed, watch, onBeforeUnmount, h, nextTick } from 'vue';
function useAuth() { return { isAdmin: ref(true) }; }
async function $fetch(url, options) { const response = await fetch(url, { method: options?.method || 'GET', body: options?.body ? JSON.stringify(options.body) : undefined }); if (!response.ok) throw Error('Fixture API failed'); return response.json(); }
`;
  const suffix = `
const shown = ref(false), app = createApp({ setup() { return () => h(BackupModal, { open: shown.value }); } });
app.component('UModal', { setup(_props, { slots }) { return () => h('main', slots.content?.()); } });
app.component('UButton', { props: ['disabled','loading'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()); } });
app.component('UInputMenu', { props: ['items','modelValue'], setup(props, { attrs }) { return () => h('select', { ...attrs, multiple: true }, props.items.map(item => h('option', { value: item.id, selected: props.modelValue.includes(item.id) }, item.label))); } });
app.component('UCheckbox', { props: ['label','modelValue'], setup(props) { return () => h('label', [h('input', { type: 'checkbox', checked: props.modelValue }), props.label]); } });
app.component('UIcon', { render() { return null; } });
app.mount('#app'); nextTick(() => { shown.value = true; });`;
  const bundle = await build({ stdin: { contents: prelude + composable + '\n' + script.content + suffix,
    resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  const adminId = '8b5c936e-a859-4039-873a-6f7af0960b61';
  let settings: any = { providerId: 'google-drive', enabled: true, selection: 'selected', workspaceIds: [adminId, 'gpu'],
    selectedPathsByWorkspace: { gpu: ['/opt/project'] }, persistSelectedDirectories: true, includeManagedVolumes: false,
    intervalMinutes: 1440, retentionCount: 7, nextRunAt: null };
  const requests: string[] = [], errors: string[] = []; let saved = false;
  page.on('pageerror', error => errors.push(error.message));
  const server = createServer(async (request, response) => {
    requests.push(request.method+' '+request.url);
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); return; }
    if (request.url?.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/backup-settings') {
        if (request.method === 'PUT') { const chunks = []; for await (const chunk of request) chunks.push(chunk); settings = JSON.parse(Buffer.concat(chunks).toString()); saved = true; }
        response.end(JSON.stringify(settings));
      } else if (request.url === '/api/backups/workspaces') response.end(JSON.stringify([
        { id: adminId, administrativeKind: 'platform', displayName: 'ADMIN / ORCHESTRATOR', status: 'stopped' },
        { id: 'gpu', displayName: 'GPU', status: 'running' },
      ]));
      else if (request.url === '/api/backups') response.end(JSON.stringify({ backups: [], jobs: [] }));
      else if (request.url === '/api/backup-providers') response.end(JSON.stringify([{ id: 'google-drive', type: 'google-drive', connected: true }]));
      else if (request.url === '/api/backups/recovery-key') response.end(JSON.stringify({ keys: [] }));
      else if (request.url === '/api/admin/backup-providers/google-oauth') response.end(JSON.stringify({ configured: false }));
      else if (request.url === '/api/backups/remote') response.end('[]');
      else { response.statusCode = 404; response.end('{}'); }
      return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
    const modal = page.getByTestId('backup-management');
    await expect(modal.getByLabel('Provider')).toBeEnabled();
    await expect(modal.getByTestId('backup-path-settings')).toContainText('ADMIN / ORCHESTRATOR');
    const option = modal.getByRole('option', { name: /ADMIN \/ ORCHESTRATOR.*Global admin.*stopped/ });
    await expect(option).toHaveAttribute('value', adminId);
    await modal.getByRole('button', { name: 'Save schedule' }).click(); await expect.poll(() => saved).toBe(true);
    expect(settings.workspaceIds).toEqual([adminId, 'gpu']); expect(settings.selectedPathsByWorkspace[adminId]).toBeUndefined();
    expect(settings).toMatchObject({ providerId: 'google-drive', enabled: true, intervalMinutes: 1440 });
    expect(requests).toContain('GET /api/backups/workspaces'); expect(requests).not.toContain('GET /api/containers'); expect(errors).toEqual([]);
  } finally { await page.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
