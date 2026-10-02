import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
function held() {
  let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture() {
  const gate = new InstanceControlPlaneCoordinator(), pending = held(), entered = held(), calls: string[] = [];
  const source = await readFile(new URL('../../orchestrator/server/utils/auth-helpers.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(compiled, { exports, Headers, require: (name: string) => {
    if (name === './instance-snapshot-gate') return { instanceControlPlaneCoordinator: gate };
    if (name === './auth') return { useAuth: () => {
      calls.push('initialized-auth'); return { api: { getSession: async () => {
        entered.resolve(); await pending.promise;
        await gate.run(() => { calls.push('session-write'); });
        return { user: { id: 'owner', role: 'admin' }, session: { id: 'session', userId: 'owner', token: 'synthetic', expiresAt: new Date(Date.now() + 10000) } };
      } } };
    } };
    return {};
  } });
  return { exports, gate, pending, entered, calls };
}
for (const kind of ['HTTP/proxy', 'WebSocket']) test(`${kind} auth drains actual session writes and refuses new roots before lazy initialization`, async () => {
  const f = await fixture();
  const invoke = () => kind === 'WebSocket'
    ? f.exports.authenticateWsPeer({ request: { headers: new Headers({ cookie: 'synthetic=valid' }) } })
    : f.exports.resolveAuthFromEvent({ headers: new Headers({ cookie: 'synthetic=valid' }) });
  const running = invoke(); await f.entered.promise;
  const barrier = f.gate.begin('auth-drain', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    expect(await invoke()).toBeNull(); expect(f.calls).toEqual(['initialized-auth']);
    f.pending.resolve(); expect((await running)?.user.id).toBe('owner');
    await barrier.drain({ timeoutMs: 1000 }); expect(f.calls).toEqual(['initialized-auth', 'session-write']);
  } finally { f.pending.resolve(); await running; barrier.release(); }
});
