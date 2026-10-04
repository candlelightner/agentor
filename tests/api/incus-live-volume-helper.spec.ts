import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('trusted guest live helper contains startup/watcher/controller faults without unsafe thaw or unbounded sync', async () => {
  const output = execFileSync('python3', ['-I',
    fileURLToPath(new URL('../helpers/incus-live-helper-faults.py', import.meta.url)),
    fileURLToPath(new URL('../../orchestrator/incus-volume-live-helper.py', import.meta.url))], { encoding: 'utf8', timeout: 15_000 });
  for (const fault of ['fork', 'watchdog-startup', 'watchdog-pre-attach', 'watchdog-post-attach', 'controller-post-attach', 'bounded-sync', 'start-sync', 'kill-sync'])
    expect(output).toContain(`${fault}: passed`);
});
