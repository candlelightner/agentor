import { expect, test } from '@playwright/test';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupInterruptedBackupStaging } from '../../orchestrator/server/utils/backup-manager';

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
