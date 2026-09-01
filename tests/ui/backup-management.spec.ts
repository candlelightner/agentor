import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { goToDashboard } from '../helpers/ui-helpers';

async function mock(page: Page) {
  let jobs:any[]=[]; let backups:any[]=[{id:'backup-1',workspaceIds:['worker-1','worker-2'],provider:'fake',createdAt:'2026-01-01T00:00:00Z',sizeBytes:4096,integrityVerified:true,missingSecrets:['API_TOKEN']}];
  await page.route('**/api/backup-providers',r=>r.fulfill({json:[{id:'fake',type:'fake',connected:true},{id:'google',type:'google-drive',connected:false}]}));
  await page.route('**/api/admin/backup-providers/google-oauth',async r=>r.fulfill({json:r.request().method()==='PUT'?{configured:true,source:'installation',clientId:'dashboard-client',redirectUri:'https://dash.example/api/backup-providers/google/oauth/callback',clientSecretConfigured:true}:{configured:false,source:'none',clientSecretConfigured:false}}));
  await page.route('**/api/backup-settings',async r=>r.fulfill({json:r.request().method()==='PUT'?await r.request().postDataJSON():{providerId:'fake',enabled:false,selection:'all',workspaceIds:[],intervalMinutes:1440,retentionCount:7,nextRunAt:null}}));
  await page.route('**/api/containers',r=>r.fulfill({json:[
    {id:'worker-1',userId:'test-user',displayName:'Alpha worker',status:'running'},
    {id:'worker-2',userId:'test-user',displayName:'Beta worker',status:'stopped'},
  ]}));
  await page.route('**/api/backups',async r=>{if(r.request().method()==='POST'){const j={id:'job-1',status:'queued',phase:'queued',progress:0,consistency:{warning:'Running worker: crash-consistent copy'}};jobs=[j];return r.fulfill({status:202,json:j})}return r.fulfill({json:{backups,jobs}})});
  await page.route('**/api/backup-jobs/job-1/retry',r=>r.fulfill({status:202,json:{id:'job-2',status:'queued',phase:'queued',progress:0}}));
  await page.route('**/api/backups/backup-1/restore',r=>r.fulfill({status:202,json:{jobId:'restore-1'}}));
  await page.route('**/api/backups/backup-1',r=>{backups=[];return r.fulfill({status:204})});
  await page.route('**/api/containers/worker-1/backup-paths**', async route => {
    const path = new URL(route.request().url()).searchParams.get('path') || '/workspace';
    const entries = path === '/' ? [{name:'etc',path:'/etc',type:'directory',readable:true}] : [{name:'project',path:'/workspace/project',type:'directory',readable:true},{name:'note.txt',path:'/workspace/note.txt',type:'file',readable:true}];
    await route.fulfill({json:{path,entries}});
  });
}
async function open(page:Page){await goToDashboard(page);await page.getByRole('button',{name:/backup management/i}).click();return page.locator('[data-testid="backup-management"]')}
async function selectWorkspace(page:Page,modal:ReturnType<Page['locator']>,query:string,name:RegExp){
  const selector=modal.getByTestId('backup-workspace-selector');
  await selector.click();
  await selector.fill(query);
  await page.getByRole('option',{name}).click();
  await page.keyboard.press('Escape');
}
test.beforeEach(async({page})=>mock(page));
test('configures scheduling and starts a manual backup with progress and consistency warning',async({page})=>{const m=await open(page);await expect(m).toContainText('fake — linked');await m.getByLabel('Enable scheduled backups').check();await m.getByRole('button',{name:'Save schedule'}).click();await m.getByRole('button',{name:'Back up now'}).click();await expect(m).toContainText('queued · queued');await expect(m).toContainText('crash-consistent')});
test('saves draft settings and uses the selected provider when backing up immediately',async({page})=>{
  let saved:any; let started:any;
  await page.route('**/api/backup-settings',async route=>{
    if(route.request().method()==='PUT'){
      saved=await route.request().postDataJSON();
      return route.fulfill({json:saved});
    }
    return route.fulfill({json:{providerId:'fake',enabled:false,selection:'all',workspaceIds:[],selectedPathsByWorkspace:{},intervalMinutes:1440,retentionCount:7,nextRunAt:null}});
  });
  await page.route('**/api/backups',async route=>{
    if(route.request().method()==='POST'){
      started=await route.request().postDataJSON();
      return route.fulfill({status:202,json:{id:'job-draft',status:'queued',phase:'queued',progress:0}});
    }
    return route.fulfill({json:{backups:[],jobs:[]}});
  });
  const m=await open(page);
  await m.getByLabel('Provider').selectOption('google-drive');
  await m.getByRole('button',{name:'Back up now'}).click();
  await expect.poll(()=>saved?.providerId).toBe('google-drive');
  await expect.poll(()=>started?.providerId).toBe('google-drive');
});
test('selects files and any browsed directory including root from a picker rooted at workspace', async ({ page }) => {
  const m = await open(page);
  await m.getByLabel('Selected workspaces').check();
  await selectWorkspace(page,m,'Alpha',/Alpha worker.*Worker.*running.*worker-1/i);
  await m.getByRole('button', { name: 'Choose paths' }).click();
  const picker = page.getByTestId('backup-path-picker');
  const project = picker.getByRole('button', { name: 'project', exact: true });
  await expect(project).toBeVisible();
  await project.dblclick();
  await expect(picker).toContainText('/workspace/project');
  await picker.getByRole('button', { name: 'Up' }).click();
  await picker.getByLabel(/note.txt/).check();
  await picker.getByRole('button', { name: 'Up' }).click();
  await expect(picker).toContainText('/');
  await picker.getByLabel('Select current directory').check();
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect(m).toContainText('2 additional');
});
test('warns precisely which retained and detached data can change when persistence is deselected', async ({ page }) => {
  const m = await open(page);
  await m.getByLabel('Selected workspaces').check();
  await selectWorkspace(page,m,'worker-1',/Alpha worker.*worker-1/i);
  await m.getByRole('button', { name: 'Choose paths' }).click();
  let picker = page.getByTestId('backup-path-picker');
  await picker.getByRole('checkbox').nth(1).check();
  await picker.getByRole('button', { name: 'Done' }).click();
  const saveButton = m.getByRole('button', { name: 'Save schedule' });
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/api/backup-settings') && response.request().method() === 'PUT'),
    saveButton.click(),
  ]);
  await expect(saveButton).toBeEnabled();
  await m.getByRole('button', { name: 'Choose paths' }).click();
  picker = page.getByTestId('backup-path-picker');
  await picker.getByRole('checkbox').nth(1).uncheck();
  await picker.getByRole('button', { name: 'Done' }).click();
  let warning = '';
  page.once('dialog', async dialog => { warning = dialog.message(); await dialog.accept(); });
  await saveButton.click();
  await expect.poll(() => warning).toContain('No persisted data is deleted now');
  expect(warning).toContain('changes made there are lost by another rebuild');
  expect(warning).toContain('current same-named files overwrite their older persisted versions');
  expect(warning).toContain('other old and new files are kept');
});
test('restores safely into a new or lock-protected original worker without retaining its password',async({page})=>{
  const lockPassword='UI_BACKUP_LOCK_DO_NOT_RENDER';let restoreBody:any;
  await page.route('**/api/backups/backup-1/restore',async route=>{restoreBody=await route.request().postDataJSON();await route.fulfill({status:202,json:{jobId:'restore-1'}})});
  const m=await open(page);await expect(m).toContainText('Integrity verified');await expect(m).toContainText('API_TOKEN');await m.getByRole('button',{name:'Restore'}).click();await m.getByLabel('Original worker').check();await expect(m.getByLabel('worker-1')).toBeChecked();await m.getByLabel('worker-2').check();await expect(m.getByLabel('worker-2')).toBeChecked();await expect(m.getByRole('button',{name:'Start restore'})).toBeDisabled();await m.getByLabel(/Original worker is stopped/).check();await m.getByLabel(/Worker lock password/).fill(lockPassword);await m.getByRole('button',{name:'Start restore'}).click();
  expect(restoreBody).toMatchObject({target:'original',confirmOverwrite:true,lockPassword,workspaceIds:['worker-2']});await expect(m.getByLabel(/Worker lock password/)).toHaveCount(0);await expect(m).not.toContainText(lockPassword);
  await m.getByRole('button',{name:'Delete'}).click();await expect(m).not.toContainText('backup-1')
});
test('selects one workspace from a multi-worker backup and posts that exact restore subset',async({page})=>{
  let restoreBody:any;
  await page.route('**/api/backups/backup-1/restore',async route=>{restoreBody=await route.request().postDataJSON();await route.fulfill({status:202,json:{jobId:'restore-1'}})});
  const m=await open(page);
  await m.getByRole('button',{name:'Restore'}).click();
  const panel=m.getByTestId('restore-backup');
  await expect(panel.getByLabel('worker-1')).toBeChecked();
  await expect(panel.getByLabel('worker-2')).toBeChecked();
  await panel.getByLabel('worker-1').uncheck();
  await panel.getByLabel('worker-2').uncheck();
  await expect(panel.getByRole('button',{name:'Start restore'})).toBeDisabled();
  await panel.getByRole('button',{name:'Reset selection'}).click();
  await expect(panel.getByLabel('worker-1')).toBeChecked();
  await expect(panel.getByLabel('worker-2')).toBeChecked();
  await panel.getByLabel('worker-1').uncheck();
  await panel.getByRole('button',{name:'Start restore'}).click();
  expect(restoreBody).toMatchObject({target:'new',displayName:'',confirmOverwrite:false,workspaceIds:['worker-2']});
  expect(restoreBody.requestId).toMatch(/^ui-restore-/);
});
test('an administrator configures write-only Google OAuth installation credentials before linking',async({page})=>{const m=await open(page);const panel=m.locator('[data-testid="google-oauth-installation"]');await expect(panel).toBeVisible();await panel.getByLabel('Client ID').fill('dashboard-client');await panel.getByLabel('Redirect URI').fill('https://dash.example/api/backup-providers/google/oauth/callback');await panel.getByLabel('Client secret').fill('DO_NOT_RENDER_SECRET');await panel.getByRole('button',{name:'Save Google OAuth configuration'}).click();await expect(panel).toContainText('Configured from installation');await expect(panel).not.toContainText('DO_NOT_RENDER_SECRET')});
test('discovers a remote backup and keeps recovery material out of persistent browser state', async ({ page }) => {
  const rawKey = randomBytes(32).toString('base64');
  let discoveryRequests = 0;
  await page.route('**/api/backups/recovery-key', route => route.fulfill({
    headers: { 'cache-control': 'no-store' },
    json: { activeFingerprint: 'sha256:current', keys: [{ fingerprint: 'sha256:current', active: true, source: 'generated' }] },
  }));
  await page.route('**/api/backups/remote', async route => {
    if (route.request().method() === 'POST') {
      discoveryRequests++;
      return route.fulfill({ status: 202, json: { jobId: 'discover-1', status: 'queued' } });
    }
    return route.fulfill({ json: [{ id: 'remote-1', provider: 'fake', createdAt: '2026-01-02T00:00:00Z', size: 42, formatVersion: 2, keyFingerprint: 'sha256:remote', keyAvailable: false, state: 'missing-key', integrityStatus: 'unverified', blockedReason: 'Recovery key sha256:remote is not available on this installation.' }] });
  });
  await page.route('**/api/backups/recovery-key/reveal', async route => {
    expect(await route.request().postDataJSON()).toEqual({ password: 'fresh-password' });
    await route.fulfill({ headers: { 'cache-control': 'private, no-store' }, json: { keyMaterial: rawKey, fingerprint: 'sha256:current' } });
  });
  const m = await open(page);
  await expect(m.getByTestId('recovery-key-fingerprints')).toContainText('sha256:current');
  await expect(m.getByTestId('remote-backup-discovery')).toContainText('missing-key');
  await m.getByRole('button', { name: 'Scan provider' }).click();
  await expect.poll(() => discoveryRequests).toBe(1);
  await m.getByLabel(/Current password/).fill('fresh-password');
  await m.getByRole('button', { name: 'Reveal recovery key' }).click();
  await expect(m.getByTestId('revealed-recovery-key')).toHaveText(rawKey);
  expect(await page.evaluate(() => JSON.stringify({
    local: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    session: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    nuxt: (window as any).__NUXT__,
  }))).not.toContain(rawKey);
  await m.getByRole('button', { name: 'Hide key' }).click();
  await expect(m.getByTestId('revealed-recovery-key')).toHaveCount(0);
  expect(await page.content()).not.toContain(rawKey);
});
test('clears recovery material after a failed fresh reauthentication and after exporting a kit', async ({ page }) => {
  const inputMaterial = 'RECOVERY_IMPORT_DO_NOT_KEEP';
  const exportedMaterial = randomBytes(32).toString('base64');
  let revealRequests = 0;
  let importedBody: any;
  const exportBodies: any[] = [];
  await page.route('**/api/backups/recovery-key', route => route.fulfill({
    json: {
      activeFingerprint: 'sha256:current',
      keys: [
        { fingerprint: 'sha256:current', active: true, source: 'generated' },
        { fingerprint: 'sha256:legacy', active: false, source: 'legacy' },
      ],
    },
  }));
  await page.route('**/api/backups/recovery-key/import', async route => {
    importedBody = await route.request().postDataJSON();
    await route.fulfill({
      headers: { 'cache-control': 'private, no-store' },
      json: { imported: true, fingerprint: 'sha256:imported', matchingRemoteBackupIds: [] },
    });
  });
  await page.route('**/api/backups/recovery-key/reveal', async route => {
    revealRequests++;
    expect(await route.request().postDataJSON()).toEqual({ password: 'incorrect-password' });
    await route.fulfill({ status: 401, json: { statusMessage: 'Fresh reauthentication required' } });
  });
  await page.route('**/api/backups/recovery-key/export', async route => {
    exportBodies.push(await route.request().postDataJSON());
    await route.fulfill({
      headers: { 'cache-control': 'private, no-store' },
      json: { formatVersion: 2, fingerprint: 'sha256:current', keyMaterial: exportedMaterial },
    });
  });
  const m = await open(page);
  await m.getByLabel('Import recovery key or kit').fill(inputMaterial);
  await m.getByRole('button', { name: 'Import recovery material' }).click();
  await expect.poll(() => importedBody).toEqual({ kit: inputMaterial });
  await expect(m.getByLabel('Import recovery key or kit')).toHaveValue('');
  expect(await page.content()).not.toContain(inputMaterial);

  await m.getByLabel('Import recovery key or kit').fill(inputMaterial);
  await m.getByLabel(/Current password/).fill('incorrect-password');
  await m.getByRole('button', { name: 'Reveal recovery key' }).click();
  await expect.poll(() => revealRequests).toBe(1);
  await expect(m).toContainText('Fresh reauthentication required');
  await expect(m.getByLabel('Import recovery key or kit')).toHaveValue('');
  await expect(m.getByLabel(/Current password/)).toHaveValue('');
  expect(await page.content()).not.toContain(inputMaterial);

  await m.getByLabel(/Current password/).fill('fresh-password');
  const download = page.waitForEvent('download');
  await m.getByRole('button', { name: 'Download recovery kit' }).click();
  await (await download).cancel();
  expect(exportBodies[0]).toEqual({ password: 'fresh-password' });
  await expect(m.getByLabel(/Current password/)).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({
    local: Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])),
    session: Object.fromEntries(Object.keys(sessionStorage).map(key => [key, sessionStorage.getItem(key)])),
    nuxt: (window as any).__NUXT__,
  }))).not.toContain(exportedMaterial);
  expect(await page.content()).not.toContain(exportedMaterial);

  await m.getByLabel(/Current password/).fill('historical-password');
  const historicalDownload = page.waitForEvent('download');
  await m.getByRole('button', { name: 'Export this key' }).nth(1).click();
  await (await historicalDownload).cancel();
  expect(exportBodies[1]).toEqual({
    password: 'historical-password',
    fingerprint: 'sha256:legacy',
  });
});
test('inspects and adopts a ready remote-only backup asynchronously', async ({ page }) => {
  const remote = {
    id: 'remote-ready', provider: 'fake', createdAt: '2026-01-03T00:00:00Z', size: 2048,
    formatVersion: 2, keyFingerprint: 'sha256:imported', keyAvailable: true,
    state: 'ready-to-adopt', integrityStatus: 'unverified', knownLocally: false,
    workspaceMembers: [{ id: 'source-worker', displayName: 'Recovered worker' }],
  };
  let adoptionBody: any;
  await page.route('**/api/backups/remote/remote-ready/adopt', async route => {
    adoptionBody = await route.request().postDataJSON();
    await route.fulfill({ status: 202, json: { jobId: 'adopt-1', status: 'queued' } });
  });
  await page.route('**/api/backups/remote/remote-ready', route => route.fulfill({
    json: { ...remote, sourceInstallationId: 'installation-a', restorable: false, blockedReason: 'Adopt and verify this provider object before restoring it.' },
  }));
  await page.route('**/api/backups/remote', route => route.fulfill({ json: [remote] }));
  const m = await open(page);
  const card = m.getByTestId('discovered-backup-remote-ready');
  await expect(card).toContainText('remote only');
  await expect(card).toContainText('recovery key: available');
  await card.getByRole('button', { name: 'Inspect' }).click();
  await expect(m).toContainText('Source installation: installation-a');
  await expect(m).toContainText('not until adoption and verification complete');
  await card.getByRole('button', { name: 'Adopt locally' }).click();
  await expect.poll(() => adoptionBody).toBeTruthy();
  expect(adoptionBody.requestId).toMatch(/^ui-adopt-/);
  await expect(m).toContainText('queued · queued');
});
test('shows an unresolved custom-image dependency and sends only an explicit replacement or acknowledged workspace-only choice', async ({ page }) => {
  const unresolved = {
    id: 'backup-custom-image', workspaceIds: ['worker-1'], provider: 'fake',
    createdAt: '2026-01-03T00:00:00Z', sizeBytes: 4096, integrityVerified: true,
    workspaceMembers: [{ id: 'worker-1', displayName: 'Alpha worker' }],
    reconstruction: [{
      workspaceId: 'worker-1', displayName: 'Alpha worker',
      image: { kind: 'custom', definitionId: 'captured-image', version: '3', digest: 'sha256:captured', recoveryAvailable: true },
      pluginDefinitions: [], desiredPluginCount: 0, requiredSecretNames: [],
    }],
    dependencies: [{
      kind: 'image', id: 'captured-image:3@sha256:captured', workspaceId: 'worker-1',
      status: 'replacement-required', required: true,
      reason: 'The captured immutable image is unavailable on this installation.',
    }],
  };
  const restoreBodies: any[] = [];
  let recoveryJob: any;
  await page.route('**/api/backups', async route => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 202, json: { id: 'backup-job', status: 'queued', phase: 'queued', progress: 0 } });
    return route.fulfill({ json: { backups: [unresolved], jobs: recoveryJob ? [recoveryJob] : [] } });
  });
  let imageRecoveryBody: any;
  await page.route('**/api/backups/backup-custom-image/image-recovery', async route => {
    imageRecoveryBody = await route.request().postDataJSON();
    recoveryJob = {
      id: 'image-recovery-1', artifactId: 'backup-custom-image', workspaceId: 'worker-1',
      operation: 'dependency-resolution', status: 'succeeded', phase: 'complete', progress: 100,
      recoveredImageDefinitionId: 'recovered-definition', recoveredImageBuildId: 'image-build-1',
    };
    await route.fulfill({
      status: 202,
      json: {
        jobId: 'image-recovery-1',
        status: 'queued',
        next: {
          status: '/api/backup-jobs/image-recovery-1',
          logs: '/api/backups/jobs/image-recovery-1/logs',
          cancel: '/api/backup-jobs/image-recovery-1',
        },
      },
    });
  });
  await page.route('**/api/backups/backup-custom-image/restore', async route => {
    restoreBodies.push(await route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { jobId: `restore-${restoreBodies.length}` } });
  });
  const m = await open(page);
  await m.getByRole('button', { name: 'Restore' }).click();
  const panel = m.getByTestId('restore-backup');
  const dependencies = panel.getByTestId('restore-image-dependencies');
  await expect(dependencies).toContainText('Agentor will never silently replace');
  await expect(dependencies).toContainText('captured-image');
  await expect(dependencies).toContainText('captured immutable image is unavailable');
  await expect(dependencies.getByLabel('Image resolution')).toHaveValue('replacement');
  await expect(panel.getByRole('button', { name: 'Start restore' })).toBeDisabled();
  await dependencies.getByRole('button', { name: 'Recover definition & build' }).click();
  await expect.poll(() => imageRecoveryBody).toMatchObject({ workspaceId: 'worker-1', startBuild: true, requestId: expect.stringMatching(/^ui-image-recovery-/) });
  await expect(dependencies).toContainText('Recovery job image-recovery-1: queued · queued');
  await page.waitForTimeout(1_600);
  await expect(dependencies).toContainText('Recovered definition: recovered-definition');
  await expect(dependencies).toContainText('Image build: image-build-1');
  await expect(dependencies).toContainText('compatibility validation to succeed, then retry restore');

  await dependencies.getByLabel('Replacement definition ID').fill('replacement-image');
  await dependencies.getByLabel('Replacement version').fill('9');
  await panel.getByRole('button', { name: 'Start restore' }).click();
  expect(restoreBodies[0]).toMatchObject({
    target: 'new', workspaceIds: ['worker-1'],
    imageResolutions: {
      'worker-1': { mode: 'replacement', imageDefinitionId: 'replacement-image', imageVersion: '9' },
    },
  });
  expect(restoreBodies[0].requestId).toMatch(/^ui-restore-/);

  await m.getByRole('button', { name: 'Restore' }).click();
  const workspaceOnlyPanel = m.getByTestId('restore-backup');
  await workspaceOnlyPanel.getByLabel('Image resolution').selectOption('workspace-only');
  await expect(workspaceOnlyPanel).toContainText('only the workspace and portable configuration are restored');
  await workspaceOnlyPanel.getByRole('button', { name: 'Start restore' }).click();
  expect(restoreBodies[1]).toMatchObject({
    target: 'new', workspaceIds: ['worker-1'],
    imageResolutions: { 'worker-1': { mode: 'workspace-only', acknowledged: true } },
  });
});
test('only offers definition recovery for a server-marked recipe and surfaces a safe recovery-start error', async ({ page }) => {
  const artifact = {
    id: 'backup-no-recipe', workspaceIds: ['worker-1', 'worker-2'], provider: 'fake', createdAt: '2026-01-04T00:00:00Z', sizeBytes: 10,
    workspaceMembers: [{ id: 'worker-1' }, { id: 'worker-2' }],
    reconstruction: [
      { workspaceId: 'worker-1', image: { kind: 'custom', definitionId: 'no-recipe', version: '1', digest: 'sha256:no-recipe' }, pluginDefinitions: [], desiredPluginCount: 0, requiredSecretNames: [] },
      { workspaceId: 'worker-2', image: { kind: 'unmanaged', digest: 'sha256:unmanaged' }, pluginDefinitions: [], desiredPluginCount: 0, requiredSecretNames: [] },
    ],
    dependencies: [
      { kind: 'image', workspaceId: 'worker-1', id: 'no-recipe:1', status: 'replacement-required', required: true, reason: 'No portable recipe is available.' },
      { kind: 'image', workspaceId: 'worker-2', id: 'unmanaged', status: 'replacement-required', required: true, reason: 'The image was unmanaged.' },
    ],
  };
  await page.route('**/api/backups', route => route.fulfill({ json: { backups: [artifact], jobs: [] } }));
  const m = await open(page);
  await m.getByRole('button', { name: 'Restore' }).click();
  await expect(m.getByTestId('restore-image-dependencies').getByRole('button', { name: 'Recover definition & build' })).toHaveCount(0);

  const recoverable = {
    ...artifact,
    id: 'backup-recovery-error',
    workspaceIds: ['worker-1'], workspaceMembers: [{ id: 'worker-1' }],
    reconstruction: [{ ...artifact.reconstruction[0], image: { ...artifact.reconstruction[0].image, recoveryAvailable: true } }],
    dependencies: [artifact.dependencies[0]],
  };
  await m.getByRole('button', { name: 'Cancel' }).click();
  await m.getByLabel('Close').click();
  await page.unroute('**/api/backups');
  await page.route('**/api/backups', route => route.fulfill({ json: { backups: [recoverable], jobs: [] } }));
  await page.route('**/api/backups/backup-recovery-error/image-recovery', route => route.fulfill({ status: 409, json: { statusMessage: 'The recovered definition cannot be built yet.' } }));
  const reopened = await open(page);
  await reopened.getByRole('button', { name: 'Restore' }).click();
  await reopened.getByTestId('restore-image-dependencies').getByRole('button', { name: 'Recover definition & build' }).click();
  await expect(reopened).toContainText('The recovered definition cannot be built yet.');
});
