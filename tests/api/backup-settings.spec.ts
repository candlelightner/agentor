import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';

(globalThis as any).useLogger ??= () => ({ error() {}, warn() {}, info() {}, debug() {} });

test('archiving a selected worker allows unrelated saves and deselection without reseeding retained paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-settings-archive-'));
  try {
    const manager = new BackupManager({ dataDir: root });
    const calls: any[] = [];
    let archived = false;
    manager.setPathPersistenceAdapter({ reconcileSelections: async (_owner, paths) => {
      calls.push(structuredClone(paths));
      if (archived && paths?.old) throw new Error('Start workspace old before making paths rebuild-persistent');
    } });
    const retained = join(root, 'retained-backup.enc');
    await writeFile(retained, 'existing encrypted backup');
    await manager.setConfig('owner', { provider: 'fake', enabled: false, intervalMinutes: 53, retentionCount: 9,
      selectedWorkspaceIds: ['old', 'active'], persistSelectedDirectories: true,
      selectedPathsByWorkspace: { old: ['/opt/project'], active: ['/workspace'] } });
    archived = true;
    const paths = { old: ['/opt/project'], active: ['/workspace'] };
    await manager.setConfig('owner', { retentionCount: 12, selectedPathsByWorkspace: paths });
    expect(calls).toHaveLength(1);
    await manager.setConfig('owner', { selectedWorkspaceIds: ['active'], selectedPathsByWorkspace: paths });
    expect(calls).toHaveLength(1);
    await manager.setConfig('owner', { selectedWorkspaceIds: ['active'],
      selectedPathsByWorkspace: { ...paths, active: ['/workspace', '/opt/new'] } });
    expect(calls[1]).toEqual({ active: ['/opt/new'] });
    const reloaded = new BackupManager({ dataDir: root });
    expect(await reloaded.getConfig('owner')).toMatchObject({ provider: 'fake', enabled: false,
      intervalMinutes: 53, retentionCount: 12, selectedWorkspaceIds: ['active'],
      selectedPathsByWorkspace: { old: ['/opt/project'], active: ['/workspace', '/opt/new'] } });
    expect(await readFile(retained, 'utf8')).toBe('existing encrypted backup');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removed directory selections do not reconcile and failed new selections retain previous config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-settings-additions-'));
  try {
    const manager = new BackupManager({ dataDir: root });
    const calls: any[] = [];
    let fail = false;
    manager.setPathPersistenceAdapter({ reconcileSelections: async (_owner, paths) => {
      calls.push(structuredClone(paths)); if (fail) throw new Error('source unavailable');
    } });
    await manager.setConfig('owner', { selectedWorkspaceIds: ['archived'], selectedPathsByWorkspace: { archived: ['/opt/a', '/opt/b'] } });
    fail = true;
    await manager.setConfig('owner', { selectedPathsByWorkspace: { archived: ['/opt/a'] } });
    expect(calls).toHaveLength(1);
    const previous = await manager.getConfig('owner');
    await expect(manager.setConfig('owner', { selectedPathsByWorkspace: { archived: ['/opt/a', '/opt/new'] } })).rejects.toThrow('source unavailable');
    expect(calls[1]).toEqual({ archived: ['/opt/new'] });
    expect(await manager.getConfig('owner')).toEqual(previous);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('enabling directory persistence or reselecting inactive coverage still seeds newly enabled paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'backup-settings-enable-'));
  try {
    const manager = new BackupManager({ dataDir: root }), calls: any[] = [];
    manager.setPathPersistenceAdapter({ reconcileSelections: async (_owner, paths) => { calls.push(structuredClone(paths)); } });
    await manager.setConfig('owner', { selectedWorkspaceIds: ['active'], persistSelectedDirectories: false,
      selectedPathsByWorkspace: { active: ['/opt/a'], inactive: ['/opt/b'] } });
    expect(calls).toEqual([]);
    await manager.setConfig('owner', { persistSelectedDirectories: true });
    expect(calls).toEqual([{ active: ['/opt/a'] }]);
    await manager.setConfig('owner', { selectedWorkspaceIds: null });
    expect(calls).toEqual([{ active: ['/opt/a'] }, { inactive: ['/opt/b'] }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
