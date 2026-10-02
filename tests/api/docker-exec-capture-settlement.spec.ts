import { expect, test } from '@playwright/test';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer as createUnixServer, type Socket } from 'node:net';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const Docker = require('dockerode');

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function fixture(info: any = { Running: false, ExitCode: 0 }) {
  let finishDestroy!: (error?: Error | null) => void;
  let finishWrite!: (error?: Error | null) => void;
  const started = deferred(), writing = deferred(), destroying = deferred();
  const stream = new Duplex({ read() {},
    write(_chunk, _encoding, done) { finishWrite = done; writing.resolve(); },
    destroy(_error, done) { finishDestroy = done; destroying.resolve(); },
  });
  let inspections = 0;
  const controls = {
    setup: async (): Promise<any> => exec,
    start: async (): Promise<Duplex> => { started.resolve(); return stream; },
    inspect: async (): Promise<any> => { inspections++; return info; },
    demux: (source: Duplex, stdout: any) => source.on('data', chunk => stdout.write(chunk)),
  };
  const exec = { start: () => controls.start(), inspect: () => controls.inspect() };
  const service = Object.create(DockerService.prototype) as DockerService;
  (service as any).docker = { getContainer: () => ({ exec: () => controls.setup(), modem: {
    demuxStream: (source: Duplex, stdout: any) => controls.demux(source, stdout),
  } }) };
  const run = (options: any = {}) => service.execCapture('synthetic', ['synthetic'], { timeoutMs: 1500, ...options });
  return { run, stream, started, writing, destroying, controls,
    inspections: () => inspections,
    close: () => finishDestroy?.(), write: (error?: Error) => finishWrite?.(error),
    end: () => { stream.push(Buffer.from('receipt')); stream.push(null); },
  };
}

test('success requires actual closure and pending stdin callback before inspection', async () => {
  const f = fixture(); let complete = false;
  const pending = f.run({ stdin: Buffer.from('synthetic') }).then(value => { complete = true; return value; });
  await f.writing.promise; f.end(); await delay(10);
  expect(complete).toBe(false); expect(f.inspections()).toBe(0);
  f.write(); await f.destroying.promise; f.stream.emit('close'); await delay(10);
  expect(f.stream.closed).toBe(false); expect(complete).toBe(false); expect(f.inspections()).toBe(0);
  f.close(); const result = await pending;
  expect(result.stdout.toString()).toBe('receipt'); expect(result.exitCode).toBe(0);
  expect(f.stream.closed).toBe(true);
});

for (const trigger of ['abort', 'timeout', 'stream-error', 'stdin-error', 'demux-error'])
  test(`${trigger} retains actual closure and stdin settlement`, async () => {
    const f = fixture(), abort = new AbortController();
    if (trigger === 'demux-error') f.controls.demux = () => { throw new Error('synthetic demux'); };
    const result = f.run({ stdin: Buffer.from('synthetic'), signal: abort.signal, timeoutMs: 30 }).catch(error => error);
    await f.started.promise;
    if (trigger !== 'demux-error') await f.writing.promise;
    if (trigger === 'abort') abort.abort();
    if (trigger === 'stream-error') f.stream.emit('error', new Error('synthetic stream'));
    if (trigger === 'stdin-error') f.write(new Error('synthetic stdin'));
    const error = await result;
    expect(error.code).toBe(trigger === 'abort' ? 'OPERATION_ABORTED' : 'DOCKER_OPERATION_TIMEOUT');
    let settled = false;
    const settlement = error[operationSettlement].then(() => { settled = true; });
    await f.destroying.promise; f.stream.emit('close'); await delay(5); expect(settled).toBe(false);
    f.close(); await delay(5);
    if (!['stdin-error', 'demux-error'].includes(trigger)) { expect(settled).toBe(false); f.write(); }
    await settlement; expect(f.stream.closed).toBe(true);
  });

test('late start after caller abort is destroyed and retained through actual closure', async () => {
  const f = fixture(), late = deferred<Duplex>(), abort = new AbortController();
  f.controls.start = () => { f.started.resolve(); return late.promise; };
  const result = f.run({ signal: abort.signal }).catch(error => error);
  await f.started.promise; abort.abort(); const error = await result;
  let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
  late.resolve(f.stream); await f.destroying.promise; f.stream.emit('error', new Error('late synthetic'));
  await delay(5); expect(settled).toBe(false); f.close(); await settlement;
});

test('ordinary stream failure preserves its error after closure and callback settlement', async () => {
  const f = fixture(), failure = new Error('synthetic failure');
  const pending = f.run({ stdin: Buffer.from('synthetic') }).catch(error => error);
  await f.writing.promise; f.stream.emit('error', failure); await f.destroying.promise;
  f.close(); f.write(); expect(await pending).toBe(failure);
});

test('stream error after readable EOF still rejects after actual closure', async () => {
  const f = fixture(), failure = new Error('synthetic finalization failure');
  const pending = f.run().catch(error => error);
  await f.started.promise; await delay(0); f.end(); await f.destroying.promise;
  f.stream.emit('error', failure); f.close();
  expect(await pending).toBe(failure); expect(f.inspections()).toBe(0);
});

test('already cancelled caller makes no setup request', async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  let setups = 0; f.controls.setup = async () => { setups++; throw new Error('unexpected'); };
  await expect(f.run({ signal: abort.signal })).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(setups).toBe(0);
});

test('cancellation during inspection retains the late inspection promise', async () => {
  const f = fixture(), inspecting = deferred(), late = deferred<any>(), abort = new AbortController();
  f.controls.inspect = () => { inspecting.resolve(); return late.promise; };
  const pending = f.run({ signal: abort.signal }).catch(error => error);
  await f.started.promise; await delay(0); f.end(); await f.destroying.promise; f.close();
  await inspecting.promise; abort.abort(); const error = await pending;
  let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
  await delay(5); expect(settled).toBe(false); late.resolve({ Running: false, ExitCode: 0 }); await settlement;
});

for (const info of [{ Running: false }, { Running: false, ExitCode: null },
  { Running: true, ExitCode: 0 }, { Running: false, ExitCode: '0' },
  { Running: false, ExitCode: NaN }, { Running: false, ExitCode: -1 },
  { Running: false, ExitCode: 0.5 }, { ExitCode: 0 }])
  test(`rejects invalid terminal status Running=${info.Running}, ExitCode=${String(info.ExitCode)}`, async () => {
    const f = fixture(info), pending = f.run();
    const failed = expect(pending).rejects.toThrow('no valid terminal exit status');
    await f.started.promise; await delay(0); f.end(); await f.destroying.promise; f.close(); await failed;
  });

test('preserves nonzero terminal status', async () => {
  const f = fixture({ Running: false, ExitCode: 7 }), pending = f.run();
  await f.started.promise; await delay(0); f.end(); await f.destroying.promise; f.close();
  expect((await pending).exitCode).toBe(7);
});

test('failed setup preserves exposed late settlement rather than dropping it', async () => {
  const f = fixture(), held = deferred();
  const error = Object.freeze(Object.defineProperty(new Error('synthetic setup'), operationSettlement, { value: held.promise }));
  f.controls.setup = async () => { throw error; };
  const failed = await f.run({ timeoutMs: 20 }).catch(value => value);
  expect(failed.code).toBe('DOCKER_OPERATION_TIMEOUT');
  let settled = false; const settlement = failed[operationSettlement].then(() => { settled = true; });
  await delay(5); expect(settled).toBe(false); held.resolve(); await settlement;
});

for (const mode of ['upgrade', 'http']) test(`native local Unix ${mode} capture closes with stdin receipt`, async () => {
  const directory = await mkdtemp('/workspace/exec-capture-unix-');
  const path = join(directory, 'fixture.sock'), id = 'a'.repeat(64);
  const payload = Buffer.from('synthetic-input'), output = Buffer.from('synthetic-receipt');
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(output.length, 4);
  const frame = Buffer.concat([header, output]);
  let received = false;
  const server = createServer((req, res) => {
    if (req.url === '/containers/synthetic/exec') {
      req.resume(); req.on('end', () => { res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ Id: id })); });
    } else if (req.url === `/exec/${id}/json`) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ Running: false, ExitCode: 0 }));
    } else if (mode === 'http' && req.url === `/exec/${id}/start`) {
      res.writeHead(200, { 'content-type': 'application/vnd.docker.raw-stream' }); res.flushHeaders();
      let body = Buffer.alloc(0);
      req.on('data', chunk => {
        body = Buffer.concat([body, chunk]);
        if (!received && body.includes(payload)) { received = true; res.end(frame); }
      });
    } else { res.writeHead(404); res.end(); }
  });
  server.on('upgrade', (_req, socket, head) => {
    socket.write(mode === 'upgrade'
      ? 'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n'
      : 'HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
    let body = head;
    const receive = (chunk: Buffer) => {
      body = Buffer.concat([body, chunk]);
      if (!received && body.includes(payload)) {
        received = true;
        socket.end(mode === 'upgrade' ? frame : Buffer.concat([
          Buffer.from(frame.length.toString(16) + '\r\n'), frame, Buffer.from('\r\n0\r\n\r\n'),
        ]));
      }
    };
    socket.on('data', receive); receive(Buffer.alloc(0));
  });
  // For the HTTP fallback, intentionally return a normal response even when
  // the client requests an upgrade.
  await new Promise<void>(resolve => server.listen(path, resolve));
  const service = Object.create(DockerService.prototype) as DockerService;
  (service as any).docker = new Docker({ socketPath: path });
  const container = (service as any).docker.getContainer('synthetic');
  const nativeExec = container.exec.bind(container);
  let components: any[] = [], releaseWrite!: () => void;
  const wrote = deferred();
  container.exec = async (options: any) => {
    const exec = await nativeExec(options), nativeStart = exec.start.bind(exec);
    exec.start = async (startOptions: any) => {
      const attach = await nativeStart(startOptions);
      components = attach.req ? [attach.req, attach._output, attach._output.socket] : [attach];
      const destination = attach.req ?? attach, nativeWrite = destination.write.bind(destination);
      destination.write = (chunk: Buffer, callback: (error?: Error) => void) => nativeWrite(chunk, (error?: Error) => {
        releaseWrite = () => callback(error); wrote.resolve();
      });
      return attach;
    };
    return exec;
  };
  (service as any).docker.getContainer = () => container;
  try {
    let complete = false;
    const pending = service.execCapture('synthetic', ['synthetic'], { stdin: payload, timeoutMs: 2000 })
      .then(result => { complete = true; return result; });
    await wrote.promise; await delay(10); expect(complete).toBe(false); releaseWrite();
    const result = await pending;
    expect(received).toBe(true); expect(result.stdout.toString()).toBe(output.toString()); expect(result.exitCode).toBe(0);
    expect(components.every(component => component.closed)).toBe(true);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const stdin of [false, true]) for (const reason of ['abort', 'premature-close'])
  test(`native Unix HTTP fallback ${reason}, stdin=${stdin}, settles actual resources`, async () => {
    const directory = await mkdtemp('/workspace/exec-capture-failure-');
    const path = join(directory, 'fixture.sock'), id = 'b'.repeat(64);
    const peers = new Set<Socket>(), attached = deferred(), writing = deferred();
    let peer!: Socket, components: any[] = [], releaseWrite!: () => void;
    const requests: string[] = [];
    const server = createUnixServer(socket => {
      peers.add(socket); socket.on('close', () => peers.delete(socket));
      let body = Buffer.alloc(0), handled = false;
      socket.on('data', chunk => {
        body = Buffer.concat([body, chunk]);
        if (handled || !body.includes(Buffer.from('\r\n\r\n'))) return;
        const line = body.toString().split('\r\n')[0]; handled = true;
        requests.push(line);
        if (line.includes('/containers/synthetic/exec')) {
          const json = JSON.stringify({ Id: id });
          socket.end(`HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n${json}`);
        } else if (line.includes(`/exec/${id}/start`)) {
          peer = socket;
          socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\nTransfer-Encoding: chunked\r\n\r\n');
        } else { socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n'); }
      });
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const docker = new Docker({ socketPath: path }), container = docker.getContainer('synthetic');
    const nativeExec = container.exec.bind(container);
    container.exec = async (options: any) => {
      const exec = await nativeExec(options), nativeStart = exec.start.bind(exec);
      exec.start = async (options: any) => {
        const attach = await nativeStart(options);
        components = attach.req && attach._output
          ? [attach.req, attach._output, attach._output.socket]
          : [attach, attach.req, attach.socket].filter(Boolean);
        if (stdin) {
          const nativeWrite = attach.req.write.bind(attach.req);
          attach.req.write = (chunk: Buffer, callback: (error?: Error) => void) => nativeWrite(chunk, (error?: Error) => {
            releaseWrite = () => callback(error); writing.resolve();
          });
        }
        attached.resolve(); return attach;
      };
      return exec;
    };
    docker.getContainer = () => container;
    const service = Object.create(DockerService.prototype) as DockerService;
    (service as any).docker = docker;
    const abort = new AbortController();
    const pending = service.execCapture('synthetic', ['synthetic'], {
      ...(stdin ? { stdin: Buffer.from('synthetic-payload') } : {}), signal: abort.signal, timeoutMs: 500,
    }).catch(error => error);
    try {
      await Promise.race([attached.promise, delay(1000).then(() => { throw new Error(`Attach missing; fixture requests: ${requests.join(', ')}`); })]);
      if (stdin) await writing.promise; await delay(0);
      if (reason === 'abort') abort.abort(); else peer.destroy();
      if (stdin && reason === 'premature-close') releaseWrite();
      const error = await pending;
      if (reason === 'abort') expect(error.code).toBe('OPERATION_ABORTED');
      else expect(error.code).toBeUndefined();
      const settlement = error[operationSettlement];
      if (stdin && reason === 'abort') {
        let settled = false; const observed = settlement.then(() => { settled = true; });
        await expect.poll(() => components.every(component => component.closed)).toBe(true);
        expect(settled).toBe(false); releaseWrite(); await observed;
      } else if (settlement) await settlement;
      await expect.poll(() => components.every(component => component.closed)).toBe(true);
    } finally {
      releaseWrite?.(); abort.abort(); for (const socket of peers) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
