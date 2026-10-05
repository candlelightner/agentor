import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { authenticateWsPeer } from '../../orchestrator/server/utils/auth-helpers';
import { useInstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { useConfig } from '../../orchestrator/server/utils/services';

test('WebSocket authentication cannot open auth storage after rejected startup', async () => {
  const manager = useInstanceBackupManager(), originalCheck = manager.assertStartupSafe, originalInit = manager.init;
  let checks = 0, initialized = false;
  const authPath = join(useConfig().dataDir, 'auth.db'), existed = existsSync(authPath);
  try {
    manager.assertStartupSafe = async () => { checks++; throw new Error('Unsettled same-DATA helper'); };
    manager.init = async () => { initialized = true; };
    expect(await authenticateWsPeer({ request: { headers: new Headers({ cookie: 'invalid-fixture-cookie=present' }) } })).toBeNull();
    expect(checks).toBe(1); expect(initialized).toBe(false); expect(existsSync(authPath)).toBe(existed);
  } finally { manager.assertStartupSafe = originalCheck; manager.init = originalInit; }
});
