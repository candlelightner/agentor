import { test, expect } from '@playwright/test';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserScopedJsonStore } from '../../orchestrator/server/utils/user-scoped-store';
import { UserEnvVarStore } from '../../orchestrator/server/utils/user-env-store';
import { WorkerConfigStore } from '../../orchestrator/server/utils/worker-config-store';

const logger = { error() {}, warn() {}, info() {}, debug() {} };
(globalThis as any).useLogger = () => logger;

test('user-scoped stores own ingress and return detached snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-detached-store-'));
  class Store extends UserScopedJsonStore<
    string,
    { id: string; userId: string; nested: { value: string } }
  > {
    constructor() {
      super(root, 'records.json', (item) => item.id);
    }
    save(item: { id: string; userId: string; nested: { value: string } }) {
      return this.setItem(item.userId, item);
    }
  }

  try {
    const store = new Store();
    const input = {
      id: 'record-1',
      userId: 'owner-1',
      nested: { value: 'committed' },
    };
    await store.save(input);
    input.nested.value = 'mutated input';
    expect(store.get('owner-1', 'record-1')?.nested.value).toBe('committed');

    const fromGet = store.get('owner-1', 'record-1')!;
    fromGet.nested.value = 'mutated get';
    const fromList = store.listForUser('owner-1');
    fromList[0]!.nested.value = 'mutated list';
    const found = store.findWithOwner((item) => {
      item.nested.value = 'mutated predicate';
      return true;
    });
    found!.item.nested.value = 'mutated result';

    expect(store.get('owner-1', 'record-1')?.nested.value).toBe('committed');
    expect(
      JSON.parse(
        await readFile(join(root, 'users', 'owner-1', 'records.json'), 'utf8'),
      ),
    ).toEqual([
      { id: 'record-1', userId: 'owner-1', nested: { value: 'committed' } },
    ]);

    // A failed live reload must not expose the last in-memory snapshot through
    // global reads while the durable owner partition is quarantined.
    await writeFile(
      join(root, 'users', 'owner-1', 'records.json'),
      '[{"id":"record-1"',
    );
    await expect(store.loadUser('owner-1')).rejects.toBeTruthy();
    expect(store.list()).toEqual([]);
    expect(store.findWithOwner(() => true)).toBeUndefined();
    expect(() => store.get('owner-1', 'record-1')).toThrow(/unavailable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a key function failure quarantines the complete owner snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-keyfn-quarantine-'));
  const owner = 'owner-1';
  const path = join(root, 'users', owner, 'records.json');
  const source = JSON.stringify([{ id: 42, userId: owner }]);
  class Store extends UserScopedJsonStore<
    string,
    { id: unknown; userId: string }
  > {
    constructor() {
      super(root, 'records.json', (item) => {
        if (typeof item.id !== 'string') throw new Error('id must be text');
        return item.id;
      });
    }
    save(item: { id: unknown; userId: string }) {
      return this.setItem(item.userId, item);
    }
  }

  try {
    await mkdir(join(root, 'users', owner), { recursive: true });
    await writeFile(path, source);
    const store = new Store();
    await store.init();
    expect(() => store.listForUser(owner)).toThrow(/unavailable/);
    await expect(store.save({ id: 'replacement', userId: owner }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(path, 'utf8')).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('user env corruption is owner-local, fail-closed, and never overwritten', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-env-quarantine-'));
  const corruptOwner = 'owner-corrupt';
  const healthyOwner = 'owner-healthy';
  const corruptPath = join(root, 'users', corruptOwner, 'env-vars.json');
  const source = JSON.stringify({
    userId: 'another-owner',
    envVars: [{ key: 'TOKEN', value: 'preserve-me' }],
  });

  try {
    await mkdir(join(root, 'users', corruptOwner), { recursive: true });
    await mkdir(join(root, 'users', healthyOwner), { recursive: true });
    await writeFile(corruptPath, source);
    await writeFile(
      join(root, 'users', healthyOwner, 'env-vars.json'),
      JSON.stringify({
        userId: healthyOwner,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        envVars: [{ key: 'COLOR', value: 'blue' }],
      }),
    );
    const store = new UserEnvVarStore(root);
    await store.init();

    expect(store.getOrDefault(healthyOwner).envVars).toEqual([
      { key: 'COLOR', value: 'blue' },
    ]);
    expect(() => store.getOrDefault(corruptOwner)).toThrow(/unavailable/);
    await expect(
      store.upsert(corruptOwner, {
        envVars: [{ key: 'COLOR', value: 'red' }],
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(corruptPath, 'utf8')).toBe(source);

    // Explicit deleted-owner cleanup is the only operation allowed to discard
    // quarantined bytes.
    await store.delete(corruptOwner);
    await expect(access(corruptPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(store.getOrDefault(corruptOwner).envVars).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed persisted env rows quarantine instead of disappearing on save', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-env-row-quarantine-'));
  const owner = 'owner-1';
  const path = join(root, 'users', owner, 'env-vars.json');
  const source = JSON.stringify({
    userId: owner,
    envVars: [{ key: 'TOKEN' }],
  });
  try {
    await mkdir(join(root, 'users', owner), { recursive: true });
    await writeFile(path, source);
    const store = new UserEnvVarStore(root);
    await store.init();
    expect(() => store.getOrDefault(owner)).toThrow(/unavailable/);
    await expect(store.upsert(owner, { envVars: [] })).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(await readFile(path, 'utf8')).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker configuration corruption is owner-local and fail-closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-worker-config-quarantine-'));
  const corruptOwner = 'owner-corrupt';
  const healthyOwner = 'owner-healthy';
  const corruptPath = join(
    root,
    'users',
    corruptOwner,
    'worker-configurations.json',
  );
  const source = JSON.stringify([
    {
      schemaVersion: 1,
      userId: 'another-owner',
      workerId: 'worker-corrupt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: [{ kind: 'variable', key: 'COLOR', value: 'red' }],
    },
  ]);

  try {
    await mkdir(join(root, 'users', corruptOwner), { recursive: true });
    await writeFile(corruptPath, source);
    const store = new WorkerConfigStore({ dataDir: root } as never);
    await store.replace(healthyOwner, 'worker-healthy', [
      { kind: 'variable', key: 'COLOR', value: 'blue' },
    ]);

    await expect(store.get(corruptOwner, 'worker-corrupt'))
      .rejects.toMatchObject({ statusCode: 503 });
    await expect(
      store.replace(corruptOwner, 'worker-corrupt', [
        { kind: 'variable', key: 'COLOR', value: 'green' },
      ]),
    ).rejects.toMatchObject({ statusCode: 503 });
    expect((await store.resolveValues(healthyOwner, 'worker-healthy'))[0])
      .toMatchObject({ key: 'COLOR', value: 'blue' });
    expect(await readFile(corruptPath, 'utf8')).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('worker configuration get and replace results are detached snapshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-worker-config-detached-'));
  try {
    const store = new WorkerConfigStore({ dataDir: root } as never);
    const saved = await store.replace('owner-1', 'worker-1', [
      { kind: 'variable', key: 'COLOR', value: 'blue' },
    ]);
    (saved.entries[0] as { value: string }).value = 'mutated result';
    const loaded = (await store.get('owner-1', 'worker-1'))!;
    (loaded.entries[0] as { value: string }).value = 'mutated get';

    expect((await store.resolveValues('owner-1', 'worker-1'))[0]).toMatchObject({
      key: 'COLOR',
      value: 'blue',
    });
    const disk = JSON.parse(
      await readFile(
        join(root, 'users', 'owner-1', 'worker-configurations.json'),
        'utf8',
      ),
    );
    expect(disk[0].entries[0].value).toBe('blue');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
