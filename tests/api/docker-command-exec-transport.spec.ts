import { expect, test } from '@playwright/test';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { createServer, type Socket } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDockerCommandExecTransport } from '../../orchestrator/server/utils/docker-command-exec-transport';
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
function socket(held = false, holdWrite = false) {
  let finish!: () => void, finishWrite!: () => void;
  const value = new Duplex({ read() {}, write(_chunk, _encoding, done) { finishWrite = done; if (!holdWrite) done(); },
    destroy(_error, done) { finish = done; if (!held) done(); } });
  return { value: value as unknown as Socket, release: () => finish?.(), releaseWrite: () => finishWrite?.() };
}
function fixture(options: { holdRequest?: boolean; holdBody?: boolean; holdStdin?: boolean; timeoutMs?: number; endpoint?: any } = {}) {
  const gate = new InstanceControlPlaneCoordinator(), requested = deferred();
  const bodies: Buffer[] = [], requestOptions: any[] = [];
  let finishDestroy!: () => void, finishBody!: () => void;
  const req = new Writable({ autoDestroy: false,
    write(chunk, _encoding, done) {
      bodies.push(Buffer.from(chunk)); finishBody = done;
      if (!options.holdBody && !(options.holdStdin && bodies.length > 1)) done();
    },
    destroy(_error, done) { finishDestroy = done; if (!options.holdRequest) done(); },
  });

  const transport = createDockerCommandExecTransport({ modem: options.endpoint ?? modem(), coordinator: gate,
    timeoutMs: options.timeoutMs ?? 1000,
    request: settings => { requestOptions.push(settings); requested.resolve(); return req as any; } });
  return { gate, req, requested, transport, bodies, requestOptions, releaseRequest: () => finishDestroy?.(), releaseBody: () => finishBody?.() };
}

test('setup uses fixed endpoint and server argv/user/workdir/stdin with a bounded valid response', async () => {
  const f = fixture(); const pending = f.transport.setup('container/encoded', ['server-command'], { stdin: true, user: 'agent', workdir: '/workspace' }, signal());
  await f.requested.promise; const res = response(201); f.req.emit('response', res);
  res.end(JSON.stringify({ Id: id })); await expect(pending).resolves.toBe(id);
  expect(f.requestOptions[0]).toMatchObject({ socketPath: '/var/run/docker.sock', agent: false,
    method: 'POST', path: '/containers/container%2Fencoded/exec' });
  expect(JSON.parse(Buffer.concat(f.bodies).toString())).toEqual({ Cmd: ['server-command'],
    AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: false, User: 'agent', WorkingDir: '/workspace' });
  await expect.poll(() => f.gate.activeOperations).toBe(0);
});

for (const changed of [{ host: 'remote' }, { protocol: 'https' }, { socketPath: '/other' },
  { socketPathCache: '/other' }, { version: 'v1.45' }, { agent: {} }, { headers: { Authorization: 'synthetic' } }, { cert: 'synthetic' }])
  test(`unsupported effective modem refuses before request: ${Object.keys(changed)[0]}`, async () => {
    const f = fixture({ endpoint: { ...modem(), ...changed } });
    await expect(f.transport.setup('container', ['server-command'], { stdin: true, user: 'agent', workdir: '/workspace' }, signal())).rejects.toMatchObject({ code: 'DOCKER_COMMAND_ENDPOINT_UNSUPPORTED' });
    expect(f.requestOptions).toHaveLength(0); expect(f.gate.activeOperations).toBe(0);
  });

for (const kind of ['invalid', 'truncated', 'oversized', 'error', 'array', 'array-id', 'nested-array-id'])
  test(`setup refuses ${kind} response without leaking admission`, async () => {
    const f = fixture(); const pending = f.transport.setup('container', ['server-command'], { stdin: true, user: 'agent', workdir: '/workspace' }, signal());
    const failed = expect(pending).rejects.toMatchObject({ code: 'DOCKER_COMMAND_UNAVAILABLE' });
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
  expect(error.message).toBe('Docker command transport is unavailable'); expect(error[operationSettlement]).toBeInstanceOf(Promise);
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
  const stream = await pending; expect(await new Promise<string>(resolve => stream.once('data', chunk => resolve(chunk.toString())))).toBe('head');
  stream.destroy(); f.req.destroy(); await expect.poll(() => f.gate.activeOperations).toBe(0);
  expect(Buffer.concat(f.bodies).toString()).toBe('{"Detach":false,"Tty":false}');
});

test('aborted setup retains initial body callback after request closure', async () => {
  const f = fixture({ holdBody: true }); const controller = new AbortController();
  const pending = f.transport.setup('container', ['server-command'], { stdin: true }, controller.signal);
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
  const failed = expect(pending).rejects.toMatchObject({ code: 'DOCKER_COMMAND_UNAVAILABLE' });
  await f.requested.promise; res.headers = { upgrade: 'other', connection: 'Upgrade' };
  f.req.emit('upgrade', res, peer.value, Buffer.from('discarded'));
  await failed; await expect.poll(() => f.gate.activeOperations).toBe(0);
  expect(peer.value.closed).toBe(true); expect(res.closed).toBe(true);
});

for (const status of [204, 500]) test(`start HTTP ${status} is not a successful interactive transport`, async () => {
  const f = fixture(); const pending = f.transport.start(id, signal());
  const failed = expect(pending).rejects.toMatchObject({ code: 'DOCKER_COMMAND_UNAVAILABLE' });
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
        const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1] ?? '0');
        if (buffered.length < split + 4 + length) return;
        const requestPath = headers.split(' ')[1]!;
        const body = length ? JSON.parse(buffered.subarray(split + 4, split + 4 + length).toString()) : undefined;
        observed.push({ path: requestPath, body }); parsed = true;
        buffered = buffered.subarray(split + 4 + length);
        if (requestPath.endsWith('/exec')) {
          const json = JSON.stringify({ Id: id });
          peer.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`); return;
        }
        if (requestPath.endsWith('/json')) {
          const json = JSON.stringify({ ID: id, Running: false, ExitCode: 0 });
          peer.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`); return;
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
  const transport = createDockerCommandExecTransport({ modem: modem(), coordinator: gate,
    request: settings => {
      const request = httpRequest({ ...settings, socketPath: path });
      request.on('response', response => clientResponses.push(response));
      request.on('upgrade', response => clientResponses.push(response));
      return request;
    } });
  try {
    const execId = await transport.setup('container', ['server-command'], { stdin: true, user: 'agent', workdir: '/workspace' }, signal());
    const stream = await transport.start(execId, signal()); const chunks: Buffer[] = [];
    const ended = new Promise<void>((resolve, reject) => { stream.on('data', chunk => chunks.push(Buffer.from(chunk))); stream.once('end', resolve); stream.once('error', reject); });
    await new Promise<void>((resolve, reject) => stream.write('runner-stdin\n', error => error ? reject(error) : resolve()));
    expect(await Promise.race([input.promise, unexpected.promise])).toBe('runner-stdin\n');
    await ended; expect(Buffer.concat(chunks).toString()).toBe('head-tail\n'); stream.destroy();
    await expect.poll(() => gate.activeOperations).toBe(0);
    expect(await transport.inspect(execId, signal())).toEqual({ Running: false, ExitCode: 0 });
    await expect.poll(() => gate.activeOperations).toBe(0);
    expect(clientResponses).toHaveLength(3); expect(clientResponses.every(response => response.closed)).toBe(true);
    expect(observed).toHaveLength(3); expect(observed[1]).toEqual({ path: `/exec/${id}/start`, body: { Detach: false, Tty: false } });
    expect(observed[2]).toEqual({ path: `/exec/${id}/json`, body: undefined });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const value of [{ Running: false, ExitCode: 0 }, { Running: true, ExitCode: null }])
  test(`inspect validates bounded exit state ${JSON.stringify(value)}`, async () => {
    const f = fixture(); const pending = f.transport.inspect(id, signal());
    await f.requested.promise; const res = response(200); f.req.emit('response', res); res.end(JSON.stringify(value));
    expect(await pending).toEqual(value);
    expect(f.requestOptions[0]).toMatchObject({ method: 'GET', path: `/exec/${id}/json`, agent: false });
    expect(Buffer.concat(f.bodies).length).toBe(0);
    await expect.poll(() => f.gate.activeOperations).toBe(0);
  });

for (const value of [{}, [], { Running: false }, { Running: false, ExitCode: null },
  { Running: 'false', ExitCode: 0 }, { Running: false, ExitCode: -1 }, { Running: false, ExitCode: 256 },
  { Running: false, ExitCode: '0' }, { Running: false, ExitCode: 1.5 }])
  test(`inspect rejects invalid state ${JSON.stringify(value)}`, async () => {
    const f = fixture(); const pending = f.transport.inspect(id, signal());
    const failed = expect(pending).rejects.toMatchObject({ code: 'DOCKER_COMMAND_UNAVAILABLE' });
    await f.requested.promise; const res = response(200); f.req.emit('response', res); res.end(JSON.stringify(value));
    await failed; await expect.poll(() => f.gate.activeOperations).toBe(0);
  });

test('sanitized native errors preserve exposed failed settlement', async () => {
  const f = fixture(), held = deferred(); const pending = f.transport.inspect(id, signal());
  await f.requested.promise;
  const native = Object.freeze(Object.assign(new Error('synthetic secret argv'), { [operationSettlement]: held.promise }));
  f.req.emit('error', native); const error = await pending.catch(error => error);
  expect(error.message).not.toContain('secret'); expect(error[operationSettlement]).toBeInstanceOf(Promise);
  const barrier = f.gate.begin('failed-native', 'snapshot');
  try {
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    held.resolve(); await barrier.drain({ timeoutMs: 1000 }); await error[operationSettlement];
  } finally { held.resolve(); barrier.release(); }
});

test('native errors cannot opt out of sanitization by copying a transport code', async () => {
  const f = fixture(); const pending = f.transport.inspect(id, signal());
  await f.requested.promise;
  f.req.emit('error', Object.assign(new Error('synthetic secret argv'), { code: 'DOCKER_COMMAND_UNAVAILABLE' }));
  const error = await pending.catch(error => error);
  expect(error.message).toBe('Docker command transport is unavailable');
  await error[operationSettlement];
});

for (const upgraded of [false, true]) test(`returned ${upgraded ? '101' : '200'} duplex owns delayed stdin callbacks after abort`, async () => {
  const f = fixture({ holdStdin: true }), controller = new AbortController();
  const pending = f.transport.start(id, controller.signal), peer = socket(false, true);
  await f.requested.promise;
  const res = response(upgraded ? 101 : 200, 'application/vnd.docker.raw-stream');
  if (upgraded) {
    res.headers = { upgrade: 'tcp', connection: 'Upgrade' };
    f.req.emit('upgrade', res, peer.value, Buffer.alloc(0));
  } else f.req.emit('response', res);
  const stream = await pending; stream.on('error', () => {});
  const written = deferred(); stream.write('synthetic input', () => written.resolve());
  controller.abort(); const barrier = f.gate.begin('held-stdin', 'snapshot');
  try {
    expect(f.req.closed).toBe(true);
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    if (upgraded) peer.releaseWrite(); else f.releaseBody();
    await written.promise; await barrier.drain({ timeoutMs: 1000 }); expect(stream.closed).toBe(true);
  } finally { peer.releaseWrite(); f.releaseBody(); stream.destroy(); barrier.release(); }
});

test('inspect deadline retains a late response and its actual closure', async () => {
  const f = fixture({ holdRequest: true, timeoutMs: 5 });
  const failed = await f.transport.inspect(id, signal()).catch(error => error);
  expect(failed.code).toBe('DOCKER_OPERATION_TIMEOUT');
  let release!: () => void;
  const res = new PassThrough({ destroy(_error, done) { release = done; } }) as any;
  res.statusCode = 200; res.complete = true; res.headers = {};
  f.req.emit('response', res); expect(res.destroyed).toBe(true);
  const barrier = f.gate.begin('late-inspect', 'snapshot');
  try {
    f.releaseRequest();
    await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release(); await barrier.drain({ timeoutMs: 1000 }); await failed[operationSettlement];
    expect(f.requestOptions).toHaveLength(1);
  } finally { release(); f.releaseRequest(); barrier.release(); }
});

for (const kind of ['oversized', 'truncated', 'invalid-json', 'daemon-error'])
  test(`inspect rejects ${kind} without exposing response contents`, async () => {
    const f = fixture(); const pending = f.transport.inspect(id, signal());
    const failed = pending.catch(error => error);
    await f.requested.promise;
    const res = response(kind === 'daemon-error' ? 500 : 200, 'application/json', kind !== 'truncated');
    f.req.emit('response', res);
    res.end(kind === 'oversized' ? 'x'.repeat(65537) : kind === 'truncated' ? JSON.stringify({ Running: false, ExitCode: 0 }) : 'synthetic secret daemon body');
    const error = await failed; expect(error.code).toBe('DOCKER_COMMAND_UNAVAILABLE');
    expect(error.message).not.toContain('secret'); await error[operationSettlement];
  });

for (const status of [101, 200]) test(`native Unix HTTP ${status} keeps clean EOF output for a delayed consumer`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-command-delayed-'));
  const path = join(directory, 'test.sock'), gate = new InstanceControlPlaneCoordinator();
  const payload = Buffer.alloc(32 * 1024, 120), peers = new Set<Socket>();
  let clientSocket: Socket | undefined;
  const server = createServer(peer => {
    peers.add(peer); peer.on('close', () => peers.delete(peer)); peer.on('error', () => {});
    let buffered = Buffer.alloc(0), replied = false;
    peer.on('data', data => {
      buffered = Buffer.concat([buffered, data]);
      const split = buffered.indexOf('\r\n\r\n'); if (split < 0 || replied) return;
      const length = Number(buffered.subarray(0, split).toString().match(/content-length:\s*(\d+)/i)?.[1] ?? '0');
      if (buffered.length < split + 4 + length) return;
      replied = true;
      peer.end(Buffer.concat([Buffer.from(status === 101
        ? 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
        : 'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: close\r\n\r\n'), payload]));
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const transport = createDockerCommandExecTransport({ modem: modem(), coordinator: gate,
    request: settings => {
      const request = httpRequest({ ...settings, socketPath: path });
      request.on('socket', socket => { clientSocket = socket; }); return request;
    } });
  let stream: Duplex | undefined;
  try {
    stream = await transport.start(id, signal()); stream.on('error', () => {});
    // Ask the bridge to fill its readable buffer, but delay actual consumption
    // until the native socket has cleanly closed. Output fits below its HWM.
    stream.read(0);
    await expect.poll(() => clientSocket?.closed).toBe(true);
    expect(stream.readableLength).toBe(payload.byteLength);
    expect(stream.destroyed).toBe(false);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(payload);
    stream.destroy(); await expect.poll(() => gate.activeOperations).toBe(0);
  } finally {
    stream?.destroy(); for (const peer of peers) peer.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
