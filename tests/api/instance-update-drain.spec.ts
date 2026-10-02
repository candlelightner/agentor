import { expect, test } from '@playwright/test';
import { UpdateChecker } from '../../orchestrator/server/utils/update-checker';
import { attachSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, error() {}, debug() {} });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

function checker(docker: any = {}) {
  const instance = new UpdateChecker({
    workerImagePrefix: 'ghcr.io/offline-fixture/',
    orchestratorImage: 'orchestrator:latest', workerImage: 'worker:latest',
    traefikImage: 'traefik:v3', baseDomains: [],
  } as any, docker);
  (instance as any).status = {
    orchestrator: null, worker: { updateAvailable: true }, traefik: null,
    isProductionMode: true,
  };
  return instance;
}

test.afterEach(async () => {
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('caught update pull failure retains late rejected settlement until drain', async () => {
  const held = deferred(), instance = checker();
  const error = attachSettlement(new Error('Synthetic pull timeout'), held.promise);
  (instance as any).pullImage = async () => { throw error; };
  const result = await instance.applyUpdates(['worker']);
  const barrier = gate.begin('caught-update-timeout', 'snapshot');
  try {
    expect(result.errors).toEqual(['Worker pull failed: Synthetic pull timeout']);
    expect(() => barrier.assertDrained()).toThrow();
    expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    held.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    held.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    barrier.release();
  }
});

test('escaped prune failure preserves checker busy observation through exposed settlement', async () => {
  const held = deferred();
  const error = attachSettlement(new Error('Synthetic prune timeout'), held.promise);
  const instance = checker({ pruneImages: async () => { throw error; } });
  await expect(instance.pruneImages()).rejects.toThrow('Synthetic prune timeout');
  const barrier = gate.begin('escaped-prune-timeout', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow();
    expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    held.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(false);
  } finally {
    held.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    barrier.release();
  }
});

test('direct public pull cannot start a Docker mutation during the instance barrier', async () => {
  let pulls = 0;
  const instance = checker({
    pull: async () => { pulls++; return {}; },
    modem: { followProgress: (_stream: unknown, complete: (error: null) => void) => complete(null) },
  });
  const barrier = gate.begin('direct-update-pull', 'snapshot');
  try {
    await expect(instance.pullImage('offline-fixture:latest')).rejects.toMatchObject({
      code: 'INSTANCE_CONTROL_PLANE_BARRIER_ACTIVE',
    });
    expect(pulls).toBe(0);
    barrier.assertDrained();
  } finally {
    barrier.release();
  }
});

test('uncertain leftover deletion stops replacement creation and retains its settlement', async () => {
  const held = deferred(), originalHostname = process.env.HOSTNAME; let creates = 0;
  process.env.HOSTNAME = 'synthetic-update-checker';
  const error = attachSettlement(new Error('Synthetic leftover deletion timeout'), held.promise);
  const instance = checker({
    getContainer: () => ({
      inspect: async () => ({ Name: '/synthetic-update-checker', Config: {}, HostConfig: {} }),
      remove: async () => { throw error; },
    }),
    createContainer: async () => { creates++; throw new Error('Must not create during deletion'); },
  });
  try {
    await expect(instance.recreateOrchestrator()).rejects.toThrow('Synthetic leftover deletion timeout');
    const barrier = gate.begin('update-leftover-delete', 'snapshot');
    try {
      expect(creates).toBe(0); expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(true);
      expect(() => barrier.assertDrained()).toThrow(); held.resolve();
      await barrier.drain({ timeoutMs: 1000 });
      expect(instance.hasActiveOperationsForInstanceSnapshot()).toBe(false);
    } finally { held.resolve(); await barrier.drain({ timeoutMs: 1000 }); barrier.release(); }
  } finally {
    held.resolve();
    if (originalHostname === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = originalHostname;
  }
});
