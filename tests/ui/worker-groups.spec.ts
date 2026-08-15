import { expect, test } from '@playwright/test';
import { cleanupWorker, createWorker } from '../helpers/worker-lifecycle';
import { goToDashboard } from '../helpers/ui-helpers';

test.describe.serial('Worker groups dashboard', () => {
  let workerId = '';
  let workerName = '';
  let ungroupedWorkerId = '';
  let ungroupedWorkerName = '';
  let secondWorkerId = '';
  let secondWorkerName = '';
  let groupId = '';
  let treeRootId = '';
  let treeChildId = '';

  test.beforeAll(async ({ request }) => {
    const worker = await createWorker(request, {
      displayName: `group-ui-worker-${Date.now()}`,
    });
    workerId = worker.id;
    workerName = String(worker.displayName);
    const ungroupedWorker = await createWorker(request, {
      displayName: `group-ui-worker-ungrouped-${Date.now()}`,
    });
    ungroupedWorkerId = ungroupedWorker.id;
    ungroupedWorkerName = String(ungroupedWorker.displayName);
    const secondWorker = await createWorker(request, {
      displayName: `group-ui-worker-second-${Date.now()}`,
    });
    secondWorkerId = secondWorker.id;
    secondWorkerName = String(secondWorker.displayName);
  });

  test.afterAll(async ({ request }) => {
    if (groupId) await request.delete(`/api/worker-groups/${groupId}`).catch(() => {});
    if (treeChildId) await request.delete(`/api/worker-groups/${treeChildId}`).catch(() => {});
    if (treeRootId) await request.delete(`/api/worker-groups/${treeRootId}`).catch(() => {});
    if (workerId) await cleanupWorker(request, workerId);
    if (ungroupedWorkerId) await cleanupWorker(request, ungroupedWorkerId);
    if (secondWorkerId) await cleanupWorker(request, secondWorkerId);
  });

  test('creates a group, changes real worker membership, and deletes only the group', async ({ page, request }) => {
    const groupName = `UI experiment ${Date.now()}`;
    await goToDashboard(page);
    await page.getByRole('button', { name: 'Worker groups' }).click();
    const modal = page.getByRole('dialog', { name: 'Worker groups' });
    await expect(modal).toBeVisible();
    await modal.getByLabel('Group name').fill(groupName);
    await modal.getByRole('button', { name: 'Create group' }).click();
    const group = modal
      .locator('strong')
      .filter({ hasText: new RegExp(`^${groupName}$`) })
      .locator('xpath=ancestor::section[1]');
    await expect(group).toBeVisible();
    const membership = group.getByRole('checkbox', { name: workerName });
    await membership.check();
    await group.getByRole('checkbox', { name: secondWorkerName }).check();
    await expect(membership).toBeChecked();
    await expect
      .poll(async () => {
        const groups = (await (await request.get('/api/worker-groups')).json()) as Array<{ id: string; name: string; workerIds: string[] }>;
        const persisted = groups.find((entry) => entry.name === groupName);
        groupId = persisted?.id || '';
        return persisted?.workerIds || [];
      })
      .toEqual([workerId, secondWorkerId]);
    const workerGroupCards = page.getByTestId(`worker-group-cards-${groupId}`);
    await expect(workerGroupCards).toBeVisible();
    await expect(workerGroupCards.getByText(groupName, { exact: true })).toBeVisible();
    await expect(workerGroupCards.getByText(workerName, { exact: true })).toBeVisible();
    await expect(workerGroupCards.getByText(secondWorkerName, { exact: true })).toBeVisible();
    await expect(workerGroupCards.locator('h3')).toHaveCount(2);
    await expect(workerGroupCards.getByText(ungroupedWorkerName, { exact: true })).toHaveCount(0);
    await group.getByRole('button', { name: 'Provision group admin' }).click();
    await expect(group.getByText('running', { exact: true })).toBeVisible({
      timeout: 120_000,
    });
    await expect.poll(async () => (await request.get(`/api/worker-groups/${groupId}/admin-workspace`)).status(), { timeout: 120_000 }).toBe(200);
    await expect(workerGroupCards.getByText('GROUP ADMIN', { exact: true })).toBeVisible();
    await expect(workerGroupCards.locator('h3')).toHaveCount(3);
    await group.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(page.getByTestId('workspace-files-modal')).toBeVisible();
    await expect(page.getByTestId('workspace-files-modal')).toContainText('Group administrator');
    await page.getByTestId('workspace-files-modal').getByRole('button', { name: 'Close', exact: true }).last().click();
    await group.getByRole('button', { name: 'Open terminal' }).click();
    await expect(page.getByText('GROUP ADMIN - Terminal', { exact: true })).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Worker groups' }).click();
    const reopened = page
      .getByRole('dialog', { name: 'Worker groups' })
      .locator('strong')
      .filter({ hasText: new RegExp(`^${groupName}$`) })
      .locator('xpath=ancestor::section[1]');
    // Recursive groups are deliberately non-destructive: an occupied group
    // must be emptied before it can be deleted. Removing membership must not
    // remove the workers themselves.
    await reopened.getByRole('checkbox', { name: workerName }).uncheck();
    await reopened.getByRole('checkbox', { name: secondWorkerName }).uncheck();
    await expect.poll(async () => {
      const persisted = await (await request.get(`/api/worker-groups/${groupId}`)).json();
      return persisted.workerIds;
    }).toEqual([]);
    await reopened.getByRole('button', { name: 'Delete' }).click();
    await expect(reopened).toBeHidden();
    groupId = '';
    expect((await request.get(`/api/containers/${workerId}`)).status()).toBe(200);
  });

  test('renders child groups recursively and offers only legal parent moves', async ({ page, request }) => {
    const stamp = Date.now();
    const root = await (await request.post('/api/worker-groups', { data: { name: `Tree root ${stamp}` } })).json();
    treeRootId = root.id;
    const child = await (await request.post('/api/worker-groups', { data: { name: `Tree child ${stamp}`, parentId: treeRootId } })).json();
    treeChildId = child.id;
    expect((await request.put('/api/worker-groups/assignment', { data: { workerId: ungroupedWorkerId, groupId: treeChildId } })).ok()).toBeTruthy();

    await goToDashboard(page);
    const rootBox = page.getByTestId(`worker-group-cards-${treeRootId}`);
    const childBox = page.getByTestId(`worker-group-cards-${treeChildId}`);
    await expect(rootBox).toBeVisible();
    await expect(childBox).toBeVisible();
    await expect(rootBox.locator(`[data-testid="worker-group-cards-${treeChildId}"]`)).toBeVisible();
    await expect(childBox.getByText(ungroupedWorkerName, { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Worker groups' }).click();
    const modal = page.getByRole('dialog', { name: 'Worker groups' });
    const childSection = modal.getByTestId(`worker-group-${treeChildId}`);
    await expect(childSection).toHaveAttribute('data-depth', '1');
    await expect(childSection).toContainText(`Tree root ${stamp} / Tree child ${stamp}`);
    await expect(modal.getByLabel(`Parent for Tree root ${stamp}`).locator(`option[value="${treeChildId}"]`)).toHaveCount(0);

    await request.put('/api/worker-groups/assignment', { data: { workerId: ungroupedWorkerId, groupId: null } });
  });

  test('manages write-only group variables and descendant inheritance by name', async ({ page }) => {
    await goToDashboard(page);
    await page.getByRole('button', { name: 'Worker groups' }).click();
    let modal = page.getByRole('dialog', { name: 'Worker groups' });
    const root = modal.getByTestId(`worker-group-${treeRootId}`);
    await root.getByText('Group variables', { exact: true }).click();
    await root.getByLabel('Group variable name').fill('ROOT_SHARED_TOKEN');
    const secret = root.getByLabel('Group variable value');
    await expect(secret).toHaveAttribute('type', 'password');
    await secret.fill('write-only-group-value');
    await root.getByRole('button', { name: 'Add or replace' }).click();
    await expect(root).toContainText('ROOT_SHARED_TOKEN · configured');
    expect(await root.textContent()).not.toContain('write-only-group-value');

    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Worker groups' }).click();
    modal = page.getByRole('dialog', { name: 'Worker groups' });
    const child = modal.getByTestId(`worker-group-${treeChildId}`);
    await child.getByText('Group variables', { exact: true }).click();
    const inherited = child.getByLabel('Inherit ancestor ROOT_SHARED_TOKEN');
    await expect(inherited).toBeChecked();
    await inherited.uncheck();
    await child.getByRole('button', { name: 'Save inherited selection' }).click();
    await expect(inherited).not.toBeChecked();
  });
});
