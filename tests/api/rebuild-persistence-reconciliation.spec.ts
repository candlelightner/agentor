import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { cleanupWorker, createWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { captureCommandOutput } from '../helpers/terminal-ws';
import { createTestUser, deleteTestUser, type CreatedUser } from '../helpers/test-users';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const EMPTY_AUTH = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

function manifest(suffix: string) {
  return {
    schemaVersion: 1,
    name: `Rebuild persistence ${suffix}`,
    slug: `rebuild-persistence-${suffix}`,
    description: 'Minimal lifecycle plugin for rebuild persistence coverage.',
    version: '1.0.0',
    lifecycle: { start: { argv: ['true'] } },
  };
}

test.describe.serial('worker rebuild persistence and plugin reconciliation', () => {
  let owner: CreatedUser;
  let ownerCtx: APIRequestContext;
  let workerId = '';
  let definitionId = '';
  let installationId = '';

  test.beforeAll(async () => {
    owner = await createTestUser('Rebuild persistence owner');
    ownerCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect((await new ApiClient(ownerCtx).signInEmail(owner.email, owner.password)).status).toBe(200);
    workerId = (await createWorker(ownerCtx, { displayName: `rebuild-persistence-${Date.now()}` })).id;
  });

  test.afterAll(async () => {
    if (installationId)
      await ownerCtx.delete(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}`).catch(() => undefined);
    if (definitionId)
      await ownerCtx.delete(`${BASE_URL}/api/plugins/definitions/${definitionId}`).catch(() => undefined);
    if (workerId) await cleanupWorker(ownerCtx, workerId).catch(() => undefined);
    await ownerCtx?.dispose();
    if (owner) await deleteTestUser(owner.id).catch(() => undefined);
  });

  test('rebuild retains workspace and selected Codex state while refreshing the enabled plugin runtime', async () => {
    test.setTimeout(180_000);
    const stamp = `${Date.now()}`;
    const workspaceMarker = `workspace-${stamp}`;
    const codexMarker = `codex-${stamp}`;
    const settings = await ownerCtx.put('/api/backup-settings', {
      data: {
        enabled: false,
        selection: 'selected',
        workspaceIds: [workerId],
        selectedPathsByWorkspace: {
          [workerId]: ['/workspace', '/home/agent/.agent-data', '/home/agent/.agent-data/.codex'],
        },
      },
    });
    expect(settings.status(), await settings.text()).toBe(200);

    const definition = await ownerCtx.post(`${BASE_URL}/api/plugins/definitions`, {
      data: { scope: 'owner', manifest: manifest(stamp) },
    });
    expect(definition.status()).toBe(201);
    definitionId = (await definition.json()).id;
    const installed = await ownerCtx.post(`${BASE_URL}/api/containers/${workerId}/plugins`, {
      data: { definitionId, desiredEnabled: true },
    });
    expect(installed.status()).toBe(201);
    const before = await installed.json();
    installationId = before.id;
    expect(before.observed).toMatchObject({ state: 'ready', ready: true, runtimeGeneration: expect.any(String) });

    await captureCommandOutput(
      workerId,
      `printf %s ${workspaceMarker} > /workspace/rebuild-workspace-marker && mkdir -p /home/agent/.agent-data/.codex/sessions && printf %s ${codexMarker} > /home/agent/.agent-data/.codex/sessions/rebuild-codex-marker`,
    );
    const rebuilt = await new ApiClient(ownerCtx).rebuildContainer(workerId);
    expect(rebuilt.status).toBe(200);
    await waitForWorkerRunning(ownerCtx, workerId, 90_000);

    expect(await captureCommandOutput(workerId, 'cat /workspace/rebuild-workspace-marker')).toContain(workspaceMarker);
    expect(await captureCommandOutput(workerId, 'cat /home/agent/.agent-data/.codex/sessions/rebuild-codex-marker')).toContain(codexMarker);
    const plugins = await ownerCtx.get(`${BASE_URL}/api/containers/${workerId}/plugins`);
    expect(plugins.status()).toBe(200);
    expect(await plugins.json()).toContainEqual(expect.objectContaining({
      id: installationId,
      definitionId,
      desiredEnabled: true,
      observed: expect.objectContaining({
        state: 'ready',
        ready: true,
        runtimeGeneration: rebuilt.body.containerId,
      }),
    }));
    expect(rebuilt.body.containerId).not.toBe(before.observed.runtimeGeneration);
  });
});
