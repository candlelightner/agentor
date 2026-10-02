import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, type FileHandle } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { attachSettlement, combineSettlements } from './operation-deadline';

export const externalOperationKinds = [
  'docker-exec', 'docker-helper', 'docker-image-build', 'docker-image-pull',
  'docker-image-remove', 'orchestrator-update', 'worker-export',
] as const;
export type ExternalOperationKind = typeof externalOperationKinds[number];
export const externalOperationUncertaintyReasons = [
  'caller-timeout', 'transport-lost', 'missing-terminal-receipt', 'cleanup-failed',
] as const;
export type ExternalOperationUncertaintyReason = typeof externalOperationUncertaintyReasons[number];
export interface ExternalOperationJournalIdentity { installationId: string; daemonId: string; }
export interface ExternalOperationBinding {
  operationId: string;
  kind: ExternalOperationKind;
  ownerId: string | null;
  workerId: string | null;
  /** Full immutable Docker IDs only; names and short IDs cannot reconcile. */
  containerId: string | null;
  execId: string | null;
  /** Exact immutable content identity, never a mutable image tag or file path. */
  artifactId: string | null;
}
export interface ExternalOperationJournalEntry extends ExternalOperationBinding {
  state: 'intent' | 'uncertain' | 'terminal';
  uncertaintyReason: ExternalOperationUncertaintyReason | null;
  terminal: { outcome: 'completed' | 'failed' | 'never-started'; receiptDigest: string } | null;
}
interface JournalState {
  version: 1;
  kind: 'instance-external-operation-journal';
  identity: ExternalOperationJournalIdentity;
  revision: string;
  entries: ExternalOperationJournalEntry[];
}
export interface ExternalOperationVerificationTarget {
  identity: ExternalOperationJournalIdentity;
  operation: ExternalOperationBinding;
  bindingDigest: string;
}
export interface VerifiedExternalOperationReceipt {
  operationId: string;
  bindingDigest: string;
  receiptDigest: string;
  outcome: 'completed' | 'failed' | 'never-started';
}
export type ExternalOperationJournalFaultPoint = 'write' | 'file-sync' | 'rename' | 'directory-sync' | 'acknowledge';
export interface ExternalOperationJournalOptions {
  /** Trusted installation configuration. Preprovisioned local POSIX directory. */
  directory: string;
  identity: ExternalOperationJournalIdentity;
  /** Explicit first provisioning only. A missing existing journal is an error. */
  create: boolean;
  /** Trusted server adapter only, NEVER a callback or grant supplied by an API.
   * It must prove all native work/cleanup quiescent for this exact binding.
   * A timeout, absent PID/404, stream close, or helper exit alone cannot do so.
   * Candidate proof bytes are not stored; only the verified digest is retained. */
  verifyReceipt: (target: ExternalOperationVerificationTarget, candidate: unknown) => Promise<VerifiedExternalOperationReceipt | undefined>;
  /** Test injection only; never populated by request data. */
  fault?: (point: ExternalOperationJournalFaultPoint) => void | Promise<void>;
}

const MAX_BYTES = 512 * 1024;
const MAX_ENTRIES = 256;
const MAX_UINT = (1n << 64n) - 1n;
const filename = 'external-operations.v1.json';
const temporaryFilename = 'external-operations.next';
const lockName = 'external-operations.writer.lock';
function refused(): Error {
  return Object.assign(new Error('External operation journal is unavailable; authoritative offline reconciliation is required'),
    { code: 'INSTANCE_EXTERNAL_OPERATION_JOURNAL_HELD', statusCode: 503 });
}
function invalid(): never { throw Object.assign(new Error('Invalid external operation journal data'), { code: 'INSTANCE_EXTERNAL_OPERATION_JOURNAL_INVALID' }); }
function row(value: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || ![...fields, ...optional].includes(key)) ||
      fields.some(key => !Object.hasOwn(value, key))) invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalid();
  return value;
}
function dockerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}
function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null { return value === null ? null : parse(value); }
function identity(value: unknown): ExternalOperationJournalIdentity {
  const item = row(value, ['installationId', 'daemonId']);
  return { installationId: token(item.installationId), daemonId: token(item.daemonId) };
}
function binding(value: unknown): ExternalOperationBinding {
  const item = row(value, ['operationId', 'kind', 'ownerId', 'workerId', 'containerId', 'execId', 'artifactId']);
  if (!(externalOperationKinds as readonly unknown[]).includes(item.kind)) invalid();
  return { operationId: uuid(item.operationId), kind: item.kind as ExternalOperationKind,
    ownerId: nullable(item.ownerId, token), workerId: nullable(item.workerId, token),
    containerId: nullable(item.containerId, dockerId), execId: nullable(item.execId, dockerId),
    artifactId: nullable(item.artifactId, digest) };
}
function operationBinding(entry: ExternalOperationJournalEntry): ExternalOperationBinding {
  return binding({ operationId: entry.operationId, kind: entry.kind, ownerId: entry.ownerId, workerId: entry.workerId,
    containerId: entry.containerId, execId: entry.execId, artifactId: entry.artifactId });
}
function terminal(value: unknown): ExternalOperationJournalEntry['terminal'] {
  if (value === null) return null;
  const item = row(value, ['outcome', 'receiptDigest']);
  if (!['completed', 'failed', 'never-started'].includes(item.outcome as string)) invalid();
  return { outcome: item.outcome as NonNullable<ExternalOperationJournalEntry['terminal']>['outcome'], receiptDigest: digest(item.receiptDigest) };
}
function entry(value: unknown): ExternalOperationJournalEntry {
  const item = row(value, ['operationId', 'kind', 'ownerId', 'workerId', 'containerId', 'execId', 'artifactId', 'state', 'uncertaintyReason', 'terminal']);
  const base = binding({ operationId: item.operationId, kind: item.kind, ownerId: item.ownerId, workerId: item.workerId,
    containerId: item.containerId, execId: item.execId, artifactId: item.artifactId });
  if (!['intent', 'uncertain', 'terminal'].includes(item.state as string)) invalid();
  if (item.uncertaintyReason !== null && !(externalOperationUncertaintyReasons as readonly unknown[]).includes(item.uncertaintyReason)) invalid();
  const receipt = terminal(item.terminal);
  if (item.state === 'intent' && (item.uncertaintyReason !== null || receipt !== null) ||
      item.state === 'uncertain' && (item.uncertaintyReason === null || receipt !== null) ||
      item.state === 'terminal' && (item.uncertaintyReason !== null || receipt === null)) invalid();
  return { ...base, state: item.state as ExternalOperationJournalEntry['state'],
    uncertaintyReason: item.uncertaintyReason as ExternalOperationUncertaintyReason | null, terminal: receipt };
}
function state(value: unknown): JournalState {
  const item = row(value, ['version', 'kind', 'identity', 'revision', 'entries']);
  if (item.version !== 1 || item.kind !== 'instance-external-operation-journal' ||
      typeof item.revision !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(item.revision) || BigInt(item.revision) > MAX_UINT ||
      !Array.isArray(item.entries) || item.entries.length > MAX_ENTRIES || Reflect.ownKeys(item.entries).length !== item.entries.length + 1) invalid();
  const ids = new Set<string>();
  const entries = Array.from({ length: item.entries.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(item.entries, String(index));
    if (!descriptor || !('value' in descriptor)) invalid();
    const parsed = entry(descriptor.value);
    if (ids.has(parsed.operationId)) invalid(); ids.add(parsed.operationId); return parsed;
  });
  return { version: 1, kind: 'instance-external-operation-journal', identity: identity(item.identity), revision: item.revision, entries };
}
function hash(value: unknown): string { return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function envelope(value: JournalState): string {
  const text = JSON.stringify({ state: value, checksum: hash(value) }) + '\n';
  if (Buffer.byteLength(text) > MAX_BYTES) invalid();
  return text;
}
function copy<T>(value: T): T { return structuredClone(value); }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}

/** Isolated journal core; application admission, native transports and receipt
 * adapters must still be wired. ONE authoritative owner of protected local
 * POSIX storage, with atomic rename and working file/directory fsync.
 * Ancestors must be operator-controlled; no-follow checks cannot defend against
 * an operator concurrently replacing ancestors. No API request chooses paths.
 *
 * Intent is durable BEFORE external work starts. Terminal entries remain as
 * tombstones, and every nonterminal entry blocks readiness across restart.
 * No retry grant, reset, delete, TTL, PID check or lock stealing is provided.
 * Unclean restart, lost storage, corruption or uncertain persistence requires
 * offline reconciliation; a surviving lock/next file is never removed here.
 * These records contain typed identities/digests only: never commands, paths,
 * environment values, secrets, freeform failures or raw receipts.
 */
export class InstanceExternalOperationJournal {
  private value!: JournalState;
  private directoryHandle!: FileHandle;
  private directoryIdentity!: { dev: bigint; ino: bigint };
  private queue: Promise<unknown> = Promise.resolve();
  private quarantined = false;
  private closed = false;
  private accepting = true;
  private activeMutations = 0;
  private ownsLock = false;
  private constructor(private readonly options: ExternalOperationJournalOptions) {}

  static async open(options: ExternalOperationJournalOptions): Promise<InstanceExternalOperationJournal> {
    if (typeof options.verifyReceipt !== 'function' || typeof options.create !== 'boolean' || typeof options.directory !== 'string') invalid();
    const directory = resolve(options.directory);
    const journal = new InstanceExternalOperationJournal({ ...options, directory, identity: identity(options.identity) });
    try {
      if (directory !== options.directory || await realpath(directory) !== directory) throw refused();
      const info = await lstat(directory, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n) throw refused();
      journal.directoryIdentity = { dev: info.dev, ino: info.ino };
      journal.directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await journal.assertDirectory();
      await mkdir(join(directory, lockName), { mode: 0o700 }); journal.ownsLock = true;
      await journal.directoryHandle.sync();
      const names = await readdir(directory);
      if (names.some(name => ![filename, lockName].includes(name))) throw refused();
      if (options.create) {
        if (names.includes(filename)) throw refused();
        await journal.persist({ version: 1, kind: 'instance-external-operation-journal', identity: journal.options.identity, revision: '0', entries: [] });
      } else {
        journal.value = await journal.read();
        if (JSON.stringify(journal.value.identity) !== JSON.stringify(journal.options.identity)) throw refused();
      }
      return journal;
    } catch (error) {
      // Never remove an acquired lock on failed bootstrap, including missing
      // or corrupt state; restarting cannot silently replace uncertain state.
      let closeError: unknown;
      try { await journal.directoryHandle?.close(); } catch (failure) { closeError = failure; }
      throw attachSettlement(refused(), combineSettlements(error, closeError));
    }
  }
  private async assertDirectory(): Promise<void> {
    const [path, handle] = await Promise.all([
      lstat(this.options.directory, { bigint: true }), this.directoryHandle.stat({ bigint: true }),
    ]);
    if (!path.isDirectory() || path.isSymbolicLink() || path.dev !== this.directoryIdentity.dev || path.ino !== this.directoryIdentity.ino ||
        handle.dev !== path.dev || handle.ino !== path.ino || path.uid !== BigInt(process.getuid!()) || (path.mode & 0o777n) !== 0o700n) throw refused();
  }
  private async read(): Promise<JournalState> {
    const file = await open(join(this.options.directory, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let result: JournalState | undefined, primary: unknown, closeError: unknown;
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o777n) !== 0o600n ||
          before.size < 1n || before.size > BigInt(MAX_BYTES)) throw refused();
      const bytes = Buffer.alloc(Number(before.size) + 1); let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) break; offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (offset !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw refused();
      const text = bytes.subarray(0, offset).toString('utf8');
      const raw = row(JSON.parse(text), ['state', 'checksum']); result = state(raw.state);
      if (digest(raw.checksum) !== hash(result) || envelope(result) !== text) throw refused();
    } catch (error) { primary = error; }
    try { await file.close(); } catch (error) { closeError = error; }
    if (primary || closeError) throw attachSettlement(refused(), combineSettlements(primary, closeError));
    return result!;
  }
  private async persist(candidate: JournalState): Promise<void> {
    const next = state(candidate), text = envelope(next);
    let file: FileHandle | undefined, primary: unknown, closeError: unknown;
    try {
      await this.assertDirectory();
      file = await open(join(this.options.directory, temporaryFilename), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await this.options.fault?.('write'); await file.writeFile(text);
      await this.options.fault?.('file-sync'); await file.sync();
      await file.close(); file = undefined;
      await this.options.fault?.('rename');
      await rename(join(this.options.directory, temporaryFilename), join(this.options.directory, filename));
      await this.options.fault?.('directory-sync'); await this.directoryHandle.sync();
      await this.options.fault?.('acknowledge'); this.value = next;
    } catch (error) { primary = error; this.quarantined = true; }
    if (file) try { await file.close(); } catch (error) { closeError = error; this.quarantined = true; }
    if (primary || closeError) throw attachSettlement(refused(), combineSettlements(primary, closeError));
  }
  private serial<T>(operation: () => Promise<T>, mutating = true): Promise<T> {
    if (!this.accepting) return Promise.reject(refused());
    if (mutating) this.activeMutations++;
    const work = this.queue.then(async () => {
      if (this.closed || this.quarantined) throw refused();
      return operation();
    });
    // Register accounting before handing the work promise to the caller.
    // Successful persistence must retire its count before the caller observes
    // success; rejected work still holds the count through actual settlement.
    this.queue = work.then(() => {
      if (mutating) this.activeMutations--;
    }, async error => {
      await combineSettlements(error);
      if (mutating) this.activeMutations--;
    });
    return work;
  }
  private candidate(): JournalState {
    const next = copy(this.value);
    if (BigInt(next.revision) === MAX_UINT) throw refused();
    next.revision = (BigInt(next.revision) + 1n).toString(); return next;
  }
  private find(operationId: string): ExternalOperationJournalEntry {
    const result = this.value.entries.find(item => item.operationId === operationId);
    if (!result) throw refused(); return result;
  }
  /** Nonwriting readiness veto. It never treats a terminal caller as proof. */
  hasUnresolvedOperations(): boolean {
    return !this.accepting || this.closed || this.quarantined || this.activeMutations > 0 ||
      !this.value || this.value.entries.some(item => item.state !== 'terminal');
  }
  inspect(): Promise<{ revision: string; entries: ExternalOperationJournalEntry[]; unresolved: boolean }> {
    return this.serial(async () => ({ revision: this.value.revision, entries: copy(this.value.entries), unresolved: this.hasUnresolvedOperations() }), false);
  }
  beginIntent(input: Omit<ExternalOperationBinding, 'operationId'>): Promise<ExternalOperationJournalEntry> {
    // Parse BEFORE scheduling to detach caller values and reject accessors.
    const parsed = row(input, ['kind', 'ownerId', 'workerId', 'containerId', 'execId', 'artifactId']);
    const operation = binding({ operationId: randomUUID(), ...parsed });
    return this.serial(async () => {
      if (this.value.entries.length >= MAX_ENTRIES) throw refused();
      const next = this.candidate(), item: ExternalOperationJournalEntry = { ...operation, state: 'intent', uncertaintyReason: null, terminal: null };
      next.entries.push(item); await this.persist(next); return copy(item);
    });
  }
  bindIdentity(operationId: string, input: Partial<Pick<ExternalOperationBinding, 'containerId' | 'execId' | 'artifactId'>>): Promise<void> {
    uuid(operationId);
    const parsed = row(input, [], ['containerId', 'execId', 'artifactId']);
    if (!Object.keys(parsed).length) invalid();
    const updates: Partial<ExternalOperationBinding> = {};
    for (const key of Object.keys(parsed) as ('containerId' | 'execId' | 'artifactId')[]) updates[key] = key === 'artifactId' ? digest(parsed[key]) : dockerId(parsed[key]);
    return this.serial(async () => {
      const previous = this.find(operationId);
      if (previous.state === 'terminal') throw refused();
      for (const key of Object.keys(updates) as (keyof typeof updates)[]) if (previous[key] !== null && previous[key] !== updates[key]) throw refused();
      const next = this.candidate(), item = next.entries.find(value => value.operationId === operationId)!;
      Object.assign(item, updates); await this.persist(next);
    });
  }
  recordUncertainty(operationId: string, reason: ExternalOperationUncertaintyReason): Promise<void> {
    uuid(operationId); if (!(externalOperationUncertaintyReasons as readonly unknown[]).includes(reason)) invalid();
    return this.serial(async () => {
      if (this.find(operationId).state === 'terminal') throw refused();
      const next = this.candidate(), item = next.entries.find(value => value.operationId === operationId)!;
      item.state = 'uncertain'; item.uncertaintyReason = reason; await this.persist(next);
    });
  }
  settle(operationId: string, candidateReceipt: unknown): Promise<void> {
    uuid(operationId);
    return this.serial(async () => {
      const previous = this.find(operationId), operation = operationBinding(previous);
      const target: ExternalOperationVerificationTarget = { identity: copy(this.options.identity), operation,
        bindingDigest: hash({ identity: this.options.identity, operation }) };
      // Freeze a detached target so trusted checker bugs cannot alter the
      // expected binding or the state that will be persisted after verification.
      const verified = await this.options.verifyReceipt(frozen(copy(target)), candidateReceipt);
      if (!verified) throw refused();
      const proof = row(verified, ['operationId', 'bindingDigest', 'receiptDigest', 'outcome']);
      const receipt = terminal({ outcome: proof.outcome, receiptDigest: proof.receiptDigest })!;
      if (uuid(proof.operationId) !== operationId || digest(proof.bindingDigest) !== target.bindingDigest) throw refused();
      if (previous.state === 'terminal') {
        if (JSON.stringify(previous.terminal) !== JSON.stringify(receipt)) throw refused();
        return;
      }
      const next = this.candidate(), item = next.entries.find(value => value.operationId === operationId)!;
      item.state = 'terminal'; item.uncertaintyReason = null; item.terminal = receipt; await this.persist(next);
    });
  }
  /** Clean process shutdown only. Uncertain writers retain their durable lock.
   * Caller must already have stopped all external dispatch; pending records
   * remain durable and continue to veto snapshots after the next clean open. */
  async close(): Promise<void> {
    this.accepting = false;
    const work = this.queue.then(async () => {
      if (this.closed) return;
      this.closed = true;
      let primary: unknown, closeError: unknown;
      try {
        await this.assertDirectory();
        if (!this.quarantined && this.ownsLock) {
          // Finish all fallible writer/descriptor work BEFORE unlocking. A
          // post-unlink fsync or close failure cannot safely reacquire the lock:
          // a new owner may already hold it. Keep the lock on either failure.
          await this.directoryHandle.sync();
        }
      } catch (error) { primary = error; this.quarantined = true; }
      try { await this.directoryHandle.close(); } catch (error) { closeError = error; this.quarantined = true; }
      if (primary || closeError) throw attachSettlement(refused(), combineSettlements(primary, closeError));
      if (!this.quarantined && this.ownsLock) {
        try {
          // Final native operation, under the protected local POSIX contract.
          // No fallible I/O follows successful release. A power loss can leave
          // the old lock durable: that conservative veto needs offline review.
          // The next owner's exclusive mkdir + directory fsync persists its
          // ownership before it can admit any work.
          await rmdir(join(this.options.directory, lockName)); this.ownsLock = false;
        } catch (error) {
          this.quarantined = true;
          throw attachSettlement(refused(), combineSettlements(error));
        }
      }
    });
    this.queue = work.then(() => undefined, async error => { await combineSettlements(error); });
    return work;
  }
}
