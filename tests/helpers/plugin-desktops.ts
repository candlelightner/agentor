import { expect, type APIRequestContext } from '@playwright/test';
import { createWorker, cleanupWorker } from './worker-lifecycle';
import WebSocket from 'ws';

export const desktopBase = process.env.BASE_URL || 'http://localhost:3000';
export async function desktopFixture(request: APIRequestContext, label: string) {
  const worker = await createWorker(request, { displayName: `${label}-${Date.now()}` });
  const definitions: any[] = [], installations: any[] = [];
  const cleanup = async (cleanupRequest = request) => {
    for (const item of installations) await cleanupRequest.delete(`/api/containers/${worker.id}/plugins/${item.id}`).catch(() => undefined);
    for (const definition of definitions) await cleanupRequest.delete(`/api/plugins/definitions/${definition.id}`).catch(() => undefined);
    await cleanupWorker(cleanupRequest, worker.id);
  };
  try {
    for (const [index, mode] of ['isolated', 'isolated', 'shared'].entries()) {
      const name = `${label} ${['Red', 'Blue', 'Shared'][index]}`;
      const created = await request.post('/api/plugins/definitions', { data: { scope: 'owner', manifest: {
        schemaVersion: 1, name, slug: `desktop-${index}-${Date.now()}`, description: 'Managed desktop acceptance fixture', version: '1',
        lifecycle: { start: { argv: ['xmessage', '-geometry', '500x300+20+20', '-bg', index === 0 ? '#cc2222' : '#2222cc', '-fg', 'white', '-buttons', 'OK', name], mode: 'background' } },
        resources: { display: mode === 'isolated' ? { mode, width: index === 0 ? 800 : 960, height: 600, depth: 24 } : { mode } },
        actions: [{ id: 'open', label: 'Open review', kind: 'desktop', displayId: 'primary', openMode: 'sandboxed-pane' }],
      } } });
      expect(created.status(), await created.text()).toBe(201); const definition = await created.json(); definitions.push(definition);
      const installed = await request.post(`/api/containers/${worker.id}/plugins`, { data: { definitionId: definition.id } });
      expect(installed.status(), await installed.text()).toBe(201); const installation = await installed.json(); installations.push(installation);
      expect(installation.observed, JSON.stringify(installation)).toMatchObject({ ready: true, state: 'ready' });
    }
    const path = (index: number) => `/plugin-desktop/${worker.id}/${installations[index].id}/open/primary/`;
    return { worker, definitions, installations, path, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

export async function rfbBanner(request: APIRequestContext | null, path: string, origin = desktopBase) {
  const cookies = request ? (await request.storageState()).cookies.map(c => `${c.name}=${c.value}`).join('; ') : '';
  return new Promise<string>((resolve) => {
    const ws = new WebSocket(`${desktopBase.replace(/^http/, 'ws')}${path}`, { headers: { Cookie: cookies, Origin: origin }, rejectUnauthorized: false });
    let done = false;
    const finish = (value: string) => { if (done) return; done = true; clearTimeout(timer); ws.close(); resolve(value); };
    const timer = setTimeout(() => { ws.terminate(); finish(''); }, 10_000);
    ws.on('message', data => finish(data.toString())); ws.on('close', () => finish('')); ws.on('error', () => finish(''));
  });
}
