import { expect, test } from '@playwright/test';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { installInstanceHttpAdapter, scheduleInstanceHttpTask } from '../../orchestrator/server/utils/instance-http-adapter';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { createApp, eventHandler, toNodeListener, createError } = require('h3');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function fixture(options: any, handler: (event: any) => unknown) {
  const gate = new InstanceControlPlaneCoordinator();
  const app = createApp(options);
  app.use(eventHandler(handler));
  // Nitro creates the node listener before running application plugins.
  const server = createServer(toNodeListener(app));
  installInstanceHttpAdapter(app, gate);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as any).port}/test`;
  return { app, gate, url, close: async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('actual Node/H3 envelope waits for an admitted mutating GET through both writes and response hooks', async () => {
  const entered = deferred(), resume = deferred(), hook = deferred(), inHook = deferred();
  const writes: string[] = [];
  const f = await fixture({ onAfterResponse: async () => { inHook.resolve(); await hook.promise; writes.push('hook'); } },
    async () => { writes.push('first'); entered.resolve(); await resume.promise; writes.push('second'); return 'ok'; });
  try {
    const response = fetch(f.url); await entered.promise;
    const barrier = f.gate.begin('job', 'snapshot');
    let drained = false; const waiting = barrier.drain({ timeoutMs: 2000 }).then(() => { drained = true; });
    expect(writes).toEqual(['first']); expect(drained).toBe(false);
    resume.resolve(); await inHook.promise; expect(drained).toBe(false);
    hook.resolve(); await waiting; expect(writes).toEqual(['first', 'second', 'hook']);
    expect(await (await response).text()).toBe('ok'); barrier.release();
  } finally { resume.resolve(); hook.resolve(); await f.close(); }
});

test('closed admission rejects before request/auth hooks, handler, or mutating error hooks', async () => {
  const calls: string[] = [];
  const f = await fixture({ onRequest: () => calls.push('auth'), onError: () => calls.push('error'),
    onBeforeResponse: () => calls.push('before'), onAfterResponse: () => calls.push('after') }, () => calls.push('handler'));
  try {
    const barrier = f.gate.begin('job', 'snapshot');
    expect((await fetch(f.url)).status).toBe(423); expect(calls).toEqual([]);
    expect(f.gate.activeOperations).toBe(0); barrier.release();
  } finally { await f.close(); }
});

test('handled H3 errors remain enrolled through error renderer and after-response writes', async () => {
  const entered = deferred(), resume = deferred(), after = deferred(), releaseAfter = deferred();
  const f = await fixture({ onError: async (_error: any, event: any) => {
    entered.resolve(); await resume.promise; event.context.errorHookCompleted = true;
  }, onAfterResponse: async (event: any) => {
    expect(event.context.errorHookCompleted).toBe(true); after.resolve(); await releaseAfter.promise;
  } }, () => { throw createError({ statusCode: 409, statusMessage: 'Expected test failure' }); });
  try {
    const response = fetch(f.url); await entered.promise;
    const barrier = f.gate.begin('job', 'snapshot');
    resume.resolve(); await after.promise;
    expect(() => barrier.assertDrained()).toThrow(); releaseAfter.resolve();
    await barrier.drain({ timeoutMs: 2000 }); expect((await response).status).toBe(409); barrier.release();
  } finally { resume.resolve(); releaseAfter.resolve(); await f.close(); }
});

test('Nitro-style waitUntil assignment inside onRequest tracks children after response completion', async () => {
  const work = deferred(), started = deferred(), passed: unknown[] = [];
  const f = await fixture({ onRequest: (event: any) => {
    event.waitUntil = (promise: Promise<unknown>) => passed.push(promise);
    event.waitUntil(work.promise); started.resolve();
  } }, () => 'ok');
  try {
    expect(await (await fetch(f.url)).text()).toBe('ok'); await started.promise;
    const barrier = f.gate.begin('job', 'snapshot'); expect(passed).toEqual([work.promise]);
    expect(f.gate.activeOperations).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    work.resolve(); await barrier.drain({ timeoutMs: 2000 }); barrier.release();
  } finally { work.resolve(); await f.close(); }
});

test('waitUntil in the H3 error hook stays enrolled after its response is sent', async () => {
  const work = deferred();
  const f = await fixture({ onError: (_error: any, event: any) => event.waitUntil(work.promise) },
    () => { throw createError({ statusCode: 400 }); });
  try {
    expect((await fetch(f.url)).status).toBe(400);
    const barrier = f.gate.begin('job', 'snapshot'); expect(() => barrier.assertDrained()).toThrow();
    work.resolve(); await barrier.drain({ timeoutMs: 2000 }); barrier.release();
  } finally { work.resolve(); await f.close(); }
});

test('response disconnect does not release a still-running handler and its finally', async () => {
  const entered = deferred(), resume = deferred(), completed = deferred();
  let wrote = false;
  const f = await fixture({}, async () => {
    entered.resolve(); try { await resume.promise; return 'ok'; }
    finally { wrote = true; completed.resolve(); }
  });
  try {
    const client = request(f.url); client.on('error', () => {}); client.end();
    await entered.promise; client.destroy();
    const barrier = f.gate.begin('job', 'snapshot'); expect(() => barrier.assertDrained()).toThrow();
    expect(wrote).toBe(false); resume.resolve(); await completed.promise;
    await barrier.drain({ timeoutMs: 2000 }); expect(wrote).toBe(true); barrier.release();
  } finally { resume.resolve(); await f.close(); }
});

test('real stream response remains enrolled until stream end and after-response finalizer', async () => {
  const stream = new PassThrough(), entered = deferred();
  const f = await fixture({}, () => { entered.resolve(); return stream; });
  try {
    const response = fetch(f.url); await entered.promise;
    stream.write('first'); const result = await response;
    const barrier = f.gate.begin('job', 'snapshot'); expect(() => barrier.assertDrained()).toThrow();
    stream.end('second'); expect(await result.text()).toBe('firstsecond');
    await barrier.drain({ timeoutMs: 2000 }); barrier.release();
  } finally { stream.end(); await f.close(); }
});

test('duplicate installation fails without wrapping twice', async () => {
  const f = await fixture({}, () => 'ok');
  try {
    expect(() => installInstanceHttpAdapter(f.app, f.gate)).toThrow('already installed');
    expect(await (await fetch(f.url)).text()).toBe('ok'); expect(f.gate.activeOperations).toBe(0);
  } finally { await f.close(); }
});

test('thunk-created HTTP task retains late nested write and awaited cleanup admission', async () => {
  const work = deferred(), cleanup = deferred(), inCleanup = deferred();
  const writes: string[] = [];
  let actual!: Promise<void>;
  const f = await fixture({}, (event: any) => {
    actual = scheduleInstanceHttpTask(event, f.gate, async () => {
      try { await work.promise; await f.gate.run(() => { writes.push('write'); }); }
      finally {
        inCleanup.resolve(); await cleanup.promise;
        await f.gate.run(() => { writes.push('cleanup'); });
      }
    });
    return 'ok';
  });
  try {
    expect(await (await fetch(f.url)).text()).toBe('ok');
    const barrier = f.gate.begin('job', 'snapshot');
    work.resolve(); await inCleanup.promise;
    expect(writes).toEqual(['write']); expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve(); await actual; await barrier.drain({ timeoutMs: 2000 });
    expect(writes).toEqual(['write', 'cleanup']); barrier.release();
  } finally { work.resolve(); cleanup.resolve(); await actual?.catch(() => {}); await f.close(); }
});
