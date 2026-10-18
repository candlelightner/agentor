import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { redactManagedBufferSlice } from '../../orchestrator/server/utils/worker-output-redaction';
import type { ManagementConsoleStore } from '../../orchestrator/server/utils/management-console-store';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const ts = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('typescript');
const secret = 'managed-console-secret';

// Run the actual caller against the real manager/runtime, replacing only I/O.
async function fixture(kind: 'incus-vm' | 'legacy-docker', replaceDuringAttach = false, shortTimeout = false) {
  const root = await mkdtemp(join(tmpdir(), 'agentor-console-runtime-'));
  const installation = await backupInstallationId(root), calls: string[][] = [], input: string[] = [];
  let closed = 0, failures = 0;
  const stream = new PassThrough();
  const socket = Object.assign(new EventEmitter(), { readyState: 1, _socket: undefined,
    send(bytes: Buffer, ...args: any[]) { input.push(bytes.toString()); const done = args.find(value => typeof value === 'function'); done?.(); },
    close() { if (socket.readyState === 3) return; socket.readyState = 3; socket.emit('close'); },
    terminate() { socket.close(); },
  });
  const instance = { name: 'agentor-worker-console', type: 'virtual-machine', status: 'Running', config: {
    'user.agentor.id': 'console', 'user.agentor.owner': 'owner', 'user.agentor.installation': installation, 'volatile.uuid': 'original' } };
  const docker = {
    async execAttachTmuxWindow(handle: string, window: number) {
      expect(kind).toBe('legacy-docker'); expect(handle).toBe('docker-original');
      calls.push(['docker-attach', handle, String(window)]);
      return { exec: { id: 'docker-exec' }, stream, tmuxSession: 'ws-docker' };
    },
    async killTmuxSession(...args: string[]) { calls.push(['docker-close', ...args]); closed++; },
  };
  const manager = new ContainerManager(docker as any, { dataDir: root, containerPrefix: 'agentor-worker' } as any);
  manager.reportRuntimeFailure = () => { failures++; };
  const workers = new WorkerStore(root); await workers.init(); manager.setWorkerStore(workers);
  await workers.upsert({ id: 'console', userId: 'owner', status: 'active', runtimeKind: kind, displayName: 'console' } as any);
  manager.registerExternal({ id: 'console', userId: 'owner', runtimeKind: kind, status: 'running',
    containerId: kind === 'incus-vm' ? 'incus:original' : 'docker-original', containerName: instance.name } as any);
  manager.setIncusRuntime(new IncusWorkerRuntime({ dataDir: root, containerPrefix: 'agentor-worker' } as any, {
    getInstance: async () => structuredClone(instance),
    execInteractive: async (_name: string, command: string[], _options: unknown, connected: (value: any) => void) => {
      calls.push(command); connected(socket);
      if (replaceDuringAttach) instance.config['volatile.uuid'] = 'replacement';
      return { resize() {}, close() { closed++; socket.close(); } };
    },
    execStream: async (_name: string, command: string[]) => {
      calls.push(command); const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      stdout.end(); stderr.end();
      return { stdin, stdout, stderr, result: Promise.resolve(0), close() { stdin.destroy(); }, sendSignal() {} };
    },
  } as any));
  const source = await readFile(new URL('../../orchestrator/server/utils/management-console-store.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  new Function('require', 'exports', 'setTimeout', compiled)((name: string) => {
    if (name === './services') return { useContainerManager: () => manager, useDockerService: () => docker };
    if (name === './worker-output-redaction') return { redactManagedBufferSlice, workerOutputRedactionValues: async (worker: any) => {
      expect(worker.id).toBe('console'); return [secret];
    } };
    return createRequire(import.meta.url)(name);
  }, exports, shortTimeout ? (callback: () => void, ms: number) => setTimeout(callback, ms === 15_000 ? 1 : ms) : setTimeout);
  const consoles: ManagementConsoleStore = new exports.ManagementConsoleStore();
  return { consoles, manager, instance, calls, input, stream, socket, closed: () => closed, failures: () => failures,
    output: (text: string) => kind === 'incus-vm' ? socket.emit('message', Buffer.from(text), false) : stream.write(text),
    cleanup: async () => { await consoles.closeAll(); stream.destroy(); socket.close(); await rm(root, { recursive: true, force: true }); },
  };
}

for (const kind of ['legacy-docker', 'incus-vm'] as const) test(`${kind} management console uses shared terminal dispatch, redaction and exact cleanup`, async () => {
  const f = await fixture(kind);
  try {
    const session = await f.consoles.open('admin', 'console', 2);
    expect(session.workerId).toBe('console'); expect(f.calls[0]).toContain(kind === 'incus-vm' ? 'agentor-terminal' : 'docker-attach');
    await expect(f.consoles.read('another-admin', session.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(() => f.consoles.write('another-admin', session.id, 'forbidden')).toThrow('Console session not found');
    f.output(`ready ${secret} done`); await new Promise(resolve => setImmediate(resolve));
    expect((await f.consoles.read('admin', session.id)).output).toBe('ready [REDACTED] done');
    expect(f.consoles.write('admin', session.id, 'echo fixture\r').acceptedBytes).toBe(13);
    f.consoles.interrupt('admin', session.id);
    if (kind === 'incus-vm') { expect(f.input).toContain('echo fixture\r'); expect(f.input).toContain('\x03'); }
    await f.consoles.close('admin', session.id);
    await expect.poll(f.closed).toBe(1);
    if (kind === 'incus-vm') await expect.poll(() => f.calls.length).toBe(2);
    await expect(f.consoles.read('admin', session.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.failures()).toBe(0);
  } finally { await f.cleanup(); }
});

test('management console refuses a native incarnation replaced during attach without Docker fallback', async () => {
  const f = await fixture('incus-vm', true);
  try {
    await expect(f.consoles.open('admin', 'console')).rejects.toThrow('incarnation');
    expect(f.closed()).toBe(1); expect(f.calls).toHaveLength(1); expect(f.failures()).toBe(1);
  } finally { await f.cleanup(); }
});

test('management console disconnect never cleans a same-name native replacement', async () => {
  const f = await fixture('incus-vm');
  try {
    const session = await f.consoles.open('admin', 'console');
    f.instance.config['volatile.uuid'] = 'replacement';
    await f.consoles.close('admin', session.id);
    await new Promise(resolve => setImmediate(resolve));
    expect(f.closed()).toBe(1); expect(f.calls).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('management console stream close removes its session and performs captured cleanup once', async () => {
  const f = await fixture('incus-vm');
  try {
    const session = await f.consoles.open('admin', 'console');
    f.socket.close();
    await expect.poll(() => f.consoles.target('admin', session.id)).toBeUndefined();
    expect(f.closed()).toBe(1);
  } finally { await f.cleanup(); }
});

test('management console closes a late attachment after its bounded timeout', async () => {
  const f = await fixture('legacy-docker', false, true);
  let accept!: (terminal: any) => void, closed = 0;
  f.manager.attachTerminal = () => new Promise(resolve => { accept = resolve; });
  try {
    await expect(f.consoles.open('admin', 'console')).rejects.toMatchObject({ statusCode: 504 });
    accept({ stream: f.stream, resize() {}, close() { closed++; } });
    await expect.poll(() => closed).toBe(1);
    expect(f.failures()).toBe(1);
  } finally { await f.cleanup(); }
});
