import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createRequire } from 'node:module';
import { WebSocketServer } from 'ws';
import * as lifecycle from '../../orchestrator/server/utils/worker-lifecycle-coordinator';

const fixtureRequire = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { transform } = fixtureRequire('esbuild');

async function fixture(runtimeKind = 'incus-vm') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const port = (server.address() as any).port, id = randomUUID();
  let info: any = { id, userId: 'owner', status: 'running', runtimeKind, administrativeKind: 'group', containerId: 'incus:'+randomUUID() };
  let address = '127.0.0.1', denied = false, connections = 0, closed = 0;
  const messages: string[] = [];
  server.on('connection', socket => { connections++; socket.on('message', bytes => socket.send(bytes)); });
  const cm = { get: () => info, resolveWorkerHost: async () => { if (denied) throw Error('Dedicated authority revoked'); return address; } };
  const source = await readFile(new URL('../../orchestrator/server/utils/ws-utils.ts', import.meta.url), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'node22' });
  const module = { exports: {} as any };
  runInNewContext(compiled.code, { module, exports: module.exports, Buffer, URL, setInterval, clearInterval,
    require(name: string) {
      if (name === './services') return { useContainerManager: () => cm };
      if (name === './auth-helpers') return { authenticateWsPeer: async () => ({ user: { id: 'owner', role: 'user' } }) };
      if (name === './worker-lifecycle-coordinator') return lifecycle;
      if (name === 'ws') return fixtureRequire('ws');
      throw Error('Unexpected fixture import: '+name);
    } });
  const relay = module.exports.createWsRelayHandlers(/\/ws\/desktop\/([^/?]+)/, (host: string) => `ws://${host}:${port}`);
  const peer = { id: randomUUID(), request: { url: 'http://agentor.test/ws/desktop/'+id,
    headers: new Headers({ host: 'agentor.test', origin: 'https://agentor.test' }) },
    close() { closed++; }, send(bytes: Buffer) { messages.push(bytes.toString()); } } as any;
  return { relay, peer, id, cm, messages, connections: () => connections, closed: () => closed,
    revoke: () => { denied = true; }, replace: () => { info = { ...info, containerId: 'incus:'+randomUUID() }; },
    changeOwner: () => { info = { ...info, userId: 'foreign' }; }, mutateOwner: () => { info.userId='foreign'; }, changeAddress: () => { address = '127.0.0.2'; },
    cleanup: async () => { relay.close(peer); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

for (const change of ['dedicated-record', 'incarnation', 'owner', 'in-place-owner', 'peer', 'lifecycle'] as const)
  test(`an established native administrative proxy closes on ${change} revocation`, async () => {
    const f = await fixture();
    try {
      await f.relay.open(f.peer); await expect.poll(f.connections).toBe(1);
      f.relay.message(f.peer, 'before-revocation'); await expect.poll(() => f.messages).toEqual(['before-revocation']);
      if (change === 'dedicated-record') f.revoke();
      if (change === 'incarnation') f.replace();
      if (change === 'owner') f.changeOwner();
      if (change === 'in-place-owner') f.mutateOwner();
      if (change === 'peer') f.changeAddress();
      if (change === 'lifecycle') await lifecycle.withOwnerWorkerLifecycleMutation('owner', f.id, async () => {});
      await expect.poll(f.closed).toBe(1);
      f.relay.message(f.peer, 'after-revocation');
      expect(f.messages).toEqual(['before-revocation']); expect(f.connections()).toBe(1);
    } finally { await f.cleanup(); }
  });

test('native proxy replacement during asynchronous backend lookup never opens a connection', async () => {
  const f = await fixture(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), active = new Promise<void>(resolve => { entered = resolve; });
  f.cm.resolveWorkerHost = async () => { entered(); await gate; return '127.0.0.1'; };
  try {
    await f.relay.open(f.peer); await active; f.replace(); release();
    await expect.poll(f.closed).toBe(1); expect(f.connections()).toBe(0);
  } finally { release(); await f.cleanup(); }
});

test('an established legacy admin proxy closes when dedicated authority switches to native', async () => {
  const f=await fixture('legacy-docker');
  try {
    await f.relay.open(f.peer); await expect.poll(f.connections).toBe(1);
    f.revoke(); await expect.poll(f.closed).toBe(1); expect(f.connections()).toBe(1);
  } finally { await f.cleanup(); }
});
