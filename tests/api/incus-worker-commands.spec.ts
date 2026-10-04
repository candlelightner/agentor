import { test, expect } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const output = execFileSync('python3', ['-c', INCUS_EXEC_ENV_SCRIPT, 'python3', '-c', 'import os,json; print(json.dumps(dict(os.environ)))'], {
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
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-commands-'));
  const config = { dataDir: dir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase6-candidate',
    incusNetwork: 'incusbr0', incusStoragePool: 'default', incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    containerPrefix: 'agentor-worker', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const runtime = new IncusWorkerRuntime(config);
  const store = new WorkerStore(dir); await store.init();
  const manager = new ContainerManager({ listContainers: async () => [], createWorkerContainer: async () => { throw new Error('Docker fallback'); } } as any, config);
  manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const environmentJson = { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: 'COMMAND_PRECEDENCE=environment', exposeApis: {} };
  (manager as any).assertOwnerExists = async () => {};
  (manager as any).resolveGitIdentity = async () => ({ gitName: 'Command Test', gitEmail: 'test@example.invalid' });
  (manager as any).resolveUserEnvAndBinds = async () => ({ userEnv: { ...zeroUserEnvVars('test-user'), envVars: [{ key: 'COMMAND_PRECEDENCE', value: 'account' }] }, credentialBinds: [], groupSecrets: [] });
  (manager as any).resolveAuthorizedHostMounts = async () => undefined;
  (manager as any).resolveHardwareDeviceAccess = async () => undefined;
  (manager as any).resolveEnvironmentConfig = () => ({ environmentJson, capabilitiesJson: [], instructionsJson: [], dockerEnabled: false });
  let terminal: Awaited<ReturnType<ContainerManager['attachTerminal']>> | undefined;
  let desktopStream: Duplex | undefined;
  let primaryFailure = false;
  try {
    const worker = await (manager as any).createForOwner({ userId: 'test-user', displayName: 'Incus files-terminal integration' });
    const commands = manager.workerCommands(worker.id);
    expect((await commands.execCapture(worker.containerId, ['printenv', 'COMMAND_PRECEDENCE'])).stdout.toString().trim()).toBe('environment');
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
    terminal = await manager.attachTerminal(worker.id, 0);
    let text = '';
    terminal.stream.on('data', (chunk) => { text += chunk.toString(); });
    terminal.resize(120,40);
    const nonce = randomUUID();
    terminal.stream.write(Buffer.from(`printf '${nonce}\\n'; stty size\r`));
    await expect.poll(() => text, { timeout: 20_000 }).toContain(nonce);
    await expect.poll(() => text, { timeout: 20_000 }).toMatch(/40\s+120/);
    terminal.close(); terminal = undefined;
    await expect.poll(async () => (await commands.execCapture(worker.containerId, ['tmux', 'list-sessions', '-F', '#{session_name}'])).stdout.toString(), { timeout: 15_000 }).not.toContain('ws-');
    await manager.deleteFiles(worker.id, ['renamed.bin', 'binary']);
    expect((await manager.listFiles(worker.id, '')).entries.some((entry) => entry.name === 'renamed.bin')).toBe(false);
    const window = await manager.createTmuxWindow(worker.id, 'incus-command-test');
    await manager.renameTmuxWindow(worker.id, window.index, 'incus-renamed');
    expect((await manager.listTmuxWindows(worker.id)).some((item) => item.name === 'incus-renamed')).toBe(true);
    await manager.killTmuxWindow(worker.id, window.index);
    const app = await manager.createAppInstance(worker.id, 'socks5');
    await expect.poll(async () => manager.listAppInstances(worker.id, 'socks5'), { timeout: 15_000 }).toContainEqual(expect.objectContaining({ id: app.id, status: 'running' }));
    expect((await commands.execCapture(worker.containerId, ['curl', '--noproxy', '', '--socks5-hostname', `127.0.0.1:${app.port}`, '--max-time', '10', `${config.incusInternalGatewayUrl}/api/health`])).exitCode).toBe(0);
    await manager.stopAppInstance(worker.id, 'socks5', app.id);
    if (process.env.INCUS_APP_LOG_TEST === 'true') {
      expect((await commands.execCapture(worker.containerId, ['test', '-w', '/proc/1/fd/1'])).exitCode).not.toBe(0);
      await commands.startAppInstance(worker.containerId, 'ssh', 'ssh', 2222);
      expect((await commands.execCapture(worker.containerId, ['python3', '-c',
        "import socket; s=socket.create_connection(('127.0.0.1',2222),5); print(s.recv(100).decode()); s.close()"])).stdout.toString()).toContain('SSH-2.0-');
      await commands.stopAppInstance(worker.containerId, 'ssh', 'ssh');
      const chromium = await manager.createAppInstance(worker.id, 'chromium');
      await expect.poll(async () => (await commands.execCapture(worker.containerId,
        ['curl', '--noproxy', '*', '-fsS', '--max-time', '5', `http://127.0.0.1:${chromium.port}/json/version`])).stdout.toString(),
      { timeout: 20_000 }).toContain('webSocketDebuggerUrl');
      await manager.stopAppInstance(worker.id, 'chromium', chromium.id);
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
    const installed = await executor.execute({ workerId: worker.id, installationId: plugin, phase: 'install',
      command: { argv: ['python3', '-c', "import os; print(os.environ['COMMAND_PRECEDENCE'])"] },
      envKeys: ['COMMAND_PRECEDENCE'], secretKeys: [], systemEnvironment: {}, signal } as any);
    expect(installed).toMatchObject({ exitCode: 0, output: 'environment\n' });
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
