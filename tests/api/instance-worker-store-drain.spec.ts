import { expect, test } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerDurableStore } from '../../orchestrator/server/utils/worker-durable-store';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';

type Record = { id: string; userId: string; value: number };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
class Store extends WorkerDurableStore<Record> {
  beforePersist: (userId: string) => Promise<void> = async () => {};
  put(value: Record) {
    return this.transaction(value.userId, draft => {
      draft.set(value.id, value); return { result: value, persist: true };
    });
  }
  protected override async persistUser(userId: string) {
    await this.beforePersist(userId); await super.persistUser(userId);
  }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-worker-drain-'));
  const store = new Store(directory, value => value.id); await store.init();
  return { directory, store, close: () => rm(directory, { recursive: true, force: true }) };
}
test.afterEach(async () => {
  expect(gate.barrierActive).toBe(false);
  await expect.poll(() => gate.activeOperations).toBe(0);
});

test('worker store rejects new mutation, reload and init before queue or draft changes', async () => {
  const f = await fixture(); const initial = { id: 'worker', userId: 'owner', value: 1 };
  await f.store.put(initial); let writes = 0;
  f.store.beforePersist = async () => { writes++; };
  const barrier = gate.begin('worker-store-closed', 'snapshot');
  try {
    for (const operation of [
      () => f.store.put({ ...initial, value: 2 }),
      () => f.store.removeForUser('owner'),
      () => f.store.loadUser('owner'),
      () => f.store.init(),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
    expect(writes).toBe(0); expect(f.store.get('owner', 'worker')).toEqual(initial);
    expect((f.store as any).candidates.size).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); await f.close(); }
});

test('queued worker commits and tombstone remain admitted through the closed barrier', async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let writes = 0;
  f.store.beforePersist = async () => {
    if (++writes === 1) { entered.resolve(); await release.promise; }
    await gate.run(() => {});
  };
  const first = f.store.put({ id: 'worker', userId: 'owner', value: 1 });
  await entered.promise;
  const second = f.store.put({ id: 'worker', userId: 'owner', value: 2 });
  const removed = f.store.removeForUser('owner');
  const barrier = gate.begin('worker-store-queued', 'snapshot');
  try {
    expect(f.store.get('owner', 'worker')).toBeUndefined();
    await expect(barrier.drain({ timeoutMs: 20 })).rejects.toMatchObject({ code: 'INSTANCE_CONTROL_PLANE_DRAIN_TIMEOUT' });
    release.resolve(); await Promise.all([first, second]); expect(await removed).toBe(1);
    await barrier.drain({ timeoutMs: 1000 }); expect(writes).toBe(3);
    expect(JSON.parse(await readFile(join(f.directory, 'users/owner/workers.json'), 'utf8'))).toEqual([]);
  } finally { release.resolve(); await Promise.allSettled([first, second, removed]); barrier.release(); await f.close(); }
});

test('a pending owner does not delay another owner and failure preserves quarantine', async () => {
  const f = await fixture(), entered = deferred(), release = deferred();
  f.store.beforePersist = async owner => {
    if (owner === 'held') { entered.resolve(); await release.promise; throw new Error('fsync failed'); }
  };
  const first = f.store.put({ id: 'worker', userId: 'held', value: 1 });
  const failed = expect(first).rejects.toMatchObject({ code: 'WORKER_RECORD_STORE_UNAVAILABLE' });
  await entered.promise;
  await f.store.put({ id: 'other', userId: 'sibling', value: 2 });
  const barrier = gate.begin('worker-store-failure', 'snapshot');
  try {
    expect(f.store.get('sibling', 'other')?.value).toBe(2); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await failed; await barrier.drain({ timeoutMs: 1000 });
    // Draining a rejected transaction never clears its separate durable-store
    // uncertainty check. Snapshot preflight must still reject this quarantine.
    expect(f.store.hasUnavailableOwners()).toBe(true);
    expect(() => f.store.get('held', 'worker')).toThrow('Worker record store is unavailable');
  } finally { release.resolve(); await failed; barrier.release(); await f.close(); }
});
