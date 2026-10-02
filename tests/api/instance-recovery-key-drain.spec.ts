import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../../orchestrator/server/utils/config';
import { BackupKeyring, backupKeyFingerprint } from '../../orchestrator/server/utils/backup-keyring';
import { encryptWorkerValue, decryptWorkerValue, decryptWorkerValueForInstanceRestore } from '../../orchestrator/server/utils/worker-config-crypto';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { execFileSync } from 'node:child_process';
import { readExistingRecoveryKey } from '../../orchestrator/server/utils/recovery-key-read';

function held() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}
const syntheticMaterial = Buffer.alloc(32, 7).toString('base64');
const syntheticFingerprint = backupKeyFingerprint(syntheticMaterial);
let directory: string;
let previousWorkerKey: string | undefined, previousBackupKey: string | undefined;
const config = () => ({ dataDir: directory }) as Config;
const files = () => ({ chmod: fs.chmod, mkdir: fs.mkdir, open: fs.open, rename: fs.rename, rm: fs.rm });
test.beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'agentor-recovery-drain-'));
  previousWorkerKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  previousBackupKey = process.env.BACKUP_ENCRYPTION_KEY;
  delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  delete process.env.BACKUP_ENCRYPTION_KEY;
});
test.afterEach(async () => {
  try {
    await expect.poll(() => gate.activeOperations).toBe(0); expect(gate.barrierActive).toBe(false);
  } finally {
    if (previousWorkerKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY;
    else process.env.WORKER_CONFIG_ENCRYPTION_KEY = previousWorkerKey;
    if (previousBackupKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY;
    else process.env.BACKUP_ENCRYPTION_KEY = previousBackupKey;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('all keyring roots reject before initialization, owner queues, or permission normalization', async () => {
  const ring = new BackupKeyring(config());
  const barrier = gate.begin('key-roots', 'snapshot');
  try {
    for (const operation of [
      () => ring.init(), () => ring.active('owner'), () => ring.importKit('owner', syntheticMaterial),
      () => ring.exportKit('owner'), () => ring.status('owner'), () => ring.find('owner', syntheticFingerprint),
      () => ring.candidates('owner'),
    ]) await expect(operation()).rejects.toMatchObject({ statusCode: 423 });
    expect(await fs.readdir(directory)).toEqual([]); barrier.assertDrained();
  } finally { barrier.release(); }
  await ring.init();
  const closed = gate.begin('key-cached-init', 'snapshot');
  try { await expect(ring.init()).rejects.toMatchObject({ statusCode: 423 }); }
  finally { closed.release(); }
});

test('restore lookup requires completed initialization and never starts or joins lazy initialization', async () => {
  const f = files(), entered = held(), release = held();
  let opens = 0;
  f.open = (async (...args: Parameters<typeof fs.open>) => { opens++; entered.resolve(); await release.promise; return fs.open(...args); }) as typeof fs.open;
  const ring = new BackupKeyring(config(), undefined, f);
  await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
  expect(opens).toBe(0);
  const operation = ring.init(); await entered.promise;
  const barrier = gate.begin('key-init', 'snapshot');
  try {
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    expect(opens).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    release.resolve(); await operation; await barrier.drain({ timeoutMs: 1000 });
    expect(await ring.findForInstanceRestore('owner', syntheticFingerprint)).toBeUndefined();
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { release.resolve(); await operation; barrier.release(); }
});

test('initialized-only lookup stays closed until keyring load handle cleanup actually finishes', async () => {
  await fs.writeFile(join(directory, 'backup-keyring.json'), JSON.stringify({ version: 1, owners: {} }));
  const f = files(), entered = held(), release = held();
  f.open = (async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    return new Proxy(file, { get(target, property) {
      if (property === 'close') return async () => { entered.resolve(); await release.promise; await target.close(); };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof fs.open;
  const ring = new BackupKeyring(config(), undefined, f);
  const operation = ring.init(); await entered.promise;
  const barrier = gate.begin('key-load-close', 'restore');
  try {
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); await operation;
    await barrier.drain({ timeoutMs: 1000 });
  } finally { release.resolve(); await operation; barrier.release(); }
});

test('sanitized initialization failure preserves settlement and never marks the keyring ready', async () => {
  const f = files(), entered = held(), late = held();
  f.open = async () => { entered.resolve(); throw Object.assign(new Error('synthetic sensitive diagnostic'), { [operationSettlement]: late.promise }); };
  const ring = new BackupKeyring(config(), undefined, f);
  const operation = ring.init().catch(error => error); await entered.promise;
  const barrier = gate.begin('key-load-failure', 'restore');
  try {
    const error = await operation;
    expect(error.message).toBe('Backup recovery keyring is unavailable');
    expect(error[operationSettlement]).toBe(late.promise);
    expect(() => barrier.assertDrained()).toThrow();
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    late.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { late.resolve(); await operation; barrier.release(); }
});

test('rejected load close retains settlement and never publishes ready state', async () => {
  await fs.writeFile(join(directory, 'backup-keyring.json'), JSON.stringify({ version: 1, owners: {} }));
  const f = files(), entered = held(), late = held(); let returned = false;
  f.open = (async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    return new Proxy(file, { get(target, property) {
      if (property === 'close') return async () => {
        await target.close(); entered.resolve();
        throw Object.assign(new Error('synthetic close failure'), { [operationSettlement]: late.promise });
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof fs.open;
  const ring = new BackupKeyring(config(), undefined, f);
  const loading = ring.init().catch(error => { returned = true; return error; }); await entered.promise;
  const barrier = gate.begin('key-rejected-close', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    expect(() => barrier.assertDrained()).toThrow();
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    late.resolve(); expect((await loading).message).toBe('Backup recovery keyring cleanup is unavailable');
    await barrier.drain({ timeoutMs: 1000 });
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
  } finally { late.resolve(); await loading; barrier.release(); }
});

test('missing keyring waits for failed-open settlement before publishing ready state', async () => {
  const f = files(), entered = held(), late = held(); let returned = false;
  f.open = async () => {
    entered.resolve();
    const error = Object.assign(new Error('synthetic missing keyring'), { code: 'ENOENT' });
    Object.defineProperty(error, operationSettlement, { value: late.promise });
    throw error;
  };
  const ring = new BackupKeyring(config(), undefined, f);
  const loading = ring.init().then(() => { returned = true; }); await entered.promise;
  const barrier = gate.begin('key-missing-open-settlement', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    expect(() => barrier.assertDrained()).toThrow();
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    late.resolve(); await loading; await barrier.drain({ timeoutMs: 1000 });
    expect(await ring.findForInstanceRestore('owner', 'invalid')).toBeUndefined();
    expect(await fs.readdir(directory)).toEqual([]);
  } finally { late.resolve(); await loading; barrier.release(); }
});

test('keyring load double failure preserves both read and close settlements before retirement', async () => {
  await fs.writeFile(join(directory, 'backup-keyring.json'), JSON.stringify({ version: 1, owners: {} }));
  const f = files(), readLate = held(), closeLate = held(), entered = held();
  let returned = false;
  f.open = (async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args);
    return new Proxy(file, { get(target, property) {
      if (property === 'readFile') return async () => {
        entered.resolve();
        throw Object.assign(new Error('synthetic read failure'), { [operationSettlement]: readLate.promise });
      };
      if (property === 'close') return async () => {
        await target.close();
        throw Object.assign(new Error('synthetic close failure'), { [operationSettlement]: closeLate.promise });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  }) as typeof fs.open;
  const ring = new BackupKeyring(config(), undefined, f);
  const loading = ring.init().catch(error => { returned = true; return error; });
  await entered.promise;
  const barrier = gate.begin('key-double-failure', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(returned).toBe(false);
    expect(() => barrier.assertDrained()).toThrow();
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
    closeLate.resolve();
    const error = await loading;
    expect(error.message).toBe('Backup recovery keyring is unavailable');
    expect(() => barrier.assertDrained()).toThrow();
    readLate.resolve();
    await barrier.drain({ timeoutMs: 1000 });
    await expect(ring.findForInstanceRestore('owner', syntheticFingerprint)).rejects.toThrow('initialized before');
  } finally {
    closeLate.resolve();
    readLate.resolve();
    await loading;
    barrier.release();
  }
});

test('swallowed commit cleanup failure retains settlement before next writer runs', async () => {
  const f = files(), entered = held(), late = held(); let removals = 0, nextRan = false;
  f.rm = async (...args) => {
    await fs.rm(...args);
    if (++removals === 1) {
      entered.resolve(); throw Object.assign(new Error('synthetic cleanup failure'), { [operationSettlement]: late.promise });
    }
  };
  const ring = new BackupKeyring(config(), undefined, f); await ring.init();
  const first = (ring as any).commit(() => {}); await entered.promise;
  const second = (ring as any).commit(() => { nextRan = true; });
  const barrier = gate.begin('key-commit-cleanup', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(nextRan).toBe(false);
    expect(() => barrier.assertDrained()).toThrow(); late.resolve(); await Promise.all([first, second]);
    await barrier.drain({ timeoutMs: 1000 }); expect(nextRan).toBe(true);
  } finally { late.resolve(); await Promise.allSettled([first, second]); barrier.release(); }
});

test('restore lookup decrypts persisted and legacy keys without changing bytes or modes under barrier', async () => {
  const ring = new BackupKeyring(config());
  const current = await ring.active('owner');
  await fs.writeFile(join(directory, 'backup.key'), syntheticMaterial, { mode: 0o640 });
  const keyPath = join(directory, 'worker-config.key');
  await fs.chmod(keyPath, 0o640);
  const before = await fs.readFile(keyPath);
  const barrier = gate.begin('key-read-only', 'restore');
  try {
    expect(await ring.findForInstanceRestore('owner', current.fingerprint)).toBe(current.material);
    expect(await ring.findForInstanceRestore('owner', syntheticFingerprint)).toBe(syntheticMaterial);
    expect(await ring.findForInstanceRestore('other-owner', current.fingerprint)).toBeUndefined();
    expect(await ring.findForInstanceRestore('owner', 'invalid')).toBeUndefined();
    expect(await fs.readFile(keyPath)).toEqual(before);
    expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o640);
    expect((await fs.stat(join(directory, 'backup.key'))).mode & 0o777).toBe(0o640);
    barrier.assertDrained();
  } finally { barrier.release(); }
  await ring.find('owner', current.fingerprint); await ring.status('owner');
  expect((await fs.stat(keyPath)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(join(directory, 'backup.key'))).mode & 0o777).toBe(0o600);
});

test('missing restore crypto key never regenerates it or creates a missing data directory', async () => {
  const ring = new BackupKeyring(config()); const key = await ring.active('owner');
  const encrypted = await encryptWorkerValue(config(), 'synthetic value', 'synthetic aad');
  await fs.unlink(join(directory, 'worker-config.key'));
  const barrier = gate.begin('missing-restore-key', 'restore');
  try {
    await expect(ring.findForInstanceRestore('owner', key.fingerprint)).rejects.toThrow('key is unavailable');
    await expect(decryptWorkerValueForInstanceRestore(config(), encrypted, 'synthetic aad')).rejects.toMatchObject({ code: 'ENOENT' });
    const missingConfig = { dataDir: join(directory, 'absent') } as Config;
    await expect(decryptWorkerValueForInstanceRestore(missingConfig, encrypted, 'synthetic aad')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(missingConfig.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat(join(directory, 'worker-config.key'))).rejects.toMatchObject({ code: 'ENOENT' });
    barrier.assertDrained();
  } finally { barrier.release(); }
});

test('crypto normal operations are admitted while restore reads preserve format, AAD and symlink checks', async () => {
  const encrypted = await encryptWorkerValue(config(), 'synthetic value', 'synthetic aad');
  const barrier = gate.begin('crypto-roots', 'snapshot');
  try {
    await expect(encryptWorkerValue(config(), 'denied', 'aad')).rejects.toMatchObject({ statusCode: 423 });
    await expect(decryptWorkerValue(config(), encrypted, 'synthetic aad')).rejects.toMatchObject({ statusCode: 423 });
    expect(await decryptWorkerValueForInstanceRestore(config(), encrypted, 'synthetic aad')).toBe('synthetic value');
    await expect(decryptWorkerValueForInstanceRestore(config(), encrypted, 'wrong aad')).rejects.toThrow();
    await expect(decryptWorkerValueForInstanceRestore(config(), { ...encrypted, version: 2 } as any, 'synthetic aad')).rejects.toThrow('Unsupported');
  } finally { barrier.release(); }
  await fs.rename(join(directory, 'worker-config.key'), join(directory, 'synthetic-key'));
  await fs.symlink(join(directory, 'synthetic-key'), join(directory, 'worker-config.key'));
  await expect(decryptWorkerValueForInstanceRestore(config(), encrypted, 'synthetic aad')).rejects.toMatchObject({ code: 'ELOOP' });
});

test('restore lookup rejects FIFOs without opening a writer or blocking initialization checks', async () => {
  const encrypted = await encryptWorkerValue(config(), 'synthetic value', 'synthetic aad');
  await fs.unlink(join(directory, 'worker-config.key'));
  const ring = new BackupKeyring(config()); await ring.init();
  for (const name of ['worker-config.key', 'backup.key']) execFileSync('mkfifo', [join(directory, name)]);
  const barrier = gate.begin('fifo-key-read', 'restore');
  try {
    await expect(decryptWorkerValueForInstanceRestore(config(), encrypted, 'synthetic aad')).rejects.toThrow('regular');
    expect(await ring.findForInstanceRestore('owner', syntheticFingerprint)).toBeUndefined();
    barrier.assertDrained();
  } finally { barrier.release(); }
});

test('readonly key reads reject oversized files before reading and detect growth within their byte bound', async () => {
  const path = join(directory, 'bounded-key');
  await fs.writeFile(path, 'x'.repeat(4097)); let reads = 0, closed = false;
  const open: typeof fs.open = async (...args) => {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return (...values: any[]) => { reads++; return (target.read as any)(...values); };
      if (property === 'close') return async () => { await target.close(); closed = true; };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  await expect(readExistingRecoveryKey(path, 4096, open)).rejects.toThrow('bounded regular');
  expect(reads).toBe(0); expect(closed).toBe(true);
  await fs.writeFile(path, 'small');
  const racingOpen: typeof fs.open = async (...args) => {
    const handle = await fs.open(...args); let stats = 0;
    return new Proxy(handle, { get(target, property) {
      if (property === 'stat') return async (...values: any[]) => {
        const value = await (target.stat as any)(...values);
        if (++stats === 1) await fs.writeFile(path, 'x'.repeat(8192));
        return value;
      };
      if (property === 'read') return (buffer: Buffer, ...values: any[]) => {
        expect(buffer.length).toBe(4097); return (target.read as any)(buffer, ...values);
      };
      const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  await expect(readExistingRecoveryKey(path, 4096, racingOpen)).rejects.toThrow('changed');
});

for (const immutable of [false, true]) test(`readonly key reads preserve both read and close settlements on double failure (${immutable ? 'immutable deadline linkage' : 'mutable linkage'})`, async () => {
  const path = join(directory, 'double-fail-key');
  await fs.writeFile(path, 'valid-key-material');
  const readLate = held(), closeLate = held(), entered = held();
  const open: typeof fs.open = async (...args) => {
    const handle = await fs.open(...args);
    return new Proxy(handle, { get(target, property) {
      if (property === 'read') return () => {
        entered.resolve();
        const error = new Error('synthetic read failure');
        Object.defineProperty(error, operationSettlement, { value: readLate.promise, configurable: !immutable });
        throw error;
      };
      if (property === 'close') return async () => {
        await target.close();
        throw Object.assign(new Error('synthetic close failure'), { [operationSettlement]: closeLate.promise });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  let operationError: any;
  const operation = gate.run(() => readExistingRecoveryKey(path, 4096, open)).catch(err => {
    operationError = err;
    return err;
  });
  await entered.promise;
  const barrier = gate.begin('recovery-double-failure', 'restore');
  try {
    await operation;
    expect(operationError).toBeDefined();
    expect(operationError.message).toBe('synthetic read failure');
    expect(() => barrier.assertDrained()).toThrow();
    readLate.resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(() => barrier.assertDrained()).toThrow();
    closeLate.resolve();
    await barrier.drain({ timeoutMs: 1000 });
  } finally {
    readLate.resolve();
    closeLate.resolve();
    await operation;
    barrier.release();
  }
});

test('configured crypto key remains compatible with restore-only lookup without local key files', async () => {
  process.env.WORKER_CONFIG_ENCRYPTION_KEY = syntheticMaterial;
  const encrypted = await encryptWorkerValue(config(), 'synthetic value', 'synthetic aad');
  const barrier = gate.begin('configured-restore-key', 'restore');
  try {
    expect(await decryptWorkerValueForInstanceRestore(config(), encrypted, 'synthetic aad')).toBe('synthetic value');
    expect(await fs.readdir(directory)).toEqual([]); barrier.assertDrained();
  } finally { barrier.release(); }
});

test('admitted export continues through initialization and owner generation after barrier closes', async () => {
  const f = files(), entered = held(), release = held();
  f.open = (async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith('/backup-keyring.json')) { entered.resolve(); await release.promise; }
    return fs.open(...args);
  }) as typeof fs.open;
  const ring = new BackupKeyring(config(), undefined, f);
  const operation = ring.exportKit('owner'); await entered.promise;
  const barrier = gate.begin('key-export', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve();
    const kit = await operation; await barrier.drain({ timeoutMs: 1000 });
    expect(await ring.findForInstanceRestore('owner', kit.fingerprint)).toBe(kit.keyMaterial);
    expect(await fs.readFile(join(directory, 'backup-keyring.json'), 'utf8')).not.toContain(kit.keyMaterial);
  } finally { release.resolve(); await operation; barrier.release(); }
});

for (const rejectedSettlement of [false, true]) test(`owner queue retains ${rejectedSettlement ? 'rejected' : 'resolved'} settlement without blocking another owner`, async () => {
  const ring = new BackupKeyring(config()); await ring.init();
  const late = held(), entered = held(); let secondRan = false;
  const failure = Object.assign(new Error('synthetic owner failure'), { [operationSettlement]: late.promise.then(() => { if (rejectedSettlement) throw new Error('synthetic late failure'); }) });
  const first = (ring as any).mutateOwner('owner', async () => { entered.resolve(); throw failure; });
  const outcome = first.catch((error: unknown) => error); await entered.promise;
  const second = (ring as any).mutateOwner('owner', async () => { secondRan = true; });
  await (ring as any).mutateOwner('other', async () => {});
  const barrier = gate.begin('key-owner-queue', 'snapshot');
  try {
    expect(await outcome).toBe(failure); expect(secondRan).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    late.resolve(); await second; await barrier.drain({ timeoutMs: 1000 }); expect(secondRan).toBe(true);
  } finally { late.resolve(); await Promise.allSettled([first, second]); barrier.release(); }
});

test('global commit queue waits for exposed failed write settlement before next persistence', async () => {
  const f = files(), entered = held(), late = held(); let renames = 0;
  const failure = Object.assign(new Error('synthetic rename failure'), { [operationSettlement]: late.promise });
  f.rename = async (from, to) => { if (++renames === 1) { entered.resolve(); throw failure; } await fs.rename(from, to); };
  const ring = new BackupKeyring(config(), undefined, f); await ring.init();
  const first = (ring as any).commit(() => {}); const outcome = first.catch((error: unknown) => error);
  await entered.promise; const second = (ring as any).commit(() => {});
  const barrier = gate.begin('key-write-queue', 'snapshot');
  try {
    expect(await outcome).toBe(failure); expect(renames).toBe(1); expect(() => barrier.assertDrained()).toThrow();
    late.resolve(); await second; await barrier.drain({ timeoutMs: 1000 }); expect(renames).toBe(2);
  } finally { late.resolve(); await Promise.allSettled([first, second]); barrier.release(); }
});

test('candidate failure waits sibling decrypt and retains a separate failed branch settlement', async () => {
  const ring = new BackupKeyring(config()); await ring.active('owner'); await ring.importKit('owner', syntheticMaterial);
  const entered = held(), release = held(), late = held(); let decrypts = 0, returned = false;
  const failure = Object.assign(new Error('synthetic candidate failure'), { [operationSettlement]: late.promise });
  (ring as any).decrypt = async () => {
    if (++decrypts === 1) throw failure;
    entered.resolve(); await release.promise; return syntheticMaterial;
  };
  const operation = ring.candidates('owner').catch(error => { returned = true; return error; }); await entered.promise;
  const barrier = gate.begin('key-candidates', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false);
    release.resolve(); expect(await operation).toBe(failure); expect(() => barrier.assertDrained()).toThrow();
    late.resolve(); await barrier.drain({ timeoutMs: 1000 });
  } finally { release.resolve(); late.resolve(); await operation; barrier.release(); }
});

test('legacy read fallback retains late permission normalization even when its error is swallowed', async () => {
  await fs.writeFile(join(directory, 'backup.key'), syntheticMaterial);
  const f = files(), entered = held(), late = held(); let returned = false;
  f.chmod = async () => { entered.resolve(); throw Object.assign(new Error('synthetic chmod failure'), { [operationSettlement]: late.promise }); };
  const ring = new BackupKeyring(config(), undefined, f);
  const operation = ring.status('owner').then(value => { returned = true; return value; }); await entered.promise;
  const barrier = gate.begin('key-legacy-fallback', 'snapshot');
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); expect(returned).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    late.resolve(); expect(await operation).toEqual([]); await barrier.drain({ timeoutMs: 1000 });
  } finally { late.resolve(); await operation; barrier.release(); }
});
