import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { ApiClient } from '../helpers/api-client';
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
    name: `REST plugin ${suffix}`,
    slug: `rest-plugin-${suffix.toLowerCase()}`,
    description: 'A minimal disabled plugin used only for the REST contract test.',
    version: '1.0.0',
    lifecycle: { start: { argv: ['true'] } },
    actions: [{ id: 'open', label: 'Open', kind: 'private-ui', portId: 'ui', path: '/' }],
    resources: { ports: [{ id: 'ui', protocol: 'http', rangeStart: 39100, rangeEnd: 39199 }] },
  };
}

test.describe.serial('Plugin REST contract', () => {
  let workerId = '';
  let definitionId = '';
  let installationId = '';

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request, { displayName: `PluginRest-${Date.now()}` })).id;
  });
  test.afterAll(async ({ request }) => {
    if (installationId) await request.delete(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}`).catch(() => undefined);
    if (definitionId) await request.delete(`${BASE_URL}/api/plugins/definitions/${definitionId}`).catch(() => undefined);
    if (workerId) await cleanupWorker(request, workerId);
  });

  test('creates, lists, installs disabled, changes desired state, and removes a plugin', async ({ request }) => {
    const suffix = String(Date.now());
    const create = await request.post(`${BASE_URL}/api/plugins/definitions`, { data: { scope: 'owner', manifest: manifest(suffix) } });
    expect(create.status()).toBe(201);
    const definition = await create.json();
    definitionId = definition.id;
    expect(definition).toMatchObject({ id: expect.any(String), name: `REST plugin ${suffix}`, scope: 'owner', builtIn: false });

    const listed = await request.get(`${BASE_URL}/api/plugins/definitions?workerId=${workerId}`);
    expect(listed.status()).toBe(200);
    expect(await listed.json()).toContainEqual(expect.objectContaining({
      id: definitionId,
      manifest: expect.objectContaining({
        schemaVersion: 1,
        name: `REST plugin ${suffix}`,
        slug: `rest-plugin-${suffix.toLowerCase()}`,
        version: '1.0.0',
        description: expect.any(String),
      }),
    }));

    const installed = await request.post(`${BASE_URL}/api/containers/${workerId}/plugins`, { data: { definitionId, desiredEnabled: false } });
    expect(installed.status()).toBe(201);
    const installation = await installed.json();
    installationId = installation.id;
    expect(installation).toMatchObject({ id: expect.any(String), definitionId, desiredEnabled: false, observed: { state: 'disabled', ready: false } });

    const workerPlugins = await request.get(`${BASE_URL}/api/containers/${workerId}/plugins`);
    expect(workerPlugins.status()).toBe(200);
    expect((await workerPlugins.json()).some((item: any) => item.id === installationId)).toBe(true);

    const disabled = await request.put(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}/enabled`, { data: { enabled: false } });
    expect(disabled.status()).toBe(200);
    expect((await disabled.json()).desiredEnabled).toBe(false);

    const blockedDelete = await request.delete(`${BASE_URL}/api/plugins/definitions/${definitionId}`);
    expect(blockedDelete.status()).toBe(409);

    const remove = await request.delete(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}`);
    expect(remove.status()).toBe(204);
    installationId = '';

    const definitionDelete = await request.delete(`${BASE_URL}/api/plugins/definitions/${definitionId}`);
    expect(definitionDelete.status()).toBe(204);
    definitionId = '';
  });
});

test('global admin derives target-worker ownership for owner and worker plugin definitions', async ({ request }) => {
  let owner: CreatedUser | undefined;
  let ownerRequest: APIRequestContext | undefined;
  let workerId = '';
  const definitionIds: string[] = [];
  try {
    owner = await createTestUser(`Plugin target owner ${Date.now()}`);
    ownerRequest = await playwrightRequest.newContext(EMPTY_AUTH);
    expect((await new ApiClient(ownerRequest).signInEmail(owner.email, owner.password)).status).toBe(200);
    workerId = (await createWorker(ownerRequest, { displayName: `PluginTarget-${Date.now()}` })).id;
    const suffix = String(Date.now());
    const ownerDefinition = await request.post('/api/plugins/definitions', {
      data: { scope: 'owner', targetWorkerId: workerId, manifest: manifest(`target-owner-${suffix}`) },
    });
    const ownerPayload = await ownerDefinition.text();
    expect(ownerDefinition.status(), ownerPayload).toBe(201);
    const ownerBody = JSON.parse(ownerPayload);
    definitionIds.push(ownerBody.id);
    expect(ownerBody).toMatchObject({ scope: 'owner', userId: owner.id });

    const workerDefinition = await request.post('/api/plugins/definitions', {
      data: { scope: 'worker', workerId, manifest: manifest(`target-worker-${suffix}`) },
    });
    const workerPayload = await workerDefinition.text();
    expect(workerDefinition.status(), workerPayload).toBe(201);
    const workerBody = JSON.parse(workerPayload);
    definitionIds.push(workerBody.id);
    expect(workerBody).toMatchObject({ scope: 'worker', userId: owner.id, workerId });
    const visible = await ownerRequest.get(`/api/plugins/definitions?workerId=${workerId}`);
    expect(visible.status()).toBe(200);
    expect(await visible.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownerBody.id, userId: owner.id }),
      expect.objectContaining({ id: workerBody.id, userId: owner.id, workerId }),
    ]));
  } finally {
    for (const definitionId of definitionIds)
      await request.delete(`/api/plugins/definitions/${definitionId}`).catch(() => undefined);
    if (workerId && ownerRequest) await cleanupWorker(ownerRequest, workerId);
    await ownerRequest?.dispose();
    if (owner) await deleteTestUser(owner.id);
  }
});
