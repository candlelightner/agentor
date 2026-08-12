import { test, expect } from '@playwright/test';
import { ManagementImageBackupDomain } from '../../orchestrator/server/utils/management-image-backup-domain';

test('image and backup MCP domain exposes bounded tool surface and safe hints', () => {
  const tools = new ManagementImageBackupDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['images.list','images.create','images.build','images.build-logs','images.promote','images.rollback','images.delete-version','images.usage','images.test-worker','images.git-sync','backups.list','backups.providers','backups.create','backups.cancel','backups.retry','backups.delete','backups.restore']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'images.build-logs')?.annotations).toMatchObject({ readOnlyHint:true });
  expect(tools.find(tool => tool.name === 'backups.delete')?.annotations).toMatchObject({ destructiveHint:true });
});
