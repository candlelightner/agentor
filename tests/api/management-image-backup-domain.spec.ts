import { test, expect } from '@playwright/test';
import { ManagementImageBackupDomain, sanitizeManagementBackupPayload } from '../../orchestrator/server/utils/management-image-backup-domain';

test('image and backup MCP domain exposes bounded tool surface and safe hints', () => {
  const tools = new ManagementImageBackupDomain().tools();
  const names = tools.map(tool => tool.name);
  for (const name of ['images.list','images.create','images.update','images.build','images.build-logs','images.promote','images.rollback','images.delete-version','images.usage','images.test-worker','images.git-sync','backups.list','backups.providers','backups.create','backups.cancel','backups.retry','backups.delete','backups.restore']) expect(names).toContain(name);
  expect(tools.find(tool => tool.name === 'images.build-logs')?.annotations).toMatchObject({ readOnlyHint:true });
  expect(tools.find(tool => tool.name === 'backups.delete')?.annotations).toMatchObject({ destructiveHint:true });
  const restore = tools.find(tool => tool.name === 'backups.restore');
  expect(restore?.inputSchema).toMatchObject({
    required: ['ownerId', 'artifactId'],
    properties: {
      workspaceIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    },
  });
  expect(restore?.description).toContain('exact non-empty workspaceIds subset');
});

test('backup MCP payloads redact internal provider cleanup and upload handles', () => {
  expect(sanitizeManagementBackupPayload({
    providerUploadId: 'session',
    pendingProviderUploadId: 'pending-session',
    pendingProviderObjectId: 'object',
    pendingProviderArtifactId: 'artifact',
    status: 'failed',
  })).toEqual({
    providerUploadId: '[REDACTED]',
    pendingProviderUploadId: '[REDACTED]',
    pendingProviderObjectId: '[REDACTED]',
    pendingProviderArtifactId: '[REDACTED]',
    status: 'failed',
  });
});
