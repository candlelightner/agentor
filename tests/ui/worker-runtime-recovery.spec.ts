import { test, expect, chromium, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Render the actual SFC without an installation, account, Docker or network.
// Only Nuxt globals/API responses and primitive Nuxt UI controls are stubbed.
const requireApp = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { parse, compileScript } = requireApp('@vue/compiler-sfc');
const ts = requireApp('typescript');
function compileSfc(relativePath: string) {
  const filename = new URL('../../orchestrator/app/' + relativePath, import.meta.url).pathname;
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename });
  const compiled = compileScript(descriptor, { id: 'runtime-recovery-fixture', inlineTemplate: true });
  return ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
const component = compileSfc('components/WorkerRuntimeControl.vue');
const panel = compileSfc('components/RuntimeMigrationRecoveryPanel.vue');
const dashboard = compileSfc('pages/index.vue');
const vue = readFileSync(requireApp.resolve('vue/dist/vue.global.js'), 'utf8');
test.use({ launchOptions: !existsSync(chromium.executablePath()) && existsSync('/usr/bin/chromium')
  ? { executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] } : {} });

interface Status { phase: string; reconciliationRequired?: boolean; workerRecordTransitionPending?: boolean }
async function mount(page: Page, status: Status | null, options: {
  result?: Status; error?: string; refreshError?: boolean; admin?: boolean; disabled?: boolean;
  recoveryOnly?: boolean; initialError?: boolean; dashboard?: boolean; inventoryError?: boolean;
} = {}) {
  await page.setContent('<div id="app"></div>');
  await page.addScriptTag({ content: vue });
  await page.evaluate(({ component, panel, dashboard, status, options }) => {
    const fixture = window as any;
    const Vue = fixture.Vue;
    Object.assign(fixture, { ref: Vue.ref, computed: Vue.computed, watch: Vue.watch, onBeforeUnmount: Vue.onBeforeUnmount });
    fixture.admin = Vue.ref(options.admin !== false);
    fixture.useAuth = () => ({ isAdmin: fixture.admin });
    fixture.requests = [];
    fixture.failStatus = !!options.initialError;
    fixture.failInventory = !!options.inventoryError;
    fixture.statusHook = null;
    fixture.recoveryHook = null;
    let current = status;
    let statusReads = 0;
    fixture.$fetch = async (url: string, request: any = {}) => {
      fixture.requests.push({ url, ...request });
      if (url === '/api/admin/runtime-migrations') {
        if (fixture.failInventory) throw new Error('Worker record storage unavailable');
        return current ? [{ ...current, workerId: 'runtime-fixture', operationId: 'operation-fixture', displayName: 'Held Worker',
          sourceProfile: 'legacy-runc', targetProfile: 'kata-qemu' }] : [];
      }
      if (url.endsWith('/migration-recover')) {
        if (fixture.recoveryHook) return fixture.recoveryHook(url);
        if (options.error) throw { data: { statusMessage: options.error } };
        current = options.result || { ...status, reconciliationRequired: false, workerRecordTransitionPending: false };
        return current;
      }
      if (url.endsWith('/migration-finalize')) { current = null as any; return { finalized: true }; }
      if (url.endsWith('/migration-preflight')) return { targetProfile: 'kata-qemu', capacityAdmission: 'not-yet-implemented', mounts: [] };
      if (fixture.statusHook) return fixture.statusHook(url);
      if (fixture.failStatus) throw new Error('Initial status unavailable');
      if (options.refreshError && statusReads++ > 0) throw new Error('Status unavailable');
      return current;
    };
    function load(code: string) {
      const exports: any = {};
      new Function('require', 'exports', code)((name: string) => {
        if (name !== 'vue') throw new Error(`Unexpected fixture dependency: ${name}`);
        return Vue;
      }, exports);
      return exports.default;
    }
    const control = load(component);
    fixture.workerProps = Vue.reactive({
      workerId: 'runtime-fixture', runtimeProfile: 'kata-qemu', canMigrate: true,
      disabled: options.disabled === true, recoveryOnly: options.recoveryOnly === true,
    });
    const noOperation = () => { throw new Error('Unexpected dashboard operation'); };
    fixture.liveWorkers = Vue.ref([]);
    fixture.useGitProviders = () => ({ gitProviders: Vue.ref([]) });
    fixture.useContainers = () => ({ containers: fixture.liveWorkers, refresh: noOperation });
    fixture.useArchivedWorkers = () => ({ archivedWorkers: Vue.ref([]), refresh: noOperation });
    fixture.useWorkerGroups = () => ({ groups: Vue.ref([]), refresh: noOperation });
    fixture.useSplitPanes = () => ({ tabs: Vue.ref([]), activeTabId: Vue.ref(''), rootNode: Vue.ref(null), focusedNodeId: Vue.ref('') });
    fixture.useSidebarResize = () => ({ sidebarWidth: Vue.ref(320), isCollapsed: Vue.ref(false), isMobile: Vue.ref(false), isDragging: Vue.ref(false) });
    fixture.useHead = () => {};
    const app = Vue.createApp(options.dashboard ? load(dashboard) : { setup: () => () => Vue.h(control, fixture.workerProps) });
    app.component('WorkerRuntimeControl', control);
    app.component('RuntimeMigrationRecoveryPanel', load(panel));
    // Render the real dashboard placement with an explicitly empty live list;
    // unrelated modals, sidebar UI and pane implementation are not under test.
    app.component('AppSidebar', { props: ['containers'], setup: (props: any) => () => Vue.h('aside', { 'data-testid': 'live-workers' }, `Live workers: ${props.containers.length}`) });
    for (const name of [...dashboard.matchAll(/resolveComponent\)\("([^\"]+)"\)/g)].map((match: any) => match[1])) {
      if (name !== 'RuntimeMigrationRecoveryPanel' && name !== 'AppSidebar') app.component(name, { render: () => null });
    }
    app.component('UButton', {
      props: ['disabled', 'loading'],
      setup: (props: any, { slots }: any) => () => Vue.h('button', { disabled: props.disabled || props.loading }, slots.default?.()),
    });
    app.component('UCheckbox', {
      props: ['modelValue', 'label'], emits: ['update:modelValue'],
      setup: (props: any, { emit }: any) => () => Vue.h('label', [
        Vue.h('input', { type: 'checkbox', checked: props.modelValue,
          onChange: (event: any) => emit('update:modelValue', event.target.checked) }), props.label,
      ]),
    });
    app.component('UInput', {
      props: ['modelValue'], emits: ['update:modelValue'],
      setup: (props: any, { emit }: any) => () => Vue.h('input', { value: props.modelValue,
        onInput: (event: any) => emit('update:modelValue', event.target.value) }),
    });
    app.mount('#app');
  }, { component, panel, dashboard, status, options });
}
const settled = 'The operator verified that outstanding Docker operations have settled.';
const deletion = 'I confirm deletion of the retained rollback container and copied volumes.';
async function mutations(page: Page) {
  return page.evaluate(() => (window as any).requests.filter((request: any) => request.method === 'POST'));
}

for (const phase of ['committed', 'rolled-back']) {
  test(`${phase} terminal hold requires explicit acknowledged reconciliation before cleanup`, async ({ page }) => {
    await mount(page, { phase, reconciliationRequired: true });
    const reconcile = page.getByRole('button', { name: 'Reconcile migration', exact: true });
    await expect(reconcile).toBeDisabled();
    await expect(page.getByText('it does not perform a new rollback.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
    await page.getByLabel(settled).check();
    await page.getByLabel('Migration recovery protection password').fill('fixture-only-password');
    await reconcile.click();
    await expect(page.getByRole('status').filter({ hasText: phase === 'committed'
      ? 'Committed migration reconciled' : 'Completed rollback reconciled' })).toBeVisible();
    await expect(page.getByText('Rollback completed;', { exact: false })).toHaveCount(0);
    const cleanup = page.getByRole('button', { name: 'Delete rollback evidence' });
    await expect(cleanup).toBeDisabled();
    expect(await mutations(page)).toEqual([{ url: '/api/admin/workers/runtime-fixture/migration-recover', method: 'POST',
      body: { acknowledgeDaemonOperationsSettled: true, lockPassword: 'fixture-only-password' } }]);
    await page.getByLabel(deletion).check();
    await cleanup.click();
    await expect(page.getByRole('status').filter({ hasText: 'Rollback cleanup completed.' })).toBeVisible();
    expect((await mutations(page)).map((request: any) => request.url)).toEqual([
      '/api/admin/workers/runtime-fixture/migration-recover', '/api/admin/workers/runtime-fixture/migration-finalize',
    ]);
  });
}

test('reconciliation error retains the hold and requires a fresh acknowledgment', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { error: 'Terminal migration Docker identity differs' });
  await page.getByLabel(settled).check();
  await page.getByRole('button', { name: 'Reconcile migration' }).click();
  await expect(page.getByRole('alert')).toHaveText('Terminal migration Docker identity differs');
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
  await expect(page.getByText('Committed migration reconciled', { exact: false })).toHaveCount(0);
});

test('nonterminal recovery reports rollback only after a rolled-back response', async ({ page }) => {
  await mount(page, { phase: 'recovery-required', reconciliationRequired: true }, {
    result: { phase: 'rolled-back', reconciliationRequired: false },
  });
  await expect(page.getByRole('button', { name: 'Recover interrupted migration' })).toBeDisabled();
  await page.getByLabel(settled).check();
  await page.getByRole('button', { name: 'Recover interrupted migration' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rollback completed; the previous worker and its local data were restored.' })).toBeVisible();
  await expect(page.getByText('Shared account state was not rewound.', { exact: false })).toBeVisible();
});

test('successful HTTP response with a remaining hold is not reported as recovery success', async ({ page }) => {
  const status = { phase: 'committed', reconciliationRequired: true };
  await mount(page, status, { result: status });
  await page.getByLabel(settled).check();
  await page.getByRole('button', { name: 'Reconcile migration' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Migration still requires recovery or reconciliation.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
});

for (const status of [
  { phase: 'committed' },
  { phase: 'rolled-back', reconciliationRequired: false, workerRecordTransitionPending: true },
]) {
  test(`missing reconciliation authority or pending transition blocks cleanup: ${JSON.stringify(status)}`, async ({ page }) => {
    await mount(page, status);
    await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
  });
}

test('status refresh failure after recovery does not expose cleanup', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { refreshError: true });
  await page.getByLabel(settled).check();
  await page.getByRole('button', { name: 'Reconcile migration' }).click();
  await expect(page.getByText('Migration status could not be verified.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
});

test('nonadministrator has no migration mutations', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { admin: false });
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(await mutations(page)).toEqual([]);
});

test('disabled worker cannot reconcile even after acknowledgment', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { disabled: true });
  await page.getByLabel(settled).check();
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeDisabled();
  expect(await mutations(page)).toEqual([]);
});

test('reconciled terminal journal offers separately confirmed cleanup without recovery', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: false });
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toBeDisabled();
  expect(await mutations(page)).toEqual([]);
});

test('capacity gate remains closed after downtime acknowledgment', async ({ page }) => {
  await mount(page, null);
  await page.getByRole('button', { name: 'Check runtime migration' }).click();
  await page.getByLabel('I confirm worker downtime and snapshot creation.').check();
  await expect(page.getByRole('button', { name: 'Migrate runtime', exact: true })).toBeDisabled();
  expect(await mutations(page)).toEqual([]);
});

test('initial status failure offers retry and never exposes recovery or cleanup', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { initialError: true, recoveryOnly: true });
  await expect(page.getByRole('alert')).toContainText('Migration status could not be verified');
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
  await page.evaluate(() => { (window as any).failStatus = false; });
  await page.getByRole('button', { name: 'Retry migration status' }).click();
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeDisabled();
});

test('recovery-only control never offers runtime authorization or a new migration', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { recoveryOnly: true });
  await page.evaluate(() => { (window as any).workerProps.runtimeProfile = 'legacy-runc'; });
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Authorize legacy|Confirm authorization|Check runtime migration|Migrate runtime/ })).toHaveCount(0);
});

test('late status for an old worker cannot clear the new worker hold', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { recoveryOnly: true });
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeVisible();
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.statusHook = (url: string) => url.includes('/runtime-fixture/')
      ? new Promise(resolve => { fixture.resolveOldStatus = resolve; })
      : Promise.resolve({ phase: 'rolled-back', reconciliationRequired: true });
  });
  await page.getByRole('button', { name: 'Refresh migration status' }).click();
  await page.evaluate(() => { (window as any).workerProps.workerId = 'other-worker'; });
  await expect(page.getByRole('status')).toHaveText('Migration: rolled-back');
  await page.evaluate(() => { (window as any).resolveOldStatus({ phase: 'committed', reconciliationRequired: false }); });
  await expect(page.getByRole('status')).toHaveText('Migration: rolled-back');
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
});

test('late recovery for an old worker cannot publish success or authorize cleanup for another worker', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { recoveryOnly: true });
  await page.evaluate(() => {
    const fixture = window as any;
    fixture.recoveryHook = () => new Promise(resolve => { fixture.resolveOldRecovery = resolve; });
    fixture.statusHook = () => Promise.resolve({ phase: 'rolled-back', reconciliationRequired: true });
  });
  await page.getByLabel(settled).check();
  await page.getByRole('button', { name: 'Reconcile migration' }).click();
  await page.evaluate(() => { (window as any).workerProps.workerId = 'other-worker'; });
  await expect(page.getByRole('status')).toHaveText('Migration: rolled-back');
  await page.evaluate(() => { (window as any).resolveOldRecovery({ phase: 'committed', reconciliationRequired: false }); });
  await expect(page.getByRole('status')).toHaveText('Migration: rolled-back');
  await expect(page.getByRole('button', { name: 'Reconcile migration' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Delete rollback evidence' })).toHaveCount(0);
});

test('dashboard exposes held migration recovery when live worker inventory is empty', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { dashboard: true });
  await expect(page.getByTestId('live-workers')).toHaveText('Live workers: 0');
  const panel = page.getByRole('region', { name: 'Runtime migration recovery' });
  await expect(panel).toContainText('Held Worker — committed — reconciliation required');
  await panel.locator('summary').click();
  await expect(panel.getByRole('button', { name: 'Reconcile migration' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Check runtime migration|Authorize legacy|Migrate runtime/ })).toHaveCount(0);
  await panel.getByLabel(settled).check();
  await panel.getByRole('button', { name: 'Reconcile migration' }).click();
  await expect(panel.locator('summary')).toContainText('rollback evidence retained');
  await panel.locator('summary').click();
  await panel.getByLabel(deletion).check();
  await panel.getByRole('button', { name: 'Delete rollback evidence' }).click();
  await expect(panel).toContainText('No retained runtime migration journals.');
  await expect(page.getByTestId('live-workers')).toHaveText('Live workers: 0');
});

test('dashboard recovery inventory error is explicit and retryable, not an empty inventory', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { dashboard: true, inventoryError: true });
  await expect(page.getByRole('alert')).toContainText('do not assume no migrations need attention');
  await expect(page.getByText('No retained runtime migration journals.')).toHaveCount(0);
  await page.evaluate(() => { (window as any).failInventory = false; });
  await page.getByRole('button', { name: 'Retry recovery inventory' }).click();
  await expect(page.locator('summary')).toContainText('Held Worker');
});

test('nonadministrator dashboard does not render or fetch recovery inventory', async ({ page }) => {
  await mount(page, { phase: 'committed', reconciliationRequired: true }, { dashboard: true, admin: false });
  await expect(page.getByTestId('live-workers')).toHaveText('Live workers: 0');
  await expect(page.getByRole('region', { name: 'Runtime migration recovery' })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).requests)).toEqual([]);
});
