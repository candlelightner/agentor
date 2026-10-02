import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { PassThrough, Readable } from 'node:stream';
import { get } from 'node:http';
import { ManagementMcpStore } from '../../orchestrator/server/utils/management-mcp-store';
import { ManagementMcpTransport } from '../../orchestrator/server/utils/management-mcp-transport';
import { accountManagementStream, runManagementOperation } from '../../orchestrator/server/utils/management-control-plane';
import { withinGroupAdminLifecycleDeadline, withinManagementFailFastDeadline } from '../../orchestrator/server/utils/management-worker-domain';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const identity = { workspaceId: 'review-admin', scope: 'platform', audience: 'agentor-management-mcp', expiresAt: '2099-01-01T00:00:00Z', persistedInWorkspace: false };
async function fixture(writer?: (state: any) => Promise<void>) {
  const path = await mkdtemp('/workspace/kata-mcp-control-plane-');
  const snapshots: any[] = [];
  const store = new ManagementMcpStore(path, async state => {
    await writer?.(state);
    snapshots.push(structuredClone(state));
  });
  store.introspect = async () => identity as any;
  return { store, snapshots, close: () => rm(path, { recursive: true, force: true }) };
}
test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('direct read-only invocation drains through final audit and rejects all new MCP roots', async () => {
  const execution = deferred(), audit = deferred(), entered = deferred(), auditing = deferred();
  const f = await fixture(async () => { auditing.resolve(); await audit.promise; });
  (f.store as any).executeTool = async () => { entered.resolve(); await execution.promise; return { ok: true }; };
  const call = f.store.invoke('test-only', 'status.system');
  await entered.promise;
  const barrier = gate.begin('mcp-direct', 'snapshot');
  try {
    let introspections = 0;
    f.store.introspect = async () => { introspections++; return identity as any; };
    for (const tool of ['status.system', 'instance-backups.cancel'])
      await expect(f.store.invoke('test-only', tool, { jobId: 'mcp-direct' }))
        .rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(introspections).toBe(0);
    execution.resolve(); await auditing.promise;
    expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); expect(await call).toEqual({ ok: true });
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.snapshots.at(-1).audit.at(-1)).toMatchObject({ action: 'tool.invoked', outcome: 'success' });
  } finally { execution.resolve(); audit.resolve(); await call.catch(() => {}); barrier.release(); await f.close(); }
});

test('direct identity denial retains both denial and final failure audits', async () => {
  const identified = deferred(), deny = deferred(), audit = deferred(), auditing = deferred();
  const f = await fixture(async state => {
    if (state.audit.length === 2) { auditing.resolve(); await audit.promise; }
  });
  f.store.introspect = async () => { identified.resolve(); await deny.promise; throw Object.assign(new Error('denied'), { statusCode: 401 }); };
  const call = f.store.invoke('invalid', 'status.system');
  const observed = call.catch(error => error);
  await identified.promise;
  const barrier = gate.begin('mcp-denial', 'snapshot');
  try {
    deny.resolve(); await auditing.promise;
    expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); expect(await observed).toMatchObject({ statusCode: 401 });
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.snapshots.at(-1).audit.map((item: any) => item.action)).toEqual(['authorization.denied', 'tool.invoked']);
  } finally { deny.resolve(); audit.resolve(); await observed; barrier.release(); await f.close(); }
});

for (const groupAdmin of [false, true]) test(`caught caller deadline retains actual mutation and nested cleanup (groupAdmin=${groupAdmin})`, async () => {
  const held = deferred(), entered = deferred();
  let completed = false;
  const f = await fixture();
  (f.store as any).executeTool = async () => {
    const actual = async () => {
      entered.resolve(); await held.promise;
      await runManagementOperation(async () => { await f.store.audit('late.cleanup', 'success'); completed = true; });
    };
    try {
      if (groupAdmin) await withinGroupAdminLifecycleDeadline(actual, 0.01);
      else await withinManagementFailFastDeadline(actual, 0.01, 'review.operation');
    } catch (error: any) { return { statusCode: error.statusCode }; }
  };
  const call = f.store.invoke('test-only', 'status.system');
  await entered.promise;
  expect(await call).toEqual({ statusCode: 504 });
  const barrier = gate.begin('mcp-deadline', 'snapshot');
  try {
    expect(gate.activeOperations).toBeGreaterThan(0);
    expect(() => barrier.assertDrained()).toThrow();
    held.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(completed).toBe(true);
    expect(f.snapshots.at(-1).audit.at(-1)).toMatchObject({ action: 'late.cleanup' });
  } finally { held.resolve(); barrier.release(); await f.close(); }
});

test('a direct returned stream keeps its own lifetime without consuming or buffering data', async () => {
  const stream = Readable.from(['first', 'second']);
  await runManagementOperation(() => accountManagementStream(stream));
  const barrier = gate.begin('mcp-direct-stream', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    const chunks: string[] = [];
    for await (const chunk of stream) chunks.push(String(chunk));
    await barrier.drain({ timeoutMs: 1000 });
    expect(chunks).toEqual(['first', 'second']);
  } finally { stream.destroy(); barrier.release(); }
});

test('direct openDownload registers its returned stream before the opening call retires', async () => {
  const f = await fixture(), stream = new PassThrough();
  (f.store as any).openDownloadAdmitted = async () => ({ stream, audit: {}, filename: 'test.txt', contentType: 'application/octet-stream' });
  const opened = await f.store.openDownload('test-only', 'test-token');
  const barrier = gate.begin('mcp-store-stream', 'snapshot');
  try {
    expect(opened.stream).toBe(stream);
    expect(() => barrier.assertDrained()).toThrow();
    stream.destroy(new Error('consumer disconnected'));
    await barrier.drain({ timeoutMs: 1000 });
  } finally { stream.destroy(); barrier.release(); await f.close(); }
});

test('direct import upload denial remains admitted until its authorization audit completes', async () => {
  const identified = deferred(), deny = deferred(), auditing = deferred(), audit = deferred();
  const f = await fixture(async () => { auditing.resolve(); await audit.promise; });
  f.store.introspect = async () => { identified.resolve(); await deny.promise; throw Object.assign(new Error('denied'), { statusCode: 401 }); };
  const source = Readable.from(['not consumed']);
  const call = f.store.uploadImport('invalid', 'token', source).catch(error => error);
  await identified.promise;
  const barrier = gate.begin('mcp-import-denied', 'snapshot');
  try {
    deny.resolve(); await auditing.promise;
    expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); expect(await call).toMatchObject({ statusCode: 401 });
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.snapshots.at(-1).audit.at(-1)).toMatchObject({ action: 'authorization.denied' });
  } finally { deny.resolve(); audit.resolve(); await call; source.destroy(); barrier.release(); await f.close(); }
});

async function start(store: any) {
  const transport = new ManagementMcpTransport(store, 0);
  await transport.start('127.0.0.1');
  const port = (transport as any).servers.get('127.0.0.1').address().port;
  return { transport, base: `http://127.0.0.1:${port}` };
}

test('transport denial accounting includes persisted authentication failure and blocks before new dispatch', async () => {
  const identifying = deferred(), deny = deferred(), auditing = deferred(), audit = deferred();
  let calls = 0;
  const { transport, base } = await start({
    introspect: async () => { calls++; identifying.resolve(); await deny.promise; throw Object.assign(new Error('denied'), { statusCode: 401 }); },
    auditAuthorizationFailure: async () => { auditing.resolve(); await audit.promise; },
  });
  const response = fetch(`${base}/mcp`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) });
  await identifying.promise;
  const barrier = gate.begin('mcp-transport-denial', 'snapshot');
  try {
    const blocked = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    expect(blocked.status).toBe(423); expect(calls).toBe(1);
    deny.resolve(); await auditing.promise; expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); await (await response).json(); await barrier.drain({ timeoutMs: 1000 });
  } finally { deny.resolve(); audit.resolve(); await response; barrier.release(); await transport.stop(); }
});

for (const disconnect of [false, true]) test(`download pipeline and final audit outlive response close (disconnect=${disconnect})`, async () => {
  const stream = new PassThrough(), auditing = deferred(), audit = deferred(), opened = deferred();
  let outcome: string | undefined;
  const { transport, base } = await start({
    openDownload: async () => { opened.resolve(); return { stream, filename: 'test.txt', contentType: 'application/octet-stream', audit: { resourceId: 'test' } }; },
    auditDownloadTransfer: async (_: unknown, value: string) => { outcome = value; auditing.resolve(); await audit.promise; },
  });
  const consumed = new Promise<void>((resolve, reject) => {
    const request = get(`${base}/downloads/00000000-0000-4000-8000-000000000000`, response => {
      response.on('error', error => disconnect ? resolve() : reject(error));
      response.on('end', resolve);
      response.once('data', () => { if (disconnect) { response.destroy(); resolve(); } });
      response.resume();
    });
    request.on('error', reject);
  });
  await opened.promise;
  const barrier = gate.begin('mcp-download', 'snapshot');
  try {
    stream.write('chunk'); if (!disconnect) stream.end();
    await consumed; await auditing.promise;
    expect(outcome).toBe(disconnect ? 'failure' : 'success');
    expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { audit.resolve(); stream.destroy(); barrier.release(); await transport.stop(); }
});

test('transport import consumption and final audit are one admitted lifetime', async () => {
  const consuming = deferred(), consumed = deferred(), finalAudit = deferred(), audit = deferred();
  let bytes = '';
  const { transport, base } = await start({
    uploadImport: async (_credential: unknown, _token: string, source: Readable) => {
      consuming.resolve(); await consumed.promise;
      for await (const chunk of source) bytes += String(chunk);
      finalAudit.resolve(); await audit.promise;
      return { uploaded: true };
    },
  });
  const response = fetch(`${base}/imports/00000000-0000-4000-8000-000000000000`, {
    method: 'PUT', headers: { 'Content-Type': 'application/x-tar' }, body: 'test archive bytes',
  });
  await consuming.promise;
  const barrier = gate.begin('mcp-import', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    consumed.resolve(); await finalAudit.promise;
    expect(bytes).toBe('test archive bytes'); expect(() => barrier.assertDrained()).toThrow();
    audit.resolve(); expect((await response).status).toBe(201);
    await barrier.drain({ timeoutMs: 1000 });
  } finally { consumed.resolve(); audit.resolve(); await response; barrier.release(); await transport.stop(); }
});
