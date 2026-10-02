import { expect, test } from '@playwright/test';
import { Duplex } from 'node:stream';
import { terminalWsHandler } from '../../orchestrator/server/utils/terminal-handler';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const restore: Array<() => void> = [];
  const patch = (target: any, name: string, value: any) => {
    const original = target[name];
    target[name] = value;
    restore.push(() => {
      target[name] = original;
    });
  };
  const streams: Duplex[] = [],
    commands: any[] = [],
    failures: any[] = [];
  const worker = {
    id: 'worker-1',
    status: 'running',
    containerId: 'synthetic-container',
    userId: 'owner',
  };
  const controls = {
    destroy: async () => {},
    write: async (_chunk: Buffer) => {},
    attach: async (): Promise<any> => {
      const stream = new Duplex({
        read() {},
        write(chunk, _encoding, done) {
          controls.write(chunk).then(() => done(), done);
        },
        destroy(error, done) {
          controls.destroy().then(() => done(error), done);
        },
      });
      streams.push(stream);
      return {
        exec: { id: 'synthetic-exec-id' },
        stream,
        tmuxSession: `synthetic-term-session-${streams.length}`,
      };
    },
    cleanup: async (cmd: string[]) => ({
      stdout: Buffer.from(`${cmd.at(-1)}\n`),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    }),
    resize: async () => {},
  };

  patch(terminalWsHandler, 'authenticate', async () => ({
    user: { id: 'owner', role: 'admin' },
    session: {},
  }));
  patch(ContainerManager.prototype, 'get', () => worker);
  patch(
    ContainerManager.prototype,
    'reportRuntimeFailure',
    (...args: any[]) => {
      failures.push(args);
    },
  );
  patch(DockerService.prototype, 'execAttachTmuxWindow', () =>
    controls.attach(),
  );
  patch(DockerService.prototype, 'killTmuxSession', () => {
    throw new Error('Swallowing cleanup API must not be used');
  });
  patch(
    DockerService.prototype,
    'execCapture',
    async (container: string, cmd: string[], options: any) => {
      commands.push({ container, cmd, options });
      return controls.cleanup(cmd);
    },
  );
  patch(DockerService.prototype, 'resizeExec', async (...args: any[]) =>
    controls.resize(),
  );

  function mockPeer(id = 'peer-1', url = '/ws/terminal/worker-1/0') {
    const sent: any[] = [];
    let closed = false;
    return {
      id,
      request: { url },
      send: (data: any) => {
        if (closed) throw new Error('Peer closed');
        sent.push(data);
      },
      close: () => {
        closed = true;
      },
      sent,
      get closed() {
        return closed;
      },
    };
  }

  return {
    controls,
    streams,
    commands,
    failures,
    worker,
    mockPeer,
    isolated: () => {
      const isolated = new InstanceControlPlaneCoordinator();
      patch(gate, 'fork', () => isolated.fork());
      return isolated;
    },
    shorten: () => {
      const original = globalThis.setTimeout;
      patch(globalThis, 'setTimeout', (callback: any, ms: number, ...args: any[]) =>
        original(callback, ms === 15_000 ? 25 : ms, ...args),
      );
    },
    authenticate: (value: any) => patch(terminalWsHandler, 'authenticate', value),
    close: async () => {
      for (const stream of streams) stream.destroy();
      for (const undo of restore.reverse()) undo();
    },
  };
}

test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('terminal session lifetime remains admitted and drains only after stream close and verified cleanup', async () => {
  const f = fixture(),
    cleanup = deferred(),
    cleaning = deferred();
  let nested = false;
  f.controls.cleanup = async (cmd) => {
    cleaning.resolve();
    await cleanup.promise;
    await gate.run(() => {
      nested = true;
    });
    return {
      stdout: Buffer.from(`${cmd.at(-1)}\n`),
      stderr: Buffer.alloc(0),
      exitCode: 0,
    };
  };

  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);

  // Wait for attach to complete and stream to be established
  await expect.poll(() => f.streams.length).toBe(1);
  const barrier = gate.begin('term-lifetime', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();

    // Close the terminal session
    terminalWsHandler.close(peer as any);
    await cleaning.promise;

    // While cleanup is in flight, barrier still cannot drain
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve();

    await barrier.drain({ timeoutMs: 1000 });
    expect(nested).toBe(true);
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toMatchObject({
      container: 'synthetic-container',
      options: { operationLabel: 'Docker terminal cleanup' },
    });
  } finally {
    cleanup.resolve();
    barrier.release();
    await f.close();
  }
});

test('swallowing killTmuxSession API is not used during terminal cleanup', async () => {
  const f = fixture();
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);

  await expect.poll(() => f.streams.length).toBe(1);
  terminalWsHandler.close(peer as any);

  await expect.poll(() => f.commands.length).toBe(1);
  expect(f.commands[0].cmd[2]).toContain('tmux');
  await f.close();
});

test('captured container ID is retained for cleanup even if worker lookup changes', async () => {
  const f = fixture();
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);

  await expect.poll(() => f.streams.length).toBe(1);

  // Change the live container ID on the worker record
  f.worker.containerId = 'different-replaced-container';

  terminalWsHandler.close(peer as any);

  await expect.poll(() => f.commands.length).toBe(1);
  // Must clean up the original captured container ID, NOT the replaced one
  expect(f.commands[0].container).toBe('synthetic-container');
  await f.close();
});

test('accepted input callback owns delayed write callback context independently', async () => {
  const f = fixture(),
    write = deferred(),
    writing = deferred();
  let nested = false;
  f.controls.write = async () => {
    writing.resolve();
    await write.promise;
    await gate.run(() => {
      nested = true;
    });
  };

  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);

  await expect.poll(() => f.streams.length).toBe(1);

  // Send keystrokes
  terminalWsHandler.message(peer as any, 'echo hello\n');
  await writing.promise;

  const barrier = gate.begin('term-input-late', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();

    write.resolve();
    terminalWsHandler.close(peer as any);

    await barrier.drain({ timeoutMs: 1000 });
    expect(nested).toBe(true);
  } finally {
    write.resolve();
    barrier.release();
    await f.close();
  }
});

test('cleanup failure or denial retains a fail-closed uncertainty hold', async () => {
  const f = fixture();
  const isolated = f.isolated();
  f.controls.cleanup = async () => {
    throw Object.assign(new Error('denied'), { statusCode: 403 });
  };

  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);

  await expect.poll(() => f.streams.length).toBe(1);
  const barrier = isolated.begin('term-uncertain', 'snapshot');
  try {
    terminalWsHandler.close(peer as any);

    await expect.poll(() => f.commands.length).toBe(1);
    // Drain must time out because uncertainty holds the process fail-closed
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({
      code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT',
    });
  } finally {
    barrier.release();
    await f.close();
  }
});

test('terminal connection attempt during active barrier is refused and closed cleanly', async () => {
  const f = fixture();
  const barrier = gate.begin('term-open-barrier', 'snapshot');
  try {
    const peer = f.mockPeer();
    terminalWsHandler.open(peer as any);

    expect(peer.closed).toBe(true);
    expect(peer.sent[0]).toContain(
      'Worker runtime is unavailable (maintenance in progress)',
    );
    expect(f.streams).toHaveLength(0);
  } finally {
    barrier.release();
    await f.close();
  }
});

test('resize message executes under coordinator admission', async () => {
  const f = fixture();
  let resized = false;
  f.controls.resize = async () => {
    resized = true;
  };

  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => f.streams.length).toBe(1);

  terminalWsHandler.message(
    peer as any,
    JSON.stringify({ type: 'resize', cols: 120, rows: 40 }),
  );
  await expect.poll(() => resized).toBe(true);

  terminalWsHandler.close(peer as any);
  await expect.poll(() => f.commands.length).toBe(1);
  await f.close();
});

test('attach result after caller timeout remains owned through actual stream closure and cleanup', async () => {
  const f = fixture(), attaching = deferred<any>(), destroying = deferred(), cleanup = deferred();
  const originalAttach = f.controls.attach;
  f.controls.attach = () => attaching.promise;
  f.controls.destroy = () => destroying.promise;
  const originalCleanup = f.controls.cleanup;
  f.controls.cleanup = async cmd => { await cleanup.promise; return originalCleanup(cmd); };
  f.shorten();
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => peer.closed).toBe(true);
  const barrier = gate.begin('terminal-late-attach', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    attaching.resolve(await originalAttach());
    await expect.poll(() => f.streams[0].destroyed).toBe(true);
    expect(f.streams[0].closed).toBe(false);
    expect(f.commands).toHaveLength(0);
    expect(() => barrier.assertDrained()).toThrow();
    destroying.resolve();
    await expect.poll(() => f.commands.length).toBe(1);
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.streams[0].closed).toBe(true);
  } finally {
    destroying.resolve(); cleanup.resolve(); barrier.release(); await f.close();
  }
});

for (const lateReject of [false, true]) {
  test(`unknown attach failure holds uncertainty through ${lateReject ? 'rejected' : 'resolved'} client settlement`, async () => {
    const f = fixture(), isolated = f.isolated(), settlement = deferred();
    f.controls.attach = async () => {
      throw Object.assign(new Error('ambiguous attach failure'), { [operationSettlement]: settlement.promise });
    };
    const peer = f.mockPeer();
    terminalWsHandler.open(peer as any);
    await expect.poll(() => peer.closed).toBe(true);
    const barrier = isolated.begin('terminal-unknown-attach', 'snapshot');
    try {
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      if (lateReject) settlement.reject(new Error('late transport denial'));
      else settlement.resolve();
      await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(isolated.activeOperations).toBe(1);
      expect(f.commands).toHaveLength(0);
    } finally { settlement.resolve(); barrier.release(); await f.close(); }
  });
}

test('peer closing during authentication never starts Docker attach', async () => {
  const f = fixture(), authenticated = deferred<any>();
  f.authenticate(() => authenticated.promise);
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  terminalWsHandler.close(peer as any);
  const barrier = gate.begin('terminal-auth-close', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    authenticated.resolve({ user: { id: 'owner', role: 'admin' }, session: {} });
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.streams).toHaveLength(0);
    expect(f.commands).toHaveLength(0);
  } finally { barrier.release(); await f.close(); }
});

test('close-only stream termination signals cleanup without waiting for peer disconnect', async () => {
  const f = fixture(), peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => f.streams.length).toBe(1);
  f.streams[0].destroy();
  await expect.poll(() => f.commands.length).toBe(1);
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(peer.closed).toBe(true);
  await f.close();
});

test('misleading close notification cannot settle asynchronous stream destruction', async () => {
  const f = fixture(), destroying = deferred(), peer = f.mockPeer();
  f.controls.destroy = () => destroying.promise;
  terminalWsHandler.open(peer as any);
  await expect.poll(() => f.streams.length).toBe(1);
  const barrier = gate.begin('terminal-false-close', 'snapshot');
  try {
    terminalWsHandler.close(peer as any);
    f.streams[0].emit('close');
    await expect.poll(() => f.streams[0].destroyed).toBe(true);
    expect(f.streams[0].closed).toBe(false);
    expect(f.commands).toHaveLength(0);
    expect(() => barrier.assertDrained()).toThrow();
    destroying.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.commands).toHaveLength(1);
  } finally { destroying.resolve(); barrier.release(); await f.close(); }
});

test('already closed returned stream is cleaned without missing its prior close event', async () => {
  const f = fixture(), originalAttach = f.controls.attach;
  f.controls.attach = async () => {
    const attached = await originalAttach();
    attached.stream.destroy();
    await new Promise<void>(resolve => attached.stream.once('close', resolve));
    return attached;
  };
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => f.commands.length).toBe(1);
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(peer.closed).toBe(true);
  await f.close();
});

test('abandoned late stream error is observed before asynchronous destruction', async () => {
  const f = fixture(), attaching = deferred<any>(), originalAttach = f.controls.attach;
  f.controls.attach = () => attaching.promise;
  f.shorten();
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => peer.closed).toBe(true);
  const attached = await originalAttach();
  f.controls.destroy = async () => { throw new Error('stream destruction error'); };
  attaching.resolve(attached);
  await expect.poll(() => f.commands.length).toBe(1);
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(attached.stream.closed).toBe(true);
  await f.close();
});

test('post-attach setup failure uses the same actual-closure cleanup owner', async () => {
  const f = fixture(), destroying = deferred(), originalAttach = f.controls.attach;
  f.controls.destroy = () => destroying.promise;
  f.controls.attach = async () => {
    const attached = await originalAttach();
    attached.exec = { get id() { throw new Error('setup failure after stream capture'); } };
    return attached;
  };
  const peer = f.mockPeer();
  terminalWsHandler.open(peer as any);
  await expect.poll(() => peer.closed).toBe(true);
  const barrier = gate.begin('terminal-setup-failure', 'snapshot');
  try {
    f.streams[0].emit('close');
    expect(f.streams[0].closed).toBe(false);
    expect(f.commands).toHaveLength(0);
    expect(() => barrier.assertDrained()).toThrow();
    destroying.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    expect(f.commands).toHaveLength(1);
  } finally { destroying.resolve(); barrier.release(); await f.close(); }
});

test('synchronous peer close callback cannot recreate a recursive cleanup context', async () => {
  const f = fixture(), peer = f.mockPeer();
  const close = peer.close;
  let closeCalls = 0;
  peer.close = () => { closeCalls++; close(); terminalWsHandler.close(peer as any); };
  terminalWsHandler.open(peer as any);
  await expect.poll(() => f.streams.length).toBe(1);
  terminalWsHandler.close(peer as any);
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(closeCalls).toBe(1);
  expect(f.commands).toHaveLength(1);
  await f.close();
});
