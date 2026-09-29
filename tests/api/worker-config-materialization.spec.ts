import { test, expect } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WorkerConfigStore, workerConfigHasUnappliedChanges } from '../../orchestrator/server/utils/worker-config-store';

(globalThis as any).useLogger = () => ({ error() {}, warn() {}, info() {}, debug() {} });
let root: string;
let store: WorkerConfigStore;
let priorKey: string | undefined;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentor-materialization-'));
  priorKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  process.env.WORKER_CONFIG_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  store = new WorkerConfigStore({ dataDir: root } as never);
});
test.afterEach(async () => {
  if (priorKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  else process.env.WORKER_CONFIG_ENCRYPTION_KEY = priorKey;
  await rm(root, { recursive: true, force: true });
});
const input = (value: string) => [
  { kind: 'variable' as const, key: 'COLOR', value },
  { kind: 'secret' as const, key: 'SYNTHETIC_SECRET', value: `secret-${value}` },
  { kind: 'secretFile' as const, key: 'SYNTHETIC_FILE', fileName: 'fixture.txt', value: `file-${value}` },
];

test('completion marks only captured entries applied and preserves newer desired edits on disk', async () => {
  await store.replace('owner', 'worker', input('old'));
  const receipt = await store.resolveForMaterialization('owner', 'worker');
  expect(receipt.values).toEqual(input('old'));
  await store.replace('owner', 'worker', input('new'));
  await receipt.markApplied();
  expect(await store.resolveValues('owner', 'worker')).toEqual(input('new'));
  expect(await store.resolveAppliedValues('owner', 'worker')).toEqual(input('old'));
  const disk = await readFile(join(root, 'users', 'owner', 'worker-configurations.json'), 'utf8');
  expect(disk).not.toContain('secret-old'); expect(disk).not.toContain('file-old');
  const reopened = new WorkerConfigStore({ dataDir: root } as never);
  expect(await reopened.resolveAppliedValues('owner', 'worker')).toEqual(input('old'));
  expect(await reopened.resolveValues('owner', 'worker')).toEqual(input('new'));
});

test('empty captured configuration does not mark subsequently added entries applied', async () => {
  const receipt = await store.resolveForMaterialization('owner', 'worker');
  expect(receipt.values).toEqual([]);
  await store.replace('owner', 'worker', input('later'));
  await receipt.markApplied();
  expect(await store.resolveAppliedValues('owner', 'worker')).toEqual([]);
  expect(await store.resolveValues('owner', 'worker')).toEqual(input('later'));
});

test('newer materialization invalidates earlier receipts and completion is one-shot', async () => {
  await store.replace('owner', 'worker', input('old'));
  const old = await store.resolveForMaterialization('owner', 'worker');
  await store.replace('owner', 'worker', input('new'));
  const next = await store.resolveForMaterialization('owner', 'worker');
  await expect(old.markApplied()).rejects.toThrow('stale');
  await next.markApplied();
  await expect(next.markApplied()).rejects.toThrow('stale');
  expect(await store.resolveAppliedValues('owner', 'worker')).toEqual(input('new'));
});

test('worker configuration removal invalidates receipts without resurrecting records', async () => {
  await store.replace('owner', 'worker', input('old'));
  const receipt = await store.resolveForMaterialization('owner', 'worker');
  await store.remove('owner', 'worker');
  await expect(receipt.markApplied()).rejects.toThrow('stale');
  expect(await store.get('owner', 'worker')).toBeUndefined();
});

test('returned values are immutable and receipts remain bound to the exact worker', async () => {
  await store.replace('owner', 'worker', input('one'));
  await store.replace('owner', 'sibling', input('two'));
  const receipt = await store.resolveForMaterialization('owner', 'worker');
  expect(Object.isFrozen(receipt.values)).toBe(true);
  expect(Object.isFrozen(receipt.values[0])).toBe(true);
  await receipt.markApplied();
  expect(await store.resolveAppliedValues('owner', 'sibling')).toEqual([]);
});

test('failed applied-snapshot persistence does not publish or permit receipt reuse', async () => {
  await store.replace('owner', 'worker', input('old'));
  const receipt = await store.resolveForMaterialization('owner', 'worker');
  (store as any).persist = async () => { throw new Error('injected persistence failure'); };
  await expect(receipt.markApplied()).rejects.toThrow('injected persistence failure');
  await expect(receipt.markApplied()).rejects.toThrow('stale');
  expect(await store.resolveAppliedValues('owner', 'worker')).toEqual([]);
});

for (const initiallyEmpty of [false, true]) {
  test(`equal timestamps never hide different desired/applied entries (initiallyEmpty=${initiallyEmpty})`, async () => {
    if (!initiallyEmpty) await store.replace('owner', 'worker', input('old'));
    const receipt = await store.resolveForMaterialization('owner', 'worker');
    await store.replace('owner', 'worker', input('new'));
    await receipt.markApplied();
    const record = (await store.get('owner', 'worker'))!;
    // This is a legal persisted state when two writes share a millisecond.
    record.appliedAt = record.updatedAt;
    expect(workerConfigHasUnappliedChanges(record)).toBe(true);
    const current = await store.resolveForMaterialization('owner', 'worker');
    await current.markApplied();
    expect(workerConfigHasUnappliedChanges(await store.get('owner', 'worker'))).toBe(false);
  });
}
