import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { instanceBarrierHttp, type InstanceBarrierHttpDependencies } from '../../orchestrator/server/utils/instance-barrier-http';
import { installInstanceHttpAdapter } from '../../orchestrator/server/utils/instance-http-adapter';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { createApp, eventHandler, toNodeListener } = require('h3');
const path = '/api/admin/instance-backups/jobs/job';
async function fixture() {
  const calls: string[] = [];
  const dependencies: InstanceBarrierHttpDependencies = {
    jobId: () => 'job',
    administrator: cookie => { calls.push('auth'); return cookie === 'synthetic=valid' ? { userId: 'owner', sessionId: 'session' } : null; },
    trustedOrigin: origin => origin === 'https://dashboard.invalid',
    job: (id, owner, cancel) => {
      calls.push(cancel ? 'cancel' : 'status');
      expect(id).toBe('job'); expect(owner).toBe('owner');
      return { id, userId: owner, operation: 'create', status: 'running', phase: 'snapshotting' } as any;
    },
  };
  const app = createApp({ onRequest: () => calls.push('ordinary-auth'), onError: () => calls.push('ordinary-error'),
    onBeforeResponse: () => calls.push('ordinary-before'), onAfterResponse: () => calls.push('ordinary-after') });
  app.use(eventHandler(() => { calls.push('ordinary-route'); return 'ordinary'; }));
  const gate = new InstanceControlPlaneCoordinator();
  const server = createServer(toNodeListener(app));
  installInstanceHttpAdapter(app, gate, event => instanceBarrierHttp(event, dependencies));
  const barrier = gate.begin('job', 'snapshot');
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  return { dependencies, calls, gate, barrier,
    request: (target = path, init: RequestInit = {}) => fetch(url + target, { headers: { cookie: 'synthetic=valid' }, ...init }),
    close: async () => {
      barrier.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    } };
}
test('exact job status bypasses all ordinary hooks and sends no session cookie', async () => {
  const f = await fixture();
  try {
    const response = await f.request(); expect(response.status).toBe(200);
    expect((await response.json()).id).toBe('job'); expect(response.headers.has('set-cookie')).toBe(false);
    expect(f.calls).toEqual(['auth', 'status']); expect(f.gate.activeOperations).toBe(0);
  } finally { await f.close(); }
});
test('exact cancellation requires authenticated owner lookup and configured Origin', async () => {
  const f = await fixture();
  try {
    const response = await f.request(path, { method: 'DELETE', headers: { cookie: 'synthetic=valid', origin: 'https://dashboard.invalid' } });
    expect(response.status).toBe(200); expect(f.calls).toEqual(['auth', 'cancel']);
  } finally { await f.close(); }
});
for (const origin of [undefined, 'https://evil.invalid', 'null', 'https://dashboard.invalid.evil'])
  test(`cancellation refuses untrusted Origin ${origin}`, async () => {
    const f = await fixture();
    try {
      const response = await f.request(path, { method: 'DELETE', headers: { cookie: 'synthetic=valid', ...(origin ? { origin } : {}) } });
      expect(response.status).toBe(403); expect(f.calls).toEqual(['auth']);
    } finally { await f.close(); }
  });
for (const target of [path + '?x=1', path + '/', path + '/logs', path.replace('job', 'other'), '/api/auth/get-session', '/api/health?x=1'])
  test(`nonexact route ${target} never reaches auth or ordinary hooks`, async () => {
    const f = await fixture();
    try { expect((await f.request(target)).status).toBe(423); expect(f.calls).toEqual([]); }
    finally { await f.close(); }
  });
test('invalid authentication and owner mismatch fail without ordinary error hooks', async () => {
  const f = await fixture();
  try {
    const denied = await f.request(path, { headers: {} });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toBe('no-store');
    expect(denied.headers.get('x-content-type-options')).toBe('nosniff');
    f.dependencies.job = () => undefined;
    expect((await f.request()).status).toBe(404); expect(f.calls).toEqual(['auth', 'auth']);
  } finally { await f.close(); }
});
test('health remains nonwriting while all ordinary GET routes stay closed', async () => {
  const f = await fixture();
  try {
    const response = await f.request('/api/health', { headers: {} });
    expect(await response.json()).toEqual({ status: 'ok', controlPlane: 'locked' }); expect(f.calls).toEqual([]);
    f.barrier.release(); expect(await (await f.request('/other')).text()).toBe('ordinary');
    expect(f.calls).toEqual(['ordinary-auth', 'ordinary-route', 'ordinary-before', 'ordinary-after']);
  } finally { await f.close(); }
});
