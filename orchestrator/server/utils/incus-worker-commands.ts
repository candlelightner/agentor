import { PassThrough, Readable, Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { posix } from 'node:path';
import type { IncusClient, IncusInstanceExecOptions, IncusStreamExecSession } from './incus-client';
import type { DockerService } from './docker';
import type { ExecCaptureResult } from './workspace-probe';
import { createWebSocketStream } from 'ws';
import { randomUUID } from 'node:crypto';
import { getAppType, parseAppInstances, assertAppManageOk } from './apps';
import type { AppInstanceInfo, TmuxWindow } from '../../shared/types';

/** Same account -> environment -> worker precedence as entrypoint.sh, without
 * shell-evaluating user values. Exec does not inherit the worker service env. */
export const INCUS_EXEC_ENV_SCRIPT = String.raw`
import os,sys,json,base64
env=os.environ.copy()
bootstrap_tmux={key:env.get(key) for key in ('TMUX_TMPDIR','TMUX')}
environment=json.loads(env.get('ENVIRONMENT','{}'))
for line in environment.get('envVars','').splitlines():
 line=line.strip()
 if not line or line.startswith('#') or '=' not in line: continue
 key,value=line.split('=',1)
 if key in ('AGENTOR_RUNTIME_ROLE','AGENTOR_TRUSTED_RUNTIME_ROLE'): continue
 env[key]=value
for entry in json.loads(base64.b64decode(env.get('WORKER_LOCAL_ENV','W10='))):
 if entry['key'] not in ('AGENTOR_RUNTIME_ROLE','AGENTOR_TRUSTED_RUNTIME_ROLE'):
  env[entry['key']]=entry['value']
env['AGENTOR_RUNTIME_ROLE']='worker'
env['AGENTOR_TRUSTED_RUNTIME_ROLE']='worker'
for key,field in [('EXPOSE_PORT_MAPPINGS','portMappings'),('EXPOSE_DOMAIN_MAPPINGS','domainMappings'),('EXPOSE_USAGE','usage')]:
 env[key]='false' if environment.get('exposeApis',{}).get(field) is False else 'true'
env['DOCKER_ENABLED']='true' if environment.get('dockerEnabled',False) else 'false'
if sys.argv[1]=='bootstrap-tmux':
 for key,value in bootstrap_tmux.items():
  if value is None: env.pop(key,None)
  else: env[key]=value
os.execvpe(sys.argv[2],sys.argv[2:],env)
`;

export function incusWorkerCommand(command: string[], bootstrapTmux = false): string[] {
  return ['bash', '-ec',
    'test -f /run/agentor/provisioned; test -r /run/agentor/worker.env; set -a; . /run/agentor/worker.env; set +a; exec /usr/bin/python3 -c "$1" "${@:2}"',
    'agentor-worker-exec', INCUS_EXEC_ENV_SCRIPT, bootstrapTmux ? 'bootstrap-tmux' : 'worker', ...command];
}

/** Small structural file/command adapter, not a general runtime framework.
 * Its validator captures WorkerRecord ownership and VM UUID, including cleanup. */
export class IncusWorkerCommands {
  constructor(private client: IncusClient, private name: string, private handle: string,
    private validate: () => Promise<void>,
    private setup: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation()) {}

  async attachTerminal(windowIndex: number): Promise<{ stream: Duplex; resize: (cols: number, rows: number) => void; close: () => void }> {
    return this.setup(() => this.attachTerminalUnlocked(windowIndex));
  }

  private async attachTerminalUnlocked(windowIndex: number): Promise<{ stream: Duplex; resize: (cols: number, rows: number) => void; close: () => void }> {
    if (!Number.isInteger(windowIndex) || windowIndex < 0) throw new Error('Invalid tmux window index');
    await this.validate();
    const linked = `ws-${randomUUID()}`;
    let stream: Duplex | undefined;
    const session = await this.client.execInteractive(this.name, incusWorkerCommand(['sh', '-c',
      'tmux new-session -d -t =main -s "$1" && { tmux select-window -t "$1:$2" 2>/dev/null || true; } && exec tmux attach-session -t "$1"',
      'agentor-terminal', linked, String(windowIndex)], true), {
      command: [], user: 1000, group: 1000, cwd: '/workspace',
      environment: { HOME: '/home/agent', USER: 'agent', LOGNAME: 'agent', DISPLAY: ':99', TERM: 'xterm-256color',
        PATH: '/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    }, (socket) => { stream = createWebSocketStream(socket); stream.on('error', () => {}); });
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      session.close(); stream?.destroy();
      // The validator rejects after replacement, deletion, owner changes or
      // lifecycle admission. Never kill a session in a same-name replacement.
      void this.execTmux(this.handle, ['kill-session', '-t', linked]).catch(() => {});
    };
    try {
      await this.validate();
      if (!stream || stream.destroyed) throw new Error('Incus terminal closed during setup');
    }
    catch (error) { close(); throw error; }
    return { stream: stream!, resize: session.resize, close };
  }

  async open(command: string[], options: Omit<IncusInstanceExecOptions, 'command'> & { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<IncusStreamExecSession> {
    return this.setup(() => this.openUnlocked(command, options));
  }

  private async openUnlocked(command: string[], options: Omit<IncusInstanceExecOptions, 'command'> & { signal?: AbortSignal; timeoutMs?: number }, bootstrapTmux = false): Promise<IncusStreamExecSession> {
    await this.validate();
    const session = await this.client.execStream(this.name, incusWorkerCommand(command, bootstrapTmux), {
      command: [], user: 1000, group: 1000, cwd: '/workspace',
      environment: { HOME: '/home/agent', USER: 'agent', LOGNAME: 'agent', DISPLAY: ':99',
        TERM: 'xterm-256color', PATH: '/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
      ...options,
    });
    try { await this.validate(); return session; }
    catch (error) { session.close(); throw error; }
  }

  async openDuplex(command: string[], signal?: AbortSignal): Promise<{ stream: Duplex; stderr: Readable }> {
    const session = await this.open(command, { signal, timeoutMs: 24 * 60 * 60_000 });
    const output = new PassThrough();
    session.stdout.on('error', (error) => output.destroy(error));
    session.stdout.pipe(output, { end: false });
    // Preserve output until its authoritative operation has settled. Desktop
    // streams are long-lived; caller cancellation/disconnect closes control.
    void session.result.then(() => output.end()).catch((error) => output.destroy(error));
    const stream = new Duplex({
      read: () => output.resume(),
      write: (bytes, encoding, callback) => { session.stdin.write(bytes, encoding, callback); },
      final: (callback) => { session.stdin.end(callback); },
      destroy: (error, callback) => { session.close(); callback(error); },
    });
    output.on('data', (bytes: Buffer) => { if (!stream.push(bytes)) output.pause(); });
    output.on('end', () => stream.push(null));
    output.on('error', (error) => stream.destroy(error));
    stream.on('error', () => {});
    stream.once('close', () => session.close());
    return { stream, stderr: session.stderr };
  }

  private checkHandle(handle: string): void {
    if (handle !== this.handle) throw new Error('Incus command handle changed');
  }

  async execTmux(handle: string, args: string[]): Promise<void> {
    // Legacy tmux mutations intentionally allow missing-window no-ops.
    await this.capture(handle, ['tmux', ...args], {}, true);
  }

  async execListTmuxWindows(handle: string): Promise<TmuxWindow[]> {
    const result = await this.capture(handle, ['tmux', 'list-windows', '-t', '=main:', '-F', '#{window_index}:#{window_name}:#{window_active}'], {}, true);
    return result.stdout.toString().trim().split(/\r?\n/).filter(Boolean).map((line) => {
      const [index, name, active] = line.split(':');
      return { index: parseInt(index ?? '0', 10), name: name ?? '', active: active === '1' };
    });
  }

  private async appManage(handle: string, appTypeId: string, args: string[]): Promise<string> {
    const type = getAppType(appTypeId);
    if (!type) throw new Error('Unknown app type');
    const result = await this.execCapture(handle, [`/home/agent/apps/${type.manageScript}`, ...args]);
    return result.stdout.toString();
  }

  async listAppInstances(handle: string, type: string): Promise<AppInstanceInfo[]> {
    return parseAppInstances(await this.appManage(handle, type, ['list']), type);
  }

  async startAppInstance(handle: string, type: string, id: string, port: number, args: string[] = []): Promise<void> {
    assertAppManageOk(await this.appManage(handle, type, ['start', id, String(port), ...args]), `start ${type}/${id}`);
  }

  async stopAppInstance(handle: string, type: string, id: string): Promise<void> {
    assertAppManageOk(await this.appManage(handle, type, ['stop', id]), `stop ${type}/${id}`);
  }

  async execCapture(handle: string, command: string[], opts: Parameters<DockerService['execCapture']>[2] = {}): Promise<ExecCaptureResult> {
    return this.capture(handle, command, opts);
  }

  private async capture(handle: string, command: string[], opts: NonNullable<Parameters<DockerService['execCapture']>[2]>, bootstrapTmux = false): Promise<ExecCaptureResult> {
    this.checkHandle(handle);
    if (opts.user && !['agent', '1000', 'root', '0'].includes(opts.user)) throw new Error('Unsupported Incus exec user');
    const root = opts.user === 'root' || opts.user === '0';
    const session = await this.setup(() => this.openUnlocked(command, { user: root ? 0 : 1000, group: root ? 0 : 1000,
      ...(root ? { environment: { HOME: '/root', USER: 'root', LOGNAME: 'root', DISPLAY: ':99', PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' } } : {}),
      cwd: opts.workdir ?? '/workspace', signal: opts.signal, timeoutMs: opts.timeoutMs ?? 30_000 }, bootstrapTmux));
    const capture = async (stream: Readable) => {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error('Incus command output exceeded its limit');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    };
    try {
      session.stdin.end(opts.stdin);
      const [stdout, stderr, exitCode] = await Promise.all([capture(session.stdout), capture(session.stderr), session.result]);
      return { stdout, stderr, exitCode };
    } finally { session.close(); }
  }

  async getArchive(handle: string, path: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> {
    this.checkHandle(handle);
    if (!posix.isAbsolute(path) || path.includes('\0')) throw new Error('Invalid guest archive path');
    const session = await this.open(['tar', '--numeric-owner', '--xattrs', '--acls', '-cpf', '-',
      '-C', posix.dirname(path), '--', posix.basename(path)], { signal, timeoutMs: 10 * 60_000 });
    const out = new PassThrough();
    out.on('close', () => session.close());
    session.stderr.resume();
    session.stdout.on('error', (error) => out.destroy(error));
    session.stdout.pipe(out, { end: false });
    session.stdin.end();
    void session.result.then((code) => {
      if (code !== 0) throw new Error('Incus archive read failed');
      out.end();
    }).catch((error) => out.destroy(error));
    return out;
  }

  async putArchive(handle: string, source: Buffer | NodeJS.ReadableStream, path: string, signal?: AbortSignal): Promise<void> {
    this.checkHandle(handle);
    if (!posix.isAbsolute(path) || path.includes('\0')) throw new Error('Invalid guest archive path');
    const session = await this.open(['tar', '--no-same-owner', '-xpf', '-', '-C', path], { signal, timeoutMs: 10 * 60_000 });
    session.stdout.resume(); session.stderr.resume();
    try {
      const [, code] = await Promise.all([pipeline(Buffer.isBuffer(source) ? Readable.from([source]) : source as Readable, session.stdin), session.result]);
      if (code !== 0) throw new Error('Incus archive write failed');
    } finally { session.close(); }
  }

  putWorkspaceArchive(handle: string, source: Buffer): Promise<void> { return this.putArchive(handle, source, '/workspace'); }
  getWorkspaceArchive(handle: string, signal?: AbortSignal): Promise<NodeJS.ReadableStream> { return this.getArchive(handle, '/workspace', signal); }
}
