import { expect, test } from '@playwright/test';
import {
  validBackupRestoreRuntimePrincipal,
  isBackupRestoreLegacyAuthorized,
  type BackupRestoreRuntimePrincipal,
} from '../../orchestrator/server/utils/backup-restore-runtime-authority';

test('restore principal validation is exact, bounded and compatible with missing historical fields', () => {
  expect(validBackupRestoreRuntimePrincipal(undefined)).toBe(true);
  expect(validBackupRestoreRuntimePrincipal({ kind: 'admin-user', userId: 'historical_Admin-123' })).toBe(true);
  expect(validBackupRestoreRuntimePrincipal({ kind: 'platform-workspace', workspaceId: 'workspace-123' })).toBe(true);
  for (const value of [null, false, [], 'admin-user', {},
    { kind: 'group-workspace', workspaceId: 'group' },
    { kind: 'admin-user', userId: 'owner', authorized: true },
    { kind: 'admin-user', userId: 'owner', [Symbol('hidden')]: true },
    { kind: 'admin-user', userId: 'owner', workspaceId: 'workspace' },
    { kind: 'platform-workspace', workspaceId: 'workspace', userId: 'owner' },
    { kind: 'admin-user' }, { kind: 'platform-workspace', workspaceId: 42 },
    ...['', '../owner', '/owner', 'owner%2fescape', 'owner.name', 'owner\n', 'a'.repeat(201)].map(userId =>
      ({ kind: 'admin-user', userId }))]) expect(validBackupRestoreRuntimePrincipal(value)).toBe(false);
});

function fixture() {
  const calls: string[] = [];
  const state = { admin: true, enabled: true,
    workspace: { id: 'platform-workspace', kind: 'administrative', trusted: true } as any };
  const dependencies = {
    isAdminUser: (id: string) => { calls.push('admin:' + id); return state.admin; },
    platformWorkspace: () => { calls.push('workspace'); return state.workspace; },
    backupsEnabled: () => { calls.push('policy'); return state.enabled; },
  };
  return { calls, state, dependencies };
}

test('admin-user permission uses the actual issuing actor and is rechecked after demotion', async () => {
  const f = fixture(), principal: BackupRestoreRuntimePrincipal = { kind: 'admin-user', userId: 'actual-actor' };
  expect(await isBackupRestoreLegacyAuthorized(principal, f.dependencies)).toBe(true);
  f.state.admin = false;
  expect(await isBackupRestoreLegacyAuthorized(principal, f.dependencies)).toBe(false);
  expect(f.calls).toEqual(['admin:actual-actor', 'admin:actual-actor']);
});

test('platform permission requires the exact current trusted admin workspace and enabled backup policy', async () => {
  const principal: BackupRestoreRuntimePrincipal = { kind: 'platform-workspace', workspaceId: 'platform-workspace' };
  const f = fixture();
  expect(await isBackupRestoreLegacyAuthorized(principal, f.dependencies)).toBe(true);
  expect(f.calls).toEqual(['workspace', 'policy', 'workspace']);
  for (const scenario of ['removed', 'replaced', 'group', 'untrusted', 'disabled']) {
    const other = fixture();
    if (scenario === 'removed') other.state.workspace = undefined;
    if (scenario === 'replaced') other.state.workspace.id = 'replacement';
    if (scenario === 'group') other.state.workspace.kind = 'group-administrative';
    if (scenario === 'untrusted') other.state.workspace.trusted = false;
    if (scenario === 'disabled') other.state.enabled = false;
    expect(await isBackupRestoreLegacyAuthorized(principal, other.dependencies)).toBe(false);
    expect(other.calls.some(call => call.startsWith('admin:'))).toBe(false);
  }
});

test('workspace revocation during asynchronous policy read is not cached as authorization', async () => {
  const f = fixture(), principal: BackupRestoreRuntimePrincipal = { kind: 'platform-workspace', workspaceId: 'platform-workspace' };
  expect(await isBackupRestoreLegacyAuthorized(principal, { ...f.dependencies,
    backupsEnabled: async () => { f.state.workspace = undefined; return true; },
  })).toBe(false);
});

test('missing/malformed principals and unavailable authority fail closed without credential lookup', async () => {
  const f = fixture();
  for (const value of [undefined, { kind: 'admin-user', userId: '../actor' },
    { kind: 'platform-workspace', workspaceId: 'platform-workspace', authorized: true }])
    expect(await isBackupRestoreLegacyAuthorized(value as any, f.dependencies)).toBe(false);
  expect(f.calls).toEqual([]);
  for (const principal of [{ kind: 'admin-user', userId: 'actor' },
    { kind: 'platform-workspace', workspaceId: 'platform-workspace' }] as BackupRestoreRuntimePrincipal[])
    expect(await isBackupRestoreLegacyAuthorized(principal, {
      isAdminUser() { throw new Error('database unavailable'); },
      platformWorkspace() { throw new Error('workspace unavailable'); },
      backupsEnabled() { throw new Error('policy unavailable'); },
    })).toBe(false);
});
