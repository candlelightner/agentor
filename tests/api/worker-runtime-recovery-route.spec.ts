import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const requireApp = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const ts = requireApp('typescript');
function compile(path: string) {
  return ts.transpileModule(readFileSync(new URL('../../orchestrator/server/' + path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}
function fixture(role?: string, unavailable = false) {
  const calls: string[] = [];
  // Execute the real requireAdmin/requireAuth implementation with no service
  // initialization, then the real endpoint against a bounded fake inventory.
  const auth: any = {};
  runInNewContext(compile('utils/auth-helpers.ts'), {
    exports: auth,
    require: (name: string) => name === 'h3' ? { createError: (value: any) => Object.assign(new Error(value.statusMessage), value) } : {},
  });
  const entries = [{ workerId: 'held-worker', operationId: 'held-operation', phase: 'committed', reconciliationRequired: true }];
  const modules: Record<string, any> = {
    '../../utils/auth-helpers': { requireAdmin: (event: any) => { calls.push('authorize'); return auth.requireAdmin(event); } },
    '../../utils/services': { useContainerManager: () => {
      calls.push('manager');
      return { runtimeMigrationInventory: async () => {
        calls.push('inventory');
        if (unavailable) throw Object.assign(new Error('Worker record storage unavailable'), { statusCode: 503 });
        return entries;
      } };
    } },
    '../../utils/http-errors': { rethrowAsHttpError: (error: unknown) => { throw error; } },
  };
  const endpoint: any = {};
  runInNewContext(compile('api/admin/runtime-migrations.get.ts'), {
    exports: endpoint,
    defineRouteMeta: () => {},
    defineEventHandler: (handler: any) => handler,
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected endpoint dependency: ${name}`);
      return modules[name];
    },
  });
  const event = { context: role ? { auth: { user: { id: 'fixture-user', role }, session: {} } } : {} };
  return { calls, entries, run: () => endpoint.default(event) };
}

for (const [role, statusCode] of [[undefined, 401], ['user', 403], ['group-admin', 403]] as const) {
  test(`runtime recovery inventory rejects ${role || 'unauthenticated'} before accessing manager`, async () => {
    const f = fixture(role);
    await expect(f.run()).rejects.toMatchObject({ statusCode });
    expect(f.calls).toEqual(['authorize']);
  });
}
test('administrator inventory route returns held records without reading or mutating live workers', async () => {
  const f = fixture('admin');
  expect(await f.run()).toEqual(f.entries);
  expect(f.calls).toEqual(['authorize', 'manager', 'inventory']);
});
test('unavailable inventory fails rather than becoming an authoritative empty array', async () => {
  const f = fixture('admin', true);
  await expect(f.run()).rejects.toMatchObject({ statusCode: 503 });
  expect(f.calls).toEqual(['authorize', 'manager', 'inventory']);
});
