import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { useContainerManager, useWorkerGroupStore, useExportJobManager, useUsageChecker, useOrphanSweeper } from '../../orchestrator/server/utils/services';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { useBackupManager } from '../../orchestrator/server/utils/backup-manager';
import { useManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useManagedVolumeSizingManager } from '../../orchestrator/server/utils/managed-volume-sizing';
import { usePortableManagedVolumeRuntime } from '../../orchestrator/server/utils/portable-managed-volume-runtime';
import { useImageCatalogManager } from '../../orchestrator/server/utils/image-catalog';

test.describe.configure({ mode: 'serial' });

/** Run the real producer preflight. In particular, do not install the Nuxt
 * managed-volume auto-import on globalThis: that would conceal a missing
 * production import even though typed/overridden capture fixtures pass. */
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'instance-default-preflight-'));
  const restorers: Array<() => void> = [];
  const patch = (target: any, key: string, value: any) => {
    const owned = Object.hasOwn(target, key), previous = target[key]; target[key] = value;
    restorers.push(() => { if (owned) target[key] = previous; else delete target[key]; });
  };
  const calls: string[] = [];
  const inspectors = {
    backup: useBackupManager(), managed: useManagedVolumeManager(), sizing: useManagedVolumeSizingManager(),
    portable: usePortableManagedVolumeRuntime(), export: useExportJobManager(), image: useImageCatalogManager(),
    usage: useUsageChecker(), orphan: useOrphanSweeper(),
  };
  patch(useContainerManager(), 'list', () => []);
  patch(useAdminWorkspaceStore(), 'getRecord', () => undefined);
  patch(useWorkerGroupStore(), 'list', () => []);
  for (const [name, inspector] of Object.entries(inspectors))
    patch(inspector, 'hasActiveOperationsForInstanceSnapshot', () => { calls.push(name); return false; });
  const manager = new InstanceBackupManager({ dataDir }); // No preflightCreate override.
  return { calls, patch, inspectors, preflight: () => (manager as any).defaultPreflight() as Promise<void>,
    cleanup: async () => { for (const restore of restorers.reverse()) restore(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('real default instance producer preflight visits all eight operation inspectors when eligible', async () => {
  const f = await fixture();
  try {
    await f.preflight();
    expect(f.calls).toEqual(['backup', 'managed', 'sizing', 'portable', 'export', 'image', 'usage', 'orphan']);
  } finally { await f.cleanup(); }
});

test('real default instance producer preflight rejects active ordinary workers before operation inspection', async () => {
  const f = await fixture();
  try {
    for (const status of ['running', 'creating']) {
      f.patch(useContainerManager(), 'list', () => [{ id: 'fixture-worker', status, runtimeKind: 'incus-vm' }]);
      await expect(f.preflight()).rejects.toMatchObject({ statusCode: 409, code: 'INSTANCE_BACKUP_WORKSPACES_ACTIVE' });
    }
    expect(f.calls).toEqual([]);
  } finally { await f.cleanup(); }
});

test('real default instance producer preflight rejects active managed and every other operation inspector', async () => {
  for (const name of ['backup', 'managed', 'sizing', 'portable', 'export', 'image', 'usage', 'orphan'] as const) {
    const f = await fixture();
    try {
      f.patch(f.inspectors[name], 'hasActiveOperationsForInstanceSnapshot', () => { f.calls.push(name); return true; });
      await expect(f.preflight()).rejects.toMatchObject({ statusCode: 409, code: 'INSTANCE_BACKUP_JOBS_ACTIVE' });
      expect(f.calls.at(-1)).toBe(name);
    } finally { await f.cleanup(); }
  }
});
