import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { INCUS_EXEC_ENV_SCRIPT, incusWorkerCommand, IncusWorkerCommands } from '../../orchestrator/server/utils/incus-worker-commands';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import type { Config } from '../../orchestrator/server/utils/config';
import { withOwnerWorkerLifecycleMutation, withOwnerWorkerRuntimeSetup } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import { DockerPluginWorkerExecutor } from '../../orchestrator/server/utils/plugin-runtime-manager';
import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';
import { parseAppInstances, assertAppManageOk } from '../../orchestrator/server/utils/apps';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test('legacy terminal dispatch keeps the Docker exec, resize and linked-session cleanup contract', async () => {
  const calls: unknown[][] = [], stream = new PassThrough();
  const docker = {
    execAttachTmuxWindow: async (...args: unknown[]) => { calls.push(['attach', ...args]); return { exec: { id: 'legacy-exec' }, stream, tmuxSession: 'ws-legacy' }; },
    resizeExec: async (...args: unknown[]) => { calls.push(['resize', ...args]); },
    killTmuxSession: async (...args: unknown[]) => { calls.push(['cleanup', ...args]); },
  };
  const manager = new ContainerManager(docker as any, { containerPrefix: 'agentor-worker' } as Config);
  (manager as any).containers.set('legacy', { id: 'legacy', status: 'running', runtimeKind: 'legacy-docker', containerId: 'legacy-container' });
  expect(manager.workerCommands('legacy')).toBe(docker);
  const terminal = await manager.attachTerminal('legacy', 3);
  expect(terminal.stream).toBe(stream);
  terminal.resize(120, 40); terminal.close(); terminal.close();
  expect(calls).toEqual([['attach', 'legacy-container', 3], ['resize', 'legacy-exec', 120, 40], ['cleanup', 'legacy-container', 'ws-legacy']]);
  expect(stream.writableEnded).toBe(true);
  delete (manager as any).containers.get('legacy').runtimeKind;
  expect(manager.workerCommands('legacy')).toBe(docker);
});

test('shared app parser preserves legacy noisy NDJSON and tunnel metadata semantics', () => {
  expect(parseAppInstances('{"id":"socks5-1","port":1080,"status":"running"}\nwarning\n{bad-json\n{}\n{"id":"socks5-2","port":1081,"status":"stopped"}', 'socks5')).toEqual([
    { id: 'socks5-1', appType: 'socks5', port: 1080, status: 'running' },
    { id: 'socks5-2', appType: 'socks5', port: 1081, status: 'stopped' },
  ]);
  expect(parseAppInstances('warning\n{bad-json\n{}\n' + JSON.stringify({ id: 'vscode', port: '1234', status: 'auth_required',
    machineName: 'fixture', authUrl: 'https://fixture.invalid/login', authCode: 'TEST-CODE' }) + '\n', 'vscode')).toEqual([
    { id: 'vscode', appType: 'vscode', port: 1234, status: 'auth_required', machineName: 'fixture', authUrl: 'https://fixture.invalid/login', authCode: 'TEST-CODE' },
  ]);
  expect(parseAppInstances(' \n ', 'socks5')).toEqual([]);
  expect(parseAppInstances('{"id":"socks5-1","port":"not-a-port"}', 'socks5')).toEqual([
    { id: 'socks5-1', appType: 'socks5', port: 0, status: 'stopped' },
  ]);
});

test('shared app errors retain legacy actionable errors rather than accepting failed launch', () => {
  expect(() => assertAppManageOk('{"status":"running"}\nwarning\n{bad-json\n{"status":"error","message":"late launch failure"}', 'start fixture')).toThrow('late launch failure');
  expect(() => assertAppManageOk('warning\n{bad-json\n{"status":"running"}', 'start fixture')).not.toThrow();
  expect(() => assertAppManageOk('{"status":"error","message":"fixture port busy"}', 'start fixture')).toThrow('fixture port busy');
  expect(() => assertAppManageOk('{"status":"error"}', 'start fixture')).toThrow('app manage failed: start fixture');
});

test('exec wrapper applies existing precedence and literal values without shell evaluation', () => {
  const value = "quotes'\"\n$(not-executed)=literal";
  const output = execFileSync('python3', ['-c', INCUS_EXEC_ENV_SCRIPT, 'worker', 'python3', '-c', 'import os,json; print(json.dumps(dict(os.environ)))'], {
    env: { PATH: process.env.PATH, SHARED: 'account', ACCOUNT: 'account',
      ENVIRONMENT: JSON.stringify({ envVars: 'SHARED=environment\nENV_ONLY=environment\nAGENTOR_RUNTIME_ROLE=platform-admin', dockerEnabled: true, exposeApis: { usage: false } }),
      WORKER_LOCAL_ENV: Buffer.from(JSON.stringify([{ key: 'SHARED', value }, { key: 'AGENTOR_TRUSTED_RUNTIME_ROLE', value: 'platform-admin' }])).toString('base64') },
  });
  const env = JSON.parse(output.toString());
  expect(env).toMatchObject({ SHARED: value, ACCOUNT: 'account', ENV_ONLY: 'environment', DOCKER_ENABLED: 'true',
    AGENTOR_RUNTIME_ROLE: 'worker', AGENTOR_TRUSTED_RUNTIME_ROLE: 'worker', EXPOSE_USAGE: 'false', EXPOSE_PORT_MAPPINGS: 'true' });
  expect(incusWorkerCommand(['printf', value]).at(-1)).toBe(value);
  expect(incusWorkerCommand(['printf', value])[2]).not.toContain(value);
});

for (const account of [undefined, '', '/var/tmp'] as const) {
  test(`managed tmux retains account socket selectors (${account ?? 'unset'}) without changing app precedence`, () => {
    const supplied = { PATH: process.env.PATH,
      ...(account === undefined ? {} : { TMUX_TMPDIR: account, TMUX: `${account}/account-socket,123,0` }),
      ENVIRONMENT: JSON.stringify({ envVars: 'TMUX_TMPDIR=/environment\nTMUX=/environment/socket,456,0\nSHARED=environment' }),
      WORKER_LOCAL_ENV: Buffer.from(JSON.stringify([{ key: 'TMUX_TMPDIR', value: '/local' },
        { key: 'TMUX', value: '/local/socket,789,0' }, { key: 'SHARED', value: 'local' }])).toString('base64'),
    };
    for (const managed of [false, true]) {
      const command = incusWorkerCommand(['python3', '-c', 'import os,json; print(json.dumps(dict(os.environ)))'], managed);
      const env = JSON.parse(execFileSync('python3', ['-c', ...command.slice(4)], { env: supplied }).toString());
      expect(env.SHARED).toBe('local');
      expect(env.TMUX_TMPDIR).toBe(managed ? account : '/local');
      expect(env.TMUX).toBe(managed ? supplied.TMUX : '/local/socket,789,0');
    }
  });
}

test('entrypoint tmux helper preserves original selectors after later exports', async () => {
  const entrypoint = await readFile('../worker/entrypoint.sh', 'utf8');
  const helper = entrypoint.slice(entrypoint.indexOf('readonly _agentor_bootstrap_tmux_tmpdir='), entrypoint.indexOf('\n_boot\n_total'));
  for (const account of [undefined, '', '/var/tmp']) {
    const result = spawnSync('bash', ['-ec', `${helper}
# Intercept the command builtin to inspect exactly the helper's client env.
command() { [ "$1" = tmux ]; printf '%s|%s' "$TMUX_TMPDIR" "$TMUX"; }
export TMUX_TMPDIR=/local TMUX=/local/socket,999,0
agentor_tmux has-session -t '=main'
`], { env: { PATH: process.env.PATH, ...(account === undefined ? {} : { TMUX_TMPDIR: account, TMUX: '/account/socket,123,0' }) }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${account || '/tmp'}|${account === undefined ? '' : '/account/socket,123,0'}`);
  }
  // No unpinned bootstrap invocation can slip back in after the override phase.
  expect(entrypoint).not.toMatch(/^tmux\s/m);
  expect(entrypoint).not.toContain('&& tmux ');
});

test('managed tmux dispatch and disconnect cleanup use bootstrap mode with existing authority fences', async () => {
  const calls: string[][] = [];
  let allow = true, closed = 0;
  const socket = Object.assign(new EventEmitter(), { readyState: 1, _socket: undefined,
    send(_bytes: unknown, callback?: () => void) { callback?.(); },
    close() { this.readyState = 3; this.emit('close'); }, terminate() { this.close(); } });
  const commands = new IncusWorkerCommands({
    execStream: async (_name: string, command: string[]) => { calls.push(command); return fakeSession(); },
    execInteractive: async (_name: string, command: string[], _options: unknown, connected: (socket: any) => void) => {
      calls.push(command); connected(socket); return { resize() {}, close() { closed++; } };
    },
  } as any, 'fixture', 'incus:uuid', async () => { if (!allow) throw new Error('authority changed'); });
  await commands.execTmux('incus:uuid', ['rename-window', '-t', 'main:0', 'new-name']);
  await commands.execListTmuxWindows('incus:uuid');
  const terminal = await commands.attachTerminal(0);
  expect(calls[2]).toContain('agentor-terminal');
  expect(calls[2].join(' ')).toContain('-t =main');
  terminal.close(); terminal.close();
  await expect.poll(() => calls.length).toBe(4);
  expect(calls.every((command) => command[5] === 'bootstrap-tmux')).toBe(true);
  expect(calls[3].slice(-3, -1)).toEqual(['kill-session', '-t']);
  expect(closed).toBe(1);
  allow = false;
  await expect(commands.execTmux('incus:uuid', ['kill-session', '-t', 'ws-old'])).rejects.toThrow('authority changed');
  expect(calls).toHaveLength(4);
});

test('native app logging uses the guest journal without contaminating NDJSON or closing app output', () => {
  const script = `source ../worker/apps/lib.sh
cat() { if [ "$1" = /proc/1/comm ]; then printf systemd; else command cat "$@"; fi; }
logger() { [ "$1" = -t ] && [ "$2" = agentor-app ] || exit 1; command cat >&2; }
printf 'app-output\\n' | app_log
logger() { return 1; }
printf 'sink-unavailable\\n' | app_log
head -c 1048576 /dev/zero | app_log
printf '{"status":"running"}\\n'
`;
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd: process.cwd(), encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('{"status":"running"}\n');
  expect(result.stderr).toBe('app-output\n');
});

for (const app of ['socks5', 'ssh', 'chromium', 'vscode-tunnel', 'vscode-desktop']) {
  for (const native of [false, true]) {
    test(`${app} background logging closes ${native ? 'VM' : 'legacy'} exec channels while retaining app/log/PID behavior`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agentor-app-channel-'));
      let child: ReturnType<typeof spawn> | undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        const source = await readFile(`../worker/apps/${app}/manage.sh`, 'utf8');
        const pipeline = /> >\((.*)\) 2>&1 &/.exec(source)?.[1];
        expect(pipeline).toBeDefined();
        const library = (await readFile('../worker/apps/lib.sh', 'utf8')).replace('/proc/1/fd/1', `${dir}/legacy.log`);
        const script = `${library}
cat() { if [ "$1" = /proc/1/comm ]; then printf '${native ? 'systemd' : 'bash'}'; else command cat "$@"; fi; }
logger() { [ "$1" = -t ] && [ "$2" = agentor-app ]; command cat >> "$FIXTURE_DIR/journal.log"; }
ID=fixture LOG_FILE="$FIXTURE_DIR/tee.log"
bash -c 'printf "stdout-line\\n"; printf "stderr-line\\n" >&2; exec sleep 20' > >(${pipeline}) 2>&1 &
printf '{"pid":%d,"status":"running"}\\n' "$!"
`;
        child = spawn('bash', ['-ec', script], { detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH, FIXTURE_DIR: dir } });
        let stdout = '', stderr = '';
        child.stdout!.on('data', (bytes) => { stdout += bytes.toString(); });
        child.stderr!.on('data', (bytes) => { stderr += bytes.toString(); });
        await Promise.race([
          new Promise<void>((resolve, reject) => {
            child!.once('error', reject);
            child!.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Manager exited ${code}`)));
          }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Background logger retained exec channels')), 1500); }),
        ]);
        expect(stderr).toBe('');
        const record = JSON.parse(stdout);
        expect(record.status).toBe('running');
        expect(Number.isInteger(record.pid) && record.pid > 1).toBe(true);
        expect(() => process.kill(record.pid, 0)).not.toThrow();
        const log = `${dir}/${native ? 'journal' : 'legacy'}.log`;
        const tag = app === 'ssh' ? 'sshd' : ['socks5', 'chromium'].includes(app) ? `${app}-fixture` : app;
        await expect.poll(async () => readFile(log, 'utf8').catch(() => ''), { timeout: 1000 }).toContain(`[${tag}] stdout-line`);
        expect(await readFile(log, 'utf8')).toContain(`[${tag}] stderr-line`);
        if (app === 'ssh' || app === 'vscode-tunnel') expect(await readFile(`${dir}/tee.log`, 'utf8')).toContain('stdout-line');
        process.kill(record.pid, 'SIGTERM');
        await expect.poll(async () => {
          const stat = await readFile(`/proc/${record.pid}/stat`, 'utf8').catch(() => '');
          return !stat || /\) [ZX] /.test(stat);
        }, { timeout: 1000 }).toBe(true);
      } finally {
        clearTimeout(timer);
        // Only this newly spawned fixture's process group, never worker apps.
        if (child?.pid) try { process.kill(-child.pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}

function fakeSession() {
  const stdout = new PassThrough(), stderr = new PassThrough();
  const chunks: Buffer[] = [];
  let closes = 0;
  const stdin = new Writable({ write: (bytes, _encoding, callback) => { chunks.push(Buffer.from(bytes)); callback(); },
    final: (callback) => { stdout.end(Buffer.concat(chunks)); stderr.end(Buffer.from([255,0])); callback(); } });
  return { stdin, stdout, stderr, operationId: 'test', result: Promise.resolve(23), sendSignal() {}, close: () => { closes++; }, get closes() { return closes; } };
}

test('capture preserves binary stdin/stdout/stderr, user and cwd through the narrow adapter', async () => {
  const session = fakeSession();
  let supplied: any;
  let validated = 0;
  const commands = new IncusWorkerCommands({ execStream: async (...args: any[]) => { supplied = args; return session; } } as any,
    'fixture', 'incus:uuid', async () => { validated++; });
  const input = Buffer.from([0,255,13,10,128]);
  const result = await commands.execCapture('incus:uuid', ['cat'], { stdin: input, user: 'agent', workdir: '/workspace/sub' });
  expect(result).toEqual({ stdout: input, stderr: Buffer.from([255,0]), exitCode: 23 });
  expect(validated).toBe(2);
  expect(supplied[2]).toMatchObject({ user: 1000, group: 1000, cwd: '/workspace/sub', timeoutMs: 30_000 });
  expect(session.closes).toBe(1);
  await expect(commands.execCapture('incus:replacement', ['true'])).rejects.toThrow('handle changed');
  await expect(commands.execCapture('incus:uuid', ['true'], { user: 'unknown' })).rejects.toThrow('Unsupported');
});

test('late ownership validation closes an accepted session rather than returning stale authority', async () => {
  const session = fakeSession();
  let checks = 0;
  const commands = new IncusWorkerCommands({ execStream: async () => session } as any, 'fixture', 'incus:uuid', async () => {
    if (++checks === 2) throw new Error('authority changed');
  });
  await expect(commands.open(['true'])).rejects.toThrow('authority changed');
  expect(session.closes).toBe(1);
});

test('runtime command boundary rejects foreign installation, owner, incarnation and stopped state before dispatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-command-authority-'));
  try {
    const installation = await backupInstallationId(dir);
    for (const mismatch of ['installation', 'owner', 'incarnation', 'stopped']) {
      const instance = { name: 'agentor-worker-test', type: 'virtual-machine', status: 'Running', config: {
        'user.agentor.id': 'test', 'user.agentor.owner': 'owner', 'user.agentor.installation': installation, 'volatile.uuid': 'uuid' } };
      if (mismatch === 'installation') instance.config['user.agentor.installation'] = 'foreign';
      if (mismatch === 'owner') instance.config['user.agentor.owner'] = 'foreign';
      if (mismatch === 'incarnation') instance.config['volatile.uuid'] = 'replacement';
      if (mismatch === 'stopped') instance.status = 'Stopped';
      let dispatched = false;
      const runtime = new IncusWorkerRuntime({ dataDir: dir, containerPrefix: 'agentor-worker' } as Config,
        { getInstance: async () => instance, execStream: async () => { dispatched = true; return fakeSession(); } } as any);
      await expect(runtime.commands({ id: 'test', userId: 'owner', containerName: instance.name }, 'uuid', () => {}).open(['true'])).rejects.toThrow();
      expect(dispatched).toBe(false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manager command dispatch rechecks the durable record and never falls back to Docker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-command-record-'));
  try {
    const installation = await backupInstallationId(dir);
    const store = new WorkerStore(dir); await store.init();
    await store.upsert({ id: 'test', userId: 'owner', status: 'active', runtimeKind: 'incus-vm', displayName: 'test' } as any);
    const manager = new ContainerManager({ execCapture: () => { throw new Error('Docker fallback'); } } as any, { dataDir: dir, containerPrefix: 'agentor-worker' } as Config);
    manager.setWorkerStore(store);
    const instance = { name: 'agentor-worker-test', type: 'virtual-machine', status: 'Running', config: {
      'user.agentor.id': 'test', 'user.agentor.owner': 'owner', 'user.agentor.installation': installation, 'volatile.uuid': 'uuid' } };
    manager.setIncusRuntime(new IncusWorkerRuntime({ dataDir: dir, containerPrefix: 'agentor-worker' } as Config,
      { getInstance: async () => instance, execStream: async () => fakeSession() } as any));
    (manager as any).containers.set('test', { id: 'test', userId: 'owner', status: 'running', runtimeKind: 'incus-vm', containerId: 'incus:uuid', containerName: instance.name });
    const commands = manager.workerCommands('test');
    await store.upsert({ ...store.findById('test')!, status: 'archived' });
    await expect(commands.execCapture('incus:uuid', ['true'])).rejects.toThrow('authority changed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('delayed name-based dispatch holds the lifecycle setup fence but not command lifetime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-command-setup-fence-'));
  try {
    const installation = await backupInstallationId(dir);
    const id = randomUUID(), userId = `owner-${randomUUID()}`, name = `agentor-worker-${id}`;
    const instance = { name, type: 'virtual-machine', status: 'Running', config: {
      'user.agentor.id': id, 'user.agentor.owner': userId, 'user.agentor.installation': installation, 'volatile.uuid': 'original' } };
    let accept!: () => void, enter!: () => void, acceptedIncarnation = '', replacementRan = false;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const barrier = new Promise<void>((resolve) => { accept = resolve; });
    const session = fakeSession();
    const runtime = new IncusWorkerRuntime({ dataDir: dir, containerPrefix: 'agentor-worker' } as Config, {
      getInstance: async () => structuredClone(instance), execStream: async () => {
        enter(); await barrier; acceptedIncarnation = instance.config['volatile.uuid']; return session;
      },
    } as any);
    const commands = runtime.commands({ id, userId, containerName: name }, 'original', () => {},
      (operation) => withOwnerWorkerRuntimeSetup(userId, id, operation));
    const opening = commands.open(['true']);
    await entered;
    const replacement = withOwnerWorkerLifecycleMutation(userId, id, async () => {
      replacementRan = true; instance.config['volatile.uuid'] = 'replacement';
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(replacementRan).toBe(false);
    accept();
    const connected = await opening;
    await replacement;
    expect(acceptedIncarnation).toBe('original');
    expect(replacementRan).toBe(true);
    connected.close();
    // Old disconnect cleanup must not issue an exec in the replacement.
    await expect(commands.execCapture('incus:original', ['tmux', 'kill-session', '-t', 'ws-old'])).rejects.toThrow('incarnation');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const mode of ['valid', 'too-large', 'setup-failure'] as const) {
  test(`shared plugin runner ${mode} uses alternate transport without Docker fallback or stderr leakage`, async () => {
    let dockerCalls = 0;
    const executor = new DockerPluginWorkerExecutor({ getContainer: () => { dockerCalls++; throw new Error('Docker fallback'); } } as any,
      () => 'incus:fixture', async (_worker, command) => {
        expect(command).toEqual(['/home/agent/apps/plugin-runner/runner.py', 'execute']);
        if (mode === 'setup-failure') throw new Error('Incus unavailable');
        const stream = new Duplex({ read() {}, write(bytes, _encoding, callback) {
          expect(JSON.parse(bytes.toString())).toMatchObject({ installationId: 'plugin', phase: 'start' });
          this.push(mode === 'valid' ? Buffer.from('{"exitCode":0,"output":"plugin-ok"}\n') : Buffer.alloc(9 * 1024 * 1024 + 1, 65));
          this.push(null); callback();
        } });
        return { stream, demux: (stdout, stderr) => { stream.pipe(stdout); stderr.end('private-worker-error'); } };
      });
    const invocation = executor.execute({ workerId: 'test', installationId: 'plugin', phase: 'start', command: { argv: ['true'] }, envKeys: [], secretKeys: [], systemEnvironment: {}, signal: new AbortController().signal } as any);
    if (mode === 'valid') await expect(invocation).resolves.toEqual({ exitCode: 0, output: 'plugin-ok' });
    else await expect(invocation).rejects.toMatchObject({ code: mode === 'too-large' ? 'PLUGIN_RUNNER_OUTPUT_LIMIT' : 'PLUGIN_RUNNER_UNAVAILABLE' });
    expect(dockerCalls).toBe(0);
  });
}

test('real production manager files and linked terminal use the accepted Incus guest', async () => {
  test.skip(process.env.INCUS_COMMAND_TEST !== 'true', 'Explicit disposable-host command integration');
  test.setTimeout(600_000);
  const gateway = new URL(process.env.INCUS_STACK_GATEWAY || 'http://10.159.68.1:38000');
  if (gateway.protocol !== 'http:' || gateway.username || gateway.password || gateway.pathname !== '/' || gateway.search || gateway.hash)
    throw new Error('Fixture requires the approved internal HTTP gateway origin');
  // Check the external fixture dependency before paying for another VM boot.
  expect(execFileSync('ssh', ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
    '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1',
    'curl', '--max-time', '5', '-fsS', '-o', '/dev/null', '-w', '%{http_code}',
    "'" + (gateway.origin + '/api/health').replaceAll("'", "'\\''") + "'"],
  { encoding: 'utf8', timeout: 10_000 })).toBe('200');
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-commands-'));
  const config = { dataDir: dir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase6-candidate',
    incusNetwork: 'incusbr0', incusStoragePool: 'default', incusInternalGatewayUrl: gateway.origin,
    containerPrefix: 'agentor-worker', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const runtime = new IncusWorkerRuntime(config);
  const store = new WorkerStore(dir); await store.init();
  const manager = new ContainerManager({ listContainers: async () => [], createWorkerContainer: async () => { throw new Error('Docker fallback'); } } as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const environmentJson = { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '',
    envVars: 'COMMAND_PRECEDENCE=environment\nTMUX_TMPDIR=/tmp/agentor-environment-tmux\nTMUX=/tmp/environment-socket,456,0', exposeApis: {} };
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).resolveGitIdentity = async () => ({ gitName: 'Command Test', gitEmail: 'test@example.invalid' });
  (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: { ...zeroUserEnvVars('test-user'),
    envVars: [{ key: 'COMMAND_PRECEDENCE', value: 'account' }, { key: 'TMUX_TMPDIR', value: '/var/tmp' }] }, credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveEnvironmentConfig = () => ({ environmentJson, capabilitiesJson: [], instructionsJson: [], dockerEnabled: false });
  let terminal: Awaited<ReturnType<ContainerManager['attachTerminal']>> | undefined;
  let desktopStream: Duplex | undefined;
  let primaryFailure = false;
  let stage = 'create';
  try {
    const worker = await (manager as any).createForOwner({ userId: 'test-user', displayName: 'Incus files-terminal integration',
      workerConfiguration: { variables: [{ key: 'TMUX_TMPDIR', value: '/tmp/agentor-local-tmux' },
        { key: 'TMUX', value: '/tmp/local-socket,789,0' }] } });
    const commands = manager.workerCommands(worker.id);
    stage = 'environment and main session';
    expect((await commands.execCapture(worker.containerId, ['printenv', 'COMMAND_PRECEDENCE'])).stdout.toString().trim()).toBe('environment');
    expect((await commands.execCapture(worker.containerId, ['printenv', 'TMUX_TMPDIR'])).stdout.toString().trim()).toBe('/tmp/agentor-local-tmux');
    expect((await commands.execCapture(worker.containerId, ['printenv', 'TMUX'])).stdout.toString().trim()).toBe('/tmp/local-socket,789,0');
    expect(await manager.listTmuxWindows(worker.id)).toContainEqual(expect.objectContaining({ name: 'main' }));
    stage = 'file operations';
    const binary = Buffer.from([0,255,10,13,128,0]);
    await manager.mkdirFiles(worker.id, 'binary');
    await manager.uploadFiles(worker.id, 'binary', [{ rel: 'bytes.bin', data: binary }], false);
    const listing = await manager.listFiles(worker.id, 'binary');
    expect(listing.entries[0]).toMatchObject({ name: 'bytes.bin', owner: '1000', group: '1000' });
    const download = await manager.downloadFiles(worker.id, ['binary/bytes.bin']);
    expect(download.kind).toBe('file'); expect(await collect(download.stream)).toEqual(binary);
    const zip = await manager.downloadFiles(worker.id, ['binary']);
    expect(zip.kind).toBe('zip'); expect((await collect(zip.stream)).subarray(0,2).toString()).toBe('PK');
    await manager.renameFile(worker.id, 'binary/bytes.bin', 'renamed.bin');
    await manager.moveFiles(worker.id, ['binary/renamed.bin'], '', false);
    await commands.execCapture(worker.containerId, ['ln', '-s', '/etc', '/workspace/escape']);
    await expect(manager.downloadFiles(worker.id, ['escape/passwd'])).rejects.toThrow(/escape/);
    await expect(manager.mkdirFiles(worker.id, '../outside')).rejects.toThrow();
    stage = 'terminal input/resize/cleanup';
    terminal = await manager.attachTerminal(worker.id, 0);
    let text = '';
    terminal.stream.on('data', (chunk) => { text += chunk.toString(); });
    terminal.resize(120,40);
    const nonce = randomUUID().replaceAll('-', '');
    terminal.stream.write(Buffer.from(`printf '%s%s\\n' '${nonce.slice(0, 16)}' '${nonce.slice(16)}'; stty size\r`));
    await expect.poll(() => text, { timeout: 20_000 }).toContain(nonce);
    await expect.poll(() => text, { timeout: 20_000 }).toMatch(/40\s+120/);
    terminal.close(); terminal = undefined;
    await expect.poll(async () => {
      const result = await commands.execCapture(worker.containerId,
        ['tmux', '-S', '/var/tmp/tmux-1000/default', 'list-sessions', '-F', '#{session_name}']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain('main');
      return result.stdout.toString();
    }, { timeout: 15_000 }).not.toContain('ws-');
    await manager.deleteFiles(worker.id, ['renamed.bin', 'binary']);
    expect((await manager.listFiles(worker.id, '')).entries.some((entry) => entry.name === 'renamed.bin')).toBe(false);
    stage = 'tmux windows';
    const window = await manager.createTmuxWindow(worker.id, 'incus-command-test');
    await manager.renameTmuxWindow(worker.id, window.index, 'incus-renamed');
    expect((await manager.listTmuxWindows(worker.id)).some((item) => item.name === 'incus-renamed')).toBe(true);
    await manager.killTmuxWindow(worker.id, window.index);
    stage = 'SOCKS app';
    const app = await manager.createAppInstance(worker.id, 'socks5');
    await expect.poll(async () => manager.listAppInstances(worker.id, 'socks5'), { timeout: 15_000 }).toContainEqual(expect.objectContaining({ id: app.id, status: 'running' }));
    expect((await commands.execCapture(worker.containerId, ['curl', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${app.port}`, '--max-time', '10', `${config.incusInternalGatewayUrl}/api/health`])).exitCode).toBe(0);
    await manager.stopAppInstance(worker.id, 'socks5', app.id);
    if (process.env.INCUS_APP_LOG_TEST === 'true') {
      expect((await commands.execCapture(worker.containerId, ['test', '-w', '/proc/1/fd/1'])).exitCode).not.toBe(0);
      stage = 'SSH app/logging';
      await commands.startAppInstance(worker.containerId, 'ssh', 'ssh', 2222);
      expect((await commands.execCapture(worker.containerId, ['python3', '-c',
        "import socket; s=socket.create_connection(('127.0.0.1',2222),5); print(s.recv(100).decode()); s.close()"])).stdout.toString()).toContain('SSH-2.0-');
      await commands.stopAppInstance(worker.containerId, 'ssh', 'ssh');
      stage = 'Chromium app/logging';
      const chromium = await manager.createAppInstance(worker.id, 'chromium');
      await expect.poll(async () => (await commands.execCapture(worker.containerId,
        ['curl', '--noproxy', '*', '-fsS', '--max-time', '5', `http://127.0.0.1:${chromium.port}/json/version`])).stdout.toString(),
      { timeout: 20_000 }).toContain('webSocketDebuggerUrl');
      await manager.stopAppInstance(worker.id, 'chromium', chromium.id);
      stage = 'VS Code tunnel app/logging';
      const tunnel = await manager.createAppInstance(worker.id, 'vscode');
      await expect.poll(async () => (await manager.listAppInstances(worker.id, 'vscode'))[0]?.status,
        { timeout: 60_000 }).toMatch(/auth_required|running/);
      await manager.stopAppInstance(worker.id, 'vscode', tunnel.id);
      const guestJournal = await commands.execCapture(worker.containerId,
        ['journalctl', '-t', 'agentor-app', '--no-pager', '-n', '80'], { user: 'root' });
      expect(guestJournal.stdout.toString()).toContain('[sshd]');
      expect(guestJournal.stdout.toString()).toContain('[vscode-tunnel]');
    }
    expect(commands instanceof IncusWorkerCommands).toBe(true);
    const executor = new DockerPluginWorkerExecutor({ getContainer: () => { throw new Error('Docker fallback'); } } as any,
      () => worker.containerId, async (_id, command, signal) => {
        const transport = await (commands as IncusWorkerCommands).openDuplex(command, signal);
        return { stream: transport.stream, demux: (stdout, stderr) => { transport.stream.pipe(stdout); transport.stderr.pipe(stderr); } };
      });
    const plugin = randomUUID(), signal = new AbortController().signal;
    stage = 'plugin exec';
    const installed = await executor.execute({ workerId: worker.id, installationId: plugin, phase: 'install',
      command: { argv: ['python3', '-c', "import os; print(os.environ['COMMAND_PRECEDENCE'])"] },
      envKeys: ['COMMAND_PRECEDENCE'], secretKeys: [], systemEnvironment: {}, signal } as any);
    expect(installed).toMatchObject({ exitCode: 0, output: 'environment\n' });
    stage = 'isolated desktop';
    const desktop = await executor.desktop({ workerId: worker.id, installationId: plugin, operation: 'ensure',
      config: { display: 100, width: 640, height: 480, depth: 24 }, signal });
    expect(desktop.exitCode).toBe(0);
    const relay = await (commands as IncusWorkerCommands).openDuplex(['python3', '/home/agent/apps/plugin-runner/desktop_runtime.py', 'connect', plugin, '100']);
    desktopStream = relay.stream; relay.stderr.resume();
    const rfb = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Isolated desktop RFB timeout')), 15_000);
      relay.stream.once('data', (bytes) => { clearTimeout(timer); resolve(bytes); });
      relay.stream.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    expect(rfb.toString()).toMatch(/^RFB 003\./);
    desktopStream.destroy(); desktopStream = undefined;
    expect((await executor.desktop({ workerId: worker.id, installationId: plugin, operation: 'stop',
      config: { display: 100, width: 640, height: 480, depth: 24 }, signal })).exitCode).toBe(0);
    console.log('Phase 7 manager feature assertions complete; cleaning exact fixture');
  } catch (error) {
    primaryFailure = true;
    console.error('Phase 7 manager feature failure at', stage);
    throw error;
  } finally {
    terminal?.close();
    desktopStream?.destroy();
    for (const worker of store.list()) {
      const name = manager.buildContainerName(worker.id);
      try {
        await runtime.remove(name);
        await runtime.removeStorage({ id: worker.id, userId: worker.userId, containerName: name });
      } catch (error) {
        console.error(`Exact fixture cleanup failed: ${name}`, error);
        if (!primaryFailure) throw error;
      }
    }
    runtime.client.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
