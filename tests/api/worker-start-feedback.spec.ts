import { test, expect } from '@playwright/test';
import { useContainers } from '../../orchestrator/app/composables/useContainers';

for (const fails of [false, true]) test(`worker start ${fails ? 'failure' : 'success'} visibly replaces its pending notice and refreshes status`, async () => {
  const names = ['useToast', 'useFetch', 'usePolling', '$fetch'];
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const notices: any[] = [], removed: string[] = [], requests: any[] = [];
  let refreshes = 0, settle!: () => void;
  const pending = new Promise<void>((resolve, reject) => {
    settle = () => fails ? reject({ data: { statusMessage: 'Incus worker bootstrap command failed during Docker storage preparation' } }) : resolve();
  });
  Object.assign(globalThis, {
    useToast: () => ({ add: (notice: any) => { notices.push(notice); return { id: 'fixture-notice' }; }, remove: (id: string) => removed.push(id) }),
    useFetch: () => ({ data: { value: [] }, refresh: async () => { refreshes++; } }),
    usePolling: () => {},
    $fetch: (url: string, options: any) => { requests.push({ url, options }); return pending; },
  });
  try {
    const operation = useContainers().restartContainer('fixture-worker');
    expect(notices[0]).toMatchObject({ title: 'Starting worker', duration: 0 });
    expect(notices[0].description).toContain('storage');
    expect(removed).toEqual([]);
    settle(); await operation;
    expect(requests).toEqual([{ url: '/api/containers/fixture-worker/restart', options: { method: 'POST', retry: 0 } }]);
    expect(refreshes).toBe(1);
    expect(notices).toHaveLength(2);
    expect(removed).toEqual(['fixture-notice']);
    expect(notices[1]).toMatchObject({ color: fails ? 'error' : 'success', title: fails ? 'Worker start not confirmed' : 'Worker started' });
    if (fails) expect(notices[1].description).toContain('Docker storage preparation');
  } finally {
    for (const [index, name] of names.entries()) {
      if (previous[index]) Object.defineProperty(globalThis, name, previous[index]!);
      else delete (globalThis as any)[name];
    }
  }
});
