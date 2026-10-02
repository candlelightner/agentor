import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { OfflineWorkspaceAccess } from '../../orchestrator/server/utils/workspace-access';
import { DockerService } from '../../orchestrator/server/utils/docker';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { isOperationHelperActive } from '../../orchestrator/server/utils/operation-helper-registry';
import { InstanceControlPlaneCoordinator } from '../../orchestrator/server/utils/instance-control-plane-coordinator';
import { withOperationDeadline, operationSettlement, type OperationFailureWithSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const Docker = require('dockerode');
const tar = require('tar-stream');
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  const restore: Array<() => void> = [];
  const patch = (target: any, key: string, value: any) => {
    const old = target[key]; target[key] = value; restore.push(() => { target[key] = old; });
  };
  const source = new PassThrough();
  const creates: any[] = [], removes: string[] = [];
  const helper = { id: 'synthetic-helper', start: async () => {} };
  const controls = {
    create: async (_options: any): Promise<any> => helper,
    remove: async (_id: string): Promise<void> => {},
    image: async () => ({ Id: 'sha256:synthetic-approved-image' }),
    putArchive: async (): Promise<void> => {},
    getArchive: async (): Promise<any> => source,
  };
  patch(Docker.prototype, 'getImage', () => ({ inspect: () => controls.image() }));
  patch(Docker.prototype, 'getVolume', () => ({ inspect: async () => ({}) }));
  patch(Docker.prototype, 'createContainer', (options: any) => {
    creates.push(options); return controls.create(options);
  });
  patch(Docker.prototype, 'getContainer', (id: string) => ({
    ...helper, id,
    remove: () => { removes.push(id); return controls.remove(id); },
  }));
  patch(DockerService.prototype, 'ensureImage', async () => {});
  patch(DockerService.prototype, 'execCapture', async () => ({
    stdout: Buffer.from(JSON.stringify({ ok: true, entries: [], entry: {
      name: 'test.txt', path: 'test.txt', type: 'file', size: 3,
      mtime: '2026-01-01T00:00:00Z', mode: '0644', owner: '1000', group: '1000',
    } })), stderr: Buffer.alloc(0), exitCode: 0,
  }));
  patch(DockerService.prototype, 'getArchive', () => controls.getArchive());
  patch(DockerService.prototype, 'putArchive', () => controls.putArchive());
  const access = new OfflineWorkspaceAccess({
    id: 'synthetic-workspace', userId: 'synthetic-user-' + randomUUID(), displayName: 'test',
    backend: 'volume', state: 'stopped', size: null, storageRef: 'synthetic-volume',
  });
  return {
    access, controls, source, helper, creates, removes,
    active: () => creates.some(options => isOperationHelperActive(options.Labels['agentor.helper.operation-id'])),
    shortDeadlines: () => {
      const original = globalThis.setTimeout;
      patch(globalThis, 'setTimeout', (callback: any, ms: number, ...args: any[]) =>
        original(callback, ms === 8_000 ? 40 : ms, ...args));
    },
    inactivity: () => {
      let expire!: () => void;
      const original = globalThis.setTimeout;
      patch(globalThis, 'setTimeout', (callback: any, ms: number, ...args: any[]) => {
        if (ms === 60_000) expire = callback;
        return original(callback, ms, ...args);
      });
      return () => expire();
    },
    end: () => {
      const packed = tar.pack(); packed.pipe(source);
      packed.entry({ name: 'test.txt' }, 'abc'); packed.finalize();
    },
    close: () => { source.destroy(); for (const undo of restore.reverse()) undo(); },
  };
}

test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

for (const event of ['end', 'disconnect', 'error', 'inactivity'] as const) {
  test(`offline download ${event} holds drain through actual helper removal`, async () => {
    const f = fixture(), removed = deferred(), removing = deferred();
    const expire = f.inactivity();
    const cancellation = new AbortController();
    f.controls.remove = async () => { removing.resolve(); await removed.promise; };
    const opened = await gate.run(() => f.access.download(['test.txt'], cancellation.signal));
    const barrier = gate.begin(`workspace-${event}`, 'snapshot');
    try {
      expect(gate.activeOperations).toBeGreaterThan(0);
      expect(opened.stream.readableFlowing).not.toBe(true);
      expect(f.active()).toBe(true);
      const closed = new Promise<void>(resolve => opened.stream.once('close', resolve));
      opened.stream.on('error', () => {});
      if (event === 'end') { opened.stream.resume(); f.end(); }
      else if (event === 'disconnect') cancellation.abort();
      else if (event === 'error') f.source.destroy(new Error('synthetic source failure'));
      else expire();
      await closed; await removing.promise;
      // close/end/error may all fire; cleanup is still exactly one operation.
      expect(f.removes).toHaveLength(1);
      expect(() => barrier.assertDrained()).toThrow();
      expect(f.active()).toBe(true);
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      removed.resolve(); await barrier.drain({ timeoutMs: 1000 });
      expect(f.active()).toBe(false);
      expect(f.creates[0].HostConfig).toMatchObject({ NetworkMode: 'none', ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'] });
    } finally {
      removed.resolve(); opened.stream.destroy();
      await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
    }
  });
}

test('bounded close response does not release a late Docker remove or its helper ownership', async () => {
  const f = fixture(), removed = deferred(), removing = deferred(); f.shortDeadlines();
  f.controls.remove = async () => { removing.resolve(); await removed.promise; };
  const call = gate.run(() => f.access.list(''));
  await removing.promise;
  const barrier = gate.begin('workspace-late-remove', 'snapshot');
  try {
    expect(await call).toEqual({ path: '', entries: [] });
    expect(() => barrier.assertDrained()).toThrow(); expect(f.active()).toBe(true);
    expect(f.removes).toHaveLength(1);
    removed.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(f.active()).toBe(false);
  } finally { removed.resolve(); await call; await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close(); }
});

test('aborted creation retains late success and the subsequent deterministic-name cleanup', async () => {
    const f = fixture(), creation = deferred<any>(), creating = deferred(), removed = deferred(), removing = deferred();
    const cancellation = new AbortController(); f.shortDeadlines();
    f.controls.create = async () => { creating.resolve(); return creation.promise; };
    f.controls.remove = async () => {
      if (f.removes.length === 1) throw Object.assign(new Error('not present yet'), { statusCode: 404 });
      removing.resolve(); await removed.promise;
    };
    const call = gate.run(() => f.access.download(['test.txt'], cancellation.signal)).catch(error => error);
    await creating.promise; cancellation.abort();
    const barrier = gate.begin('workspace-create-resolve', 'snapshot');
    try {
      expect(await call).toMatchObject({ code: 'OPERATION_ABORTED' });
      expect(() => barrier.assertDrained()).toThrow(); expect(f.active()).toBe(true);
      creation.resolve(f.helper);
      await removing.promise;
      expect(f.removes).toEqual([f.creates[0].name, f.creates[0].name]);
      expect(() => barrier.assertDrained()).toThrow();
      // Both cleanup caller deadlines may expire; actual removal still owns drain.
      await delay(70); expect(() => barrier.assertDrained()).toThrow();
      removed.resolve(); await barrier.drain({ timeoutMs: 1000 }); expect(f.active()).toBe(false);
    } finally {
      creation.resolve(f.helper); removed.resolve(); await call;
      await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
    }
});

test('new offline helper creation is rejected before Docker when drain admission is closed', async () => {
  const f = fixture(), barrier = gate.begin('workspace-reject-new', 'snapshot');
  try {
    await expect(f.access.list('')).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
    expect(f.creates).toHaveLength(0); barrier.assertDrained();
  } finally { barrier.release(); f.close(); }
});

for (const lateReject of [false, true]) test(`ambiguous create remains held after client settlement and absent-name cleanup (late rejection=${lateReject})`, async () => {
  const f = fixture(), creation = deferred<any>(), creating = deferred(); f.shortDeadlines();
  const isolated = new InstanceControlPlaneCoordinator(), originalFork = gate.fork;
  gate.fork = () => isolated.fork();
  const reset = Object.assign(new Error('synthetic lost create response'), { code: 'ECONNRESET' });
  const cancellation = new AbortController();
  f.controls.create = async () => {
    creating.resolve();
    if (lateReject) return creation.promise;
    throw reset;
  };
  f.controls.remove = async () => { throw Object.assign(new Error('not published yet'), { statusCode: 404 }); };
  const call = f.access.download(['test.txt'], cancellation.signal).catch(error => error);
  await creating.promise;
  if (lateReject) cancellation.abort();
  try {
    const failure = await call;
    expect(failure).toMatchObject({ code: lateReject ? 'OPERATION_ABORTED' : 'ECONNRESET' });
    if (lateReject) {
      creation.reject(reset);
      await (failure as OperationFailureWithSettlement)[operationSettlement];
      await expect.poll(() => f.removes.length).toBe(2);
    }
    const barrier = isolated.begin('ambiguous-create-held', 'snapshot');
    try {
      expect(f.active()).toBe(true); expect(isolated.activeOperations).toBe(1);
      // Daemon work is deliberately unknown even after all client requests
      // settled and every lookup returned404. There is no fake release API.
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(() => barrier.assertDrained()).toThrow();
      expect(f.creates).toHaveLength(1);
      expect(f.removes).toHaveLength(lateReject ? 2 : 1);
    } finally { barrier.release(); }
  } finally {
    if (lateReject) creation.reject(reset);
    await call; gate.fork = originalFork; f.close();
  }
});

for (const rejects of [false, true]) test(`caught clone deadline retains target extraction and awaited helper cleanup (late rejection=${rejects})`, async () => {
  const f = fixture(), extraction = deferred(), extracting = deferred(), cleanup = deferred(), cleaning = deferred();
  const cancellation = new AbortController(); f.shortDeadlines();
  let completed = false;
  f.controls.putArchive = () => withOperationDeadline(async () => {
    extracting.resolve(); await extraction.promise;
    completed = true;
    if (rejects) throw new Error('late extraction rejection');
  }, 1000, 'Synthetic target extraction', cancellation.signal);
  f.controls.remove = async () => { cleaning.resolve(); await cleanup.promise; };
  const call = gate.run(async () => {
    try { await f.access.cloneInto('synthetic-target'); }
    catch (error) { return error; }
  });
  await extracting.promise; cancellation.abort();
  const failure = await call;
  expect(failure).toMatchObject({ code: 'OPERATION_ABORTED' });
  const barrier = gate.begin('clone-settlement', 'snapshot');
  try {
    expect(completed).toBe(false); expect(f.removes).toHaveLength(0);
    expect(() => barrier.assertDrained()).toThrow(); expect(f.active()).toBe(true);
    extraction.resolve(); await cleaning.promise;
    expect(completed).toBe(true); expect(f.removes).toEqual([f.helper.id]);
    // Actual target settlement does not by itself release source cleanup.
    expect(() => barrier.assertDrained()).toThrow();
    cleanup.resolve(); await barrier.drain({ timeoutMs: 1000 });
    expect(f.active()).toBe(false);
  } finally {
    extraction.resolve(); cleanup.resolve(); await call;
    await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
  }
});

test('caught archive-preparation failure retains service settlement before helper cleanup', async () => {
  const f = fixture(), archive = deferred<any>(), opening = deferred(), cancellation = new AbortController();
  f.shortDeadlines();
  f.controls.getArchive = () => withOperationDeadline(async () => {
    opening.resolve(); return archive.promise;
  }, 1000, 'Synthetic archive preparation', cancellation.signal);
  const call = gate.run(async () => {
    try { await f.access.download(['test.txt']); }
    catch (error) { return error; }
  });
  await opening.promise; cancellation.abort();
  expect(await call).toMatchObject({ code: 'OPERATION_ABORTED' });
  const barrier = gate.begin('archive-preparation', 'snapshot');
  try {
    expect(f.removes).toHaveLength(0); expect(() => barrier.assertDrained()).toThrow();
    archive.reject(new Error('late archive setup failure'));
    await barrier.drain({ timeoutMs: 1000 }); expect(f.removes).toEqual([f.helper.id]);
  } finally {
    archive.resolve(f.source); await call;
    await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
  }
});

test('late helper start settlement cannot escape its final cleanup', async () => {
  const f = fixture(), started = deferred(), starting = deferred(), removed = deferred(), removing = deferred();
  const cancellation = new AbortController(); f.shortDeadlines();
  f.helper.start = async () => { starting.resolve(); await started.promise; };
  f.controls.remove = async () => {
    if (f.removes.length === 1) return;
    removing.resolve(); await removed.promise;
  };
  const call = gate.run(() => f.access.download(['test.txt'], cancellation.signal)).catch(error => error);
  await starting.promise; cancellation.abort();
  const barrier = gate.begin('workspace-start-late', 'snapshot');
  try {
    expect(await call).toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(() => barrier.assertDrained()).toThrow();
    started.resolve(); await removing.promise;
    expect(f.removes).toEqual([f.helper.id, f.helper.id]);
    expect(() => barrier.assertDrained()).toThrow();
    removed.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally {
    started.resolve(); removed.resolve(); await call;
    await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
  }
});

test('known cgroup fallback retains unchanged isolation and accounts late fallback creation cleanup', async () => {
  const f = fixture(), creation = deferred<any>(), creating = deferred(), removed = deferred(), removing = deferred();
  const cancellation = new AbortController(); f.shortDeadlines();
  f.helper.start = async () => { throw new Error('cannot enter cgroupv2 in threaded mode'); };
  f.controls.create = async () => {
    if (f.creates.length === 1) return f.helper;
    creating.resolve(); return creation.promise;
  };
  f.controls.remove = async () => {
    if (f.removes.length < 3) return;
    removing.resolve(); await removed.promise;
  };
  const call = gate.run(() => f.access.download(['test.txt'], cancellation.signal)).catch(error => error);
  await creating.promise; cancellation.abort();
  const barrier = gate.begin('workspace-fallback-late', 'snapshot');
  try {
    expect(await call).toMatchObject({ code: 'OPERATION_ABORTED' });
    expect(() => barrier.assertDrained()).toThrow();
    expect(f.creates).toHaveLength(2);
    const { PidsLimit, Memory, NanoCpus, ...isolation } = f.creates[0].HostConfig;
    expect(f.creates[1].HostConfig).toEqual(isolation);
    creation.resolve({ id: 'synthetic-fallback' }); await removing.promise;
    expect(f.removes).toEqual([f.helper.id, f.creates[1].name, f.creates[1].name]);
    expect(() => barrier.assertDrained()).toThrow();
    removed.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally {
    creation.resolve({ id: 'synthetic-fallback' }); removed.resolve(); await call;
    await barrier.drain({ timeoutMs: 1000 }); barrier.release(); f.close();
  }
});

test('startup inspection failure retires its pre-registered helper drain lease', async () => {
  const f = fixture();
  f.controls.image = async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); };
  try {
    await expect(f.access.list('')).rejects.toMatchObject({ statusCode: 403 });
    expect(f.creates).toHaveLength(0); expect(gate.activeOperations).toBe(0);
  } finally { f.close(); }
});

test('denied failed-start cleanup stops without fallback or a second cleanup attempt', async () => {
  const f = fixture(); f.shortDeadlines();
  // An intentional unreconciled hold must not poison the shared test process's
  // singleton. The real helper owns this isolated coordinator, with no fake
  // successful cleanup or production release bypass.
  const isolated = new InstanceControlPlaneCoordinator(), originalFork = gate.fork;
  gate.fork = () => isolated.fork();
  f.helper.start = async () => { throw new Error('cannot enter cgroupv2 in threaded mode'); };
  f.controls.remove = async () => { throw Object.assign(new Error('denied'), { statusCode: 403 }); };
  try {
    await expect(f.access.list('')).rejects.toThrow('threaded');
    expect(f.creates).toHaveLength(1); expect(f.removes).toHaveLength(1);
    const barrier = isolated.begin('workspace-unreconciled', 'snapshot');
    try {
      expect(f.active()).toBe(true); expect(() => barrier.assertDrained()).toThrow();
      await expect(barrier.drain({ timeoutMs: 10 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
      expect(isolated.activeOperations).toBe(1);
    } finally { barrier.release(); }
  } finally { gate.fork = originalFork; f.close(); }
});
