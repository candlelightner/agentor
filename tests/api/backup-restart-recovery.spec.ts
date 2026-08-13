import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupManager, cleanupInterruptedBackupStaging } from '../../orchestrator/server/utils/backup-manager';

test('restart recovery removes interrupted backup and restore staging', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-backup-restart-'));
  const jobId = 'interrupted-job';
  await mkdir(join(dataDir, 'tmp', `backup-${jobId}`), { recursive: true });
  await mkdir(join(dataDir, 'tmp', `restore-${jobId}`), { recursive: true });
  try {
    await cleanupInterruptedBackupStaging(dataDir, jobId);
    await expect(stat(join(dataDir, 'tmp', `backup-${jobId}`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(dataDir, 'tmp', `restore-${jobId}`))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('manager reconstruction fails interrupted jobs and deletes a pending local object', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-backup-manager-restart-'));
  const userId = 'restart-owner';
  const backupJobId = 'interrupted-backup';
  const restoreJobId = 'interrupted-restore';
  const pendingObjectId = 'pending-local-object';
  const now = new Date().toISOString();
  const job = (id: string, target?: 'new') => ({
    schemaVersion: 1 as const,
    id,
    userId,
    workspaceId: 'workspace-id',
    provider: 'local' as const,
    status: 'running' as const,
    phase: 'uploading',
    progress: 55,
    bytesProcessed: 123,
    createdAt: now,
    updatedAt: now,
    attempt: 1,
    ...(target ? { target } : {}),
    ...(id === backupJobId ? { pendingProviderObjectId: pendingObjectId } : {}),
  });
  await mkdir(join(dataDir, 'users', userId), { recursive: true });
  await writeFile(join(dataDir, 'users', userId, 'backups.json'), JSON.stringify({
    schemaVersion: 1,
    jobs: [job(backupJobId), job(restoreJobId, 'new')],
    artifacts: [],
  }));
  await mkdir(join(dataDir, 'backup-objects', userId), { recursive: true });
  await writeFile(join(dataDir, 'backup-objects', userId, `${pendingObjectId}.backup`), 'partial encrypted archive');
  for (const id of [backupJobId, restoreJobId]) {
    await mkdir(join(dataDir, 'tmp', `backup-${id}`), { recursive: true });
    await mkdir(join(dataDir, 'tmp', `restore-${id}`), { recursive: true });
  }
  const manager = new BackupManager({ dataDir });
  try {
    await manager.init();
    const backup = await manager.getJob(backupJobId);
    const restore = await manager.getJob(restoreJobId);
    expect(backup).toMatchObject({ status: 'failed', phase: 'failed', error: 'Backup interrupted by orchestrator restart' });
    expect(backup?.pendingProviderObjectId).toBeUndefined();
    expect(restore).toMatchObject({ status: 'failed', phase: 'failed', error: 'Restore interrupted by orchestrator restart' });
    await expect(stat(join(dataDir, 'backup-objects', userId, `${pendingObjectId}.backup`))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const id of [backupJobId, restoreJobId]) {
      await expect(stat(join(dataDir, 'tmp', `backup-${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(dataDir, 'tmp', `restore-${id}`))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    const persisted = JSON.parse(await readFile(join(dataDir, 'users', userId, 'backups.json'), 'utf8'));
    const persistedBackup = persisted.jobs.find((entry: { id: string }) => entry.id === backupJobId);
    expect(persistedBackup).toMatchObject({ id: backupJobId, status: 'failed' });
    expect(persistedBackup).not.toHaveProperty('pendingProviderObjectId');
    expect(persisted.jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: restoreJobId, status: 'failed' }),
    ]));
  } finally {
    manager.stop();
    await rm(dataDir, { recursive: true, force: true });
  }
});
