import { expect, test } from '@playwright/test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  InstanceExternalOperationJournal as Journal,
  type ExternalOperationBinding, type ExternalOperationJournalFaultPoint,
  type ExternalOperationJournalOptions, type ExternalOperationVerificationTarget,
} from '../../orchestrator/server/utils/instance-external-operation-journal';
import { attachSettlement, operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

const identity = { installationId: 'installation-fixture', daemonId: 'daemon-fixture' };
const filename = 'external-operations.v1.json', lock = 'external-operations.writer.lock';
const input: Omit<ExternalOperationBinding, 'operationId'> = {
  kind: 'docker-exec', ownerId: 'fixture_owner', workerId: 'fixture_worker',
  containerId: 'a'.repeat(64), execId: null, artifactId: null,
};
const receiptDigest = 'sha256:' + 'b'.repeat(64);
const makeProof = (target: ExternalOperationVerificationTarget) => ({
  operationId: target.operation.operationId, bindingDigest: target.bindingDigest,
  receiptDigest, outcome: 'completed' as const,
});
const defaults: Omit<ExternalOperationJournalOptions, 'directory'> = {
  identity, create: true, verifyReceipt: async () => undefined,
};
let directory: string;
let journals: Journal[];
test.beforeEach(async () => {
  directory = await mkdtemp('/workspace/kata-external-journal-test-'); journals = [];
});
test.afterEach(async () => {
  for (const journal of journals) await journal.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
});
async function open(options: Partial<ExternalOperationJournalOptions> = {}) {
  const journal = await Journal.open({ ...defaults, directory, ...options }); journals.push(journal); return journal;
}
function held() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const heldError = { code: 'INSTANCE_EXTERNAL_OPERATION_JOURNAL_HELD' };
const invalidError = { code: 'INSTANCE_EXTERNAL_OPERATION_JOURNAL_INVALID' };

test('intent is acknowledged after directory sync and vetoes readiness while persistence is pending', async () => {
  const entered = held(), release = held(); let armed = false, completed = false;
  const journal = await open({ fault: async point => {
    if (armed && point === 'directory-sync') { entered.resolve(); await release.promise; }
  } });
  armed = true;
  const writing = journal.beginIntent(input).then(value => { completed = true; return value; });
  await entered.promise;
  try {
    expect(completed).toBe(false); expect(journal.hasUnresolvedOperations()).toBe(true);
    release.resolve(); const intent = await writing;
    expect(intent.state).toBe('intent'); expect(intent.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const stored = JSON.parse(await readFile(join(directory, filename), 'utf8'));
    expect(stored.state.entries).toEqual([intent]);
    expect((await lstat(join(directory, filename))).mode & 0o777).toBe(0o600);
    expect((await journal.inspect()).unresolved).toBe(true);
  } finally { release.resolve(); await writing; }
});

test('clean restart retains both intent and explicitly uncertain records with exact identities', async () => {
  const first = await open();
  const one = await first.beginIntent(input), two = await first.beginIntent({ ...input, kind: 'docker-helper' });
  await first.recordUncertainty(two.operationId, 'transport-lost');
  await first.close();
  const second = await open({ create: false });
  expect((await second.inspect()).entries).toEqual([
    one, { ...two, state: 'uncertain', uncertaintyReason: 'transport-lost' },
  ]);
  expect(second.hasUnresolvedOperations()).toBe(true);
});

test('receipt candidate cannot clear an intent without the constructor-injected authority', async () => {
  let checks = 0;
  const journal = await open({ verifyReceipt: async () => { checks++; return undefined; } });
  const intent = await journal.beginIntent(input);
  for (const proof of [true, { StatusCode: 0 }, { statusCode: 404 }, { closed: true }, { expired: true }, { pidMissing: true }])
    await expect(journal.settle(intent.operationId, proof)).rejects.toMatchObject(heldError);
  expect(checks).toBe(6); expect((await journal.inspect()).entries).toEqual([intent]);
});

test('trusted receipt is bound to the exact operation and installation/daemon digest', async () => {
  let mode: 'operation' | 'binding' | 'valid' = 'operation';
  const journal = await open({ verifyReceipt: async target => {
    const proof = makeProof(target);
    if (mode === 'operation') proof.operationId = '11111111-1111-4111-8111-111111111111';
    if (mode === 'binding') proof.bindingDigest = 'sha256:' + 'c'.repeat(64);
    return proof;
  } });
  const intent = await journal.beginIntent(input);
  await expect(journal.settle(intent.operationId, undefined)).rejects.toMatchObject(heldError);
  mode = 'binding'; await expect(journal.settle(intent.operationId, undefined)).rejects.toMatchObject(heldError);
  mode = 'valid'; await journal.settle(intent.operationId, { syntheticRawSecret: 'must-never-be-stored' });
  expect(journal.hasUnresolvedOperations()).toBe(false);
  const bytes = await readFile(join(directory, filename), 'utf8'); expect(bytes).not.toContain('must-never-be-stored');
  const before = (await journal.inspect()).revision;
  await journal.settle(intent.operationId, undefined); expect((await journal.inspect()).revision).toBe(before);
  await journal.close(); const restarted = await open({ create: false });
  expect(restarted.hasUnresolvedOperations()).toBe(false);
  expect((await restarted.inspect()).entries[0].terminal).toEqual({ outcome: 'completed', receiptDigest });
});

test('verifier sees a deeply frozen detached target and cannot mutate stored expected identities', async () => {
  const journal = await open({ verifyReceipt: async target => {
    expect(Object.isFrozen(target)).toBe(true); expect(Object.isFrozen(target.identity)).toBe(true);
    expect(Object.isFrozen(target.operation)).toBe(true);
    expect(() => { target.operation.containerId = 'c'.repeat(64); }).toThrow();
    return makeProof(target);
  } });
  const intent = await journal.beginIntent(input); await journal.settle(intent.operationId, undefined);
  expect((await journal.inspect()).entries[0].containerId).toBe(input.containerId);
});

test('identity additions reject replacement, stale receipts, mutable tags, and short Docker IDs', async () => {
  let stale: ReturnType<typeof makeProof> | undefined;
  const journal = await open({ verifyReceipt: async target => stale ?? makeProof(target) });
  const intent = await journal.beginIntent(input);
  // Capture a receipt using the old binding while intentionally refusing it.
  const verifier = (journal as any).options.verifyReceipt;
  (journal as any).options.verifyReceipt = async (target: ExternalOperationVerificationTarget) => { stale = makeProof(target); return undefined; };
  await expect(journal.settle(intent.operationId, undefined)).rejects.toMatchObject(heldError);
  (journal as any).options.verifyReceipt = verifier;
  await journal.bindIdentity(intent.operationId, { execId: 'd'.repeat(64), artifactId: 'sha256:' + 'e'.repeat(64) });
  await expect(journal.settle(intent.operationId, undefined)).rejects.toMatchObject(heldError);
  await expect(journal.bindIdentity(intent.operationId, { containerId: 'f'.repeat(64) })).rejects.toMatchObject(heldError);
  expect(() => journal.bindIdentity(intent.operationId, { execId: 'abc123' })).toThrow();
  expect(() => journal.bindIdentity(intent.operationId, { artifactId: 'worker:latest' })).toThrow();
  stale = undefined; await journal.settle(intent.operationId, undefined);
  await expect(journal.bindIdentity(intent.operationId, { execId: 'd'.repeat(64) })).rejects.toMatchObject(heldError);
});

test('failed receipt verification retains its exposed settlement before a queued mutation runs', async () => {
  const entered = held(), release = held(), settlement = held();
  const journal = await open({ verifyReceipt: async () => {
    entered.resolve(); await release.promise; throw attachSettlement(new Error('synthetic receipt failure'), settlement.promise);
  } });
  const intent = await journal.beginIntent(input);
  const checking = journal.settle(intent.operationId, undefined).catch(error => error); await entered.promise;
  let done = false;
  const next = journal.beginIntent({ ...input, kind: 'docker-image-build' }).then(value => { done = true; return value; });
  try {
    release.resolve(); expect(await checking).toBeInstanceOf(Error); await tick(); expect(done).toBe(false);
    settlement.reject(new Error('late receipt failure')); await next;
    expect((await journal.inspect()).entries).toHaveLength(2);
  } finally { release.resolve(); settlement.resolve(); await Promise.allSettled([checking, next]); }
});

for (const point of ['write', 'file-sync', 'rename', 'directory-sync', 'acknowledge'] as ExternalOperationJournalFaultPoint[]) {
  test(`uncertain ${point} never acknowledges intent and keeps writer lock across close/restart`, async () => {
    let armed = false;
    const journal = await open({ fault: where => { if (armed && where === point) throw new Error('synthetic storage failure'); } });
    armed = true;
    await expect(journal.beginIntent(input)).rejects.toMatchObject(heldError);
    expect(journal.hasUnresolvedOperations()).toBe(true);
    await expect(journal.beginIntent(input)).rejects.toMatchObject(heldError);
    await journal.close(); expect(await readdir(directory)).toContain(lock);
    await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
  });
}

test('uncertain terminal persistence cannot release a pending operation or discard its restart hold', async () => {
  let armed = false;
  const journal = await open({ verifyReceipt: async target => makeProof(target), fault: point => {
    if (armed && point === 'directory-sync') throw new Error('synthetic terminal sync failure');
  } });
  const intent = await journal.beginIntent(input); armed = true;
  await expect(journal.settle(intent.operationId, undefined)).rejects.toMatchObject(heldError);
  expect(journal.hasUnresolvedOperations()).toBe(true); await journal.close();
  await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
});

test('second owner and crash lock are never cleared from TTL/PID/receipt guesses', async () => {
  const first = await open(); await first.beginIntent(input);
  await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
  expect(await readdir(directory)).toContain(lock); await first.close();
  await mkdir(join(directory, lock), { mode: 0o700 });
  await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
  expect(await readdir(directory)).toContain(lock);
});

test('existing state is never replaced by create and absent state is never treated as empty', async () => {
  const journal = await open(); await journal.beginIntent(input); await journal.close();
  const bytes = await readFile(join(directory, filename), 'utf8');
  await expect(Journal.open({ ...defaults, directory })).rejects.toMatchObject(heldError);
  expect(await readFile(join(directory, filename), 'utf8')).toBe(bytes);
  const missing = join(directory, 'missing'); await mkdir(missing, { mode: 0o700 });
  await expect(Journal.open({ ...defaults, directory: missing, create: false })).rejects.toMatchObject(heldError);
  expect(await readdir(missing)).toEqual([lock]);
});

test('symlink and permissive control directories reject before locking', async () => {
  const actual = join(directory, 'actual'); await mkdir(actual, { mode: 0o700 });
  const alias = join(directory, 'alias'); await symlink(actual, alias);
  await expect(Journal.open({ ...defaults, directory: alias })).rejects.toMatchObject(heldError);
  expect(await readdir(actual)).toEqual([]);
  await chmod(actual, 0o755);
  await expect(Journal.open({ ...defaults, directory: actual })).rejects.toMatchObject(heldError);
  expect(await readdir(actual)).toEqual([]);
  await expect(Journal.open({ ...defaults, directory: actual + '/' })).rejects.toMatchObject(heldError);
});

test('directory replacement quarantines mutation before it can acknowledge an intent', async () => {
  const control = join(directory, 'control'), displaced = join(directory, 'displaced');
  await mkdir(control, { mode: 0o700 }); const journal = await open({ directory: control });
  await rename(control, displaced); await mkdir(control, { mode: 0o700 });
  await expect(journal.beginIntent(input)).rejects.toMatchObject(heldError);
  expect(journal.hasUnresolvedOperations()).toBe(true); expect(await readdir(control)).toEqual([]);
  expect(await readdir(displaced)).toContain(lock);
});

for (const artifact of ['symlink', 'hardlink', 'fifo', 'oversize', 'bad-mode', 'unknown-field', 'duplicate-key', 'duplicate-operation', 'checksum'] as const) {
  test(`restart refuses ${artifact} journal and preserves an acquired reconciliation lock`, async () => {
    const journal = await open(); await journal.beginIntent(input); await journal.close();
    const path = join(directory, filename), original = await readFile(path, 'utf8');
    if (artifact === 'symlink') {
      const target = join(directory, 'saved'); await rename(path, target); await symlink(target, path);
      // Unknown extra artifacts also fail closed; do not use a real host path.
    } else if (artifact === 'hardlink') {
      // Keep the second link outside the protected control directory so the
      // regular-file nlink check, rather than artifact enumeration, catches it.
      const linked = await mkdtemp('/workspace/kata-external-journal-link-');
      try { await link(path, join(linked, 'copy')); await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError); }
      finally { await rm(linked, { recursive: true, force: true }); }
      return;
    } else if (artifact === 'fifo') {
      await rm(path); await promisify(execFile)('mkfifo', ['-m', '600', path]);
    } else if (artifact === 'oversize') {
      await writeFile(path, Buffer.alloc(512 * 1024 + 1), { mode: 0o600 });
    } else if (artifact === 'bad-mode') {
      await chmod(path, 0o644);
    } else {
      const value = JSON.parse(original);
      if (artifact === 'unknown-field') value.state.freeformSecret = 'must-not-be-accepted';
      if (artifact === 'duplicate-operation') value.state.entries.push(value.state.entries[0]);
      if (artifact === 'checksum') value.checksum = 'sha256:' + '0'.repeat(64);
      else value.checksum = 'sha256:' + createHash('sha256').update(JSON.stringify(value.state)).digest('hex');
      const bytes = JSON.stringify(value) + '\n';
      await writeFile(path, artifact === 'duplicate-key' ? bytes.replace('"version":1', '"version":1,"version":1') : bytes);
    }
    await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
    expect(await readdir(directory)).toContain(lock);
  });
}

test('leftover next file is not guessed away during restart', async () => {
  const journal = await open(); await journal.close();
  await writeFile(join(directory, 'external-operations.next'), 'synthetic uncertain artifact', { mode: 0o600 });
  await expect(Journal.open({ ...defaults, directory, create: false })).rejects.toMatchObject(heldError);
  expect(await readdir(directory)).toContain('external-operations.next'); expect(await readdir(directory)).toContain(lock);
});

test('bounded schema refuses accessor/unknown/oversize identities without storing caller values', async () => {
  const journal = await open(); let accessed = false;
  const values = [
    { ...input, command: 'must-never-be-stored' }, { ...input, ownerId: 'x'.repeat(129) },
    { ...input, kind: 'arbitrary-shell-command' }, { ...input, containerId: 'short-id' },
    Object.defineProperty({ ...input }, 'ownerId', { enumerable: true, get() { accessed = true; return 'owner'; } }),
  ];
  for (const value of values) expect(() => journal.beginIntent(value as any)).toThrow();
  expect(accessed).toBe(false); expect((await journal.inspect()).revision).toBe('0');
  expect(await readFile(join(directory, filename), 'utf8')).not.toContain('must-never-be-stored');
  expect(() => journal.recordUncertainty('invalid', 'caller-timeout')).toThrow();
  expect(() => journal.recordUncertainty('11111111-1111-4111-8111-111111111111', 'freeform' as any)).toThrow();
});

test('caller mutation and inspection mutation cannot alter a queued durable intent', async () => {
  const entered = held(), release = held(); let armed = false;
  const journal = await open({ fault: async point => { if (armed && point === 'write') { entered.resolve(); await release.promise; } } });
  const candidate = { ...input }; armed = true; const work = journal.beginIntent(candidate); await entered.promise;
  try {
    candidate.ownerId = 'different'; release.resolve(); await work;
    const result = await journal.inspect(); result.entries[0].ownerId = 'inspection-mutated';
    expect((await journal.inspect()).entries[0].ownerId).toBe(input.ownerId);
  } finally { release.resolve(); await work; }
});

test('shutdown rejects new roots while allowing already accepted persistence to finish', async () => {
  const entered = held(), release = held(); let armed = false;
  const journal = await open({ fault: async point => { if (armed && point === 'write') { entered.resolve(); await release.promise; } } });
  armed = true; const first = journal.beginIntent(input); await entered.promise;
  const second = journal.beginIntent(input), closing = journal.close();
  try {
    await expect(journal.beginIntent(input)).rejects.toMatchObject(heldError);
    release.resolve(); await first; await second; await closing;
    const restarted = await open({ create: false }); expect((await restarted.inspect()).entries).toHaveLength(2);
  } finally { release.resolve(); await Promise.allSettled([first, second, closing]); }
});

test('failed shutdown directory sync keeps a durable restart veto', async () => {
  const journal = await open();
  // Inject only this fixture's already-owned directory handle. No global fs
  // patch, external filesystem, or native Docker operation is involved.
  const handle = (journal as any).directoryHandle;
  handle.sync = async () => { throw new Error('synthetic shutdown sync failure'); };
  await expect(journal.close()).rejects.toMatchObject(heldError);
  expect(journal.hasUnresolvedOperations()).toBe(true);
  await expect(open({ create: false })).rejects.toMatchObject(heldError);
});

test('frozen receipt failure holds shutdown through rejecting native settlement', async () => {
  const native = held(), entered = held();
  const failure = Object.freeze(attachSettlement(new Error('synthetic verifier failure'), native.promise));
  const journal = await open({ verifyReceipt: async () => { entered.resolve(); throw failure; } });
  const intent = await journal.beginIntent(input);
  const checking = journal.settle(intent.operationId, undefined).catch(error => error);
  await entered.promise;
  let closed = false;
  const closing = journal.close().then(() => { closed = true; });
  try {
    expect(await checking).toBe(failure); await tick();
    expect(closed).toBe(false); expect(journal.hasUnresolvedOperations()).toBe(true);
    expect(await readdir(directory)).toContain(lock);
    native.reject(new Error('synthetic late native rejection')); await closing;
    const restarted = await open({ create: false });
    expect((await restarted.inspect()).entries).toEqual([intent]);
    expect(restarted.hasUnresolvedOperations()).toBe(true);
  } finally { native.resolve(); await Promise.allSettled([checking, closing]); }
});

test('failed native handle close keeps the restart veto and frozen settlement linkage', async () => {
  const journal = await open(), native = held();
  const handle = (journal as any).directoryHandle, actualClose = handle.close.bind(handle);
  const failure = Object.freeze(attachSettlement(new Error('synthetic native close failure'), native.promise));
  handle.close = async () => { await actualClose(); throw failure; };
  const error = await journal.close().catch(error => error);
  let settled = false;
  const settlement = error[operationSettlement].then(() => { settled = true; });
  try {
    expect(error).toMatchObject(heldError); await tick(); expect(settled).toBe(false);
    expect(journal.hasUnresolvedOperations()).toBe(true);
    await expect(open({ create: false })).rejects.toMatchObject(heldError);
  } finally {
    native.reject(new Error('synthetic late native close rejection')); await settlement;
  }
});
