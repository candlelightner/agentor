import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createApp, defineEventHandler, getCookie, toNodeListener } from '../../orchestrator/node_modules/h3/dist/index.mjs';
import { ManagementMcpStore } from '../../orchestrator/server/utils/management-mcp-store';
import { ManagementMcpTransport } from '../../orchestrator/server/utils/management-mcp-transport';
import { useLogStore } from '../../orchestrator/server/utils/services';
import { serverLogDownload } from '../../orchestrator/server/utils/server-log-download';

// Only temporary log storage and production HTTP handlers/listener run here.
// Identity/session fixtures never initialize Docker or Incus resources.
test.describe.serial('Isolated server log listeners', () => {
  let store: ManagementMcpStore, transport: ManagementMcpTransport, credential: string, mcpUrl: string, downloadUrl: string;
  let http: ReturnType<typeof createServer>;
  const known = `known-server-entry-${randomBytes(8).toString('hex')}\nsecond line`;
  test.beforeAll(async () => {
    await useLogStore().init();
    useLogStore().append({ timestamp: '2026-10-17T10:00:00.000Z', level: 'error', source: 'orchestrator', message: known + '\nPASSWORD=do-not-leak' }, 'orchestrator');
    useLogStore().append({ timestamp: '2026-10-17T10:00:01.000Z', level: 'info', source: 'orchestrator', message: 'another-server-entry' }, 'orchestrator');
    store = new ManagementMcpStore(process.env.DATA_DIR, async () => undefined);
    const raw = randomBytes(32).toString('base64url');
    credential = `mcp1.${raw}`;
    const hash = createHash('sha256').update(raw).digest('hex');
    (store as any).identities.set(hash, { hash, workspaceId: 'isolated-platform-admin', expiresAt: Date.now() + 300_000 });
    const introspect = store.introspect.bind(store);
    store.introspect = async value => value === 'test-group-principal' ? { workspaceId: 'isolated-group-admin', audience: 'agentor-management-mcp', expiresAt: new Date(Date.now() + 60_000).toISOString(), persistedInWorkspace: false, scope: 'group', ownerId: 'owner-a', groupId: 'group-a' } : introspect(value);
    transport = new ManagementMcpTransport(store, 0);
    await transport.start('127.0.0.1');
    mcpUrl = `http://127.0.0.1:${[...(transport as any).servers.values()][0].address().port}/mcp`;
    const app = createApp();
    app.use(defineEventHandler(event => {
      // Stand-in middleware supplies three principals; production requireAdmin
      // still enforces authorization on the actual file handler.
      const session = getCookie(event, 'isolated-session');
      if (session) event.context.auth = { user: { role: session === 'admin' ? 'admin' : 'user', id: session }, session: { id: session } };
    }));
    app.use('/api/logs/download', serverLogDownload);
    http = createServer(toNodeListener(app));
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    downloadUrl = `http://127.0.0.1:${(http.address() as any).port}/api/logs/download`;
  });
  test.afterAll(async () => { await transport?.stop(); await new Promise<void>(resolve => http?.close(() => resolve())); await useLogStore().destroy(); });
  async function rpc(method: string, params: any, token = credential) {
    const response = await fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    expect(response.status).toBe(200);
    return response.json();
  }
  test('real MCP listener discovers and invokes redacted server logs for a platform identity', async () => {
    const discovery = await rpc('tools/list', {});
    expect(discovery.result.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'logs.server-read', annotations: expect.objectContaining({ readOnlyHint: true }) })]));
    const response = await rpc('tools/call', { name: 'logs.server-read', arguments: { levels: ['error'], search: 'known-server-entry', limit: 1 } });
    expect(response.result.isError).toBe(false);
    expect(response.result.structuredContent.entries).toHaveLength(1);
    expect(response.result.structuredContent.entries[0].message).toContain(known);
    expect(JSON.stringify(response)).not.toContain('do-not-leak');
  });
  test('real MCP listener hides and denies server logs to group/ordinary identities and honors live policy', async () => {
    const discovery = await rpc('tools/list', {}, 'test-group-principal');
    expect(discovery.result.tools.map((tool: any) => tool.name)).not.toContain('logs.server-read');
    for (const token of ['test-group-principal', 'ordinary-worker-no-identity']) {
      const denied = await rpc('tools/call', { name: 'logs.server-read', arguments: {} }, token);
      expect(denied.result.isError).toBe(true);
      expect([401, 403]).toContain(denied.result.structuredContent.error.statusCode);
      expect(JSON.stringify(denied)).not.toContain(known);
    }
    await store.updatePolicy({ logs: false }, 'isolated-test');
    try {
      expect((await rpc('tools/list', {})).result.tools.map((tool: any) => tool.name)).not.toContain('logs.server-read');
      expect((await rpc('tools/call', { name: 'logs.server-read', arguments: {} })).result.structuredContent.error.statusCode).toBe(403);
    } finally { await store.updatePolicy({ logs: true }, 'isolated-test'); }
  });
  test('authenticated HTTP download returns filtered JSONL bytes, filename, type, and pagination headers', async () => {
    const headers = { Cookie: 'isolated-session=admin' };
    const response = await fetch(downloadUrl + '?levels=error&search=known-server-entry&since=2026-10-17T10:00:00Z&until=2026-10-17T10:00:01Z', { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="agentor-server-logs-.*\.jsonl"$/);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(0);
    expect(JSON.parse(bytes.toString('utf8').trim())).toMatchObject({ source: 'orchestrator', level: 'error', message: expect.stringContaining(known) });
    expect(bytes.toString()).not.toContain('do-not-leak');
    expect(response.headers.get('x-log-has-more')).toBe('false');
    const first = await fetch(downloadUrl + '?limit=1', { headers });
    expect(first.headers.get('x-log-has-more')).toBe('true');
    const second = await fetch(downloadUrl + '?limit=1&cursor=' + encodeURIComponent(first.headers.get('x-log-next-cursor')!), { headers });
    expect(await first.text()).not.toEqual(await second.text());
  });
  test('HTTP download denies anonymous/non-admin sessions and reports empty/malformed requests', async () => {
    expect((await fetch(downloadUrl)).status).toBe(401);
    expect((await fetch(downloadUrl, { headers: { Cookie: 'isolated-session=user' } })).status).toBe(403);
    for (const [query, status] of [['?search=nonexistent-test-entry', 404], ['?limit=-1', 400], ['?sources=worker', 400], ['?since=invalid', 400]] as const) {
      const response = await fetch(downloadUrl + query, { headers: { Cookie: 'isolated-session=admin' } });
      expect(response.status).toBe(status);
      expect(response.headers.get('content-disposition')).toBeNull();
    }
  });
});
