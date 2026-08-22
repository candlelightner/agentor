import { test, expect, type Page } from '@playwright/test';
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
  expect(restoreBody).toEqual({target:'new',displayName:'',confirmOverwrite:false,workspaceIds:['worker-2']});
});
test('an administrator configures write-only Google OAuth installation credentials before linking',async({page})=>{const m=await open(page);const panel=m.locator('[data-testid="google-oauth-installation"]');await expect(panel).toBeVisible();await panel.getByLabel('Client ID').fill('dashboard-client');await panel.getByLabel('Redirect URI').fill('https://dash.example/api/backup-providers/google/oauth/callback');await panel.getByLabel('Client secret').fill('DO_NOT_RENDER_SECRET');await panel.getByRole('button',{name:'Save Google OAuth configuration'}).click();await expect(panel).toContainText('Configured from installation');await expect(panel).not.toContainText('DO_NOT_RENDER_SECRET')});
