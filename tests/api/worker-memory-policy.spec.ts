import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createApp, defineEventHandler, getCookie, toNodeListener } from '../../orchestrator/node_modules/h3/dist/index.mjs';
import { incusDefaultMemoryLimit, effectiveIncusWorkerMemoryLimit, incusWorkerMemoryLimit } from '../../orchestrator/shared/worker-memory';
import { loadConfig } from '../../orchestrator/server/utils/config';
import memoryPolicy from '../../orchestrator/server/api/worker-memory-policy.get';
import { useConfig } from '../../orchestrator/server/utils/services';
import { ContainerManager } from '../../orchestrator/server/utils/container';

test('operator VM default is finite, configurable, validated, and stable after configuration normalization', () => {
  const previous = process.env.INCUS_DEFAULT_MEMORY_LIMIT;
  try {
    delete process.env.INCUS_DEFAULT_MEMORY_LIMIT;
    expect(loadConfig().incusDefaultMemoryLimit).toBe('4GiB');
    for (const raw of ['6GiB', '1.5g', '512m']) {
      process.env.INCUS_DEFAULT_MEMORY_LIMIT = raw;
      const configured = loadConfig().incusDefaultMemoryLimit;
      expect(incusDefaultMemoryLimit(configured)).toBe(configured);
      expect(effectiveIncusWorkerMemoryLimit(undefined, configured)).toBe(incusWorkerMemoryLimit(raw));
    }
    for (const raw of ['', '0g', 'NaN', 'all', '50%', '-1g']) {
      process.env.INCUS_DEFAULT_MEMORY_LIMIT = raw;
      expect(() => loadConfig()).toThrow('INCUS_DEFAULT_MEMORY_LIMIT');
    }
  } finally {
    if (previous === undefined) delete process.env.INCUS_DEFAULT_MEMORY_LIMIT;
    else process.env.INCUS_DEFAULT_MEMORY_LIMIT = previous;
  }
});

test('shared environment and Docker default derivation remain unchanged by the native fallback', () => {
  const config = { defaultMemoryLimit: '', defaultCpuLimit: 0 } as any;
  const manager = new ContainerManager({} as any, config);
  expect((manager as any).deriveLimits({})).toMatchObject({ memoryLimit: undefined });
  expect((manager as any).deriveLimits({ memoryLimit: '0g' })).toMatchObject({ memoryLimit: '0g' });
  expect((manager as any).deriveLimits({ memoryLimit: '512m' })).toMatchObject({ memoryLimit: '512m' });
  config.defaultMemoryLimit = '2g';
  expect((manager as any).deriveLimits({ memoryLimit: '' })).toMatchObject({ memoryLimit: '2g' });
  expect((manager as any).deriveLimits({ memoryLimit: '0g' })).toMatchObject({ memoryLimit: '0g' });
  expect(incusWorkerMemoryLimit('')).toBeUndefined();
  expect(incusWorkerMemoryLimit('0g')).toBeUndefined();
});

test('memory policy is authenticated and returns only effective default inputs for ordinary users', async () => {
  const app = createApp();
  app.use(defineEventHandler(event => {
    if (getCookie(event, 'test-session')) event.context.auth = { user: { id: 'ordinary-user', role: 'user' }, session: {} };
  }));
  app.use('/api/worker-memory-policy', memoryPolicy);
  const server = createServer(toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/worker-memory-policy`;
  try {
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { Cookie: 'test-session=ordinary' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ defaultMemoryLimit: useConfig().defaultMemoryLimit || '', incusDefaultMemoryLimit: incusDefaultMemoryLimit(useConfig().incusDefaultMemoryLimit) });
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
