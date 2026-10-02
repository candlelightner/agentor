import { expect, test } from '@playwright/test';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { createServer, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerPluginExecTransport } from '../../orchestrator/server/utils/docker-plugin-exec-transport';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

const id = 'a'.repeat(64);
const modem = () => ({ socketPath: '/var/run/docker.sock', protocol: 'http', headers: {} });
const signal = () => new AbortController().signal;
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response(status: number, content = 'application/json', complete = true) {
  const stream = new PassThrough() as any;
  stream.statusCode = status; stream.headers = { 'content-type': content }; stream.complete = complete;
  return stream;
}
function socket(held = false) {
  let finish!: () => void;
  const value = new Duplex({ read() {}, write(_chunk, _encoding, done) { done(); },
    destroy(_error, done) { finish = done; if (!held) done(); } });
  return { value: value as unknown as Socket, release: () => finish?.() };
}
function fixture(options: { holdRequest?: boolean; holdBody?: boolean; timeoutMs?: number; endpoint?: any } = {}) {
  const gate = new InstanceControlPlaneCoordinator(), requested = deferred();
  const bodies: Buffer[] = [], requestOptions: any[] = [];
  let finishDestroy!: () => void, finishBody!: () => void;
  const req = new Writable({ autoDestroy: false,
    write(chunk, _encoding, done) { bodies.push(Buffer.from(chunk)); finishBody = done; if (!options.holdBody) done(); },
    destroy(_error, done) { finishDestroy = done; if (!options.holdRequest) done(); },
  });
  const transport = createDockerPluginExecTransport({ modem: options.endpoint ?? modem(), coordinator: gate,
    timeoutMs: options.timeoutMs ?? 1000,
    request: settings => { requestOptions.push(settings); requested.resolve(); return req as any; } });
  return { gate, req, requested, transport, bodies, requestOptions, releaseRequest: () => finishDestroy?.(), releaseBody: () => finishBody?.() };
}

test('setup uses fixed endpoint/runner/grants and waits for full valid bounded response', async () => {
  const f = fixture(); const pending = f.transport.setup('container/encoded', 'execute', signal());
  await f.requested.promise; const res = response(201); f.req.emit('response', res);
  res.end(JSON.stringify({ Id: id })); await expect(pending).resolves.toBe(id);
  expect(f.requestOptions[0]).toMatchObject({ socketPath: '/var/run/docker.sock', agent: false,
    method: 'POST', path: '/containers/container%2Fencoded/exec' });
  expect(JSON.parse(Buffer.concat(f.bodies).toString())).toEqual({ Cmd: ['/home/agent/apps/plugin-runner/runner.py', 'execute'],
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, User: 'agent' });
  await expect.poll(() => f.gate.activeOperations).toBe(0);
});

for (const changed of [{ host: 'remote' }, { protocol: 'https' }, { socketPath: '/other' },
  { socketPathCache: '/other' }, { version: 'v1.45' }, { agent: {} }, { headers: { Authorization: 'synthetic' } }, { cert: 'synthetic' }])
  test(`unsupported effective modem refuses before request: ${Object.keys(changed)[0]}`, async () => {
    const f = fixture({ endpoint: { ...modem(), ...changed } });
    await expect(f.transport.setup('container', 'execute', signal())).rejects.toMatchObject({ code: 'DOCKER_PLUGIN_ENDPOINT_UNSUPPORTED' });
    expect(f.requestOptions).toHaveLength(0); expect(f.gate.activeOperations).toBe(0);
  });

for (const kind of ['invalid', 'truncated', 'oversized', 'error', 'array', 'array-id', 'nested-array-id'])
  test(`setup refuses ${kind} response without leaking admission`, async () => {
    const f = fixture(); const pending = f.transport.setup('container', 'execute', signal());
    const failed = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_RUNNER_UNAVAILABLE' });
    await f.requested.promise; const res = response(kind === 'error' ? 500 : 201, 'application/json', kind !== 'truncated');
    f.req.emit('response', res);
    res.end(kind === 'oversized' ? 'x'.repeat(65537) : kind === 'array' ? JSON.stringify([{ Id: id }]) :
      JSON.stringify({ Id: kind === 'invalid' ? '../escape' : kind === 'array-id' ? [id] : kind === 'nested-array-id' ? [[id]] : id }));
    await failed; await expect.poll(() => f.gate.activeOperations).toBe(0);
  });

test('error-first late upgrade remains owned until actual request/socket/response closure', async () => {
  const f = fixture({ holdRequest: true }); const pending = f.transport.start(id, signal());
  const failed = pending.catch(error => error); await f.requested.promise;
  f.req.emit('error', new Error('synthetic request failure')); const error = await failed;
  expect(error.message).toBe('synthetic request failure'); expect(error[operationSettlement]).toBeInstanceOf(Promise);
  const late = socket(true), res = response(101); res.headers = { upgrade: 'tcp', connection: 'Upgrade' };
  f.req.emit('upgrade', res, late.value, Buffer.from('unclaimed'));
  const barrier = f.gate.begin('late-upgrade', 'snapshot');
  try {
    expect(late.value.destroyed).toBe(true); f.req.emit('close'); late.value.emit('close');
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    f.releaseRequest(); expect(() => barrier.assertDrained()).toThrow(); late.release();
    await barrier.drain({ timeoutMs: 1000 }); expect(res.closed).toBe(true);
  } finally { f.releaseRequest(); late.release(); barrier.release(); }
});

test('upgrade is not exposed until initial POST body callback settles', async () => {
  const f = fixture({ holdBody: true }); let exposed = false;
  const pending = f.transport.start(id, signal()).then(stream => { exposed = true; return stream; });
  await f.requested.promise; const peer = socket(), res = response(101); res.headers = { upgrade: 'tcp', connection: 'Upgrade' };
  f.req.emit('socket', peer.value); f.req.emit('upgrade', res, peer.value, Buffer.from('head'));
  await Promise.resolve(); expect(exposed).toBe(false); f.releaseBody();
  const stream = await pending; expect(stream.read()?.toString()).toBe('head');
  stream.destroy(); f.req.destroy(); await expect.poll(() => f.gate.activeOperations).toBe(0);
  expect(Buffer.concat(f.bodies).toString()).toBe('{"Detach":false,"Tty":false}');
});

test('aborted setup retains initial body callback after request closure', async () => {
  const f = fixture({ holdBody: true }); const controller = new AbortController();
  const pending = f.transport.setup('container', 'execute', controller.signal);
  const failed = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  await f.requested.promise; controller.abort(); await failed;
  const barrier = f.gate.begin('body-callback', 'snapshot');
  try {
    expect(f.req.closed).toBe(true);
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    f.releaseBody(); await barrier.drain({ timeoutMs: 1000 });
  } finally { f.releaseBody(); barrier.release(); }
});

test('real start deadline returns promptly while actual request close remains held', async () => {
  const f = fixture({ holdRequest: true, timeoutMs: 5 });
  const failed = await f.transport.start(id, signal()).catch(error => error);
  expect(failed).toMatchObject({ code: 'DOCKER_OPERATION_TIMEOUT' });
  const barrier = f.gate.begin('request-timeout', 'snapshot');
  try {
    expect(f.req.closed).toBe(false); expect(f.requestOptions).toHaveLength(1);
    expect(() => barrier.assertDrained()).toThrow(); f.releaseRequest(); await barrier.drain({ timeoutMs: 1000 });
  } finally { f.releaseRequest(); barrier.release(); }
});

test('aborted upgrade candidate never becomes exposed after a delayed initial body callback', async () => {
  const f = fixture({ holdBody: true }); const controller = new AbortController();
  const pending = f.transport.start(id, controller.signal), peer = socket(), res = response(101);
  const failed = expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  await f.requested.promise; res.headers = { upgrade: 'tcp', connection: 'Upgrade' };
  f.req.emit('socket', peer.value); f.req.emit('upgrade', res, peer.value, Buffer.from('head'));
  controller.abort(); await failed; f.releaseBody();
  await expect.poll(() => f.gate.activeOperations).toBe(0);
  expect(peer.value.closed).toBe(true); expect(Buffer.concat(f.bodies).toString()).toBe('{"Detach":false,"Tty":false}');
});

test('invalid upgrade headers close the unclaimed response and socket', async () => {
  const f = fixture(), peer = socket(), res = response(101);
  const pending = f.transport.start(id, signal());
  const failed = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_RUNNER_UNAVAILABLE' });
  await f.requested.promise; res.headers = { upgrade: 'other', connection: 'Upgrade' };
  f.req.emit('upgrade', res, peer.value, Buffer.from('discarded'));
  await failed; await expect.poll(() => f.gate.activeOperations).toBe(0);
  expect(peer.value.closed).toBe(true); expect(res.closed).toBe(true);
});

for (const status of [204, 500]) test(`start HTTP ${status} is not a successful interactive transport`, async () => {
  const f = fixture(); const pending = f.transport.start(id, signal());
  const failed = expect(pending).rejects.toMatchObject({ code: 'PLUGIN_RUNNER_UNAVAILABLE' });
  await f.requested.promise; const res = response(status); f.req.emit('response', res); res.end();
  await failed; await expect.poll(() => f.gate.activeOperations).toBe(0);
});

for (const status of [101, 200]) test(`native Unix HTTP ${status} preserves stdin/head exactly and closes all transports`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-plugin-http-'));
  const path = join(directory, 'test.sock'), gate = new InstanceControlPlaneCoordinator();
  const clientResponses: any[] = [];
  const peers = new Set<Socket>(), observed: Array<{ path: string; body: any }> = [];
  const input = deferred<string>(), unexpected = deferred<never>();
  const server = createServer(peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', error => unexpected.reject(error));
    let buffered = Buffer.alloc(0), parsed = false;
    peer.on('data', data => {
      buffered = Buffer.concat([buffered, data]);
      if (!parsed) {
        const split = buffered.indexOf('\r\n\r\n'); if (split < 0) return;
        const headers = buffered.subarray(0, split).toString();
        const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1]);
        if (buffered.length < split + 4 + length) return;
        const requestPath = headers.split(' ')[1]!;
        const body = JSON.parse(buffered.subarray(split + 4, split + 4 + length).toString());
        observed.push({ path: requestPath, body }); parsed = true;
        buffered = buffered.subarray(split + 4 + length);
        if (requestPath.endsWith('/exec')) {
          const json = JSON.stringify({ Id: id });
          peer.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`); return;
        }
        peer.write(status === 101
          ? 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nhead-'
          : 'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: close\r\n\r\nhead-');
      }
      if (observed.at(-1)?.path.endsWith('/start') && buffered.includes(10)) {
        input.resolve(buffered.toString()); peer.end('tail\n');
      }
    });
  });
  void unexpected.promise.catch(() => {});
  await new Promise<void>(resolve => server.listen(path, resolve));
  const transport = createDockerPluginExecTransport({ modem: modem(), coordinator: gate,
    request: settings => {
      const request = httpRequest({ ...settings, socketPath: path });
      request.on('response', response => clientResponses.push(response));
      request.on('upgrade', response => clientResponses.push(response));
      return request;
    } });
  try {
    const execId = await transport.setup('container', 'execute', signal());
    const stream = await transport.start(execId, signal()); const chunks: Buffer[] = [];
    const ended = new Promise<void>((resolve, reject) => { stream.on('data', chunk => chunks.push(Buffer.from(chunk))); stream.once('end', resolve); stream.once('error', reject); });
    await new Promise<void>((resolve, reject) => stream.write('runner-stdin\n', error => error ? reject(error) : resolve()));
    expect(await Promise.race([input.promise, unexpected.promise])).toBe('runner-stdin\n');
    await ended; expect(Buffer.concat(chunks).toString()).toBe('head-tail\n'); stream.destroy();
    await expect.poll(() => gate.activeOperations).toBe(0);
    expect(clientResponses).toHaveLength(2); expect(clientResponses.every(response => response.closed)).toBe(true);
    expect(observed).toHaveLength(2); expect(observed[1]).toEqual({ path: `/exec/${id}/start`, body: { Detach: false, Tty: false } });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
