import { expect, test } from '@playwright/test';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { GoogleBackupOAuthConfigStore } from '../../orchestrator/server/utils/google-backup-oauth-config';
import { encryptWorkerValue, decryptWorkerValue, type EncryptedWorkerValue } from '../../orchestrator/server/utils/worker-config-crypto';
import { instanceControlPlaneCoordinator as gate } from '../../orchestrator/server/utils/instance-snapshot-gate';
import { operationSettlement } from '../../orchestrator/server/utils/operation-deadline';
import { decryptBackup, decryptBackupV1WithMaterial, encryptBackup } from '../../orchestrator/server/utils/backup-crypto';

function held() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const id = '12345678-1234-4123-8123-123456789abc';
const envelope: EncryptedWorkerValue = { version: 1, algorithm: 'aes-256-gcm', iv: 'synthetic', tag: 'synthetic', ciphertext: 'synthetic' };
const stored = { schemaVersion: 1, clientId: 'original', redirectUri: 'https://example.test/callback', clientSecret: envelope, updatedAt: 'original' };
const input = (clientId = 'saved') => ({ clientId, redirectUri: 'https://example.test/callback', clientSecret: 'synthetic-secret' });
function failure(settlement: Promise<void>, code?: string) {
  return Object.freeze(Object.assign(new Error('synthetic failure'), { [operationSettlement]: settlement, code }));
}
function oauthIo(overrides = {}) {
  return { readFile: async () => JSON.stringify(stored), encrypt: async () => envelope, decrypt: async () => 'synthetic-secret', ...overrides } as any;
}
function identityIo(overrides = {}) {
  return { chmod: async () => {}, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }), mkdir: async () => {}, readFile: async () => id, writeFile: async () => {}, ...overrides } as any;
}
let previousBackupKey: string | undefined;
test.beforeEach(() => { previousBackupKey = process.env.BACKUP_ENCRYPTION_KEY; delete process.env.BACKUP_ENCRYPTION_KEY; });
test.afterEach(async () => {
  if (previousBackupKey === undefined) delete process.env.BACKUP_ENCRYPTION_KEY; else process.env.BACKUP_ENCRYPTION_KEY = previousBackupKey;
  await expect.poll(() => gate.activeOperations).toBe(0);
  expect(gate.barrierActive).toBe(false);
});

test('legacy key writer refuses both v1 entry points before reading or staging', async () => {
  let reads = 0;
  const io = identityIo({ readFile: async () => { reads++; return 'synthetic-key'; } });
  const barrier = gate.begin('legacy-key-refused', 'snapshot');
  try {
    await expect(encryptBackup({ dataDir: '/synthetic' } as any, '/synthetic/input', '/synthetic/output', undefined, io)).rejects.toMatchObject({ statusCode: 423 });
    await expect(decryptBackup({ dataDir: '/synthetic' } as any, '/synthetic/input', '/synthetic/output', 'synthetic-hash', io)).rejects.toMatchObject({ statusCode: 423 });
    expect(reads).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); }
});

for (const branch of ['read', 'write'] as const) for (const rejects of [false, true]) {
  test(`legacy key swallowed ${branch} failure owns ${rejects ? 'rejected' : 'resolved'} settlement before normalization`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentor-legacy-key-drain-'));
    const source = join(directory, 'plain'), output = join(directory, 'encrypted');
    await writeFile(source, 'synthetic archive contents');
    const entered = held(), settlement = held(); let reads = 0, normalized = false, created = false;
    const io = identityIo({
      readFile: async () => {
        if (++reads === 1) {
          if (branch === 'read') { entered.resolve(); throw failure(settlement.promise); }
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return 'synthetic-key';
      },
      writeFile: async () => {
        created = true;
        if (branch === 'write') { entered.resolve(); throw failure(settlement.promise, 'EEXIST'); }
      },
      chmod: async () => { await gate.run(() => { normalized = true; }); },
    });
    const writing = encryptBackup({ dataDir: directory } as any, source, output, undefined, io);
    await entered.promise; const barrier = gate.begin('legacy-key-swallowed', 'snapshot');
    try {
      await tick(); expect(normalized).toBe(false); if (branch === 'read') expect(created).toBe(false);
      expect(() => barrier.assertDrained()).toThrow();
      if (rejects) settlement.reject(new Error('late key operation')); else settlement.resolve();
      await writing; await barrier.drain({ timeoutMs: 1000 }); expect(normalized).toBe(true);
    } finally { settlement.resolve(); await writing; barrier.release(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('legacy key permission failure retains settlement without admitting staging work', async () => {
  const settlement = held();
  const io = identityIo({ readFile: async () => 'synthetic-key', chmod: async () => { throw failure(settlement.promise); } });
  await expect(encryptBackup({ dataDir: '/synthetic' } as any, '/synthetic/input', '/synthetic/output', undefined, io)).rejects.toThrow('synthetic failure');
  const barrier = gate.begin('legacy-key-permissions', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); settlement.reject(new Error('late chmod')); await barrier.drain({ timeoutMs: 1000 }); }
  finally { settlement.resolve(); barrier.release(); }
});

test('concurrent legacy key creation preserves v1 envelope and material-based excluded decryption', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-legacy-key-compatibility-'));
  const source = join(directory, 'plain'), outputs = [join(directory, 'one'), join(directory, 'two')];
  const config = { dataDir: directory } as any;
  try {
    await writeFile(source, 'synthetic v1 archive contents');
    const artifacts = await Promise.all(outputs.map(output => encryptBackup(config, source, output)));
    const material = await readFile(join(directory, 'backup.key'), 'utf8');
    expect((await lstat(join(directory, 'backup.key'))).mode & 0o777).toBe(0o600);
    expect(material).toMatch(/^[0-9a-f]{64}$/);
    await decryptBackup(config, outputs[0], join(directory, 'restored-one'), artifacts[0].sha256);
    const barrier = gate.begin('legacy-excluded-material-read', 'restore');
    try {
      await decryptBackupV1WithMaterial(outputs[1], join(directory, 'restored-two'), artifacts[1].sha256, material);
      barrier.assertDrained();
    } finally { barrier.release(); }
    for (const name of ['restored-one', 'restored-two']) expect(await readFile(join(directory, name), 'utf8')).toBe('synthetic v1 archive contents');
    expect((await readFile(outputs[0])).subarray(0, 17).toString()).toBe('AGENTOR-BACKUP-1\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('closed admission refuses identity and every OAuth entry before dependencies or queue insertion', async () => {
  let calls = 0;
  const io = oauthIo({ readFile: async () => { calls++; return JSON.stringify(stored); }, encrypt: async () => { calls++; return envelope; } });
  const store = new GoogleBackupOAuthConfigStore('/synthetic', async () => { calls++; }, io);
  const barrier = gate.begin('backup-config-refused', 'snapshot');
  try {
    for (const action of [() => backupInstallationId('/synthetic', identityIo({ readFile: async () => { calls++; return id; } })),
      () => store.status(), () => store.credentials(), () => store.configure(input()),
      () => (store as any).init(), () => (store as any).persist(stored)])
      await expect(action()).rejects.toMatchObject({ statusCode: 423 });
    expect(calls).toBe(0); barrier.assertDrained();
  } finally { barrier.release(); }
  await expect(store.status()).resolves.toMatchObject({ clientId: 'original' });
});

test('identity logical operation owns read through later permission normalization', async () => {
  const entered = held(), release = held(); let normalized = false;
  const writing = backupInstallationId('/synthetic', identityIo({ readFile: async () => { entered.resolve(); await release.promise; return id; },
    chmod: async () => { await gate.run(() => { normalized = true; }); } }));
  await entered.promise; const barrier = gate.begin('identity-permissions', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); expect(await writing).toBe(id);
    await barrier.drain({ timeoutMs: 1000 }); expect(normalized).toBe(true);
  } finally { release.resolve(); await writing; barrier.release(); }
});

for (const rejects of [false, true]) {
  test(`identity swallowed exclusive-create failure retains ${rejects ? 'rejected' : 'resolved'} settlement before rereading`, async () => {
    const entered = held(), settlement = held(); let reads = 0, reread = false;
    const writing = backupInstallationId('/synthetic', identityIo({
      readFile: async () => { if (++reads === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); reread = true; return id; },
      writeFile: async () => { entered.resolve(); throw failure(settlement.promise, 'EEXIST'); },
    }));
    await entered.promise; const barrier = gate.begin('identity-create-race', 'snapshot');
    try {
      await tick(); expect(reread).toBe(false); expect(() => barrier.assertDrained()).toThrow();
      if (rejects) settlement.reject(new Error('late failure')); else settlement.resolve();
      expect(await writing).toBe(id); await barrier.drain({ timeoutMs: 1000 }); expect(reread).toBe(true);
    } finally { settlement.resolve(); await writing; barrier.release(); }
  });

  test(`OAuth failed writer retains ${rejects ? 'rejected' : 'resolved'} settlement and serializes accepted successor`, async () => {
    const entered = held(), release = held(), settlement = held(); let writes = 0;
    const store = new GoogleBackupOAuthConfigStore('/synthetic', async () => {
      if (++writes === 1) { entered.resolve(); await release.promise; throw failure(settlement.promise); }
    }, oauthIo());
    const first = store.configure(input('failed')).catch(error => error); await entered.promise;
    const second = store.configure(input('success')); await tick();
    const barrier = gate.begin('oauth-queue-settlement', 'snapshot');
    try {
      release.resolve(); expect(await first).toBeInstanceOf(Error); await tick();
      expect(writes).toBe(1); expect(() => barrier.assertDrained()).toThrow();
      if (rejects) settlement.reject(new Error('late failure')); else settlement.resolve();
      await expect(second).resolves.toMatchObject({ clientId: 'success' }); await barrier.drain({ timeoutMs: 1000 });
    } finally { release.resolve(); settlement.resolve(); await Promise.allSettled([first, second]); barrier.release(); }
  });
}

test('identity sanitized read failure retains immutable exposed settlement', async () => {
  const settlement = held();
  const result = await backupInstallationId('/synthetic', identityIo({ readFile: async () => { throw failure(settlement.promise); } })).catch(error => error);
  expect(result.message).toBe('Backup installation identity is unavailable');
  const barrier = gate.begin('identity-rejected-read', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); settlement.reject(new Error('late read')); await barrier.drain({ timeoutMs: 1000 }); }
  finally { settlement.resolve(); barrier.release(); }
});

test('OAuth concurrent initialization loads once and admitted configure finishes after closure', async () => {
  const entered = held(), release = held(); let reads = 0, encrypted = false, saved = false;
  const store = new GoogleBackupOAuthConfigStore('/synthetic', async () => { saved = true; }, oauthIo({
    readFile: async () => { reads++; entered.resolve(); await release.promise; return JSON.stringify(stored); },
    encrypt: async () => { await gate.run(() => { encrypted = true; }); return envelope; },
  }));
  const status = store.status(), configuring = store.configure(input()); await entered.promise;
  const barrier = gate.begin('oauth-initialization', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve();
    await status; await expect(configuring).resolves.toMatchObject({ clientId: 'saved' });
    await barrier.drain({ timeoutMs: 1000 }); expect(reads).toBe(1); expect(encrypted && saved).toBe(true);
  } finally { release.resolve(); await Promise.allSettled([status, configuring]); barrier.release(); }
});

test('OAuth swallowed missing initialization waits for settlement before publishing readiness', async () => {
  const entered = held(), settlement = held(); let finished = false;
  const store = new GoogleBackupOAuthConfigStore('/synthetic', undefined, oauthIo({ readFile: async () => {
    entered.resolve(); throw failure(settlement.promise, 'ENOENT');
  } }));
  const status = store.status().then(value => { finished = true; return value; }); await entered.promise;
  const barrier = gate.begin('oauth-missing-read', 'snapshot');
  try {
    await tick(); expect(finished).toBe(false); expect(() => barrier.assertDrained()).toThrow();
    settlement.reject(new Error('late missing read')); await status; await barrier.drain({ timeoutMs: 1000 });
  } finally { settlement.resolve(); await status; barrier.release(); }
});

test('OAuth failed initialization remains unavailable and retains exposed settlement', async () => {
  const settlement = held(); let reads = 0;
  const store = new GoogleBackupOAuthConfigStore('/synthetic', undefined, oauthIo({ readFile: async () => {
    reads++; throw failure(settlement.promise);
  } }));
  await expect(store.status()).rejects.toThrow('synthetic failure');
  await expect(store.configure(input())).rejects.toThrow('synthetic failure'); expect(reads).toBe(1);
  const barrier = gate.begin('oauth-failed-init', 'snapshot');
  try { expect(() => barrier.assertDrained()).toThrow(); settlement.resolve(); await barrier.drain({ timeoutMs: 1000 }); }
  finally { settlement.resolve(); barrier.release(); }
});

for (const action of ['configure', 'credentials'] as const) test(`OAuth ${action} owns late crypto work and its rejected settlement`, async () => {
  const entered = held(), release = held(), settlement = held();
  const crypto = async () => { entered.resolve(); await release.promise; throw failure(settlement.promise); };
  const store = new GoogleBackupOAuthConfigStore('/synthetic', undefined, oauthIo({ encrypt: crypto, decrypt: crypto }));
  const result = (action === 'configure' ? store.configure(input()) : store.credentials()).catch(error => error);
  await entered.promise; const barrier = gate.begin('oauth-crypto-work', 'snapshot');
  try {
    expect(() => barrier.assertDrained()).toThrow(); release.resolve(); expect(await result).toBeInstanceOf(Error);
    expect(() => barrier.assertDrained()).toThrow(); settlement.reject(new Error('late crypto failure'));
    await barrier.drain({ timeoutMs: 1000 });
  } finally { release.resolve(); settlement.resolve(); await result; barrier.release(); }
});

test('OAuth environment fallback remains compatible without serializing its synthetic secret', async () => {
  const keys = ['GOOGLE_BACKUP_CLIENT_ID', 'GOOGLE_BACKUP_REDIRECT_URI', 'GOOGLE_BACKUP_CLIENT_SECRET'] as const;
  const previous = keys.map(key => process.env[key]);
  const values = ['environment-client', 'https://example.test/environment', 'synthetic-environment-secret'];
  try {
    keys.forEach((key, index) => { process.env[key] = values[index]; });
    const store = new GoogleBackupOAuthConfigStore('/synthetic', undefined, oauthIo({ readFile: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    } }));
    const status = await store.status(); expect(status).toMatchObject({ source: 'environment', configured: true });
    expect(JSON.stringify(status)).not.toContain(values[2]);
    await expect(store.credentials()).resolves.toEqual({ clientId: values[0], redirectUri: values[1], clientSecret: values[2] });
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test('real local identity and encrypted OAuth persistence preserve format, permissions and secret redaction', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-backup-config-drain-'));
  const previousKey = process.env.WORKER_CONFIG_ENCRYPTION_KEY;
  process.env.WORKER_CONFIG_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const config = { dataDir: directory } as any;
  const io = { readFile, encrypt: (value: string) => encryptWorkerValue(config, value, 'backup-google-installation-oauth-v1'),
    decrypt: (value: EncryptedWorkerValue) => decryptWorkerValue(config, value, 'backup-google-installation-oauth-v1') };
  try {
    const identity = await backupInstallationId(directory);
    await chmod(join(directory, 'backup-installation-id'), 0o644);
    expect(await backupInstallationId(directory)).toBe(identity);
    expect((await lstat(join(directory, 'backup-installation-id'))).mode & 0o777).toBe(0o600);
    const store = new GoogleBackupOAuthConfigStore(directory, undefined, io);
    const status = await store.configure(input()); expect(JSON.stringify(status)).not.toContain('synthetic-secret');
    const bytes = await readFile(join(directory, 'backup-google-oauth.v1.json'), 'utf8');
    expect(bytes).not.toContain('synthetic-secret'); expect(JSON.parse(bytes).clientSecret).toMatchObject({ version: 1, algorithm: 'aes-256-gcm' });
    expect((await lstat(join(directory, 'backup-google-oauth.v1.json'))).mode & 0o777).toBe(0o600);
    await expect(new GoogleBackupOAuthConfigStore(directory, undefined, io).credentials()).resolves.toEqual(input());
    await writeFile(join(directory, 'backup-installation-id'), 'malformed');
    await expect(backupInstallationId(directory)).rejects.toThrow('unavailable');
  } finally {
    if (previousKey === undefined) delete process.env.WORKER_CONFIG_ENCRYPTION_KEY; else process.env.WORKER_CONFIG_ENCRYPTION_KEY = previousKey;
    await rm(directory, { recursive: true, force: true });
  }
});
