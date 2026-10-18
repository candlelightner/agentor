import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = require('@vue/compiler-sfc');
const { build } = require('esbuild');

// Production modal and composable, only UI-kit styling and API data are faked.
// The complete authenticated API -> Incus restore remains a deployment gate.
test('actual instance recovery modal describes fresh stopped admin storage and refuses blocked apply', async ({ page }) => {
  const source = await readFile(new URL('../../orchestrator/app/components/InstanceBackupManagementModal.vue', import.meta.url), 'utf8');
  const composable = await readFile(new URL('../../orchestrator/app/composables/useInstanceBackups.ts', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'isolated-instance-recovery', inlineTemplate: true, genDefaultAs: 'InstanceRecovery' });
  const prelude = `import { formatBytes } from './app/utils/format';
import { createApp, ref, reactive, computed, watch, onBeforeUnmount, h, nextTick } from 'vue';
async function $fetch(url, options) { const response = await fetch(url, { method: options?.method || 'GET', body: options?.body ? JSON.stringify(options.body) : undefined }); if (!response.ok) throw Error('Fixture API failed'); return response.json(); }
`;
  const suffix = `
const shown = ref(false);
const app = createApp({ setup() { return () => h(InstanceRecovery, { open: shown.value }); } });
app.component('UModal', { setup(_props, { slots }) { return () => h('main', slots.content?.()); } });
app.component('UButton', { props: ['disabled','loading'], setup(props, { slots, attrs }) { return () => h('button', { ...attrs, disabled: props.disabled || props.loading }, slots.default?.()); } });
app.component('UBadge', { setup(_props, { slots }) { return () => h('span', slots.default?.()); } });
app.component('UIcon', { render() { return null; } });
app.mount('#app'); nextTick(() => { shown.value = true; });`;
  const bundle = await build({ stdin: { contents: prelude + composable + '\n' + script.content + suffix,
    resolveDir: new URL('../../orchestrator', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'iife',
    define: { 'process.env.NODE_ENV': '"production"', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false' } });
  const options = { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true, includeLocalBackups: false, includeLogs: false };
  const artifact = { id: 'admin-fixture', provider: 'local', providerObjectId: 'fixture', createdAt: '2026-10-18T00:00:00Z',
    size: 100, sha256: 'a'.repeat(64), integrityStatus: 'verified', keyFingerprint: 'sha256:' + 'b'.repeat(64), formatVersion: 1,
    manifest: { formatVersion: 1, options, volumes: [{ name: 'agentor-admin-workspace-data', kind: 'admin-workspace', size: 10 }],
      images: { immutableDigests: [], definitions: 0 }, plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false }, storage: { mode: 'volume', containerPrefix: 'worker' }, excludedDataPaths: [] } };
  const requests: string[] = [];
  const browserErrors: string[] = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  const server = createServer((request, response) => {
    requests.push(request.method + ' ' + request.url);
    if (request.url === '/component.js') { response.setHeader('Content-Type', 'application/javascript'); response.end(bundle.outputFiles[0].text); return; }
    if (request.url?.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (request.url.includes('/preflight')) response.end(JSON.stringify({ ready: false, blockers: ['Fixture destination not configured'], warnings: [], volumeConflicts: [], hostMountPaths: [], imageDigestsNotEmbedded: [] }));
      else if (request.url === '/api/admin/instance-backups/artifacts/admin-fixture') response.end(JSON.stringify(artifact));
      else if (request.url === '/api/admin/instance-backups') response.end(JSON.stringify({ jobs: [], artifacts: [artifact], remoteBackups: [], options }));
      else if (request.url === '/api/backups/recovery-key') response.end(JSON.stringify({ keys: [] }));
      else response.end('[]');
      return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><div id="app"></div><script src="/component.js"></script>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as any).port}`);
    const modal = page.getByTestId('instance-backup-management');
    await expect(modal.getByLabel('Agentor persistent volumes')).toBeChecked();
    await modal.getByRole('button', { name: 'Inspect & restore' }).click();
    const panel = modal.getByTestId('instance-restore-panel');
    await expect(panel).toContainText('fresh native storage with stopped intent');
    await expect(panel).toContainText('Explicit Start launches its service and management identity.');
    await expect(panel.getByLabel('Restore contained Agentor-owned persistent volumes')).toBeChecked();
    await panel.getByLabel(/current Agentor database and control-plane data/).check();
    await panel.getByLabel(/separately supplied or recorded required external configuration/).check();
    await expect(panel.getByRole('button', { name: 'Apply verified snapshot and restart Agentor' })).toBeDisabled();
    expect(requests.some(value => value.startsWith('POST '))).toBe(false);
    expect(browserErrors).toEqual([]);
  } finally { await page.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
