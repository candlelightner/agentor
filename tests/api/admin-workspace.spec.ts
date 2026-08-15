import { test, expect, request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser, type CreatedUser } from '../helpers/test-users';
import { captureCommandOutput } from '../helpers/terminal-ws';

const GLOBAL_ADMIN_ROLE_SKILL_SHA256 = 'e502f6e894263e4f7e8369a49c0bd36a564783e59f979a91e326e73494f1ec41';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const EMPTY_AUTH = { baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL }, storageState: { cookies: [], origins: [] } };

async function parsed(res: APIResponse): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

test.describe.serial('Persistent administrative workspace', () => {
  let regular: CreatedUser;
  let regularCtx: APIRequestContext;
  let anonymous: APIRequestContext;
  let normalWorker = '';
  let adminWorkspaceId = '';

  test.beforeAll(async ({ request }) => {
    regular = await createTestUser('Admin Workspace Isolation');
    regularCtx = await playwrightRequest.newContext(EMPTY_AUTH);
    expect((await new ApiClient(regularCtx).signInEmail(regular.email, regular.password)).status).toBe(200);
    normalWorker = (await createWorker(regularCtx, { displayName: `normal-not-admin-${Date.now()}` })).id;
    anonymous = await playwrightRequest.newContext(EMPTY_AUTH);
    const ensured = await request.post('/api/admin/workspace', { data: {} });
    expect([200, 201]).toContain(ensured.status());
    adminWorkspaceId = (await ensured.json()).id;
  });

  test.afterAll(async () => {
    if (normalWorker) await cleanupWorker(regularCtx, normalWorker).catch(() => {});
    await regularCtx?.dispose();
    await anonymous?.dispose();
    if (regular) await deleteTestUser(regular.id).catch(() => {});
  });

  test('administrative workspace endpoints are admin-only', async () => {
    for (const ctx of [anonymous, regularCtx]) {
      const expected = ctx === anonymous ? 401 : 403;
      expect((await ctx.get('/api/admin/workspace')).status()).toBe(expected);
      expect((await ctx.post('/api/admin/workspace', { data: {} })).status()).toBe(expected);
      expect((await ctx.post('/api/admin/workspace/rebuild', { data: {} })).status()).toBe(expected);
    }
  });

  test('workspace uses only the trusted immutable administrative image', async ({ request }) => {
    const res = await request.get('/api/admin/workspace');
    expect(res.status()).toBe(200);
    const workspace = await res.json();
    expect(workspace).toMatchObject({
      id: adminWorkspaceId,
      kind: 'administrative',
      trusted: true,
      image: expect.objectContaining({ name: expect.stringContaining('agentor-admin-worker'), digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/), promoted: true }),
    });
    expect(workspace.image).not.toHaveProperty('userSupplied', true);
  });

  test('identity markers and unmistakable administrative presentation are enforced', async ({ request }) => {
    const workspace = await (await request.get('/api/admin/workspace')).json();
    expect(workspace.presentation).toMatchObject({
      terminalTheme: 'administrative-red',
      banner: expect.stringMatching(/ADMIN\s*\/\s*ORCHESTRATOR/i),
      promptMarker: expect.stringMatching(/ADMIN|ORCHESTRATOR/i),
      browserTitle: expect.stringMatching(/ADMIN|ORCHESTRATOR/i),
      environmentMarker: 'AGENTOR_ADMIN_WORKSPACE',
      warningBeforePrivilegedActions: true,
    });
    expect(workspace.services).toEqual(expect.arrayContaining(['terminal', 'editor', 'desktop']));
  });

  test('existing terminal/editor/desktop service APIs resolve the stable admin workspace id while ordinary lifecycle APIs stay blocked', async ({ request }) => {
    expect((await regularCtx.post(`/api/containers/${adminWorkspaceId}/panes`, { data: {} })).status()).toBe(403);
    const pane = await request.post(`/api/containers/${adminWorkspaceId}/panes`, { data: {} });
    expect(pane.status()).toBe(201);
    const created = await pane.json();
    expect(typeof created.index).toBe('number');
    expect((await request.get(`/api/containers/${adminWorkspaceId}/editor/status`)).status()).toBe(200);
    expect((await request.get(`/api/containers/${adminWorkspaceId}/desktop/status`)).status()).toBe(200);
    expect((await request.post(`/api/containers/${adminWorkspaceId}/stop`, { data: {} })).status()).toBe(409);
    expect((await request.delete(`/api/containers/${adminWorkspaceId}`)).status()).toBe(409);
    await request.delete(`/api/containers/${adminWorkspaceId}/panes/${created.index}`);
  });

  test('workspace storage and identity persist across stop and restart', async ({ request }) => {
    const marker = `admin-persistence-${Date.now()}`;
    const write = await request.post('/api/admin/workspace/diagnostics/write-marker', { data: { marker } });
    expect(write.status()).toBe(200);
    expect((await request.post('/api/admin/workspace/stop', { data: {} })).status()).toBe(200);
    expect((await request.post('/api/admin/workspace/start', { data: {} })).status()).toBe(200);
    const status = await (await request.get('/api/admin/workspace')).json();
    expect(status.id).toBe(adminWorkspaceId);
    const read = await request.get('/api/admin/workspace/diagnostics/read-marker');
    expect(read.status()).toBe(200);
    expect(await read.json()).toMatchObject({ marker });
  });

  test('platform admin receives only its role skill and reconciles stale roles without deleting user skills', async ({ request }) => {
    const initial = await captureCommandOutput(adminWorkspaceId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-global-administration/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-global-administration/SKILL.md | cut -d' ' -f1)"
      test ! -e ~/.claude/skills/agentor-group-administration && test ! -e ~/.claude/skills/agentor-worker-runtime && printf 'CLAUDE_ISOLATED=1\\n'
      test ! -e ~/.agents/skills/agentor-group-administration && test ! -e ~/.agents/skills/agentor-worker-runtime && printf 'CODEX_ISOLATED=1\\n'
      test ! -e ~/.gemini/commands/agentor-group-administration.toml && test ! -e ~/.gemini/commands/agentor-worker-runtime.toml && printf 'GEMINI_ISOLATED=1\\n'
    `.trim().replace(/\n\s*/g, '; '));
    expect(initial).toContain(`CLAUDE_SHA=${GLOBAL_ADMIN_ROLE_SKILL_SHA256}`);
    expect(initial).toContain(`CODEX_SHA=${GLOBAL_ADMIN_ROLE_SKILL_SHA256}`);
    expect(initial).toContain('CLAUDE_ISOLATED=1');
    expect(initial).toContain('CODEX_ISOLATED=1');
    expect(initial).toContain('GEMINI_ISOLATED=1');

    await captureCommandOutput(adminWorkspaceId, `
      mkdir -p ~/.claude/skills/agentor-worker-runtime ~/.claude/skills/user-kept
      mkdir -p ~/.agents/skills/agentor-group-administration ~/.agents/skills/user-kept
      printf stale > ~/.claude/skills/agentor-worker-runtime/SKILL.md
      printf stale > ~/.agents/skills/agentor-group-administration/SKILL.md
      printf keep > ~/.claude/skills/user-kept/SKILL.md
      printf keep > ~/.agents/skills/user-kept/SKILL.md
      printf stale > ~/.gemini/commands/agentor-worker-runtime.toml
    `.trim().replace(/\n\s*/g, '; '));
    expect((await request.post('/api/admin/workspace/stop', { data: {} })).status()).toBe(200);
    expect((await request.post('/api/admin/workspace/start', { data: {} })).status()).toBe(200);

    const reconciled = await captureCommandOutput(adminWorkspaceId, `
      printf 'CLAUDE_SHA=%s\\n' "$(sha256sum ~/.claude/skills/agentor-global-administration/SKILL.md | cut -d' ' -f1)"
      printf 'CODEX_SHA=%s\\n' "$(sha256sum ~/.agents/skills/agentor-global-administration/SKILL.md | cut -d' ' -f1)"
      test ! -e ~/.claude/skills/agentor-group-administration && test ! -e ~/.claude/skills/agentor-worker-runtime && printf 'CLAUDE_ISOLATED=1\\n'
      test ! -e ~/.agents/skills/agentor-group-administration && test ! -e ~/.agents/skills/agentor-worker-runtime && printf 'CODEX_ISOLATED=1\\n'
      test ! -e ~/.gemini/commands/agentor-group-administration.toml && test ! -e ~/.gemini/commands/agentor-worker-runtime.toml && printf 'GEMINI_ISOLATED=1\\n'
      printf 'USER_SKILLS=%s\\n' "$(cat ~/.claude/skills/user-kept/SKILL.md ~/.agents/skills/user-kept/SKILL.md)"
    `.trim().replace(/\n\s*/g, '; '));
    expect(reconciled).toContain(`CLAUDE_SHA=${GLOBAL_ADMIN_ROLE_SKILL_SHA256}`);
    expect(reconciled).toContain(`CODEX_SHA=${GLOBAL_ADMIN_ROLE_SKILL_SHA256}`);
    expect(reconciled).toContain('CLAUDE_ISOLATED=1');
    expect(reconciled).toContain('CODEX_ISOLATED=1');
    expect(reconciled).toContain('GEMINI_ISOLATED=1');
    expect(reconciled).toContain('USER_SKILLS=keepkeep');
  });

  test('normal workers never gain administrative trust or management-network attachment', async ({ request }) => {
    const res = await request.get(`/api/admin/workspace/diagnostics/container-security?workerId=${normalWorker}`);
    expect(res.status()).toBe(200);
    const security = await res.json();
    expect(security).toMatchObject({ managedWorker: true, administrative: false, managementNetworkAttached: false });
    expect(security.networks).not.toContain('agentor-management');
    expect(JSON.stringify(security)).not.toMatch(/\/var\/run\/docker\.sock|\/run\/docker\.sock/);
  });

  test('administrative workspace has no raw Docker socket or unrestricted host mounts', async ({ request }) => {
    const res = await request.get('/api/admin/workspace/diagnostics/container-security');
    expect(res.status()).toBe(200);
    const security = await res.json();
    expect(security.managementNetworkAttached).toBe(true);
    expect(security.networks).toEqual(
      expect.arrayContaining(['agentor-management', 'agentor-admin-egress-v1']),
    );
    expect(security.networks).not.toContain('agentor-net');
    expect(security.publishedPorts).toEqual([]);
    expect(security.rawDockerSocket).toBe(false);
    expect(security.hostExecution).toBe(false);
    expect(security.hostFilesystemMounts).toEqual([]);
    expect(security.controlRepresentation).toBe(true);
    expect(JSON.stringify(security.mounts ?? [])).not.toMatch(/docker\.sock|^\/$|\/var\/lib\/docker|\/data\/users/);
  });

  test('a user-supplied worker image cannot be promoted implicitly to administrative authority', async ({ request }) => {
    const res = await request.post('/api/admin/workspace/image', { data: { image: 'untrusted.example/user/image:latest' } });
    expect(res.status()).toBe(400);
    expect(JSON.stringify(await parsed(res))).toMatch(/trusted|promot|digest/i);
  });
});
