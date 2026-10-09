import { test, expect, request, chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findButtonByTooltip } from '../helpers/ui-helpers';

const WebSocket = createRequire(join(process.cwd(), '../orchestrator/package.json'))('ws');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const host = (script: string) => execFileSync('ssh', ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1', 'bash -ec ' + quote(script)],
{ encoding: 'utf8', timeout: 60_000 }).trim();

test('real Incus dashboard terminal/files/apps and authenticated plugin UI/desktops', async () => {
  test.skip(process.env.INCUS_EXPERIENCE_TEST !== 'true', 'Explicit retained disposable full-stack fixture');
  test.setTimeout(600_000);
  const baseURL = process.env.INCUS_STACK_URL || 'http://127.0.0.1:38000';
  const data = process.env.INCUS_STACK_DATA_HOST;
  if (!data || !/^\/var\/tmp\/agentor-phase6-production\.[A-Za-z0-9]+\/stack-data$/.test(data))
    throw new Error('Explicit isolated disposable fixture data path required');
  const reuseId = process.env.INCUS_EXPERIENCE_WORKER_ID;
  if (reuseId && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(reuseId))
    throw new Error('Explicit acknowledged fixture worker UUID required');
  const api = await request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL }, timeout: 360_000 });
  const anonymous = await request.newContext({ baseURL });
  const definitions: string[] = [], installations: string[] = [];
  let worker: any, environment: any, browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let terminal: any, primaryFailure = false, stage = 'login';
  let ownerId: string | undefined, incarnation: string | undefined, directoryCreated = false;
  const fence = (value: { id: string; userId: string; runtimeKind: string; status: string; containerName: string; containerId: string }) => {
    if (!ownerId) throw new Error('Fixture session owner is unavailable');
    expect(value).toMatchObject({ userId: ownerId, runtimeKind: 'incus-vm', status: 'running', containerName: 'agentor-worker-' + value.id });
    expect(value.containerId).toMatch(/^incus:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    const durable = JSON.parse(host('sudo python3 -c ' + quote(String.raw`import os,json,sys
d,u,w=sys.argv[1:];f=os.open(d+'/users/'+u+'/workers.json',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(f) as s:
 assert os.fstat(s.fileno()).st_size<=4*1024*1024;matches=[r for r in json.load(s) if r.get('id')==w];assert len(matches)==1;r=matches[0]
print(json.dumps(dict(id=r.get('id'),userId=r.get('userId'),runtimeKind=r.get('runtimeKind'),status=r.get('status'),blocked=bool(r.get('deletionPending') or r.get('incusRecreation') or r.get('incusMigration') and r['incusMigration'].get('phase')!='retained'),installation=open(d+'/backup-installation-id').read().strip())))`) +
      ' ' + quote(data) + ' ' + quote(ownerId) + ' ' + quote(value.id)));
    expect(durable).toMatchObject({ id: value.id, userId: ownerId, runtimeKind: 'incus-vm', status: 'active', blocked: false });
    expect(durable.installation).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    const observed = JSON.parse(host('sudo incus query ' + quote('/1.0/instances/' + encodeURIComponent(value.containerName) + '?project=agentor')));
    expect(observed).toMatchObject({ type: 'virtual-machine', status: 'Running', config: { 'volatile.uuid': value.containerId.slice(6),
      'user.agentor.id': value.id, 'user.agentor.owner': ownerId, 'user.agentor.installation': durable.installation } });
    if (incarnation) expect(value.containerId).toBe('incus:' + incarnation);
    else incarnation = value.containerId.slice(6);
  };
  const previousPaths = JSON.parse(host('sudo incus query /1.0/projects/agentor')).config['restricted.devices.disk.paths'] || '';
  try {
    const login = await api.post('/api/auth/sign-in/email', { data: {
      email: 'incus-stack@agentor.test', password: 'isolated-incus-stack-test-password',
    } });
    expect(login.ok(), await login.text()).toBe(true);
    const owner = (await login.json()).user.id;
    expect(owner).toMatch(/^[A-Za-z0-9_-]+$/);
    ownerId = owner;
    const roots = ['credentials', 'kilo/config', 'kilo/data'].map((suffix) => `${data}/users/${owner}/${suffix}`);
    host(`sudo incus project set agentor restricted.devices.disk.paths ${quote([previousPaths, ...roots].filter(Boolean).join(','))}`);
    if (reuseId) {
      const listed = await api.get('/api/containers'); expect(listed.status()).toBe(200);
      const matches = (await listed.json()).filter((value: { id: string }) => value.id === reuseId);
      expect(matches).toHaveLength(1); worker = matches[0];
    } else {
      const env = await api.post('/api/environments', { data: { name: `Incus experience ${randomUUID()}`, networkMode: 'full', dockerEnabled: false, memoryLimit: '2GiB', cpuLimit: 2 } });
      expect(env.status(), await env.text()).toBe(201); environment = await env.json();
      const created = await api.post('/api/containers', { data: { displayName: `Incus experience ${randomUUID()}`, environmentId: environment.id } });
      expect(created.status(), await created.text()).toBe(201); worker = await created.json();
    }
    expect(worker).toMatchObject({ runtimeKind: 'incus-vm', status: 'running', userId: owner });
    fence(worker);
    const prefix = `/api/containers/${worker.id}`;
    stage = 'files';
    expect((await anonymous.get(`${prefix}/files`)).status()).toBe(401);
    const binary = Buffer.from([0, 255, 10, 13, 128]);
    if (reuseId) {
      const before = await api.get(`${prefix}/files`); expect(before.status()).toBe(200);
      expect((await before.json()).entries.some((entry: { path: string }) => entry.path === 'experience')).toBe(false);
    }
    const mkdir = await api.post(`${prefix}/files/mkdir`, { data: { path: 'experience' } });
    expect(mkdir.status(), await mkdir.text()).toBe(200);
    directoryCreated = true;
    const upload = await api.post(`${prefix}/files/upload`, { multipart: {
      path: 'experience', file: { name: 'bytes.bin', mimeType: 'application/octet-stream', buffer: binary },
    } });
    expect(upload.status(), await upload.text()).toBe(200);
    expect((await (await api.get(`${prefix}/files?path=experience`)).json()).entries).toContainEqual(expect.objectContaining({ name: 'bytes.bin', owner: '1000', group: '1000' }));
    const download = await api.post(`${prefix}/files/download`, { data: { paths: ['experience/bytes.bin'] } });
    expect(download.status()).toBe(200); expect(await download.body()).toEqual(binary);
    const zip = await api.post(`${prefix}/files/download`, { data: { paths: ['experience'] } });
    expect(zip.status()).toBe(200); expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');
    expect((await api.post(`${prefix}/files/mkdir`, { data: { path: '../escape' } })).status()).toBe(400);
    expect((await api.post(`${prefix}/files/rename`, { data: { path: 'experience/bytes.bin', newName: 'renamed.bin' } })).status()).toBe(200);
    stage = 'terminal';
    const pane = await api.post(`${prefix}/panes`, { data: { name: 'experience' } });
    expect(pane.status(), await pane.text()).toBe(201); const window = await pane.json();
    const cookie = (await api.storageState()).cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const firstFrame = (path: string, authenticated = true, origin = baseURL) => new Promise<string>((resolve) => {
      const socket = new WebSocket(baseURL.replace(/^http/, 'ws') + path, { headers: { Cookie: authenticated ? cookie : '', Origin: origin } });
      let finished = false;
      const finish = (value: string) => { if (finished) return; finished = true; clearTimeout(timer); socket.terminate(); resolve(value); };
      const timer = setTimeout(() => finish(''), 15_000);
      socket.on('message', (bytes: Buffer) => finish(bytes.toString()));
      socket.on('error', () => finish('')); socket.on('close', () => finish(''));
    });
    expect(await firstFrame(`/ws/terminal/${worker.id}`, false)).toContain('Unauthorized');
    let output = '';
    terminal = new WebSocket(baseURL.replace(/^http/, 'ws') + `/ws/terminal/${worker.id}/${window.index}`, { headers: { Cookie: cookie, Origin: baseURL } });
    terminal.on('message', (bytes: Buffer) => { output += bytes.toString(); });
    terminal.on('error', () => {});
    await expect.poll(() => output, { timeout: 20_000 }).toMatch(/[$#>]\s/);
    terminal.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    // Computed output cannot be satisfied by the shell echo of its input.
    const token = randomUUID().replaceAll('-', '');
    terminal.send(`printf '%s%s\\n' '${token.slice(0, 16)}' '${token.slice(16)}'; stty size\r`);
    await expect.poll(() => output, { timeout: 20_000 }).toContain(token);
    await expect.poll(() => output, { timeout: 20_000 }).toMatch(/40\s+120/);
    terminal.close(); terminal = undefined;
    expect((await api.delete(`${prefix}/panes/${window.index}`)).status()).toBe(200);
    stage = 'apps';
    const app = await api.post(`${prefix}/apps/socks5`);
    expect(app.status(), await app.text()).toBe(201); const instance = await app.json();
    await expect.poll(async () => (await (await api.get(`${prefix}/apps/socks5`)).json()), { timeout: 15_000 })
      .toContainEqual(expect.objectContaining({ id: instance.id, status: 'running' }));
    expect((await api.delete(`${prefix}/apps/socks5/${instance.id}`)).status()).toBe(200);

    stage = 'plugins';
    const install = async (manifest: any) => {
      const definition = await api.post('/api/plugins/definitions', { data: { scope: 'owner', manifest } });
      expect(definition.status(), await definition.text()).toBe(201); const def = await definition.json(); definitions.push(def.id);
      const result = await api.post(`${prefix}/plugins`, { data: { definitionId: def.id, desiredEnabled: true } });
      expect(result.status(), await result.text()).toBe(201); const item = await result.json(); installations.push(item.id);
      expect(item.observed, JSON.stringify(item)).toMatchObject({ ready: true, state: 'ready' }); return item;
    };
    const server = `import os,http.server,hashlib,base64,time
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  if self.headers.get('Upgrade','').lower()=='websocket':
   accept=base64.b64encode(hashlib.sha1((self.headers['Sec-WebSocket-Key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
   self.send_response(101); self.send_header('Upgrade','websocket'); self.send_header('Connection','Upgrade'); self.send_header('Sec-WebSocket-Accept',accept); self.end_headers()
   self.connection.sendall(b'\\x82\\x09plugin-ws'); time.sleep(1)
  else:
   self.send_response(200); self.end_headers(); self.wfile.write((self.headers.get('Cookie','')+'|'+self.headers.get('Authorization','')).encode())
http.server.ThreadingHTTPServer(('0.0.0.0',int(os.environ['AGENTOR_PLUGIN_PORT_UI'])),H).serve_forever()
`;
    const privateUI = await install({ schemaVersion: 1, name: 'Incus private UI', slug: `incus-ui-${token}`, version: '1', description: 'Isolated acceptance fixture',
      lifecycle: { start: { argv: ['python3', '-c', server], mode: 'background' }, readiness: { kind: 'http', portId: 'ui', path: '/', timeoutSeconds: 20 } },
      resources: { ports: [{ id: 'ui', protocol: 'http', rangeStart: 39300, rangeEnd: 39399 }] },
      actions: [{ id: 'open', label: 'Open', kind: 'private-ui', portId: 'ui', path: '/' }] });
    const privatePath = `/plugin-ui/${worker.id}/${privateUI.id}/open/`;
    expect((await anonymous.get(privatePath)).status()).toBe(401);
    const ui = await api.get(privatePath, { headers: { Authorization: 'Bearer fixture-not-forwarded' } });
    expect(ui.status(), await ui.text()).toBe(200); expect(await ui.text()).toBe('|');
    expect(ui.headers()['content-security-policy']).toContain('sandbox');
    expect(await firstFrame(privatePath)).toBe('plugin-ws');
    expect(await firstFrame(privatePath, false)).toBe('');
    expect(await firstFrame(privatePath, true, 'https://unrelated.invalid')).toBe('');
    const desktops: any[] = [];
    for (const mode of ['shared', 'isolated']) desktops.push(await install({ schemaVersion: 1, name: `Incus ${mode} desktop`, slug: `incus-${mode}-${token}`, version: '1', description: 'Isolated acceptance fixture',
      lifecycle: { start: { argv: ['xmessage', '-geometry', '500x300+20+20', '-bg', '#cc2222', '-fg', 'white', '-buttons', 'OK', `Incus ${mode}`], mode: 'background' } },
      resources: { display: mode === 'isolated' ? { mode, width: 800, height: 600, depth: 24 } : { mode } },
      actions: [{ id: 'open', label: 'Open', kind: 'desktop', displayId: 'primary', openMode: 'sandboxed-pane' }] }));
    const desktopPath = `/plugin-desktop/${worker.id}/${desktops[1].id}/open/primary/`;
    expect((await anonymous.get(desktopPath)).status()).toBe(401);
    expect(await firstFrame(`${desktopPath}websockify`)).toMatch(/^RFB 003\./);
    expect(await firstFrame(`${desktopPath}websockify`, false)).toBe('');
    expect(await firstFrame(`${desktopPath}websockify`, true, 'https://unrelated.invalid')).toBe('');
    expect((await api.get(`/plugin-desktop/${worker.id}/${desktops[0].id}/open/primary/`)).url()).toContain(`/desktop/${worker.id}/agentor.html`);
    if (process.env.INCUS_STACK_RESTART_TEST === 'true') {
      stage = 'orchestrator restart';
      // Restart only the helper-owned disposable Orchestrator, never a
      // similarly named production/control-plane container.
      expect(worker.containerName).toMatch(/^agentor-worker-[a-f0-9-]+$/);
      const containerId = host("sudo docker inspect --format '{{.Id}}' agentor-orchestrator");
      expect(containerId).toMatch(/^[a-f0-9]{64}$/);
      const owned = JSON.parse(host(`sudo docker inspect --format '{{json .Config.Labels}}' ${quote(containerId)}`));
      expect(owned['agentor.incus.acceptance']).toBe('true');
      const mounts = JSON.parse(host(`sudo docker inspect --format '{{json .Mounts}}' ${quote(containerId)}`));
      expect(mounts).toContainEqual(expect.objectContaining({ Source: data, Destination: '/data' }));
      const guestState = () => host(`sudo incus exec ${quote(worker.containerName)} --project agentor -- sh -ec 'cat /proc/sys/kernel/random/boot_id; systemctl show agentor-worker --property=MainPID --value'`);
      const before = guestState();
      host(`sudo docker restart --time 30 ${quote(containerId)}`);
      await expect.poll(async () => {
        try { return (await api.get(`${prefix}/files?path=experience`)).status(); }
        catch { return 0; }
      }, { timeout: 120_000, intervals: [1000, 2000] }).toBe(200);
      expect(guestState()).toBe(before);
      expect((await api.get(privatePath)).status()).toBe(200);
      expect(await firstFrame(`${desktopPath}websockify`)).toMatch(/^RFB 003\./);
    }
    stage = 'browser';
    browser = await chromium.launch({ executablePath: process.env.INCUS_BROWSER_EXECUTABLE });
    const context = await browser.newContext({ baseURL, storageState: await api.storageState() });
    const page = await context.newPage(); await page.goto('/');
    // A trusted dashboard-origin browser can relay to the authenticated plugin.
    // An opaque sandbox cannot borrow that authority; do not widen the existing
    // PluginPane sandbox with allow-same-origin just to enable its WebSockets.
    const browserFrame = (url: string) => new Promise<string>((resolve) => {
      const socket = new window.WebSocket(url); socket.binaryType = 'arraybuffer';
      let settled = false;
      const finish = (value: string) => {
        if (settled) return; settled = true; clearTimeout(timer); socket.close(); resolve(value);
      };
      const timer = setTimeout(() => finish(''), 15_000);
      socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => finish(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data));
      socket.onerror = socket.onclose = () => finish('');
    });
    const pluginSocketUrl = baseURL.replace(/^http/, 'ws') + privatePath;
    expect(await page.evaluate(browserFrame, pluginSocketUrl)).toBe('plugin-ws');
    await page.evaluate(() => {
      const frame = document.createElement('iframe'); frame.dataset.originFixture = 'opaque';
      frame.sandbox.add('allow-scripts'); frame.srcdoc = '<body>Opaque plugin origin fixture</body>';
      document.body.append(frame);
    });
    const opaqueBody = page.locator('iframe[data-origin-fixture="opaque"]').contentFrame().locator('body');
    await opaqueBody.waitFor();
    expect(await opaqueBody.evaluate((_body, args) => {
      // Serialize the same bounded probe without relying on the parent origin.
      return new Promise<string>((resolve) => {
        const socket = new window.WebSocket(args); let settled = false;
        const finish = (value: string) => {
          if (settled) return; settled = true; clearTimeout(timer); socket.close(); resolve(value);
        };
        const timer = setTimeout(() => finish(''), 15_000);
        socket.onmessage = () => finish('unexpected backend frame');
        socket.onerror = socket.onclose = () => finish('');
      });
    }, pluginSocketUrl)).toBe('');
    await page.locator('iframe[data-origin-fixture="opaque"]').evaluate((frame) => frame.remove());
    const card = page.locator('.rounded-lg').filter({ hasText: worker.displayName }).first();
    await expect(card.locator('text=running')).toBeVisible({ timeout: 60_000 });
    await card.locator('button').first().click();
    await expect(page.locator('.xterm-screen').first()).toBeVisible({ timeout: 30_000 });
    await (await findButtonByTooltip(card, page, 'Files')).click();
    const modal = page.getByTestId('workspace-files-modal'); await expect(modal).toBeVisible();
    await expect(modal.locator('[data-row-path="experience"]')).toBeVisible({ timeout: 15_000 });
    await modal.locator('button[aria-label="Close"]').click();
    await page.goto(desktopPath);
    await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    await expect(page.locator('canvas')).toHaveAttribute('width', '800');
    await expect.poll(async () => page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let red = 0; for (let i = 0; i < pixels.length; i += 4) if (pixels[i]! > 140 && pixels[i + 2]! < 70) red++;
      return red;
    }), { timeout: 30_000 }).toBeGreaterThan(20_000);
    await page.reload(); await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'ready', { timeout: 30_000 });
    expect((await api.put(`${prefix}/plugins/${desktops[1].id}/enabled`, { data: { enabled: false } })).status()).toBe(200);
    await expect(page.locator('body')).toHaveAttribute('data-desktop-state', 'disabled', { timeout: 15_000 });
    expect((await api.get(privatePath)).status()).toBe(200);
  } catch (error) {
    primaryFailure = true;
    console.error('Incus experience failed at stage', stage, 'worker', worker?.id);
    throw error;
  }
  finally {
    const failures: string[] = [];
    const cleanup = async (label: string, operation: () => Promise<unknown>) => {
      try { await operation(); } catch { failures.push(label); }
    };
    const remove = (path: string) => cleanup(path, async () => {
      const response = await api.delete(path);
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    });
    try {
      await cleanup('terminal', async () => terminal?.close());
      await cleanup('browser', async () => browser?.close());
      let currentOwned = false;
      if (worker && incarnation) await cleanup('captured worker incarnation', async () => {
        const listed = await api.get('/api/containers'); expect(listed.status()).toBe(200);
        const matches = (await listed.json()).filter((value: { id: string }) => value.id === worker.id);
        expect(matches).toHaveLength(1); fence(matches[0]); currentOwned = true;
      });
      if (currentOwned) {
        for (const id of installations) await remove(`/api/containers/${worker.id}/plugins/${id}`);
        for (const id of definitions) await remove(`/api/plugins/definitions/${id}`);
        if (reuseId && directoryCreated) await cleanup('owned experience files', async () => {
          expect((await api.delete(`/api/containers/${worker.id}/files`, { data: { paths: ['experience'] } })).status()).toBe(200);
        });
        if (!reuseId) await remove(`/api/containers/${worker.id}`);
      }
      if (environment && currentOwned) await remove(`/api/environments/${environment.id}`);
      if (reuseId && currentOwned) console.info('Acknowledged experience worker/environment retained for full-stack gate', { workerId: worker.id, incarnation });
    } finally {
      await cleanup('restricted project path restoration', async () => {
        host(`sudo incus project set agentor restricted.devices.disk.paths ${quote(previousPaths)}`);
      });
      await cleanup('authenticated context', () => api.dispose());
      await cleanup('anonymous context', () => anonymous.dispose());
    }
    if (failures.length) { console.error('Exact fixture cleanup failures', failures); if (!primaryFailure) throw new Error(failures.join(', ')); }
  }
});
