import { expect, test } from '@playwright/test';
import { extraBackupPaths, normalizeBackupPath, normalizeBackupPaths } from '../../orchestrator/server/utils/backup-paths';

test('backup selections are absolute, bounded, deduplicated and preserve the legacy defaults', () => {
  expect(normalizeBackupPaths(['/workspace/project', '/workspace', '/etc/hosts', '/etc/hosts'])).toEqual(['/workspace', '/etc/hosts']);
  expect(extraBackupPaths(['/workspace/project', '/home/agent/.agent-data/.codex', '/etc/hosts'])).toEqual(['/workspace/project', '/home/agent/.agent-data/.codex', '/etc/hosts']);
  expect(extraBackupPaths(undefined)).toEqual([]);
  expect(normalizeBackupPath('/')).toBe('/');
});

test('backup selection rejects relative, traversal-shaped and malformed paths', () => {
  for (const value of ['', 'workspace', '../etc', '/etc\\passwd', '/bad\0path', 4, null])
    expect(() => normalizeBackupPath(value)).toThrow();
  expect(() => normalizeBackupPaths(Array.from({ length: 33 }, (_, i) => `/tmp/${i}`))).toThrow();
});
