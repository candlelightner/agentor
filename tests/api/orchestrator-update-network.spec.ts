import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { UpdateChecker } from '../../orchestrator/server/utils/update-checker';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {} });
const originalId = '1'.repeat(64), replacementId = '2'.repeat(64), swapperId = '3'.repeat(64);
type Request = { method: string; path: string; body?: any };

function source() {
  const peer = (suffix: number) => ({
    NetworkID: String(suffix).repeat(64), EndpointID: `old-endpoint-${suffix}`,
    IPAMConfig: { IPv4Address: `10.18.${suffix}.2`, IPv6Address: '', LinkLocalIPs: [] },
    IPAddress: `10.18.${suffix}.2`, IPPrefixLen: 24, Gateway: `10.18.${suffix}.1`,
    MacAddress: `06:11:22:33:44:0${suffix}`, Aliases: ['agentor-orchestrator'],
    DNSNames: ['agentor-orchestrator', originalId.slice(0, 12)],
    Links: [], DriverOpts: {}, GwPriority: -1,
  });
  return {
    Id: originalId, Name: '/agentor-orchestrator',
    Config: { Env: ['DATA_DIR=/data'], Labels: { 'com.docker.compose.service': 'orchestrator' }, ExposedPorts: { '3000/tcp': {} } },
    HostConfig: { NetworkMode: 'agentor-net', Binds: ['agentor-data:/data'],
      PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3000' }] },
      ExtraHosts: ['host.docker.internal:host-gateway'], RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: { Networks: {
      'agentor-net': { NetworkID: 'a'.repeat(64), EndpointID: 'old-primary', IPAMConfig: null,
        IPAddress: '172.18.0.2', MacAddress: '02:42:ac:12:00:02', Aliases: ['dashboard'],
        DriverOpts: { 'com.docker.network.endpoint.sysctls': 'net.ipv4.conf.IFNAME.log_martians=1' }, GwPriority: 1 },
      'aa-global': peer(1), 'aa-group': peer(2),
    } },
  };
}

async function fixture(run: (value: {
  checker: UpdateChecker; calls: Request[]; info: ReturnType<typeof source>;
  reject: (method: string, path: string, status: number) => void;
}) => Promise<void>, native = true) {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-update-network-'));
  const socket = join(directory, 'docker.sock'), info = source(), calls: Request[] = [];
  let rejection: { method: string; path: string; status: number } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString();
    const call = { method: request.method!, path: request.url!, ...(raw ? { body: JSON.parse(raw) } : {}) };
    calls.push(call);
    const path = call.path.replace(/^\/v1\.54/, '').split('?')[0];
    const reply = (status: number, value?: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    if (rejection?.method === call.method && rejection.path === path) return reply(rejection.status, { message: 'fixture rejection' });
    if (call.method === 'GET' && path === '/containers/source-container/json') return reply(200, info);
    if (call.method === 'DELETE') return reply(404, { message: 'no stale fixture' });
    if (call.method === 'POST' && path === '/containers/create') {
      const name = new URL(call.path, 'http://fixture.invalid').searchParams.get('name');
      return reply(201, { Id: name?.endsWith('-swapper') ? swapperId : replacementId, Warnings: [] });
    }
    if (call.method === 'POST' && path === `/containers/${swapperId}/start`) return reply(204);
    reply(500, { message: 'unexpected fixture request' });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const checker = new UpdateChecker({ incusEnabled: native, workerImagePrefix: 'ghcr.io/example/',
    orchestratorImage: 'agentor-orchestrator:next', baseDomains: [] } as unknown as Config);
  // Exercise the real Dockerode encoder/version prefix, confined to our own Unix socket.
  (checker as any).docker.modem.socketPath = socket;
  const previousHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'source-container';
  try { await run({ checker, calls, info, reject(method, path, status) { rejection = { method, path, status }; } }); }
  finally {
    if (previousHostname === undefined) delete process.env.HOSTNAME; else process.env.HOSTNAME = previousHostname;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

async function preparedScript() {
  let script = '';
  await fixture(async ({ checker, calls }) => {
    await checker.recreateOrchestrator();
    script = calls.find(call => call.body?.Cmd)?.body.Cmd[2];
  });
  return script;
}

// Execute the exact one-shot program with a simulated HTTP transport; never Docker.
async function swap(script: string, failAt = -1, timeout = false, responseError = false) {
  const calls: Request[] = [], timeouts: number[] = [];
  let exitCode = 0;
  const http = { request(options: any, callback: (response: any) => void) {
    const index = calls.push({ method: options.method, path: options.path }) - 1;
    const request = new EventEmitter() as any;
    let onTimeout: () => void;
    request.setTimeout = (milliseconds: number, action: () => void) => { timeouts.push(milliseconds); onTimeout = action; };
    request.destroy = (error: Error) => request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      if (timeout && index === failAt) return onTimeout();
      const response = new EventEmitter() as any;
      response.statusCode = index === failAt ? 409 : 204;
      callback(response);
      if (responseError && index === failAt) response.emit('error', new Error('fixture response reset'));
      else response.emit('end');
    });
    return request;
  } };
  await runInNewContext(script, { require(name: string) { expect(name).toBe('http'); return http; },
    console: { log() {}, error() {} }, process: { exit(code: number) { exitCode = code; } } });
  return { calls, exitCode, timeouts };
}

test('native self-update preserves global/group exact peers and stable endpoint configuration on the real Dockerode wire', async () => {
  await fixture(async ({ checker, calls, info }) => {
    await checker.recreateOrchestrator();
    expect(calls.every(call => call.path.startsWith('/v1.54/'))).toBe(true);
    const create = calls.find(call => call.body?.NetworkingConfig)!;
    expect(create.body.HostConfig).toEqual(info.HostConfig);
    expect(create.body.Env).toEqual(info.Config.Env);
    expect(create.body.Labels).toEqual(info.Config.Labels);
    const endpoints = create.body.NetworkingConfig.EndpointsConfig;
    expect(Object.keys(endpoints).sort()).toEqual(['aa-global', 'aa-group', 'agentor-net']);
    for (const [name, endpoint] of Object.entries(info.NetworkSettings.Networks)) {
      const { NetworkID, IPAMConfig, MacAddress, Aliases, DriverOpts, GwPriority } = endpoint;
      expect(endpoints[name]).toMatchObject({ NetworkID, IPAMConfig, MacAddress, Aliases, DriverOpts, GwPriority });
      expect(endpoints[name]).not.toHaveProperty('EndpointID');
      expect(endpoints[name]).not.toHaveProperty('DNSNames');
      expect(endpoints[name]).not.toHaveProperty('IPAddress');
      expect(endpoints[name]).not.toHaveProperty('Gateway');
    }
    expect(endpoints['aa-group'].Links).toEqual([]);
    expect(endpoints['agentor-net'].IPAMConfig).toBeNull(); // Do not turn DHCP into a static address.
    expect(calls.some(call => call.path.includes(`/containers/${replacementId}/start`))).toBe(false);
    expect(calls.some(call => call.path.includes(`/containers/${originalId}/stop`))).toBe(false);
  });
});

test('unsupported native Docker API rejects before any cleanup, creation or handoff', async () => {
  await fixture(async ({ checker, calls, reject }) => {
    reject('GET', '/containers/source-container/json', 400);
    await expect(checker.recreateOrchestrator()).rejects.toThrow('fixture rejection');
    expect(calls.map(call => call.method)).toEqual(['GET']);
    expect(calls[0]!.path).toBe('/v1.54/containers/source-container/json');
  });
});

test('legacy Docker-only installs retain their existing transport and endpoint settings', async () => {
  await fixture(async ({ checker, calls }) => {
    await checker.recreateOrchestrator();
    expect(calls.every(call => !call.path.startsWith('/v'))).toBe(true);
    expect(calls.find(call => call.body?.NetworkingConfig)?.body.NetworkingConfig.EndpointsConfig['agentor-net'].Aliases).toEqual(['dashboard']);
  }, false);
});

test('replacement rejection never launches the swapper or stops the current orchestrator', async () => {
  await fixture(async ({ checker, calls, reject }) => {
    reject('POST', '/containers/create', 400);
    await expect(checker.recreateOrchestrator()).rejects.toThrow('fixture rejection');
    expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(calls.some(call => call.path.includes('/stop'))).toBe(false);
  });
});

test('swapper uses inspected immutable IDs and waits for old removal before starting the fixed peers', async () => {
  const result = await swap(await preparedScript());
  expect(result.exitCode).toBe(0);
  expect(result.calls).toEqual([
    { method: 'POST', path: `/v1.54/containers/${originalId}/stop?t=30` },
    { method: 'POST', path: `/v1.54/containers/${originalId}/wait` },
    { method: 'DELETE', path: `/v1.54/containers/${originalId}` },
    { method: 'POST', path: `/v1.54/containers/${replacementId}/rename?name=agentor-orchestrator` },
    { method: 'POST', path: `/v1.54/containers/${replacementId}/start` },
  ]);
  expect(result.timeouts).toEqual([90000, 90000, 90000, 90000, 90000]);
});

for (const [index, step] of ['stop', 'wait', 'delete', 'rename', 'start'].entries()) {
  test(`swapper halts after rejected ${step}; it never advances the handoff`, async () => {
    const result = await swap(await preparedScript(), index);
    expect(result.exitCode).toBe(1);
    expect(result.calls).toHaveLength(index + 1);
  });
}

test('a timed out stop cannot advance to delete, rename or start', async () => {
  const result = await swap(await preparedScript(), 0, true);
  expect(result.exitCode).toBe(1);
  expect(result.calls).toHaveLength(1);
});

test('a reset Docker response cannot advance the handoff', async () => {
  const result = await swap(await preparedScript(), 0, false, true);
  expect(result.exitCode).toBe(1);
  expect(result.calls).toHaveLength(1);
});
