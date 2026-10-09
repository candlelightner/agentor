import { test, expect } from '@playwright/test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = fileURLToPath(new URL('../../scripts/incus-canary.mjs', import.meta.url));
const canary = await import(pathToFileURL(script).href) as {
  validateCanaryInput(input: unknown): { sessionCookie: string; dockerEnabled: boolean };
  canaryApiHeaders(authUrl: string, cookie?: string): Record<string, string>;
  CANARY_PACKET_SCRIPT: string;
  runIncusCanary(input: unknown, dependencies: unknown, signal?: AbortSignal): Promise<{
    status: string; stage: string; nonce: string; environments: string[]; workers: Array<{ id: string; incarnation?: string }>; retained?: boolean;
  }>;
};
const uid = (value: number) => '10000000-0000-4000-8000-' + String(value).padStart(12, '0');
const cookie = 'private-cookie=PRIVATE-CANARY-SESSION';
type Worker = { id: string; userId: string; runtimeKind: string; containerId: string; containerName: string; environmentId: string };
type PacketSpec = { nonce: string; destinationMac: string; cases: Array<{ label: string; family: number; source: string; target: string; mac: string }> };
function fixture(options: { admin?: boolean; unknownCreate?: boolean; foreignCleanup?: boolean; readiness?: boolean; abort?: AbortController;
  httpTarget?: string; guestGateway?: string; route?: unknown; brokenManualControl?: boolean; admittedSpoof?: string; ipv6?: boolean } = {}) {
  const workers: Worker[] = [], environments: Array<{ id: string; userId: string; createdAt: string; dockerEnabled: boolean }> = [];
  const calls: Array<{ path: string; method: string; body?: unknown; authenticated: boolean }> = [], commands: string[] = [], removed: string[] = [];
  let count = 0, closed = false, restarted = false, marker = '';
  let observer: { spec: PacketSpec; stdout: PassThrough; seen: Set<string> } | undefined, observerClosed = false;
  const instance = (worker: Worker) => ({ type: 'virtual-machine', name: worker.containerName, status: 'Running', profiles: [],
    config: { 'volatile.uuid': options.foreignCleanup && restarted && workers.indexOf(worker) === 1 ? uid(999) : worker.containerId.slice(6),
      'volatile.eth0.hwaddr': workers.indexOf(worker) === 0 ? '02:00:00:00:00:01' : '02:00:00:00:00:02',
      'user.agentor.id': worker.id, 'user.agentor.owner': 'owner', 'user.agentor.installation': uid(100) },
    devices: { eth0: { type: 'nic', name: 'eth0', network: 'owned-network', 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' } } });
  const request = async (path: string, body: unknown, method: string, session?: string) => {
    calls.push({ path, method, body, authenticated: session === cookie });
    if (path === '/api/auth/get-session') return { status: 200, body: { user: { id: 'owner', role: options.admin === false ? 'user' : 'admin' },
      session: { userId: 'owner', expiresAt: new Date(Date.now() + 60_000).toISOString() } } };
    if (path === '/api/environments' && method === 'POST') {
      const env = { id: uid(++count), userId: 'owner', createdAt: new Date().toISOString(), dockerEnabled: (body as { dockerEnabled: boolean }).dockerEnabled };
      environments.push(env); return { status: 201, body: env };
    }
    if (path === '/api/containers' && method === 'POST') {
      const worker = { id: uid(++count), userId: 'owner', runtimeKind: 'incus-vm', containerId: 'incus:' + uid(200 + count),
        containerName: 'canary-' + uid(count), environmentId: (body as { environmentId: string }).environmentId };
      workers.push(worker);
      if (options.unknownCreate && workers.length === 2) throw new Error('PRIVATE-CANARY-SESSION unknown create acknowledgement');
      options.abort?.abort(); return { status: 201, body: worker };
    }
    if (path === '/api/containers' && method === 'GET') return { status: 200, body: [...workers] };
    if (path.startsWith('/api/environments/') && method === 'GET') return { status: 200, body: environments.find(env => path.endsWith(env.id)) };
    if (path.startsWith('/api/environments/') && method === 'DELETE') {
      const index = environments.findIndex(env => path.endsWith(env.id)); removed.push(environments[index]!.id); environments.splice(index, 1); return { status: 200, body: { ok: true } };
    }
    if (path.endsWith('/restart')) restarted = true;
    if (path.startsWith('/api/containers/') && method === 'DELETE') {
      const index = workers.findIndex(worker => path.endsWith(worker.id)); removed.push(workers[index]!.id); workers.splice(index, 1);
    }
    if (path.startsWith('/editor/') && !session) return { status: 401, body: 'not authenticated' };
    return { status: 200, body: 'accepted' };
  };
  return { calls, commands, removed, workers, environments, closed: () => closed, observerClosed: () => observerClosed, dependencies: {
    installation: uid(100), config: { incusEnabled: true, incusEndpoint: 'https://owned-incus:8443', incusProject: 'owned',
      incusNetwork: 'owned-network', containerPrefix: 'canary', incusInternalGatewayUrl: 'http://' + (options.httpTarget ?? '10.25.0.1') + ':3079/' }, request,
    client: {
      getReadiness: async () => ({ ready: options.readiness !== false }),
      request: async (method: string, path: string) => {
        expect(method).toBe('GET'); expect(path).toBe('/1.0/projects/owned');
        return { config: { restricted: 'true', 'restricted.devices.nic': 'managed', 'restricted.networks.access': 'owned-network' } };
      },
      getInstance: async (name: string) => instance(workers.find(worker => worker.containerName === name)!),
      getInstanceState: async (name: string) => ({ network: { eth0: { addresses: [{ family: 'inet', scope: 'global',
        address: workers.findIndex(worker => worker.containerName === name) === 0 ? '10.25.0.2' : '10.25.0.3', netmask: '24' }] } } }),
      getNetworkLeases: async () => options.ipv6 ? [{ hwaddr: '02:00:00:00:00:01', address: 'fd42::2', type: 'dynamic' },
        { hwaddr: '02:00:00:00:00:02', address: 'fd42::3', type: 'dynamic' }] : [],
      execStream: async (_name: string, argv: string[]) => {
        expect(argv.at(-2)).toBe('observe'); const spec = JSON.parse(argv.at(-1)!) as PacketSpec;
        const stdout = new PassThrough(), stderr = new PassThrough(), seen = new Set<string>(); observer = { spec, stdout, seen };
        let resolve!: (code: number) => void, reject!: (error: Error) => void;
        const result = new Promise<number>((yes, no) => { resolve = yes; reject = no; });
        stdout.write(JSON.stringify({ type: 'ready', nonce: spec.nonce }) + '\n');
        const stdin = new Writable({ write(bytes, _encoding, done) {
          expect(bytes.toString()).toBe('finish\n'); stdout.end(JSON.stringify({ type: 'result', nonce: spec.nonce, seen: [...seen] }) + '\n');
          stderr.end(); resolve(0); done();
        } });
        return { stdout, stderr, stdin, result, close: () => { observerClosed = true; reject(new Error('closed')); stdout.destroy(); stderr.destroy(); } };
      },
      exec: async (name: string, argv: string[]) => {
        const worker = workers.find(item => item.containerName === name)!; const command = argv.at(-1)!; commands.push(command);
        if (command.includes('>/workspace/incus-canary')) marker = command.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/)![0];
        let stdout = '';
        const packet = command.match(/ send '(\{.*\})' '([a-z0-9-]+)'$/s);
        if (packet) {
          const spec = JSON.parse(packet[1]!) as PacketSpec, label = packet[2]!;
          expect(spec).toEqual(observer!.spec);
          if (!label.endsWith('-denied') || label === options.admittedSpoof + '-denied') {
            observer!.seen.add(label); observer!.stdout.write(JSON.stringify({ type: 'seen', nonce: spec.nonce, label }) + '\n');
          }
        }
        if (command === 'ip -j -4 route show default dev eth0') stdout = JSON.stringify(options.route ?? [{ dst: 'default', dev: 'eth0', gateway: options.guestGateway ?? '10.25.0.1', metric: 1024 }]);
        if (command.includes('/api/worker-self/info') && !command.includes('test "$code" = 28')) stdout = JSON.stringify({ workerId: worker.id, userId: 'owner' });
        if (command.includes('cat /data/proof')) stdout = marker;
        if (options.brokenManualControl && command.includes('systemctl stop systemd-networkd') && command.includes('ip link set eth0 address 02:00:00:00:00:02') && !command.includes('test "$code" = 28'))
          return { returnCode: 28, stdout: '', stderr: 'PRIVATE-GUEST-DETAILS' };
        return { returnCode: 0, stdout, stderr: 'PRIVATE-GUEST-DETAILS' };
      },
    },
    primary: async (owner: { id: string }) => ({ address: workers.findIndex(worker => worker.id === owner.id) === 0 ? '10.25.0.2' : '10.25.0.3',
      incarnation: workers.find(worker => worker.id === owner.id)!.containerId.slice(6) }),
    rfb: async () => 'RFB 003.008\n', close: () => { closed = true; },
  } };
}

test('input grants only a private current session and optional native Docker capability', () => {
  expect(canary.validateCanaryInput({ sessionCookie: cookie })).toEqual({ sessionCookie: cookie, dockerEnabled: false });
  for (const input of [{ sessionCookie: cookie, project: 'default' }, { sessionCookie: cookie, endpoint: 'https://foreign' },
    { sessionCookie: cookie, image: 'foreign' }, { sessionCookie: cookie, paths: ['/'] }, { sessionCookie: 'bad\nheader' },
    { sessionCookie: cookie, dockerEnabled: 'true' }]) expect(() => canary.validateCanaryInput(input)).toThrow();
});

test('loopback API and existing desktop relay use the actual configured public Host/Origin, including empty default', () => {
  expect(canary.canaryApiHeaders('https://agentor.example:9443', cookie)).toEqual({ Host: 'agentor.example:9443', Origin: 'https://agentor.example:9443',
    'Content-Type': 'application/json', Cookie: cookie });
  expect(canary.canaryApiHeaders('')).toMatchObject({ Host: '127.0.0.1:3000', Origin: 'http://127.0.0.1:3000' });
  expect(() => canary.canaryApiHeaders('https://user:private@agentor.example')).toThrow();
});

test('actual canary orchestration completes the stubbed native flow and deletes only acknowledged fixture resources', async () => {
  const f = fixture(); const result = await canary.runIncusCanary({ sessionCookie: cookie, dockerEnabled: true }, f.dependencies);
  expect(result.status, JSON.stringify(result)).toBe('passed'); expect(result.workers).toEqual([]); expect(result.environments).toEqual([]);
  expect(f.removed).toHaveLength(4); expect(f.workers).toEqual([]); expect(f.environments).toEqual([]); expect(f.closed()).toBe(true);
  expect(f.commands.some(command => command.endsWith("'ipv4-denied'"))).toBe(true);
  expect(f.commands.some(command => command.endsWith("'mac-denied'"))).toBe(true);
  expect(f.commands.some(command => command.includes('test "$code" = 28'))).toBe(false); expect(f.observerClosed()).toBe(true);
  expect(f.commands.some(command => command.includes('docker info'))).toBe(true);
  expect(f.calls.filter(call => call.method === 'POST' && call.path === '/api/environments').map(call => (call.body as { dockerEnabled: boolean }).dockerEnabled)).toEqual([true, false]);
  expect(f.commands.join('\n')).not.toContain(cookie); expect(JSON.stringify(result)).not.toContain('PRIVATE-');
});

test('non-admin or unavailable verified runtime never creates environment/worker resources', async () => {
  for (const options of [{ admin: false }, { readiness: false }]) {
    const f = fixture(options); const result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies);
    expect(result.status).toBe('failed'); expect(f.calls.some(call => call.method === 'POST')).toBe(false); expect(f.commands).toEqual([]);
  }
});

test('distinct Orchestrator HTTP host never substitutes for captured guest default gateway and healthy manual route precedes MAC spoof', async () => {
  const f = fixture({ httpTarget: '172.22.0.1', guestGateway: '10.25.0.1' });
  expect((await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies)).status).toBe('passed');
  const capture = f.commands.indexOf('ip -j -4 route show default dev eth0');
  const control = f.commands.findIndex(command => command.includes('systemctl stop systemd-networkd') && !command.includes('test "$code" = 28'));
  const spoof = f.commands.findIndex(command => command.endsWith("'mac-denied'"));
  expect(capture).toBeLessThan(f.commands.findIndex(command => command.endsWith("'ipv4-denied'")));
  expect(control).toBeLessThan(spoof);
  for (const command of [f.commands[control]!]) {
    expect(command).toContain('ip -4 route replace default via 10.25.0.1 dev eth0 metric 1024');
    expect(command).toContain('http://172.22.0.1:3079/api/worker-self/info'); expect(command).not.toContain('default via 172.22.0.1');
    expect(command).toContain('systemctl start systemd-networkd');
  }
});

test('bad or ambiguous guest default route and failed healthy manual control never count as successful spoof denial', async () => {
  for (const options of [{ route: [] }, { route: [{ dst: 'default', dev: 'foreign;command', gateway: '10.25.0.1' }] },
    { route: [{ dst: 'default', dev: 'eth0', gateway: 'not-ip' }] }, { brokenManualControl: true }]) {
    const f = fixture(options), result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies);
    expect(result).toMatchObject({ status: 'failed', stage: 'ipv4-mac-spoof', retained: true }); expect(f.removed).toEqual([]);
    expect(f.commands.some(command => command.endsWith("'mac-denied'"))).toBe(false);
  }
});

test('admitted stolen-source packets fail even when TCP replies would be misdirected and timeout', async () => {
  for (const admittedSpoof of ['ipv4', 'mac', 'ipv6']) {
    const f = fixture({ admittedSpoof, ipv6: admittedSpoof === 'ipv6' });
    const result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies);
    expect(result).toMatchObject({ status: 'failed', stage: 'one-way-nic-filtering', retained: true });
    expect(f.removed).toEqual([]); expect(f.observerClosed()).toBe(true);
    expect(f.commands.some(command => command.includes('test "$code" = 28'))).toBe(false);
  }
});

test('actual pure guest frame builder/parser sees allowed and stolen-source IPv4/IPv6 without kernel or reply-path help', async () => {
  const spec: PacketSpec = { nonce: uid(90), destinationMac: '02:00:00:00:00:01', cases: [
    { label: 'ipv4-before', family: 4, mac: '02:00:00:00:00:02', source: '10.25.0.3', target: '10.25.0.2' },
    { label: 'ipv4-denied', family: 4, mac: '02:00:00:00:00:02', source: '10.25.0.2', target: '10.25.0.2' },
    { label: 'mac-denied', family: 4, mac: '02:00:00:00:00:fe', source: '10.25.0.3', target: '10.25.0.2' },
    { label: 'ipv6-denied', family: 6, mac: '02:00:00:00:00:02', source: 'fd42::2', target: 'fd42::2' },
  ] };
  const result = await promisify(execFile)('python3', ['-c', canary.CANARY_PACKET_SCRIPT, 'selftest', JSON.stringify(spec)]);
  expect(JSON.parse(result.stdout)).toEqual(spec.cases.map(item => item.label)); expect(result.stderr).toBe('');
});

test('unknown worker create acknowledgement never adopts a name or issues cleanup/replay', async () => {
  const f = fixture({ unknownCreate: true }); const result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies);
  expect(result).toMatchObject({ status: 'failed', stage: 'create', retained: true }); expect(result.workers).toHaveLength(1);
  expect(f.workers).toHaveLength(2); expect(f.removed).toEqual([]); expect(f.calls.filter(call => call.path === '/api/containers' && call.method === 'POST')).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain(cookie);
});

test('foreign UUID at cleanup retains both workers and source environment without deleting a replacement', async () => {
  const f = fixture({ foreignCleanup: true }); const result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies);
  expect(result).toMatchObject({ status: 'failed', stage: 'cleanup', retained: true }); expect(f.removed).toEqual([]); expect(result.workers).toHaveLength(2);
});

test('cancellation after positive creation retains captured identities without cleanup', async () => {
  const controller = new AbortController(), f = fixture({ abort: controller });
  const result = await canary.runIncusCanary({ sessionCookie: cookie }, f.dependencies, controller.signal);
  expect(result).toMatchObject({ status: 'failed', stage: 'create', retained: true }); expect(result.workers).toHaveLength(1); expect(f.removed).toEqual([]);
});

test('CLI arguments never accept credentials or emit secrets', async () => {
  const result = await promisify(execFile)(process.execPath, [script, 'PRIVATE-ARGUMENT-CREDENTIAL']).catch(error => error);
  expect(result.code).toBe(1); expect(result.stdout).toBe('{"status":"failed","stage":"input"}\n'); expect(result.stdout + result.stderr).not.toContain('PRIVATE-ARGUMENT');
});

test('deterministic launcher coupling pins local Docker and packaged Node while transporting the exact secret only on stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'incus-canary-launch-'));
  try {
    const bin = join(directory, 'bin'), input = join(directory, 'input.json'), capture = join(directory, 'capture.json');
    await mkdir(bin, { mode: 0o700 });
    const payload = JSON.stringify({ sessionCookie: cookie, dockerEnabled: true }) + '\n';
    await writeFile(input, payload, { mode: 0o600 });
    await writeFile(join(bin, 'docker'), `#!/usr/bin/python3
import json,os,sys
value={'argv':sys.argv[1:],'stdin':sys.stdin.read(),'secretInEnvironment':${JSON.stringify(cookie)} in os.environ.values(),
       'dockerAuthorityEnvironment':[key for key in ('DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH') if key in os.environ]}
fd=os.open(os.environ['CANARY_LAUNCH_CAPTURE'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as output:json.dump(value,output)
print('{"status":"passed"}')
`, { mode: 0o700 });
    const result = await promisify(execFile)('bash', [fileURLToPath(new URL('../../scripts/run-incus-canary.sh', import.meta.url)),
      '--orchestrator-container', 'orchestrator-canary-test', '--input-file', input], { timeout: 10_000, env: {
        ...process.env, PATH: bin + ':' + process.env.PATH, CANARY_LAUNCH_CAPTURE: capture,
        DOCKER_HOST: 'tcp://foreign.example:2376', DOCKER_CONTEXT: 'foreign', DOCKER_TLS_VERIFY: '1', DOCKER_CERT_PATH: '/foreign' } });
    const observed = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; stdin: string; secretInEnvironment: boolean; dockerAuthorityEnvironment: string[] };
    expect(observed.argv).toEqual(['--host', 'unix:///var/run/docker.sock', 'exec', '-i', 'orchestrator-canary-test', 'node', '/app/.output/server/incus-canary.mjs']);
    expect(observed.stdin).toBe(payload); expect(observed.secretInEnvironment).toBe(false); expect(observed.dockerAuthorityEnvironment).toEqual([]);
    expect(result.stdout).toBe('{"status":"passed"}\n'); expect(result.stdout + result.stderr + JSON.stringify(observed.argv)).not.toContain(cookie);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('deterministic launcher rejects unsafe names, readable input and symlinks before any Docker invocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'incus-canary-reject-'));
  try {
    const bin = join(directory, 'bin'), input = join(directory, 'input.json'), link = join(directory, 'link.json'), marker = join(directory, 'docker-called');
    await mkdir(bin, { mode: 0o700 }); await writeFile(input, JSON.stringify({ sessionCookie: cookie }), { mode: 0o600 }); await symlink(input, link);
    await writeFile(join(bin, 'docker'), '#!/usr/bin/python3\nimport os\nopen(os.environ["CANARY_LAUNCH_CAPTURE"],"w").write("called")\n', { mode: 0o700 });
    for (const scenario of [{ name: 'unsafe;command', file: input, mode: 0o600 }, { name: 'safe', file: input, mode: 0o644 }, { name: 'safe', file: link, mode: 0o600 }]) {
      await chmod(input, scenario.mode);
      const result = await promisify(execFile)('bash', [fileURLToPath(new URL('../../scripts/run-incus-canary.sh', import.meta.url)),
        '--orchestrator-container', scenario.name, '--input-file', scenario.file], { timeout: 10_000,
        env: { ...process.env, PATH: bin + ':' + process.env.PATH, CANARY_LAUNCH_CAPTURE: marker } }).catch(error => error);
      expect(result.code).not.toBe(0); expect(result.stdout + result.stderr).not.toContain(cookie); await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
