/** Isolated operator-broker ledger core, NOT a migration ticket or host adapter.
 *
 * Supported ownership model: ONE operator broker, protected local POSIX control
 * storage, atomic mkdir/rename and working file/directory fsync. All brokers
 * must use the same canonical directory. The persistent writer.lock is acquired
 * with mkdir, not a PID check or a process-local queue. Never delete/steal it on
 * TTL, restart or presumed process death. Crash recovery is OFFLINE operator
 * work: stop every broker, inspect ledger and any ledger.next, reconcile all
 * potentially acknowledged reservations/artifacts, then explicitly retire the
 * old lock. No automatic recovery/lock-break API is provided here. Lost control
 * storage is not permission to initialize a replacement empty ledger.
 *
 * The directory must be preprovisioned, owned by the broker uid, mode 0700, on
 * separately protected storage; its ancestors must not be mutable by clients.
 * No request selects filesystem paths or supplies accounting reservations.
 * Trusted local adapters supply measurements/fence/envelope; transport identity,
 * inventory interpretation, quotas and phase grants remain UNIMPLEMENTED.
 *
 * Every open is held for explicit reconciliation. No release/reduction API:
 * reservations, pending nonces and replay state survive terminal journals,
 * expiry and restart. Exact retries return historical records, NOT renewed
 * phase permission. All persistence uncertainty quarantines the owner and
 * leaves the exclusive lock in place for offline recovery.
 */
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, type FileHandle } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { calculateRuntimeCapacityHeadroom, type RuntimeCapacityAccountingInput } from './worker-runtime-capacity-accounting';
import { parseRuntimeCapacityMeasurementRequest, verifyRuntimeCapacityMeasurementEvidence,
  type RuntimeCapacityMeasurementRequest } from './worker-runtime-capacity-protocol';

type Identity = { hostId: string; serviceId: string; daemonId: string };
type Allocation = { constraintId: string; amount: { bytes: string; inodes: string } };
type Entry = { request: RuntimeCapacityMeasurementRequest; status: 'pending' | 'reserved';
  sequence: string; allocations: Allocation[] };
type State = { version: 1; kind: 'capacity-ledger'; identity: Identity; revision: string;
  sequence: string; lastReviewDigest: string | null; entries: Entry[] };
export type CapacityLedgerMeasurement = {
  evidence: unknown;
  accounting: Omit<RuntimeCapacityAccountingInput, 'reservations'>;
};
export type CapacityLedgerFaultPoint = 'write' | 'file-sync' | 'rename' | 'directory-sync' | 'acknowledge';
export interface CapacityLedgerOptions {
  /** Operator configuration only. Never forward a path from RPC/API input. */
  directory: string;
  identity: Identity;
  /** Explicit first-time provisioning only; refuses any existing state. */
  create: boolean;
  now: () => number;
  policy: { maxEvidenceAgeMs: number; maxLifetimeMs: number; maxScanDurationMs: number; maxScanEntries: string };
  /** Test-only fault injection, never populated by an RPC request. */
  fault?: (point: CapacityLedgerFaultPoint) => void | Promise<void>;
}
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_UINT = (1n << 64n) - 1n;
function fail(reason: string): never {
  throw Object.assign(new Error(`Capacity ledger refused: ${reason}`), { code: 'WORKER_RUNTIME_CAPACITY_LEDGER_HELD' });
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('schema');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some(k => typeof k !== 'string' || !fields.includes(k))) fail('schema');
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('schema');
    result[key] = descriptor.value;
  }
  return result;
}
function uint(value: unknown): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX_UINT) fail('uint64');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('identity');
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail('digest');
  return value;
}
function identity(value: unknown): Identity {
  const row = object(value, ['hostId', 'serviceId', 'daemonId']);
  return { hostId: token(row.hostId), serviceId: token(row.serviceId), daemonId: token(row.daemonId) };
}
/** Bounded data-only canonical JSON: accessor/prototype/symbol inputs rejected. */
function canonical(value: unknown, depth = 0, budget = { remaining: MAX_BYTES }): string {
  const charge = (bytes: number) => { budget.remaining -= bytes; if (budget.remaining < 0) fail('data size'); };
  if (depth > 16) fail('nested data');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    if (typeof value === 'string' && value.length > MAX_BYTES) fail('oversize string');
    const result = JSON.stringify(value); charge(Buffer.byteLength(result)); return result;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) {
    const result = String(value); charge(result.length); return result;
  }
  if (Array.isArray(value)) {
    if (value.length > 1024 || Reflect.ownKeys(value).length !== value.length + 1) fail('array');
    charge(2 + value.length);
    return '[' + Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !('value' in d)) fail('array');
      return canonical(d.value, depth + 1, budget);
    }).join(',') + ']';
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('data');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024 || keys.some(k => typeof k !== 'string')) fail('data keys');
  charge(2 + keys.length);
  return '{' + (keys as string[]).sort().map(key => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || !d.enumerable) fail('data accessor');
    const name = JSON.stringify(key); charge(Buffer.byteLength(name) + 1);
    return name + ':' + canonical(d.value, depth + 1, budget);
  }).join(',') + '}';
}
function encoded(value: unknown): string {
  const text = canonical(value);
  if (Buffer.byteLength(text) > MAX_BYTES) fail('state size');
  return text;
}
function hash(value: unknown): string { return 'sha256:' + createHash('sha256').update(encoded(value)).digest('hex'); }
function copy<T>(value: T): T { return JSON.parse(encoded(value)); }
export function capacityLedgerEnvelopeDigest(accounting: CapacityLedgerMeasurement['accounting']): string {
  // Versioned envelope definition for THIS isolated core. The eventual mapper
  // must separately validate inventoryDigest and enforced allocation coverage.
  const row = object(accounting, ['version', 'constraints', 'destinations', 'demands']);
  if (row.version !== 1) fail('accounting version');
  return hash({ version: 1, destinations: row.destinations, demands: row.demands });
}
function parseState(value: unknown): State {
  const row = object(value, ['version', 'kind', 'identity', 'revision', 'sequence', 'lastReviewDigest', 'entries']);
  if (row.version !== 1 || row.kind !== 'capacity-ledger' || !Array.isArray(row.entries) || row.entries.length > MAX_ENTRIES) fail('state');
  const result: State = { version: 1, kind: 'capacity-ledger', identity: identity(row.identity),
    revision: uint(row.revision), sequence: uint(row.sequence),
    lastReviewDigest: row.lastReviewDigest === null ? null : digest(row.lastReviewDigest), entries: [] };
  const operations = new Set<string>(), nonces = new Set<string>(), sequences = new Set<string>();
  for (const raw of row.entries) {
    const item = object(raw, ['request', 'status', 'sequence', 'allocations']);
    const request = parseRuntimeCapacityMeasurementRequest(item.request);
    if (Object.keys(result.identity).some(k => result.identity[k as keyof Identity] !== request.binding[k as keyof Identity])) fail('persisted identity');
    if (operations.has(request.binding.operationId) || nonces.has(request.nonce)) fail('duplicate operation/nonce');
    operations.add(request.binding.operationId); nonces.add(request.nonce);
    if (item.status !== 'pending' && item.status !== 'reserved') fail('entry status');
    const sequence = uint(item.sequence);
    if (!Array.isArray(item.allocations) || item.allocations.length > 64) fail('allocations');
    const ids = new Set<string>();
    const allocations = item.allocations.map(rawAllocation => {
      const allocation = object(rawAllocation, ['constraintId', 'amount']);
      const id = token(allocation.constraintId), amount = object(allocation.amount, ['bytes', 'inodes']);
      if (ids.has(id)) fail('duplicate allocation');
      ids.add(id);
      const bytes = uint(amount.bytes), inodes = uint(amount.inodes);
      if (bytes === '0' && inodes === '0') fail('empty allocation');
      return { constraintId: id, amount: { bytes, inodes } };
    });
    if (item.status === 'pending' ? sequence !== '0' || allocations.length !== 0 :
        sequence === '0' || allocations.length === 0 || BigInt(sequence) > BigInt(result.sequence) || sequences.has(sequence)) fail('entry consistency');
    if (item.status === 'reserved') sequences.add(sequence);
    result.entries.push({ request, status: item.status, sequence, allocations });
  }
  const highest = result.entries.reduce((n, e) => BigInt(e.sequence) > n ? BigInt(e.sequence) : n, 0n);
  if (highest.toString() !== result.sequence) fail('replay high-water mismatch');
  return result;
}

export class RuntimeCapacityLedger {
  private state!: State;
  private directoryHandle!: FileHandle;
  private directoryIdentity!: { dev: number; ino: number };
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private quarantined = false;
  private epoch: { layoutGeneration: string; maintenanceEpoch: string } | null = null;
  private constructor(private readonly options: CapacityLedgerOptions) {}

  static async open(options: CapacityLedgerOptions): Promise<RuntimeCapacityLedger> {
    const ledger = new RuntimeCapacityLedger({ ...options, identity: identity(options.identity), policy: copy(options.policy) });
    const directory = resolve(options.directory);
    if (await realpath(directory) !== directory) fail('noncanonical control directory');
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) fail('control directory ownership/mode');
    ledger.options.directory = directory;
    ledger.directoryIdentity = { dev: info.dev, ino: info.ino };
    ledger.directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      await ledger.assertDirectory();
      // A second process loses here. Existing locks are NEVER declared stale.
      await mkdir(join(directory, 'writer.lock'), { mode: 0o700 });
      await ledger.directoryHandle.sync();
      const names = await readdir(directory);
      if (names.some(name => !['writer.lock', 'ledger.json'].includes(name))) fail('unreconciled control-storage artifact');
      if (options.create) {
        if (names.includes('ledger.json')) fail('existing ledger cannot be initialized');
        ledger.state = { version: 1, kind: 'capacity-ledger', identity: identity(options.identity), revision: '0',
          sequence: '0', lastReviewDigest: null, entries: [] };
        await ledger.persist(ledger.state);
      } else {
        const file = await open(join(directory, 'ledger.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_BYTES) fail('ledger file boundary');
          const bytes = Buffer.alloc(MAX_BYTES + 1);
          let offset = 0;
          while (offset < bytes.length) {
            const read = await file.read(bytes, offset, bytes.length - offset, null);
            if (!read.bytesRead) break;
            offset += read.bytesRead;
          }
          if (offset > MAX_BYTES) fail('ledger size');
          const envelope = object(JSON.parse(bytes.subarray(0, offset).toString('utf8')), ['state', 'checksum']);
          if (digest(envelope.checksum) !== hash(envelope.state)) fail('ledger checksum');
          ledger.state = parseState(envelope.state);
          if (encoded(ledger.state.identity) !== encoded(ledger.options.identity)) fail('ledger identity changed');
        } finally { await file.close(); }
      }
      return ledger;
    } catch (error) {
      // This includes bootstrap uncertainty. Preserve any owned lock/next file.
      await ledger.directoryHandle.close();
      throw error;
    }
  }

  private async assertDirectory(): Promise<void> {
    const [path, handle] = await Promise.all([lstat(this.options.directory), this.directoryHandle.stat()]);
    if (!path.isDirectory() || path.isSymbolicLink() || path.dev !== this.directoryIdentity.dev || path.ino !== this.directoryIdentity.ino ||
        handle.dev !== path.dev || handle.ino !== path.ino || path.uid !== process.getuid?.() || (path.mode & 0o777) !== 0o700) fail('control directory changed');
  }
  private async persist(next: State): Promise<void> {
    const state = parseState(next);
    const data = encoded({ state, checksum: hash(state) }) + '\n';
    let file: FileHandle | undefined;
    try {
      await this.assertDirectory();
      file = await open(join(this.options.directory, 'ledger.next'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await this.options.fault?.('write');
      await file.writeFile(data);
      await this.options.fault?.('file-sync');
      await file.sync();
      await file.close(); file = undefined;
      await this.options.fault?.('rename');
      await rename(join(this.options.directory, 'ledger.next'), join(this.options.directory, 'ledger.json'));
      await this.options.fault?.('directory-sync');
      await this.directoryHandle.sync();
      await this.options.fault?.('acknowledge');
      this.state = state;
    } catch {
      this.quarantined = true; this.epoch = null;
      fail('persistence uncertain; offline reconciliation required');
    } finally { if (file) await file.close().catch(() => undefined); }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      if (this.closed || this.quarantined) fail('owner closed/quarantined');
      return action();
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
  /** Detached historical state; never a phase grant. */
  inspect(): Promise<{ state: State; stateDigest: string; reconciliationRequired: boolean }> {
    return this.serial(async () => ({ state: copy(this.state), stateDigest: hash(this.state), reconciliationRequired: !this.epoch }));
  }
  /** Trusted operator-adapter review only. Does not free, reduce, or renew any
   * allocation. reviewDigest attests external review; this core cannot prove it. */
  reconcile(review: unknown): Promise<void> {
    const row = object(review, ['expectedStateDigest', 'reviewDigest', 'layoutGeneration', 'maintenanceEpoch']);
    const expected = digest(row.expectedStateDigest), reviewed = digest(row.reviewDigest);
    const layoutGeneration = uint(row.layoutGeneration), maintenanceEpoch = token(row.maintenanceEpoch);
    if (layoutGeneration === '0') fail('layout generation');
    return this.serial(async () => {
      if (hash(this.state) !== expected) fail('reconciliation state changed');
      const next = copy(this.state); next.revision = uint((BigInt(next.revision) + 1n).toString()); next.lastReviewDigest = reviewed;
      await this.persist(next);
      this.epoch = { layoutGeneration, maintenanceEpoch };
    });
  }
  private assertRequest(request: RuntimeCapacityMeasurementRequest): void {
    if (!this.epoch || request.binding.layoutGeneration !== this.epoch.layoutGeneration || request.binding.maintenanceEpoch !== this.epoch.maintenanceEpoch) fail('reconciliation/fence generation required');
    if (Object.keys(this.options.identity).some(k => this.options.identity[k as keyof Identity] !== request.binding[k as keyof Identity])) fail('request identity');
  }
  /** Durably register nonce before measurement. Exact duplicates are historical
   * idempotent lookup; changed request bytes for an operation always reject. */
  prepare(value: unknown): Promise<void> {
    const request = parseRuntimeCapacityMeasurementRequest(value);
    return this.serial(async () => {
      this.assertRequest(request);
      const previous = this.state.entries.find(e => e.request.binding.operationId === request.binding.operationId);
      if (previous) { if (encoded(previous.request) !== encoded(request)) fail('operation request mismatch'); return; }
      if (this.state.entries.length >= MAX_ENTRIES || this.state.entries.some(e => e.request.nonce === request.nonce)) fail('ledger full/nonce reused');
      const now = this.options.now();
      if (!Number.isSafeInteger(now) || now < request.issuedAtMs || now >= request.expiresAtMs) fail('request freshness');
      const next = copy(this.state); next.revision = uint((BigInt(next.revision) + 1n).toString());
      next.entries.push({ request, status: 'pending', sequence: '0', allocations: [] });
      await this.persist(next);
    });
  }
  reserve(value: unknown, measure: (request: RuntimeCapacityMeasurementRequest) => Promise<CapacityLedgerMeasurement>): Promise<Entry> {
    const request = parseRuntimeCapacityMeasurementRequest(value);
    return this.serial(async () => {
      this.assertRequest(request);
      const index = this.state.entries.findIndex(e => e.request.binding.operationId === request.binding.operationId);
      const previous = this.state.entries[index];
      if (!previous || encoded(previous.request) !== encoded(request)) fail('unregistered/mismatched operation');
      if (previous.status === 'reserved') return copy(previous); // historical, never refreshed
      // Measurement is inside this owner's exclusive transaction, not captured
      // while queued behind another reservation. The adapter must prove fence,
      // layout, inventory, quotas and complete fresh measurements independently.
      const measured = await measure(copy(request));
      const measurement = object(measured, ['evidence', 'accounting']);
      const accounting = object(measurement.accounting, ['version', 'constraints', 'destinations', 'demands']);
      const detached = copy(accounting) as unknown as CapacityLedgerMeasurement['accounting'];
      if (capacityLedgerEnvelopeDigest(detached) !== request.binding.envelopeDigest) fail('envelope digest mismatch');
      const verified = verifyRuntimeCapacityMeasurementEvidence(measurement.evidence, {
        expectedRequest: request, replayState: { ...this.options.identity, sequence: this.state.sequence },
        nowMs: this.options.now(), ...this.options.policy,
      });
      const result = calculateRuntimeCapacityHeadroom({ ...detached, reservations: this.state.entries.filter(e => e.status === 'reserved')
        .map(e => ({ id: e.request.binding.operationId, allocations: e.allocations })) });
      const next = copy(this.state); next.revision = uint((BigInt(next.revision) + 1n).toString()); next.sequence = verified.nextReplayState.sequence;
      const reserved: Entry = { request, status: 'reserved', sequence: next.sequence,
        allocations: result.constraints.filter(c => c.requested.bytes !== '0' || c.requested.inodes !== '0')
          .map(c => ({ constraintId: c.id, amount: c.requested })) };
      next.entries[index] = reserved;
      await this.persist(next);
      return copy(reserved);
    });
  }
  /** Clean shutdown only. Quarantined owners retain their lock. A crash at any
   * point before durable lock removal requires offline operator recovery. */
  async close(): Promise<void> {
    const action = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true; this.epoch = null;
      try {
        if (!this.quarantined) {
          await this.assertDirectory();
          await this.directoryHandle.sync();
          await rmdir(join(this.options.directory, 'writer.lock'));
          await this.directoryHandle.sync();
        }
      } finally { await this.directoryHandle.close(); }
    });
    this.queue = action.catch(() => undefined);
    return action;
  }
}
