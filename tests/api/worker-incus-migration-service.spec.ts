import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { WorkerIncusMigrationService, migrationLockPassword, migrationPeerLockPasswords, migrationStartRequest, type WorkerIncusMigrationDependencies,
  type WorkerMigrationPrincipal } from '../../orchestrator/server/utils/worker-incus-migration-service';
import { ManagementWorkerMigrationDomain } from '../../orchestrator/server/utils/management-worker-migration-domain';
import type { WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { ManagementMcpStore } from '../../orchestrator/server/utils/management-mcp-store';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const id = randomUUID(), calls: string[] = [];
  const state = { admin: true, enabled: true, locked: false, mutation: '', demoteInside: false,
    workspace: { id: 'platform-workspace', kind: 'administrative', trusted: true } as
      { id: string; kind: string; trusted: boolean } | undefined,
    record: { id, userId: 'worker-owner', displayName: 'Ordinary', status: 'active', runtimeKind: 'legacy-docker',
      createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } as WorkerRecord };
  const dependencies: WorkerIncusMigrationDependencies = {
    isAdminUser: user => { calls.push('admin:' + user); return state.admin; },
    platformWorkspace: () => { calls.push('workspace'); return state.workspace; },
    workerLifecycleEnabled: () => { calls.push('worker-lifecycle-policy'); return state.enabled; },
    findWorker: async workerId => { calls.push('find:' + workerId); return workerId === id ? state.record : undefined; },
    verifyUnlock: async (workerId, password) => {
      calls.push('lock:' + workerId);
      if (state.locked && password !== 'correct-password') throw Object.assign(new Error('Protected worker'), { statusCode: 423 });
    },
    migrate: async (workerId, current) => {
      calls.push('migrate:' + workerId); await current();
      if (state.demoteInside) state.admin = false;
      await current(); state.mutation = 'migrate'; state.record.runtimeKind = 'incus-vm';
      state.record.incusMigration = { nonce: randomUUID(), phase: 'retained', source: {
        containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), createdAt: new Date(0).toISOString(), wasRunning: true } };
      return { privateSource: '/private/never-return', runtimeAddress: '10.0.0.99' };
    },
    finalize: async (workerId, current) => { calls.push('finalize:' + workerId); await current(); state.mutation = 'finalize'; delete state.record.incusMigration; },
  };
  const service = new WorkerIncusMigrationService(dependencies), domain = new ManagementWorkerMigrationDomain(service);
  const admin: WorkerMigrationPrincipal = { kind: 'admin-user', userId: 'platform-admin' };
  const platform: WorkerMigrationPrincipal = { kind: 'platform-workspace', workspaceId: 'platform-workspace' };
  return { id, calls, state, dependencies, service, domain, admin, platform };
}

test('registered migration MCP schemas are platform-only and honor the existing lifecycle policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-migration-mcp-'));
  try {
    const store = new ManagementMcpStore(dir, async () => {});
    await store.updatePolicy({ 'worker-lifecycle': true }, 'fixture-admin');
    const identity = { workspaceId: 'platform', audience: 'agentor-management-mcp' as const,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), persistedInWorkspace: false as const, scope: 'platform' as const };
    const tools = (await store.listTools(identity)).filter(tool => tool.name.startsWith('migration.'));
    expect(tools.map(tool => tool.name).sort()).toEqual(['migration.finalize', 'migration.start', 'migration.status']);
    expect(tools.find(tool => tool.name === 'migration.start')?.inputSchema).toMatchObject({
      type: 'object', additionalProperties: false, required: ['workerId'],
      properties: { lockPasswords: { writeOnly: true } },
    });
    expect((await store.listTools({ ...identity, scope: 'group', ownerId: 'owner', groupId: 'group' }))
      .some(tool => tool.name.startsWith('migration.'))).toBe(false);
    await store.updatePolicy({ 'worker-lifecycle': false }, 'fixture-admin');
    expect((await store.listTools(identity)).some(tool => tool.name.startsWith('migration.'))).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('REST-equivalent and MCP migration invoke the same business operation and return only sanitized state', async () => {
  const f = fixture();
  expect(await f.service.status(f.id, f.admin)).toEqual({ kind: 'legacy-docker', phase: 'none', recoveryRequired: false, sourceRetained: false });
  expect(await f.domain.execute('migration.start', { workerId: f.id }, f.platform)).toEqual({ handled: true,
    result: { kind: 'incus-vm', phase: 'retained', recoveryRequired: false, sourceRetained: true } });
  expect(f.calls.filter(call => call.startsWith('migrate:'))).toEqual(['migrate:' + f.id]);
  expect(await f.service.finalize(f.id, f.admin)).toEqual({ kind: 'incus-vm', phase: 'none', recoveryRequired: false, sourceRetained: false });
  expect(f.calls.filter(call => call.startsWith('finalize:'))).toEqual(['finalize:' + f.id]);
  expect(JSON.stringify(await f.service.status(f.id, f.admin))).not.toMatch(/private|containerId|imageId|address|nonce|password/i);
});

test('status preserves historical legacy default and names unresolved recovery without leaking private receipt fields', async () => {
  const f = fixture(); delete f.state.record.runtimeKind;
  f.state.record.incusMigration = { nonce: randomUUID(), phase: 'recovery-required', source: {
    containerId: 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64), createdAt: 'private-time', wasRunning: false },
    sourceDirectories: [{ path: '/private/account', dev: 1, ino: 2 }] };
  expect(await f.service.status(f.id, f.admin)).toEqual({ kind: 'legacy-docker', phase: 'recovery-required', recoveryRequired: true, sourceRetained: true });
});

test('missing, group, ordinary and spoofed principals never reach worker data or migrations', async () => {
  for (const actor of [undefined, { kind: 'ordinary-worker', workspaceId: 'platform-workspace' },
    { kind: 'group-workspace', workspaceId: 'platform-workspace' }, { kind: 'admin-user', userId: '../admin' },
    { kind: 'admin-user', userId: 'platform-admin', runtimeKind: 'incus-vm' }]) {
    const f = fixture();
    await expect(f.service.migrate(f.id, actor as WorkerMigrationPrincipal)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.calls).toEqual([]);
  }
  const f = fixture(); f.state.admin = false;
  await expect(f.service.status(f.id, f.admin)).rejects.toMatchObject({ statusCode: 403 });
  expect(f.calls.some(call => call.startsWith('find:'))).toBe(false);
});

test('platform workspace requires exact trusted platform identity and worker-lifecycle policy, never backups policy', async () => {
  for (const mode of ['missing', 'replaced', 'group', 'untrusted', 'disabled', 'during-policy']) {
    const f = fixture();
    if (mode === 'missing') f.state.workspace = undefined;
    if (mode === 'replaced') f.state.workspace!.id = 'other-workspace';
    if (mode === 'group') f.state.workspace!.kind = 'group-administrative';
    if (mode === 'untrusted') f.state.workspace!.trusted = false;
    if (mode === 'disabled') f.state.enabled = false;
    if (mode === 'during-policy') f.dependencies.workerLifecycleEnabled = async () => { f.state.workspace = undefined; return true; };
    await expect(f.service.migrate(f.id, f.platform)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.state.mutation).toBe(''); expect(f.calls.some(call => call.startsWith('migrate:'))).toBe(false);
  }
  const f = fixture(); await f.service.status(f.id, f.platform);
  expect(f.calls).toContain('worker-lifecycle-policy'); expect(f.calls.some(call => call.startsWith('admin:'))).toBe(false);
});

test('admin demotion at a ContainerManager mutation boundary blocks actual cutover', async () => {
  const f = fixture(); f.state.demoteInside = true;
  await expect(f.service.migrate(f.id, f.admin)).rejects.toMatchObject({ statusCode: 403, code: 'WORKER_MIGRATION_AUTH_REVOKED' });
  expect(f.state.mutation).toBe(''); expect(f.state.record.runtimeKind).toBe('legacy-docker');
});

test('worker protection locks guard migrate and finalize with transient passwords and post-await authorization', async () => {
  for (const action of ['migrate', 'finalize'] as const) {
    const f = fixture(); f.state.locked = true;
    await expect(f.service[action](f.id, f.admin)).rejects.toMatchObject({ statusCode: 423 });
    expect(f.calls.some(call => call.startsWith(action + ':'))).toBe(false);
    await f.service[action](f.id, f.admin, 'correct-password'); expect(f.state.mutation).toBe(action);
    expect(JSON.stringify(f.state.record)).not.toContain('correct-password');
    const revoked = fixture(); revoked.dependencies.verifyUnlock = async () => { revoked.state.admin = false; };
    await expect(revoked.service[action](revoked.id, revoked.admin)).rejects.toMatchObject({ statusCode: 403 });
    expect(revoked.state.mutation).toBe('');
  }
});

test('migration forwards a cloned transient peer-lock map with current worker password overriding caller map', async () => {
  const f = fixture(), peerId = randomUUID(), passwords = { [f.id]: 'stale-own', [peerId]: 'peer-secret' };
  let observed: Record<string, string> | undefined;
  f.dependencies.migrate = async (_id, current, peers) => { observed = peers; passwords[peerId] = 'changed'; await current(); };
  await f.domain.execute('migration.start', { workerId: f.id, lockPassword: 'current-own', lockPasswords: passwords }, f.platform);
  expect(observed).toEqual({ [f.id]: 'current-own', [peerId]: 'peer-secret' });
  expect(JSON.stringify(f.state.record)).not.toMatch(/secret|current-own|stale-own/);
  expect(migrationStartRequest({ lockPassword: 'current-own', lockPasswords: { [peerId]: 'peer-secret' } }))
    .toEqual({ lockPassword: 'current-own', lockPasswords: { [peerId]: 'peer-secret' } });
  for (const value of [null, [], { '../worker': 'password' }, { [peerId]: 1 }, { [peerId]: 'x'.repeat(1025) }, { [Symbol('hidden')]: 'password' }])
    expect(() => migrationPeerLockPasswords(value)).toThrow();
  expect(() => migrationStartRequest({ lockPasswords: passwords, project: 'default' })).toThrow();
  await expect(f.domain.execute('migration.finalize', { workerId: f.id, lockPasswords: passwords }, f.platform)).rejects.toMatchObject({ statusCode: 400 });
});

test('exact REST and MCP schemas reject runtime/source/path grants and keep migration tools lifecycle-only', async () => {
  const f = fixture();
  expect(migrationLockPassword({})).toBeUndefined(); expect(migrationLockPassword({ lockPassword: 'secret' })).toBe('secret');
  for (const body of [null, [], { runtimeKind: 'incus-vm' }, { source: 'arbitrary' }, { project: 'default' },
    { lockPassword: 42 }, { lockPassword: 'x'.repeat(1025) }, { [Symbol('hidden')]: true }]) expect(() => migrationLockPassword(body)).toThrow();
  for (const args of [{ workerId: f.id, principal: f.admin }, { workerId: f.id, path: '/host' }, { workerId: f.id, runtimeKind: 'legacy-docker' },
    { workerId: f.id, lockPassword: false }, { workerId: f.id, [Symbol('hidden')]: true }])
    await expect(f.domain.execute('migration.start', args, f.platform)).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.domain.execute('migration.status', { workerId: f.id, lockPassword: 'secret' }, f.platform)).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.domain.execute('migration.start', { workerId: f.id })).rejects.toMatchObject({ statusCode: 403 });
  expect(await f.domain.execute('unrelated.tool', {}, f.platform)).toEqual({ handled: false });
  for (const tool of f.domain.tools()) { expect(tool.group).toBe('worker-lifecycle'); expect(tool.inputSchema.additionalProperties).toBe(false); }
  expect(f.domain.tools().find(tool => tool.name === 'migration.finalize')!.annotations.destructiveHint).toBe(true);
  await expect(f.service.status('../worker', f.admin)).rejects.toMatchObject({ statusCode: 400 });
  await expect(f.service.status(randomUUID(), f.admin)).rejects.toMatchObject({ statusCode: 404 });
});
