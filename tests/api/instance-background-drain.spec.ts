import { expect, test } from '@playwright/test';
import { UsageChecker } from '../../orchestrator/server/utils/usage-checker';
import { OrphanSweeper } from '../../orchestrator/server/utils/orphan-sweeper';
import { UpdateChecker } from '../../orchestrator/server/utils/update-checker';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('queued usage work registers before dispatch and finishes nested credential writes during drain', async () => {
  const checker = new UsageChecker({} as any), first = deferred(), second = deferred(), entered = deferred();
  let writes = 0;
  const one = (checker as any).enqueueFetch(() => first.promise);
  const two = (checker as any).enqueueFetch(async () => {
    entered.resolve(); await second.promise;
    await gate.run(() => { writes++; });
  });
  const barrier = gate.begin('usage', 'snapshot');
  try {
    expect(gate.activeOperations).toBe(2);
    await (checker as any).enqueueFetch(() => { throw new Error('New fetch must not run'); });
    expect(gate.activeOperations).toBe(2); first.resolve(); await one; await entered.promise;
    expect(() => barrier.assertDrained()).toThrow(); second.resolve(); await two;
    await barrier.drain({ timeoutMs: 1000 }); expect(writes).toBe(1);
    expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { first.resolve(); second.resolve(); await Promise.all([one, two]); barrier.release(); }
});

test('a caught usage failure settles its enrolled queue without dropping another queued writer', async () => {
  const checker = new UsageChecker({} as any), held = deferred();
  const one = (checker as any).enqueueFetch(async () => { throw new Error('Expected fetch failure'); });
  const two = (checker as any).enqueueFetch(() => held.promise);
  const barrier = gate.begin('usage-error', 'snapshot');
  try {
    await one; expect(() => barrier.assertDrained()).toThrow();
    held.resolve(); await two; await barrier.drain({ timeoutMs: 1000 });
  } finally { held.resolve(); await Promise.all([one, two]); barrier.release(); }
});

test('orphan sweep includes actual cleanup and rejects new background sweeps during drain', async () => {
  // No services/DB/Docker called: exercise the real public scheduling boundary
  // with an injected cleanup body and its nested included-state write.
  const sweeper = Object.create(OrphanSweeper.prototype) as OrphanSweeper;
  const held = deferred(); let sweeps = 0, cleaned = false;
  (sweeper as any).doSweep = async () => {
    sweeps++; await held.promise; await gate.run(() => { cleaned = true; });
  };
  const operation = sweeper.sweep(), barrier = gate.begin('orphans', 'snapshot');
  try {
    await sweeper.sweep(); expect(sweeps).toBe(1);
    expect(sweeper.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    expect(() => barrier.assertDrained()).toThrow(); held.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 }); expect(cleaned).toBe(true);
    expect(sweeper.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally { held.resolve(); await operation; barrier.release(); }
});

test('excluded job context grants no included-write bypass and can drain its accepting parent', async () => {
  const held = deferred(), entered = deferred(); let wait!: Promise<void>;
  let barrier!: ReturnType<typeof gate.begin>;
  const parent = gate.run(async () => {
    barrier = gate.begin('excluded-job', 'restore');
    wait = gate.withoutOperationContext(async () => {
      await expect(gate.run(() => { throw new Error('Unadmitted write ran'); }))
        .rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE' });
      entered.resolve(); await barrier.drain({ timeoutMs: 1000 });
    });
    await held.promise;
  });
  try {
    await entered.promise; expect(() => barrier.assertDrained()).toThrow();
    held.resolve(); await parent; await wait; barrier.assertDrained();
  } finally { held.resolve(); await parent; await wait; barrier.release(); }
});

test('active update image pull holds barrier drain and rejects new updates while barrier is active', async () => {
  const held = deferred(), entered = deferred();
  let pullStarted = false;
  const mockConfig: any = {
    workerImagePrefix: 'ghcr.io/test/',
    orchestratorImage: 'orchestrator:latest',
    workerImage: 'worker:latest',
    traefikImage: 'traefik:v3',
    baseDomains: [],
  };
  const mockDocker: any = {};
  const checker = new UpdateChecker(mockConfig, mockDocker);
  (checker as any).status = {
    orchestrator: null,
    worker: { name: 'ghcr.io/test/worker:latest', updateAvailable: true },
    traefik: null,
    isProductionMode: true,
  };
  (checker as any).pullImage = async () => {
    pullStarted = true;
    entered.resolve();
    await held.promise;
  };

  const updatePromise = checker.applyUpdates(['worker']);
  await entered.promise;
  expect(pullStarted).toBe(true);
  expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(true);

  const barrier = gate.begin('update-pull', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();

    await expect(checker.applyUpdates(['worker'])).rejects.toMatchObject({
      code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE',
    });
    await expect(checker.pruneImages()).rejects.toMatchObject({
      code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE',
    });

    held.resolve();
    const result = await updatePromise;
    expect(result.workerPulled).toBe(true);

    await barrier.drain({ timeoutMs: 1000 });
    expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    held.resolve();
    await updatePromise.catch(() => {});
    barrier.release();
  }
});

test('pending orchestrator self-replacement reserves drain and tracks swapper completion through exit status', async () => {
  const origHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'orchestrator-test';
  const swapperWaitDeferred = deferred();
  const mockSwapper = {
    start: async () => {},
    wait: async () => {
      await swapperWaitDeferred.promise;
      return { StatusCode: 0 };
    },
  };
  const mockContainer = {
    inspect: async () => ({
      Name: '/agentor-orchestrator',
      Config: { Env: [], Labels: {}, ExposedPorts: {} },
      HostConfig: {},
    }),
    remove: async () => {},
  };
  const mockDocker: any = {
    getContainer: () => mockContainer,
    createContainer: async (opts: any) => {
      if (opts.name?.endsWith('-swapper')) return mockSwapper;
      return { id: 'next-container-id' };
    },
  };
  const mockConfig: any = {
    workerImagePrefix: 'ghcr.io/test/',
    orchestratorImage: 'orchestrator:latest',
    workerImage: 'worker:latest',
    traefikImage: 'traefik:v3',
    baseDomains: [],
  };
  const checker = new UpdateChecker(mockConfig, mockDocker);

  const restartLease = gate.fork();
  const releaseRestart = checker.registerPendingRestart();
  expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(true);

  const barrier = gate.begin('pending-restart', 'snapshot');
  let restartFinished = false;
  try {
    expect(() => barrier.assertDrained()).toThrow();

    const restartPromise = restartLease.run(async () => {
      await checker.recreateOrchestrator();
    }).finally(() => {
      releaseRestart();
      restartFinished = true;
    });

    expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    expect(() => barrier.assertDrained()).toThrow();

    swapperWaitDeferred.resolve();
    await restartPromise;
    expect(restartFinished).toBe(true);

    await barrier.drain({ timeoutMs: 1000 });
    expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    swapperWaitDeferred.resolve();
    barrier.release();
    if (origHostname !== undefined) process.env.HOSTNAME = origHostname;
    else delete process.env.HOSTNAME;
  }
});

test('swapper failure rejects the replacement and settles the lease before drain', async () => {
  const origHostname = process.env.HOSTNAME;
  process.env.HOSTNAME = 'orchestrator-test';
  const mockSwapper = {
    start: async () => {},
    wait: async () => ({ StatusCode: 1 }),
  };
  const mockContainer = {
    inspect: async () => ({
      Name: '/agentor-orchestrator',
      Config: { Env: [], Labels: {}, ExposedPorts: {} },
      HostConfig: {},
    }),
    remove: async () => {},
  };
  const mockDocker: any = {
    getContainer: () => mockContainer,
    createContainer: async (opts: any) => {
      if (opts.name?.endsWith('-swapper')) return mockSwapper;
      return { id: 'next-container-id' };
    },
  };
  const mockConfig: any = {
    workerImagePrefix: 'ghcr.io/test/',
    orchestratorImage: 'orchestrator:latest',
    workerImage: 'worker:latest',
    traefikImage: 'traefik:v3',
    baseDomains: [],
  };
  const checker = new UpdateChecker(mockConfig, mockDocker);

  const restartLease = gate.fork();
  const releaseRestart = checker.registerPendingRestart();
  expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(true);

  const barrier = gate.begin('restart-fail', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();

    const restartPromise = restartLease.run(async () => {
      await checker.recreateOrchestrator();
    }).finally(() => {
      releaseRestart();
    });

    await expect(restartPromise).rejects.toMatchObject({
      code: 'UPDATE_SWAPPER_FAILED',
    });

    await barrier.drain({ timeoutMs: 1000 });
    expect(checker.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    barrier.release();
    if (origHostname !== undefined) process.env.HOSTNAME = origHostname;
    else delete process.env.HOSTNAME;
  }
});
