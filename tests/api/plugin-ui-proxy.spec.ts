import { test, expect, request as playwrightRequest } from '@playwright/test';
import WSImpl from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestUser, deleteTestUser } from '../helpers/test-users';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');
const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_STORAGE = resolve(__dirname, '..', '.auth/admin-api.json');

function manifest(suffix: string) {
  // The response reflects only headers which must never cross the proxy. This
  // lets the test prove that the browser session cookie itself stays at the
  // gateway rather than becoming a plugin-backend credential.
  const server = Buffer.from(`import os,socket,base64,hashlib,threading,time
s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',int(os.environ['AGENTOR_PLUGIN_PORT_UI'])));s.listen()
def handle(c):
 d=c.recv(65535).decode('iso-8859-1');h=dict(x.split(': ',1) for x in d.split('\\r\\n')[1:] if ': ' in x)
 if h.get('Upgrade','').lower()=='websocket':
  a=base64.b64encode(hashlib.sha1((h['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode();c.sendall(('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+a+'\\r\\n\\r\\n').encode());time.sleep(5)
 else:
  c.sendall(('HTTP/1.1 200 OK\\r\\nContent-Length: '+str(len((h.get('Cookie','')+'|'+h.get('Authorization','')).encode()))+'\\r\\n\\r\\n'+h.get('Cookie','')+'|'+h.get('Authorization','')).encode())
 c.close()
while True: threading.Thread(target=handle,args=(s.accept()[0],),daemon=True).start()
`).toString('base64');
  return {
    schemaVersion: 1,
    name: `UI proxy ${suffix}`,
    slug: `ui-proxy-${suffix}`,
    description: 'Private UI proxy authorization test plugin.',
    version: '1.0.0',
    lifecycle: {
      start: { argv: ['python3', '-c', `import base64;exec(compile(base64.b64decode('${server}'),'plugin-server','exec'))`], mode: 'background' },
      readiness: { kind: 'http', portId: 'ui', path: '/', timeoutSeconds: 20 },
    },
    actions: [{ id: 'open', label: 'Open', kind: 'private-ui', portId: 'ui', path: '/' }],
    resources: { ports: [{ id: 'ui', protocol: 'http', rangeStart: 39300, rangeEnd: 39399 }] },
  };
}

async function userCookieHeader(email: string, password: string): Promise<string> {
  const ctx = await playwrightRequest.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  try {
    await ctx.post('/api/auth/sign-in/email', { data: { email, password } });
    const state = await ctx.storageState();
    return (state.cookies ?? []).map((c) => `${c.name}=${c.value}`).join('; ');
  } finally {
    await ctx.dispose();
  }
}

function readAdminCookieHeader(): string {
  if (!existsSync(ADMIN_STORAGE)) return '';
  const state = JSON.parse(readFileSync(ADMIN_STORAGE, 'utf-8'));
  return (state.cookies ?? []).map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');
}

function dial(url: string, headers: Record<string, string> = {}) {
  return new Promise<boolean>((resolve) => {
    const ws = new WSImpl(url, { headers });
    let settled = false;
    const finish = (opened: boolean) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve(opened);
    };
    ws.on('open', () => setTimeout(() => finish(true), 500));
    ws.on('close', () => finish(false));
    ws.on('error', () => finish(false));
    setTimeout(() => finish(false), 5_000);
  });
}

test.describe.serial('Private plugin UI proxy', () => {
  let workerId = '';
  let definitionId = '';
  let installationId = '';
  let url = '';

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request, { displayName: `PluginUi-${Date.now()}` })).id;
    const created = await request.post(`${BASE_URL}/api/plugins/definitions`, {
      data: { scope: 'owner', manifest: manifest(String(Date.now())) },
    });
    expect(created.status()).toBe(201);
    definitionId = (await created.json()).id;
    const installed = await request.post(`${BASE_URL}/api/containers/${workerId}/plugins`, {
      data: { definitionId, desiredEnabled: true },
    });
    expect(installed.status()).toBe(201);
    const installation = await installed.json();
    expect(installation.observed).toMatchObject({ state: 'ready', ready: true });
    installationId = installation.id;
    url = `${BASE_URL}/plugin-ui/${workerId}/${installationId}/open/`;
  });

  test.afterAll(async ({ request }) => {
    if (installationId) await request.delete(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}`).catch(() => undefined);
    if (definitionId) await request.delete(`${BASE_URL}/api/plugins/definitions/${definitionId}`).catch(() => undefined);
    if (workerId) await cleanupWorker(request, workerId);
  });

  test('requires a session and isolates browser credentials from the backend', async ({ request }) => {
    const anonymous = await playwrightRequest.newContext({ baseURL: BASE_URL, storageState: { cookies: [], origins: [] } });
    try {
      expect((await anonymous.get(url)).status()).toBe(401);
    } finally {
      await anonymous.dispose();
    }

    const response = await request.get(url, { headers: { Authorization: 'Bearer should-not-reach-plugin' } });
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('|');
    expect(response.headers()['cache-control']).toBe('no-store');
    expect(response.headers()['content-security-policy']).toContain('sandbox');
  });

  test('rejects a non-owner, mismatched worker or installation, and an unknown action', async ({ request }) => {
    const user = await createTestUser('Plugin UI Cross User');
    try {
      const cookie = await userCookieHeader(user.email, user.password);
      const other = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Cookie: cookie }, storageState: { cookies: [], origins: [] } });
      try {
        expect((await other.get(url)).status()).toBe(404);
      } finally {
        await other.dispose();
      }
    } finally {
      await deleteTestUser(user.id);
    }
    expect((await request.get(`${BASE_URL}/plugin-ui/00000000-0000-0000-0000-000000000000/${installationId}/open/`)).status()).toBe(404);
    expect((await request.get(`${BASE_URL}/plugin-ui/${workerId}/00000000-0000-0000-0000-000000000000/open/`)).status()).toBe(404);
    expect((await request.get(`${BASE_URL}/plugin-ui/${workerId}/${installationId}/missing/`)).status()).toBe(404);
  });

  test('WebSocket relay enforces session, ownership, and action authorization', async () => {
    const adminCookie = readAdminCookieHeader();
    expect(adminCookie).toBeTruthy();
    expect(await dial(url.replace(/^http/, 'ws'), { Cookie: adminCookie })).toBe(true);
    expect(await dial(url.replace(/^http/, 'ws'))).toBe(false);
    const user = await createTestUser('Plugin UI WS Cross User');
    try {
      const cookie = await userCookieHeader(user.email, user.password);
      expect(await dial(url.replace(/^http/, 'ws'), { Cookie: cookie })).toBe(false);
    } finally {
      await deleteTestUser(user.id);
    }
    expect(await dial(url.replace('/open/', '/missing/').replace(/^http/, 'ws'), { Cookie: adminCookie })).toBe(false);
  });

  test('rejects disabled installations before HTTP or WebSocket proxying', async ({ request }) => {
    const disabled = await request.put(`${BASE_URL}/api/containers/${workerId}/plugins/${installationId}/enabled`, { data: { enabled: false } });
    expect(disabled.status()).toBe(200);
    expect((await request.get(url)).status()).toBe(409);
    const adminCookie = readAdminCookieHeader();
    expect(adminCookie).toBeTruthy();
    expect(await dial(url.replace(/^http/, 'ws'), { Cookie: adminCookie })).toBe(false);
  });
});
