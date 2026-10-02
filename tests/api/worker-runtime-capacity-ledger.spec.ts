import { expect, test } from '@playwright/test';
import { constants } from 'node:fs';
import { mkdtemp, chmod, readFile, rm, readdir, writeFile, mkdir, symlink, open, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { RuntimeCapacityLedger, capacityLedgerEnvelopeDigest, type CapacityLedgerMeasurement,
  type CapacityLedgerOptions, type CapacityLedgerFaultPoint } from '../../orchestrator/server/utils/worker-runtime-capacity-ledger';
import type { RuntimeCapacityMeasurementRequest } from '../../orchestrator/server/utils/worker-runtime-capacity-protocol';
import { attachSettlement, operationSettlement } from '../../orchestrator/server/utils/operation-deadline';

function held() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

const identity = { hostId: 'host', serviceId: 'service', daemonId: 'daemon' };
const policy = { maxEvidenceAgeMs: 2000, maxLifetimeMs: 10000, maxScanDurationMs: 1000, maxScanEntries: '1000' };
function accounting(bytes = '30', available = '100'): CapacityLedgerMeasurement['accounting'] {
  return { version: 1, constraints: [{ id: 'filesystem', kind: 'filesystem', available: { bytes: available, inodes: '100' },
    safetyFloor: { bytes: '10', inodes: '10' } }], destinations: [{ id: 'store', constraintIds: ['filesystem'] }],
    demands: [{ id: 'copies', destinationId: 'store', amount: { bytes, inodes: '5' } }] };
}
function request(id = 'one', input = accounting()): RuntimeCapacityMeasurementRequest {
  return { version: 1, kind: 'capacity-measurement-request', binding: { ...identity, operationId: id,
    layoutGeneration: '1', maintenanceEpoch: 'epoch', ownerId: 'owner', workerId: 'worker',
    sourceContainerId: 'a'.repeat(64), targetRuntime: 'kata-qemu', phase: 'pre-stop', expectedSourceState: 'running-bounded',
    inventoryDigest: 'sha256:' + 'b'.repeat(64), envelopeDigest: capacityLedgerEnvelopeDigest(input) },
    nonce: createHash('sha256').update(id).digest('hex'), issuedAtMs: 1000, expiresAtMs: 11000 };
}
function measurement(req: RuntimeCapacityMeasurementRequest, sequence = '1', input = accounting()): CapacityLedgerMeasurement {
  return { accounting: input, evidence: { version: 1, kind: 'capacity-measurement-evidence', request: req,
    sequence, issuedAtMs: 1500, expiresAtMs: 10000,
    scan: { status: 'complete', sourceState: req.binding.expectedSourceState, startedAtMs: 1100, completedAtMs: 1400, entries: '10' } } };
}
async function activate(ledger: RuntimeCapacityLedger) {
  const before = await ledger.inspect();
  await ledger.reconcile({ expectedStateDigest: before.stateDigest, reviewDigest: 'sha256:' + 'c'.repeat(64),
    layoutGeneration: '1', maintenanceEpoch: 'epoch' });
}
async function fixture(openFile?: CapacityLedgerOptions['openFile']) {
  const directory = await mkdtemp(join(tmpdir(), 'capacity-ledger-test-'));
  await chmod(directory, 0o700);
  let now = 2000, point: CapacityLedgerFaultPoint | undefined;
  const options: CapacityLedgerOptions = { directory, identity, create: true, policy, now: () => now,
    ...(openFile ? { openFile } : {}),
    fault: current => { if (point === current) throw new Error('injected'); } };
  const ledger = await RuntimeCapacityLedger.open(options);
  return { directory, options, ledger, setNow: (value: number) => { now = value; },
    setFault: (value?: CapacityLedgerFaultPoint) => { point = value; },
    cleanup: async () => { await ledger.close().catch(() => undefined); await rm(directory, { recursive: true, force: true }); } };
}

test('new ledger is held until explicit exact-state review and grants no phase ticket', async () => {
  const f = await fixture();
  try {
    expect((await f.ledger.inspect()).reconciliationRequired).toBe(true);
    await expect(f.ledger.prepare(request())).rejects.toThrow('reconciliation');
    await activate(f.ledger); await f.ledger.prepare(request());
    const reserved = await f.ledger.reserve(request(), async req => measurement(req));
    expect(reserved.allocations).toEqual([{ constraintId: 'filesystem', amount: { bytes: '30', inodes: '5' } }]);
    expect(Object.keys(reserved).sort()).toEqual(['allocations', 'request', 'sequence', 'status']);
    const stored = JSON.parse(await readFile(join(f.directory, 'ledger.json'), 'utf8'));
    expect(stored.state.entries[0]).toEqual(reserved);
    expect(stored.state.sequence).toBe('1');
    expect(await readdir(f.directory)).toEqual(expect.arrayContaining(['ledger.json', 'writer.lock']));
    expect(await readdir(f.directory)).not.toContain('ledger.next');
  } finally { await f.cleanup(); }
});

test('durable register is required, nonce cannot be borrowed and operation bytes cannot change', async () => {
  const f = await fixture();
  try {
    await activate(f.ledger);
    await expect(f.ledger.reserve(request(), async req => measurement(req))).rejects.toThrow('unregistered');
    await f.ledger.prepare(request());
    const other = request('two'); other.nonce = request().nonce;
    await expect(f.ledger.prepare(other)).rejects.toThrow('nonce reused');
    const changed = request(); changed.binding.ownerId = 'other';
    await expect(f.ledger.prepare(changed)).rejects.toThrow('request mismatch');
    await expect(f.ledger.reserve(changed, async req => measurement(req))).rejects.toThrow('mismatched');
    await f.ledger.prepare(request());
    expect((await f.ledger.inspect()).state.entries).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('concurrent reservations measure serially and include all retained reservations', async () => {
  const f = await fixture(); const input = accounting('50');
  try {
    await activate(f.ledger);
    const first = request('one', input), second = request('two', input);
    await Promise.all([f.ledger.prepare(first), f.ledger.prepare(second)]);
    let active = 0, maximum = 0, sequence = 0;
    const measure = async (req: RuntimeCapacityMeasurementRequest) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 5)); active--;
      return measurement(req, String(++sequence), input);
    };
    const results = await Promise.allSettled([f.ledger.reserve(first, measure), f.ledger.reserve(second, measure)]);
    expect(results.map(r => r.status)).toEqual(['fulfilled', 'rejected']); expect(maximum).toBe(1);
    expect((results[1] as PromiseRejectedResult).reason.message).toContain('Insufficient');
    expect((await f.ledger.inspect()).state.sequence).toBe('1');
  } finally { await f.cleanup(); }
});

test('exact concurrent retry measures once and returns detached historical state even after TTL', async () => {
  const f = await fixture(); let calls = 0;
  try {
    await activate(f.ledger); await f.ledger.prepare(request());
    const measure = async (req: RuntimeCapacityMeasurementRequest) => { calls++; return measurement(req); };
    const [left, right] = await Promise.all([f.ledger.reserve(request(), measure), f.ledger.reserve(request(), measure)]);
    expect(left).toEqual(right); expect(calls).toBe(1); left.allocations[0].amount.bytes = '0';
    f.setNow(999999);
    expect((await f.ledger.reserve(request(), measure)).allocations[0].amount.bytes).toBe('30');
    expect(calls).toBe(1); expect((await f.ledger.inspect()).state.entries).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('clean restart retains orphan reservation, replay high-water and nonce and requires review', async () => {
  const f = await fixture(); let reopened: RuntimeCapacityLedger | undefined;
  try {
    await activate(f.ledger); await f.ledger.prepare(request()); await f.ledger.reserve(request(), async req => measurement(req));
    await f.ledger.close();
    reopened = await RuntimeCapacityLedger.open({ ...f.options, create: false });
    expect((await reopened.inspect()).reconciliationRequired).toBe(true);
    expect((await reopened.inspect()).state.entries[0].status).toBe('reserved');
    await expect(reopened.prepare(request('two'))).rejects.toThrow('reconciliation');
    await activate(reopened); await reopened.prepare(request('two'));
    await expect(reopened.reserve(request('two'), async req => measurement(req, '1'))).rejects.toThrow('replayed');
    await reopened.reserve(request('two'), async req => measurement(req, '2'));
    expect((await reopened.inspect()).state.entries.filter(e => e.status === 'reserved')).toHaveLength(2);
  } finally { await reopened?.close(); await f.cleanup(); }
});

test('two independently opened brokers cannot own the same directory', async () => {
  const f = await fixture();
  try {
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toThrow();
    await activate(f.ledger); await f.ledger.prepare(request());
    expect((await f.ledger.inspect()).state.entries).toHaveLength(1);
  } finally { await f.cleanup(); }
});

test('a separate OS process cannot acquire ownership while the broker is open', async () => {
  const f = await fixture();
  try {
    const require = createRequire(import.meta.url);
    const script = `
      const fs = require('fs'), ts = require(${JSON.stringify(require.resolve('typescript'))});
      require.extensions['.ts'] = (module, path) => module._compile(ts.transpileModule(fs.readFileSync(path, 'utf8'),
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, path);
      const { RuntimeCapacityLedger } = require(${JSON.stringify(require.resolve('../../orchestrator/server/utils/worker-runtime-capacity-ledger.ts'))});
      RuntimeCapacityLedger.open({ directory: process.argv[1], identity: ${JSON.stringify(identity)}, create: false,
        policy: ${JSON.stringify(policy)}, now: () => 2000 }).then(async owner => {
          await owner.close(); process.exitCode = 2;
        }, error => { if (error.code !== 'EEXIST') process.exitCode = 3; });
    `;
    await promisify(execFile)(process.execPath, ['-e', script, f.directory], { timeout: 10000 });
    await activate(f.ledger); await f.ledger.prepare(request());
  } finally { await f.cleanup(); }
});

test('envelope serialization rejects accessors, sparse arrays and expansion beyond bound', () => {
  let touched = false;
  const accessor = accounting(); Object.defineProperty(accessor.demands[0], 'amount', {
    enumerable: true, get: () => { touched = true; return { bytes: '1', inodes: '1' }; },
  });
  expect(() => capacityLedgerEnvelopeDigest(accessor)).toThrow('accessor'); expect(touched).toBe(false);
  const sparse = accounting(); delete sparse.demands[0];
  expect(() => capacityLedgerEnvelopeDigest(sparse)).toThrow('array');
  const large = accounting();
  (large as any).demands = Array.from({ length: 1024 }, () => 'x'.repeat(5000));
  expect(() => capacityLedgerEnvelopeDigest(large)).toThrow('data size');
});

for (const field of ['version', 'constraints', 'destinations', 'demands'] as const) {
  test(`envelope helper rejects top-level ${field} accessor without invoking it`, () => {
    let touched = false;
    const input = accounting();
    Object.defineProperty(input, field, { enumerable: true, get: () => { touched = true; throw new Error('getter ran'); } });
    expect(() => capacityLedgerEnvelopeDigest(input)).toThrow('schema');
    expect(touched).toBe(false);
  });
}

test('envelope helper rejects wrong version and extra caller fields', () => {
  expect(() => capacityLedgerEnvelopeDigest({ ...accounting(), version: 2 } as any)).toThrow('version');
  expect(() => capacityLedgerEnvelopeDigest({ ...accounting(), reservations: [] } as any)).toThrow('schema');
});

for (const point of ['write', 'file-sync', 'rename', 'directory-sync', 'acknowledge'] as const) {
  test(`persistence failure at ${point} quarantines owner and prevents acknowledgement/reopen`, async () => {
    const f = await fixture();
    try {
      await activate(f.ledger); await f.ledger.prepare(request()); f.setFault(point);
      await expect(f.ledger.reserve(request(), async req => measurement(req))).rejects.toThrow('persistence uncertain');
      await expect(f.ledger.prepare(request('two'))).rejects.toThrow('quarantined');
      f.setFault(); await f.ledger.close();
      expect(await readdir(f.directory)).toContain('writer.lock');
      await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toThrow();
      const stored = JSON.parse(await readFile(join(f.directory, 'ledger.json'), 'utf8'));
      if (point === 'directory-sync' || point === 'acknowledge') expect(stored.state.entries[0].status).toBe('reserved');
      else expect(await readdir(f.directory)).toContain('ledger.next');
    } finally { await f.cleanup(); }
  });
}

test('manual removal of stale lock alone cannot hide an unreconciled next file', async () => {
  const f = await fixture();
  try {
    await activate(f.ledger); f.setFault('rename');
    await expect(f.ledger.prepare(request())).rejects.toThrow('persistence uncertain');
    await f.ledger.close(); f.setFault();
    // OFFLINE fake-operator fixture only. Production has no lock-break API.
    await rm(join(f.directory, 'writer.lock'), { recursive: true });
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toThrow('unreconciled');
    expect(await readdir(f.directory)).toContain('ledger.next');
  } finally { await f.cleanup(); }
});

test('offline fake-operator reconciliation after durable-but-unacknowledged reserve retains it', async () => {
  const f = await fixture(); let reopened: RuntimeCapacityLedger | undefined;
  try {
    await activate(f.ledger); await f.ledger.prepare(request()); f.setFault('acknowledge');
    await expect(f.ledger.reserve(request(), async req => measurement(req))).rejects.toThrow('uncertain');
    await f.ledger.close(); f.setFault();
    // Simulated operator has stopped the only owner and reviewed ledger.json;
    // never an automatic stale lock path or inferred journal completion.
    await rm(join(f.directory, 'writer.lock'), { recursive: true });
    reopened = await RuntimeCapacityLedger.open({ ...f.options, create: false });
    expect((await reopened.inspect()).state.entries[0].status).toBe('reserved');
    await activate(reopened);
    const historical = await reopened.reserve(request(), async () => { throw new Error('must not remeasure'); });
    expect(historical.sequence).toBe('1');
  } finally { await reopened?.close(); await f.cleanup(); }
});

for (const mutate of [
  (m: any) => { m.evidence.sequence = '0'; },
  (m: any) => { m.evidence.scan.status = 'partial'; },
  (m: any) => { m.evidence.request.nonce = 'e'.repeat(64); },
  (m: any) => { m.accounting.demands[0].amount.bytes = '31'; },
  (m: any) => { m.accounting.reservations = []; },
  (m: any) => { m.accounting.constraints[0].available.bytes = '18446744073709551616'; },
  (m: any) => { m.accounting.constraints[0].available.inodes = '1'; },
  (m: any) => { m.evidence.expiresAtMs = 1600; },
]) test(`invalid or insufficient trusted adapter output does not persist reservation (${String(mutate)})`, async () => {
  const f = await fixture();
  try {
    await activate(f.ledger); await f.ledger.prepare(request());
    const value = measurement(request()); mutate(value);
    const before = await f.ledger.inspect();
    await expect(f.ledger.reserve(request(), async () => value)).rejects.toThrow();
    expect(await f.ledger.inspect()).toEqual(before);
  } finally { await f.cleanup(); }
});

test('unknown retained allocation domain cannot be excluded from later measurements', async () => {
  const f = await fixture();
  try {
    await activate(f.ledger); await f.ledger.prepare(request()); await f.ledger.reserve(request(), async req => measurement(req));
    const changed = accounting(); changed.constraints[0].id = 'new-fs'; changed.destinations[0].constraintIds = ['new-fs'];
    const next = request('two', changed); await f.ledger.prepare(next);
    await expect(f.ledger.reserve(next, async req => measurement(req, '2', changed))).rejects.toThrow('unmapped reservation');
  } finally { await f.cleanup(); }
});

test('reconciliation rejects stale review and never reduces retained reservations', async () => {
  const f = await fixture();
  try {
    const before = await f.ledger.inspect(); await activate(f.ledger); await f.ledger.prepare(request());
    await expect(f.ledger.reconcile({ expectedStateDigest: before.stateDigest, reviewDigest: 'sha256:' + 'c'.repeat(64),
      layoutGeneration: '1', maintenanceEpoch: 'epoch' })).rejects.toThrow('state changed');
    await f.ledger.reserve(request(), async req => measurement(req));
    const retained = (await f.ledger.inspect()).state.entries;
    await activate(f.ledger); expect((await f.ledger.inspect()).state.entries).toEqual(retained);
  } finally { await f.cleanup(); }
});

for (const kind of ['corrupt', 'oversize', 'symlink', 'mode', 'missing'] as const) test(`reopen rejects ${kind} state without clearing ownership lock`, async () => {
  const f = await fixture();
  try {
    await f.ledger.close(); const path = join(f.directory, 'ledger.json');
    if (kind === 'corrupt') await writeFile(path, '{broken');
    if (kind === 'oversize') await writeFile(path, ' '.repeat(4 * 1024 * 1024 + 1));
    if (kind === 'mode') await chmod(path, 0o644);
    if (kind === 'missing' || kind === 'symlink') await rm(path);
    if (kind === 'symlink') await symlink('/dev/null', path);
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toThrow();
    expect(await readdir(f.directory)).toContain('writer.lock');
  } finally { await f.cleanup(); }
});

test('stale lock has no PID, timeout, force-open or initialization override', async () => {
  const f = await fixture();
  try {
    await f.ledger.close(); await mkdir(join(f.directory, 'writer.lock'));
    for (const create of [true, false]) await expect(RuntimeCapacityLedger.open({ ...f.options, create })).rejects.toThrow();
    expect(await readdir(f.directory)).toContain('writer.lock');
  } finally { await f.cleanup(); }
});

test('shutdown closes its descriptor while ownership still blocks a second broker', async () => {
  const f = await fixture(), handle = (f.ledger as any).directoryHandle;
  const actualClose = handle.close.bind(handle); let observed = false;
  handle.close = async () => {
    observed = true; expect(await readdir(f.directory)).toContain('writer.lock');
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
    await actualClose();
  };
  try {
    await f.ledger.close(); expect(observed).toBe(true);
    expect(await readdir(f.directory)).not.toContain('writer.lock');
    const reopened = await RuntimeCapacityLedger.open({ ...f.options, create: false }); await reopened.close();
  } finally { handle.close = actualClose; await actualClose(); await f.cleanup(); }
});

test('frozen shutdown close failure retains lock and exposed native settlement', async () => {
  const f = await fixture(), native = held(), handle = (f.ledger as any).directoryHandle;
  const actualClose = handle.close.bind(handle);
  const failure = Object.freeze(attachSettlement(new Error('synthetic close failure'), native.promise));
  handle.close = async () => { await actualClose(); throw failure; };
  try {
    const error = await f.ledger.close().catch(error => error);
    expect(error[operationSettlement]).toBeInstanceOf(Promise);
    expect(await readdir(f.directory)).toContain('writer.lock');
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
    let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
    let secondClosed = false; const secondClose = f.ledger.close().then(() => { secondClosed = true; });
    await tick(); expect(settled).toBe(false); expect(secondClosed).toBe(false);
    native.reject(new Error('synthetic late close')); await settlement; await secondClose;
  } finally { native.resolve(); handle.close = actualClose; await actualClose(); await f.cleanup(); }
});

test('compound frozen shutdown sync and close failures retain both lifetimes', async () => {
  const f = await fixture(), sync = held(), close = held(), handle = (f.ledger as any).directoryHandle;
  const actualSync = handle.sync.bind(handle), actualClose = handle.close.bind(handle);
  const primary = Object.freeze(attachSettlement(new Error('synthetic sync'), sync.promise));
  const secondary = Object.freeze(attachSettlement(new Error('synthetic close'), close.promise));
  handle.sync = async () => { throw primary; };
  handle.close = async () => { await actualClose(); throw secondary; };
  try {
    const error = await f.ledger.close().catch(error => error);
    let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
    close.resolve(); await tick(); expect(settled).toBe(false);
    expect(await readdir(f.directory)).toContain('writer.lock');
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
    sync.reject(new Error('synthetic late sync')); await settlement;
  } finally { sync.resolve(); close.resolve(); handle.sync = actualSync; handle.close = actualClose; await actualClose(); await f.cleanup(); }
});

test('failed shutdown directory sync retains ownership after successful descriptor close', async () => {
  const f = await fixture(), native = held(), handle = (f.ledger as any).directoryHandle;
  const actualSync = handle.sync.bind(handle);
  const failure = Object.freeze(attachSettlement(new Error('synthetic shutdown sync'), native.promise));
  handle.sync = async () => { throw failure; };
  try {
    const error = await f.ledger.close().catch(error => error);
    expect(error.message).toBe('synthetic shutdown sync');
    expect(error[operationSettlement]).toBeInstanceOf(Promise);
    expect(await readdir(f.directory)).toContain('writer.lock');
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
    let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
    await tick(); expect(settled).toBe(false); native.resolve(); await settlement;
  } finally { native.resolve(); handle.sync = actualSync; await f.cleanup(); }
});

test('frozen failed measurement retains queued reserve and shutdown through native settlement', async () => {
  const f = await fixture(), native = held();
  const failure = Object.freeze(attachSettlement(new Error('synthetic measurement'), native.promise));
  let measured = false, closed = false;
  try {
    await activate(f.ledger); await f.ledger.prepare(request()); await f.ledger.prepare(request('two'));
    const first = f.ledger.reserve(request(), async () => { throw failure; });
    expect(await first.catch(error => error)).toBe(failure);
    const next = f.ledger.reserve(request('two'), async req => { measured = true; return measurement(req); });
    const closing = f.ledger.close().then(() => { closed = true; });
    await tick(); expect(measured).toBe(false); expect(closed).toBe(false);
    expect(await readdir(f.directory)).toContain('writer.lock');
    native.reject(new Error('synthetic late measurement')); await next; await closing;
    const reopened = await RuntimeCapacityLedger.open({ ...f.options, create: false });
    expect((await reopened.inspect()).state.entries.map(entry => entry.status)).toEqual(['pending', 'reserved']);
    await reopened.close();
  } finally { native.resolve(); await f.cleanup(); }
});

test('failed persistence combines frozen write and file-close lifetimes before shutdown', async () => {
  const write = held(), close = held(); let armed = false;
  const primary = Object.freeze(attachSettlement(new Error('synthetic write'), write.promise));
  const secondary = Object.freeze(attachSettlement(new Error('synthetic file close'), close.promise));
  const f = await fixture(async (...args) => {
    const file = await open(...args);
    if (String(args[0]).endsWith('/ledger.next')) {
      const actualClose = file.close.bind(file);
      file.close = async () => { await actualClose(); if (armed) throw secondary; };
    }
    return file;
  });
  try {
    await activate(f.ledger); armed = true;
    (f.ledger as any).options.fault = (point: CapacityLedgerFaultPoint) => { if (point === 'write') throw primary; };
    const error = await f.ledger.prepare(request()).catch(error => error);
    expect(error.message).toContain('persistence uncertain'); expect(error[operationSettlement]).toBeInstanceOf(Promise);
    let settled = false, closed = false;
    const settlement = error[operationSettlement].then(() => { settled = true; });
    const closing = f.ledger.close().then(() => { closed = true; });
    close.resolve(); await tick(); expect(settled).toBe(false); expect(closed).toBe(false);
    expect(await readdir(f.directory)).toEqual(expect.arrayContaining(['ledger.next', 'writer.lock']));
    write.reject(new Error('synthetic late write')); await settlement; await closing;
    expect(await readdir(f.directory)).toContain('writer.lock');
    await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
  } finally { write.resolve(); close.resolve(); armed = false; await f.cleanup(); }
});

for (const create of [true, false])
  test(`bootstrap ${create ? 'write' : 'read'} preserves frozen primary and both cleanup failures`, async () => {
    const f = await fixture(); const primaryLife = held(), fileLife = held(), directoryLife = held();
    const primary = Object.freeze(attachSettlement(new Error('synthetic bootstrap primary'), primaryLife.promise));
    const fileFailure = Object.freeze(attachSettlement(new Error('synthetic bootstrap file close'), fileLife.promise));
    const directoryFailure = Object.freeze(attachSettlement(new Error('synthetic bootstrap directory close'), directoryLife.promise));
    try {
      await f.ledger.close();
      if (create) await rm(join(f.directory, 'ledger.json'));
      const error = await RuntimeCapacityLedger.open({ ...f.options, create,
        fault: point => { if (create && point === 'write') throw primary; },
        openFile: async (...args) => {
          const file = await open(...args), actualClose = file.close.bind(file);
          const directory = String(args[0]) === f.directory;
          if (!directory && !create) file.read = async () => { throw primary; };
          file.close = async () => { await actualClose(); throw directory ? directoryFailure : fileFailure; };
          return file;
        },
      }).catch(error => error);
      expect(error.message).toContain(create ? 'persistence uncertain' : 'synthetic bootstrap primary');
      expect(error[operationSettlement]).toBeInstanceOf(Promise);
      let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
      fileLife.resolve(); directoryLife.reject(new Error('synthetic late bootstrap cleanup'));
      await tick(); expect(settled).toBe(false); expect(await readdir(f.directory)).toContain('writer.lock');
      primaryLife.resolve(); await settlement;
      await expect(RuntimeCapacityLedger.open({ ...f.options, create: false })).rejects.toMatchObject({ code: 'EEXIST' });
    } finally { primaryLife.resolve(); fileLife.resolve(); directoryLife.resolve(); await f.cleanup(); }
  });

test('directory assertion waits its actual pending stat sibling before reporting missing path', async () => {
  const f = await fixture(), native = held(), handle = (f.ledger as any).directoryHandle;
  const actualStat = handle.stat.bind(handle), displaced = f.directory + '.displaced';
  let entered = false, reported = false;
  handle.stat = async () => { entered = true; await native.promise; return actualStat(); };
  let assertion: Promise<any> | undefined;
  try {
    await rename(f.directory, displaced);
    assertion = (f.ledger as any).assertDirectory().catch((error: unknown) => { reported = true; return error; });
    await tick(); expect(entered).toBe(true); expect(reported).toBe(false);
    native.resolve(); expect((await assertion).code).toBe('ENOENT');
  } finally {
    native.resolve(); await assertion; handle.stat = actualStat; await rename(displaced, f.directory); await f.cleanup();
  }
});

test('directory assertion preserves failed stat settlement alongside a missing-path error', async () => {
  const f = await fixture(), native = held(), handle = (f.ledger as any).directoryHandle;
  const actualStat = handle.stat.bind(handle), displaced = f.directory + '.displaced';
  const failure = Object.freeze(attachSettlement(new Error('synthetic native stat'), native.promise));
  handle.stat = () => { throw failure; };
  try {
    await rename(f.directory, displaced);
    const error = await (f.ledger as any).assertDirectory().catch((error: unknown) => error);
    expect(error.code).toBe('ENOENT'); expect(error[operationSettlement]).toBeInstanceOf(Promise);
    let settled = false; const settlement = error[operationSettlement].then(() => { settled = true; });
    await tick(); expect(settled).toBe(false); native.reject(new Error('synthetic late stat')); await settlement;
  } finally { native.resolve(); handle.stat = actualStat; await rename(displaced, f.directory); await f.cleanup(); }
});

test('shutdown admission rejects new work while draining an already accepted reserve', async () => {
  const f = await fixture(), entered = held(), release = held(); let closing: Promise<void> | undefined;
  let reservation: Promise<unknown> | undefined;
  try {
    await activate(f.ledger); await f.ledger.prepare(request());
    reservation = f.ledger.reserve(request(), async req => { entered.resolve(); await release.promise; return measurement(req); });
    await entered.promise; closing = f.ledger.close();
    await expect(f.ledger.prepare(request('two'))).rejects.toThrow('closed');
    release.resolve(); await reservation; await closing;
    const reopened = await RuntimeCapacityLedger.open({ ...f.options, create: false });
    expect((await reopened.inspect()).state.entries[0].status).toBe('reserved'); await reopened.close();
  } finally { release.resolve(); await Promise.allSettled([reservation, closing]); await f.cleanup(); }
});

test('corrupt FIFO bootstrap rejects promptly without waiting for a writer', async () => {
  const directory = await mkdtemp('/workspace/capacity-ledger-fifo-review-');
  await chmod(directory, 0o700);
  const path = join(directory, 'ledger.json');
  await promisify(execFile)('mkfifo', ['-m', '600', path]);
  let opening: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writer: Awaited<ReturnType<typeof open>> | undefined;
  const pending = Symbol('pending FIFO open');
  try {
    opening = RuntimeCapacityLedger.open({ directory, identity, create: false, policy, now: () => 2000 })
      .then(ledger => ledger, error => error);
    const result = await Promise.race([opening,
      new Promise<typeof pending>(resolve => { timer = setTimeout(() => resolve(pending), 250); })]);
    // Release the actual native open before making the assertion, so a failing
    // regression leaves no blocked libuv thread or owned descriptor behind.
    if (result === pending) {
      writer = await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close(); writer = undefined;
    }
    const outcome = await opening;
    if (outcome instanceof RuntimeCapacityLedger) await outcome.close();
    expect(result, 'FIFO bootstrap must reject without requiring a writer').not.toBe(pending);
    expect(outcome).toMatchObject({ code: 'WORKER_RUNTIME_CAPACITY_LEDGER_HELD' });
    expect((outcome as Error).message).toContain('ledger file boundary');
    expect(await readdir(directory)).toContain('writer.lock');
  } finally {
    if (timer) clearTimeout(timer);
    await writer?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
