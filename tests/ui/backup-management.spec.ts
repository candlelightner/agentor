import { test, expect, type Page } from '@playwright/test';
import { goToDashboard } from '../helpers/ui-helpers';

async function mock(page: Page) {
  let jobs:any[]=[]; let backups:any[]=[{id:'backup-1',workspaceIds:['worker-1'],provider:'fake',createdAt:'2026-01-01T00:00:00Z',sizeBytes:4096,integrityVerified:true,missingSecrets:['API_TOKEN']}];
  await page.route('**/api/backup-providers',r=>r.fulfill({json:[{id:'fake',type:'fake',connected:true},{id:'google',type:'google-drive',connected:false}]}));
  await page.route('**/api/admin/backup-providers/google-oauth',async r=>r.fulfill({json:r.request().method()==='PUT'?{configured:true,source:'installation',clientId:'dashboard-client',redirectUri:'https://dash.example/api/backup-providers/google/oauth/callback',clientSecretConfigured:true}:{configured:false,source:'none',clientSecretConfigured:false}}));
  await page.route('**/api/backup-settings',async r=>r.fulfill({json:r.request().method()==='PUT'?await r.request().postDataJSON():{providerId:'fake',enabled:false,selection:'all',workspaceIds:[],intervalMinutes:1440,retentionCount:7,nextRunAt:null}}));
  await page.route('**/api/backups',async r=>{if(r.request().method()==='POST'){const j={id:'job-1',status:'queued',phase:'queued',progress:0,consistency:{warning:'Running worker: crash-consistent copy'}};jobs=[j];return r.fulfill({status:202,json:j})}return r.fulfill({json:{backups,jobs}})});
  await page.route('**/api/backup-jobs/job-1/retry',r=>r.fulfill({status:202,json:{id:'job-2',status:'queued',phase:'queued',progress:0}}));
  await page.route('**/api/backups/backup-1/restore',r=>r.fulfill({status:202,json:{jobId:'restore-1'}}));
  await page.route('**/api/backups/backup-1',r=>{backups=[];return r.fulfill({status:204})});
}
async function open(page:Page){await goToDashboard(page);await page.getByRole('button',{name:/backup management/i}).click();return page.locator('[data-testid="backup-management"]')}
test.beforeEach(async({page})=>mock(page));
test('configures scheduling and starts a manual backup with progress and consistency warning',async({page})=>{const m=await open(page);await expect(m).toContainText('fake — linked');await m.getByLabel('Enable scheduled backups').check();await m.getByRole('button',{name:'Save schedule'}).click();await m.getByRole('button',{name:'Back up now'}).click();await expect(m).toContainText('queued · queued');await expect(m).toContainText('crash-consistent')});
test('restores safely into a new or lock-protected original worker without retaining its password',async({page})=>{
  const lockPassword='UI_BACKUP_LOCK_DO_NOT_RENDER';let restoreBody:any;
  await page.route('**/api/backups/backup-1/restore',async route=>{restoreBody=await route.request().postDataJSON();await route.fulfill({status:202,json:{jobId:'restore-1'}})});
  const m=await open(page);await expect(m).toContainText('Integrity verified');await expect(m).toContainText('API_TOKEN');await m.getByRole('button',{name:'Restore'}).click();await m.getByLabel('Original worker').check();await expect(m.getByRole('button',{name:'Start restore'})).toBeDisabled();await m.getByLabel(/Original worker is stopped/).check();await m.getByLabel(/Worker lock password/).fill(lockPassword);await m.getByRole('button',{name:'Start restore'}).click();
  expect(restoreBody).toMatchObject({target:'original',confirmOverwrite:true,lockPassword});await expect(m.getByLabel(/Worker lock password/)).toHaveCount(0);await expect(m).not.toContainText(lockPassword);
  await m.getByRole('button',{name:'Delete'}).click();await expect(m).not.toContainText('backup-1')
});
test('an administrator configures write-only Google OAuth installation credentials before linking',async({page})=>{const m=await open(page);const panel=m.locator('[data-testid="google-oauth-installation"]');await expect(panel).toBeVisible();await panel.getByLabel('Client ID').fill('dashboard-client');await panel.getByLabel('Redirect URI').fill('https://dash.example/api/backup-providers/google/oauth/callback');await panel.getByLabel('Client secret').fill('DO_NOT_RENDER_SECRET');await panel.getByRole('button',{name:'Save Google OAuth configuration'}).click();await expect(panel).toContainText('Configured from installation');await expect(panel).not.toContainText('DO_NOT_RENDER_SECRET')});
