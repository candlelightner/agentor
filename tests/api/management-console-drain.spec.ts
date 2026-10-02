import { expect, test } from '@playwright/test';
import { Duplex } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ManagementConsoleStore } from '../../orchestrator/server/utils/management-console-store';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const restore: Array<() => void> = [];
  const patch = (target: any, name: string, value: any) => {
    const original = target[name]; target[name] = value; restore.push(() => { target[name] = original; });
  };
  const streams: Duplex[] = [], commands: any[] = [], failures: any[] = [];
  const worker = { id: 'worker', status: 'running', containerId: 'synthetic-container' };
  const controls = {
    destroy: async () => {},
    write: async (_chunk: Buffer) => {},
    attach: async (): Promise<any> => {
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, done) { controls.write(chunk).then(() => done(), done); },
        destroy(error, done) { controls.destroy().then(() => done(error), done); },
      });
      streams.push(stream);
      return { exec: {}, stream, tmuxSession: `synthetic-linked-${streams.length}` };
    },
    cleanup: async (cmd: string[]) => ({ stdout: Buffer.from(`${cmd.at(-1)}\n`), stderr: Buffer.alloc(0), exitCode: 0 }),
  };
  patch(ContainerManager.prototype, 'get', () => worker);
  patch(ContainerManager.prototype, 'reportRuntimeFailure', (...args: any[]) => { failures.push(args); });
  patch(DockerService.prototype, 'execAttachTmuxWindow', () => controls.attach());
  patch(DockerService.prototype, 'killTmuxSession', () => { throw new Error('Swallowing cleanup API must not be used'); });
  patch(DockerService.prototype, 'execCapture', async (container: string, cmd: string[], options: any) => {
    commands.push({ container, cmd, options }); return controls.cleanup(cmd);
  });
  const store = new ManagementConsoleStore();
  return {
    store, controls, streams, commands, failures, worker,
    shorten: () => {
      const original = globalThis.setTimeout;
      patch(globalThis, 'setTimeout', (callback: any, ms: number, ...args: any[]) => original(callback, ms === 15_000 || ms === 5_000 ? 40 : ms, ...args));
    },
    idle: () => {
      let fire!: () => void;
      const original = globalThis.setTimeout;
      patch(globalThis, 'setTimeout', (callback: any, ms: number, ...args: any[]) => {
        if (ms === 15 * 60_000) fire = callback;
        return original(callback, ms, ...args);
      });
      return () => fire();
    },
    isolated: () => {
      const isolated = new InstanceControlPlaneCoordinator();
      patch(gate, 'fork', () => isolated.fork());
      return isolated;
    },
    close: async () => {
      await store.closeAll();
      for (const stream of streams) stream.destroy();
      for (const undo of restore.reverse()) undo();
    },
  };
}

test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

for (const event of ['end', 'close', 'error', 'idle', 'sweep'] as const) {
  test(`console ${event} cleanup remains admitted after parent request retires`, async () => {
    const f = fixture(), cleanup = deferred(), cleaning = deferred();
    const idle = f.idle(); let nested = false;
    f.controls.cleanup = async cmd => {
      cleaning.resolve(); await cleanup.promise;
      await gate.run(() => { nested = true; });
      return { stdout: Buffer.from(`${cmd.at(-1)}\n`), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const opened = await gate.run(() => f.store.open('workspace', 'worker'));
    const barrier = gate.begin(`console-${event}`, 'snapshot');
    try {
      expect(() => barrier.assertDrained()).toThrow();
      if (event === 'end') f.streams[0].push(null);
      else if (event === 'close') f.streams[0].destroy();
      else if (event === 'error') f.streams[0].destroy(new Error('synthetic attach failure'));
      else if (event === 'idle') idle();
      else {
        (f.store as any).sessions.get(opened.id).touchedAt = 0;
        (f.store as any).sweep();
      }
      await cleaning.promise;
      expect(f.store.target('workspace', opened.id)).toBeUndefined();
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 });
      expect(nested).toBe(true); expect(f.commands).toHaveLength(1);
      expect(f.commands[0]).toMatchObject({ container: 'synthetic-container', options: { operationLabel: 'Docker management console cleanup' } });
      expect(f.commands[0].options).not.toHaveProperty('user');
    } finally { cleanup.resolve(); barrier.release(); await f.close(); }
  });
}

test('bounded explicit close includes asynchronous stream destruction and actual cleanup', async () => {
  const f = fixture(), destroyed = deferred(), cleanup = deferred(), cleaning = deferred(); f.shorten();
  f.controls.destroy = () => destroyed.promise;
  f.controls.cleanup = async cmd => { cleaning.resolve(); await cleanup.promise; return { stdout: Buffer.from(`${cmd.at(-1)}\n`), stderr: Buffer.alloc(0), exitCode: 0 }; };
  const opened = await f.store.open('workspace', 'worker');
  const call = f.store.close('workspace', opened.id);
  const barrier = gate.begin('console-close-late', 'snapshot');
  try {
    expect(await call).toMatchObject({ state: 'closed' });
    expect(f.commands).toHaveLength(0); expect(() => barrier.assertDrained()).toThrow();
    destroyed.resolve(); await cleaning.promise;
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { destroyed.resolve(); cleanup.resolve(); await call; barrier.release(); await f.close(); }
});

for (const notification of ['error', 'premature-close'] as const) {
  test(`standalone ${notification} cannot retire destruction before delayed _destroy callback`, async () => {
    const f = fixture(), destroyed = deferred(), destroying = deferred();
    let destructionComplete = false;
    f.controls.destroy = async () => {
      destroying.resolve(); await destroyed.promise; destructionComplete = true;
    };
    const opened = await f.store.open('workspace', 'worker');
    const barrier = gate.begin(`console-destroy-${notification}`, 'snapshot');
    try {
      // Unlike destroy(error), a standalone error event arrives before the
      // stream starts its asynchronous destruction. Likewise a premature close
      // notification alone is not evidence that Node has completed _destroy.
      if (notification === 'error') f.streams[0].emit('error', new Error('standalone source error'));
      else f.streams[0].emit('close');
      await destroying.promise;
      expect(f.store.target('workspace', opened.id)).toBeUndefined();
      expect(f.streams[0].destroyed).toBe(true);
      expect(f.streams[0].closed).toBe(false);
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(destructionComplete).toBe(false);
      expect(f.commands).toHaveLength(0);
      destroyed.resolve(); await barrier.drain({ timeoutMs: 1000 });
      expect(destructionComplete).toBe(true);
      expect(f.streams[0].closed).toBe(true);
      expect(f.commands).toHaveLength(1);
    } finally {
      destroyed.resolve();
      await barrier.drain({ timeoutMs: 1000 }); barrier.release(); await f.close();
    }
  });
}

test('late attach after caller timeout is never published and owns its eventual cleanup', async () => {
  const f = fixture(), attach = deferred(), attaching = deferred(), cleanup = deferred(), cleaning = deferred(); f.shorten();
  const originalAttach = f.controls.attach;
  f.controls.attach = async () => { attaching.resolve(); await attach.promise; return originalAttach(); };
  let nested = false;
  f.controls.cleanup = async cmd => {
    cleaning.resolve(); await cleanup.promise; await gate.run(() => { nested = true; });
    return { stdout: Buffer.from(`${cmd.at(-1)}\n`), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const call = f.store.open('workspace', 'worker').catch(error => error);
  await attaching.promise;
  const barrier = gate.begin('console-late-attach', 'snapshot');
  try {
    expect(await call).toMatchObject({ statusCode: 504 });
    expect(() => barrier.assertDrained()).toThrow();
    f.worker.containerId = 'replacement-must-not-be-cleaned';
    attach.resolve(); await cleaning.promise;
    expect((f.store as any).sessions.size).toBe(0);
    expect(f.streams[0].destroyed).toBe(true);
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(nested).toBe(true);
    expect(f.commands[0].container).toBe('synthetic-container');
  } finally { attach.resolve(); cleanup.resolve(); await call; barrier.release(); await f.close(); }
});

test('session lifetime does not authorize new public roots through a closed barrier', async () => {
  const f = fixture(), idle = f.idle();
  const opened = await f.store.open('workspace', 'worker');
  const barrier = gate.begin('console-no-bypass', 'snapshot');
  try {
    for (const call of [() => f.store.open('workspace', 'worker'), () => f.store.read('workspace', opened.id), () => f.store.close('workspace', opened.id)])
      await expect(call()).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(() => f.store.write('workspace', opened.id, 'text')).toThrow();
    expect(() => f.store.interrupt('workspace', opened.id)).toThrow();
    idle(); await barrier.drain({ timeoutMs: 1000 });
  } finally { barrier.release(); await f.close(); }
});

test('accepted input owns delayed write callback context independently of the request', async () => {
  const f = fixture(), write = deferred(), writing = deferred(); let nested = false;
  f.controls.write = async () => { writing.resolve(); await write.promise; await gate.run(() => { nested = true; }); };
  const opened = await f.store.open('workspace', 'worker');
  await gate.run(() => f.store.write('workspace', opened.id, 'text'));
  await writing.promise;
  const close = f.store.close('workspace', opened.id);
  const barrier = gate.begin('console-input-late', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    write.resolve(); await close; await barrier.drain({ timeoutMs: 1000 });
    expect(nested).toBe(true);
  } finally { write.resolve(); await close; barrier.release(); await f.close(); }
});

for (const failure of ['denial', 'missing-receipt', 'deadline'] as const) {
  test(`cleanup ${failure} retains a bounded-response fail-closed uncertainty hold`, async () => {
    const f = fixture(), settlement = deferred(); f.shorten(); const isolated = f.isolated();
    f.controls.cleanup = async () => {
      if (failure === 'denial') throw Object.assign(new Error('denied'), { statusCode: 403 });
      if (failure === 'deadline') throw Object.assign(new Error('bounded failure'), { [operationSettlement]: settlement.promise });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
    };
    const opened = await f.store.open('workspace', 'worker');
    try {
      expect(await f.store.close('workspace', opened.id)).toMatchObject({ state: 'closed' });
      settlement.resolve(); await delay(5);
      const barrier = isolated.begin(`console-uncertain-${failure}`, 'snapshot');
      try {
        expect(() => barrier.assertDrained()).toThrow();
        await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
        expect(f.commands).toHaveLength(1); expect(isolated.activeOperations).toBe(1);
      } finally { barrier.release(); }
    } finally { settlement.resolve(); await f.close(); }
  });
}

test('opaque attach rejection cannot claim that hidden exec/session resources were removed', async () => {
  const f = fixture(), settled = deferred(); const isolated = f.isolated();
  f.controls.attach = async () => { throw Object.assign(new Error('lost response'), { [operationSettlement]: settled.promise }); };
  try {
    await expect(f.store.open('workspace', 'worker')).rejects.toThrow('lost response');
    settled.resolve(); await delay(5);
    const barrier = isolated.begin('console-attach-uncertain', 'snapshot');
    try {
      expect(() => barrier.assertDrained()).toThrow();
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(f.commands).toHaveLength(0);
    } finally { barrier.release(); }
  } finally { settled.resolve(); await f.close(); }
});

test('uncertain and in-flight sessions consume the existing bounded session budget', async () => {
  const f = fixture(); const isolated = f.isolated(); let attempts = 0;
  f.controls.attach = async () => { attempts++; throw new Error('unknown attach state'); };
  try {
    for (let i = 0; i < 16; i++)
      await expect(f.store.open('workspace', 'worker')).rejects.toThrow('unknown attach state');
    await expect(f.store.open('workspace', 'worker')).rejects.toMatchObject({ statusCode: 429 });
    expect(attempts).toBe(16); expect(isolated.activeOperations).toBe(16);
  } finally { await f.close(); }
});

test('fixed cleanup script emits its exact receipt only after successful exact-name tmux kill', async () => {
  const f = fixture();
  try {
    const opened = await f.store.open('workspace', 'worker');
    await f.store.close('workspace', opened.id);
    const command = f.commands[0].cmd;
    expect(command.slice(0, 2)).toEqual(['python3', '-c']);
    expect(command).toHaveLength(5);
    for (const code of [0, 1, 126]) {
      // Execute only the fixed Python script locally, replacing subprocess.run
      // before execution. No Docker, real tmux command, or shell is launched.
      const harness = `import subprocess,sys\nfrom types import SimpleNamespace\ncode=int(sys.argv[1])\nscript=sys.argv[2]\nsys.argv=['cleanup','literal;$(unexecuted)','receipt']\ndef fake(argv,**kwargs):\n assert argv==['tmux','kill-session','-t','=literal;$(unexecuted)']\n return SimpleNamespace(returncode=code)\nsubprocess.run=fake\nexec(script)\n`;
      const result = spawnSync('python3', ['-c', harness, String(code), command[2]], { encoding: 'utf8', timeout: 1000 });
      expect(result.status).toBe(code);
      expect(result.stdout).toBe(code === 0 ? 'receipt\n' : '');
      expect(result.stderr).toBe('');
    }
  } finally { await f.close(); }
});
