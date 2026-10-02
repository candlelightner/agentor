/** Operator-only Linux CandidateTreeReader. This observation adapter grants no
 * admission, layout/quota support, enforcement, maintenance or generation proof.
 * Construct from protected local operator policy, NEVER request/backup paths.
 * The filesystemId convention is linuxfs:dev-major:dev-minor:statfs-fsid-hex;
 * the independent mapper/enrollment must use and verify that same identity.
 * The helper first obtains O_PATH no-follow handles, rejects special files,
 * then reopens verified file/dir inodes through its pinned kernel procfs fd
 * directory for ioctl/xattr reads. It never reopens the supplied entry name.
 * statx mount/inode identities are process-namespace observations, not durable
 * host generation attestations. Symlinks are deliberately unsupported here.
 *
 * The operator must protect the helper and enrolled storage from unrelated
 * modification, and provide O_NOATIME read permissions. Helper pin acquisition
 * is bounded with exposed actual settlement; no timed-out verification spawns
 * a helper. The ELF is executed through its verified descriptor (no PATH/shell).
 * Each session owns one child, bounded queues/frames/time/native resources and
 * opaque handles. No replacement child is launched after interruption. Abort
 * makes in-flight methods wait for actual child AND pipe closure, so the
 * scanner's prompt incomplete result retains its cleanup in settlement().
 * Always await scanner.settlement() and reader.dispose() before disposal.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { posix } from 'node:path';
import { attachSettlement, combineSettlements, withOperationDeadline } from './operation-deadline';
import { capacityRpcRecord as row, decodeCapacityRpcPayload, encodeCapacityRpcFrame } from './worker-runtime-capacity-rpc-schema';
import type { CandidateScanRoot } from './worker-runtime-capacity-candidate-map';
import type { CandidateNodeObservation, CandidateTreeReader } from './worker-runtime-capacity-candidate-scan';

export interface LinuxCapacityReaderPolicy {
  helper: { path: string; sha256: string; uid: number };
  roots: readonly CandidateScanRoot[];
  operationTimeoutMs: number;
  sessionTimeoutMs: number;
}
/** Identity of this JS object is the capability. Numeric/native IDs are private. */
export interface LinuxCapacityHandle { readonly kind: 'linux-capacity-handle' }
type ScanReason = 'unsupported' | 'changed' | 'limit' | 'adapter' | 'timeout' | 'cancelled';
function failure(scanReason: ScanReason): Error {
  return Object.assign(new Error('Linux capacity observation incomplete; no admission authority'), { scanReason });
}
/** Keep the deadline thunk alive through failed native work AND cleanup. Merely
 * attaching a nested settlement to its rejection would let the outer deadline's
 * settlement retire early. Never mutate a frozen native/deadline error or return
 * native error text that can contain operator paths. */
async function failedAcquisition(primary: unknown, ...cleanup: unknown[]): Promise<never> {
  const settlement = combineSettlements(primary, ...cleanup);
  await settlement;
  const reason = (primary as { scanReason?: ScanReason } | undefined)?.scanReason;
  throw attachSettlement(failure(reason && ['unsupported', 'changed', 'limit', 'adapter', 'timeout', 'cancelled'].includes(reason)
    ? reason : 'adapter'), settlement);
}
function uint(value: unknown, positive = true): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n || (positive && value === '0')) throw failure('unsupported');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw failure('unsupported');
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || value === '/' || !value.startsWith('/') || value.endsWith('/') || Buffer.byteLength(value) > 1024 ||
    posix.normalize(value) !== value || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw failure('unsupported');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || Buffer.byteLength(value) > 255 ||
    /[\x00-\x1f\x7f/]/.test(value) || Buffer.from(value).toString('utf8') !== value) throw failure('unsupported');
  return value;
}
function root(value: unknown): CandidateScanRoot {
  const v = row(value, ['id', 'path', 'filesystemId', 'mountId', 'inode', 'projectId']);
  return { id: token(v.id), path: path(v.path), filesystemId: token(v.filesystemId),
    mountId: uint(v.mountId), inode: uint(v.inode), projectId: uint(v.projectId) };
}
function identity(value: unknown) {
  const v = row(value, ['filesystemId', 'inode', 'kind', 'mountId']);
  if (v.kind !== 'file' && v.kind !== 'directory') throw failure('unsupported');
  return { filesystemId: token(v.filesystemId), inode: uint(v.inode), kind: v.kind, mountId: uint(v.mountId) };
}
function observation(value: unknown): CandidateNodeObservation {
  const v = row(value, ['filesystemId', 'mountId', 'inode', 'projectId', 'kind', 'projectInherit',
    'size', 'blocks512', 'links', 'mtimeNs', 'ctimeNs', 'xattrBytes', 'aclBytes']);
  if ((v.kind !== 'file' && v.kind !== 'directory') || typeof v.projectInherit !== 'boolean') throw failure('unsupported');
  return { filesystemId: token(v.filesystemId), mountId: uint(v.mountId), inode: uint(v.inode), projectId: uint(v.projectId),
    kind: v.kind, projectInherit: v.projectInherit, size: uint(v.size, false), blocks512: uint(v.blocks512, false),
    links: uint(v.links), mtimeNs: uint(v.mtimeNs, false), ctimeNs: uint(v.ctimeNs, false),
    xattrBytes: uint(v.xattrBytes, false), aclBytes: uint(v.aclBytes, false) };
}
type Entry = { native: string; identity: ReturnType<typeof identity>; state: 'open' | 'closing' | 'closed' };

/** @internal Bounded descriptor-byte primitive for the pinned ELF verifier.
 * This does not open paths, enroll roots, construct readers or grant admission.
 * Exported separately so growth/truncation can be reproduced deterministically.
 */
export async function readBoundedLinuxCapacityHelper(file: Pick<FileHandle, 'read'>, expectedBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!Number.isInteger(expectedBytes) || expectedBytes < 4 || expectedBytes > 1048576) throw failure('limit');
  const bytes = Buffer.alloc(expectedBytes);
  let offset = 0;
  while (offset < bytes.length) {
    signal.throwIfAborted();
    const read = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!Number.isInteger(read.bytesRead) || read.bytesRead <= 0 || read.bytesRead > bytes.length - offset) throw failure('changed');
    offset += read.bytesRead;
  }
  signal.throwIfAborted();
  if ((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead) throw failure('changed');
  signal.throwIfAborted();
  return bytes;
}

export class LinuxCapacityCandidateReader implements CandidateTreeReader<LinuxCapacityHandle> {
  private readonly handles = new Map<LinuxCapacityHandle, Entry>();
  private readonly nativeHandles = new Set<string>();
  private readonly roots: Map<string, CandidateScanRoot>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly closed: Promise<void>;
  private readonly sessionTimer: ReturnType<typeof setTimeout>;
  private held = false;
  private ended = false;
  private stopReason: Error = failure('adapter');
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;
  private output = Buffer.alloc(0);
  private stderrBytes = 0;
  private pending?: { resolve(value: unknown): void; reject(error: unknown): void };

  private constructor(child: ChildProcessWithoutNullStreams, private readonly policy: LinuxCapacityReaderPolicy) {
    this.child = child;
    this.roots = new Map(policy.roots.map(r => [r.id, r]));
    this.closed = new Promise(resolve => {
      child.once('close', () => {
        this.ended = true; this.held = true; clearTimeout(this.sessionTimer);
        this.pending?.reject(this.stopReason); this.pending = undefined;
        resolve();
      });
    });
    child.on('error', () => { void this.stop(failure('adapter')); });
    for (const pipe of [child.stdin, child.stdout, child.stderr]) pipe.on('error', () => { void this.stop(failure('adapter')); });
    child.stderr.on('data', (bytes: Buffer) => {
      this.stderrBytes += bytes.length;
      // This helper never emits diagnostics/paths; any stderr is unexpected.
      if (this.stderrBytes) void this.stop(failure(this.stderrBytes > 4096 ? 'limit' : 'adapter'));
    });
    child.stdout.on('data', (bytes: Buffer) => {
      if (this.held) return;
      if (!this.pending || this.output.length + bytes.length > 65537) { void this.stop(failure('limit')); return; }
      this.output = Buffer.concat([this.output, bytes]);
      const end = this.output.indexOf(10);
      if (end < 0) return;
      try {
        if (end !== this.output.length - 1) throw failure('adapter');
        const value = decodeCapacityRpcPayload(this.output.subarray(0, end));
        this.output = Buffer.alloc(0);
        const pending = this.pending; this.pending = undefined; pending.resolve(value);
      } catch { void this.stop(failure('adapter')); }
    });
    this.sessionTimer = setTimeout(() => { void this.stop(failure('timeout')); }, policy.sessionTimeoutMs);
  }

  static async create(input: LinuxCapacityReaderPolicy): Promise<LinuxCapacityCandidateReader> {
    let policy: LinuxCapacityReaderPolicy;
    try {
      const copy = decodeCapacityRpcPayload(encodeCapacityRpcFrame(input).subarray(4));
      const p = row(copy, ['helper', 'roots', 'operationTimeoutMs', 'sessionTimeoutMs']);
      const helper = row(p.helper, ['path', 'sha256', 'uid']);
      if (process.platform !== 'linux' || typeof helper.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(helper.sha256) ||
          !Number.isInteger(helper.uid) || (helper.uid as number) < 0 || (helper.uid as number) > 4294967295 ||
          !Array.isArray(p.roots) || p.roots.length < 1 || p.roots.length > 32 ||
          !Number.isInteger(p.operationTimeoutMs) || (p.operationTimeoutMs as number) < 20 || (p.operationTimeoutMs as number) > 30000 ||
          !Number.isInteger(p.sessionTimeoutMs) || (p.sessionTimeoutMs as number) < (p.operationTimeoutMs as number) || (p.sessionTimeoutMs as number) > 30000) throw failure('unsupported');
      const roots = p.roots.map(root);
      if (new Set(roots.map(r => r.id)).size !== roots.length) throw failure('unsupported');
      policy = { helper: { path: path(helper.path), sha256: helper.sha256, uid: helper.uid as number }, roots,
        operationTimeoutMs: p.operationTimeoutMs as number, sessionTimeoutMs: p.sessionTimeoutMs as number };
    } catch { throw failure('unsupported'); }

    const executable = await withOperationDeadline(async signal => {
      let file: FileHandle | undefined;
      try {
        file = await open(policy.helper.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOATIME);
        const before = await file.stat({ bigint: true });
        if (!before.isFile() || before.size < 4n || before.size > 1048576n || before.uid !== BigInt(policy.helper.uid) ||
            (before.mode & 0o6022n) !== 0n || (before.mode & 0o100n) === 0n || before.nlink !== 1n) throw failure('unsupported');
        const bytes = await readBoundedLinuxCapacityHelper(file, Number(before.size), signal);
        const after = await file.stat({ bigint: true });
        if (bytes.length !== Number(before.size) || bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
            before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode ||
            before.uid !== after.uid || before.gid !== after.gid || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
            'sha256:' + createHash('sha256').update(bytes).digest('hex') !== policy.helper.sha256) throw failure('changed');
        signal.throwIfAborted();
        return file;
      } catch (error) {
        let closeError: unknown;
        try { await file?.close(); } catch (failure) { closeError = failure; }
        return failedAcquisition(error, closeError);
      }
    }, policy.operationTimeoutMs, 'Linux capacity helper verification');

    let reader: LinuxCapacityCandidateReader | undefined;
    let closeAttempted = false;
    try {
      // fd3 is dup'd into the exact child before exec; no reopen after hashing.
      const child = spawn('/proc/self/fd/3', [], { cwd: '/', env: { LANG: 'C', LC_ALL: 'C' },
        stdio: ['pipe', 'pipe', 'pipe', executable.fd] }) as ChildProcessWithoutNullStreams;
      reader = new LinuxCapacityCandidateReader(child, policy);
      closeAttempted = true;
      await executable.close();
      const ping = row(await reader.command('PING', undefined), ['ok', 'version']);
      if (ping.ok !== true || ping.version !== 1) throw failure('unsupported');
      return reader;
    } catch (error) {
      let disposeError: unknown, closeError: unknown;
      try { await reader?.dispose(); } catch (failure) { disposeError = failure; }
      // Retain the first close failure's actual settlement, rather than treating
      // an idempotent second close as proof that the first operation settled.
      if (!closeAttempted) try { await executable.close(); } catch (failure) { closeError = failure; }
      return failedAcquisition(error, disposeError, closeError);
    }
  }

  isHeld(): boolean { return this.held; }
  /** Actual child/stdio finalization; pending after uninterruptible native I/O. */
  settlement(): Promise<void> { return this.closed; }
  private stop(error: Error): Promise<void> {
    if (!this.held) { this.held = true; this.stopReason = error; if (!this.ended) this.child.kill('SIGKILL'); }
    return this.closed;
  }
  async dispose(): Promise<void> {
    await this.stop(failure('cancelled'));
    await this.tail;
    this.handles.clear(); this.nativeHandles.clear();
  }
  private entry(handle: LinuxCapacityHandle): Entry {
    const entry = this.handles.get(handle);
    if (!entry || entry.state !== 'open') throw failure('unsupported');
    return entry;
  }
  private command(command: string, signal: AbortSignal | undefined): Promise<unknown> {
    if (Buffer.byteLength(command) > 2046 || command.includes('\n') || command.includes('\r')) return Promise.reject(failure('limit'));
    if (this.queued >= 32) return Promise.reject(failure('limit'));
    this.queued++;
    const run = this.tail.then(async () => {
      if (signal?.aborted) await this.stop(failure('cancelled'));
      if (this.held) { await this.closed; throw this.stopReason; }
      const abort = () => { void this.stop(failure('cancelled')); };
      const timer = setTimeout(() => { void this.stop(failure('timeout')); }, this.policy.operationTimeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      try {
        const response = new Promise<unknown>((resolve, reject) => { this.pending = { resolve, reject }; });
        const written = new Promise<void>((resolve, reject) => {
          this.child.stdin.write(command + '\n', error => { if (error) { void this.stop(failure('adapter')); reject(error); } else resolve(); });
        });
        const [value] = await Promise.all([response, written]);
        if (this.held) { await this.closed; throw this.stopReason; }
        if (!value || typeof value !== 'object') throw failure('adapter');
        const ok = Object.getOwnPropertyDescriptor(value, 'ok');
        if (!ok || !('value' in ok)) throw failure('adapter');
        if (ok.value === false) {
          const err = row(value, ['ok', 'reason']);
          if (!['unsupported', 'changed', 'limit', 'adapter'].includes(err.reason as string)) throw failure('adapter');
          throw failure(err.reason as ScanReason);
        }
        if (ok.value !== true) throw failure('adapter');
        return value;
      } catch (error) {
        if (!(error as { scanReason?: string })?.scanReason) await this.stop(failure('adapter'));
        if (this.held) await this.closed;
        throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    }).finally(() => { this.queued--; });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
  private async opened(command: string, expected: Pick<CandidateScanRoot, 'filesystemId' | 'mountId'> & { inode?: string }, signal: AbortSignal): Promise<LinuxCapacityHandle> {
    try {
      const value = row(await this.command(command, signal), ['ok', 'handle', 'identity']);
      const native = uint(value.handle), actual = identity(value.identity);
      if (this.nativeHandles.has(native) || actual.filesystemId !== expected.filesystemId || actual.mountId !== expected.mountId ||
          (expected.inode !== undefined && (actual.inode !== expected.inode || actual.kind !== 'directory'))) throw failure('changed');
      const handle: LinuxCapacityHandle = Object.freeze({ kind: 'linux-capacity-handle' });
      this.handles.set(handle, { native, identity: actual, state: 'open' }); this.nativeHandles.add(native);
      return handle;
    } catch (error) {
      // Unknown/contradictory handle replies cannot be cleaned up by guessing an
      // fd/token. Terminate the sole process and await all kernel descriptor close.
      await this.stop((error as Error)); throw error;
    }
  }
  async openRoot(requested: CandidateScanRoot, signal: AbortSignal): Promise<LinuxCapacityHandle> {
    let enrolled: CandidateScanRoot;
    try {
      const input = root(decodeCapacityRpcPayload(encodeCapacityRpcFrame(requested).subarray(4)));
      const trusted = this.roots.get(input.id);
      if (!trusted || !encodeCapacityRpcFrame(input).equals(encodeCapacityRpcFrame(trusted))) throw failure('unsupported');
      enrolled = trusted;
    } catch { throw failure('unsupported'); }
    return this.opened('ROOT\t' + enrolled.path, enrolled, signal);
  }
  async openChild(parent: LinuxCapacityHandle, childName: string, signal: AbortSignal): Promise<LinuxCapacityHandle> {
    const entry = this.entry(parent);
    if (entry.identity.kind !== 'directory') throw failure('unsupported');
    return this.opened('CHILD\t' + entry.native + '\t' + name(childName), {
      filesystemId: entry.identity.filesystemId, mountId: entry.identity.mountId,
    }, signal);
  }
  async stat(handle: LinuxCapacityHandle, signal: AbortSignal): Promise<CandidateNodeObservation> {
    const entry = this.entry(handle), result = row(await this.command('STAT\t' + entry.native, signal), ['ok', 'value']);
    const actual = observation(result.value);
    if (actual.filesystemId !== entry.identity.filesystemId || actual.mountId !== entry.identity.mountId ||
        actual.inode !== entry.identity.inode || actual.kind !== entry.identity.kind) {
      await this.stop(failure('changed')); throw failure('changed');
    }
    return actual;
  }
  async readDirectory(handle: LinuxCapacityHandle, cursor: string | null, maximum: number, signal: AbortSignal): Promise<unknown> {
    const entry = this.entry(handle);
    if (entry.identity.kind !== 'directory' || (cursor !== null && !/^[1-9][0-9]{0,19}$/.test(cursor)) ||
        !Number.isInteger(maximum) || maximum < 1 || maximum > 64) throw failure('unsupported');
    const response = row(await this.command('DIR\t' + entry.native + '\t' + (cursor ?? '-') + '\t' + maximum, signal), ['ok', 'value']);
    const page = row(response.value, ['names', 'next']);
    if (!Array.isArray(page.names) || page.names.length > maximum || (page.next !== null && typeof page.next !== 'string')) throw failure('adapter');
    const names = page.names.map(name);
    if (new Set(names).size !== names.length) throw failure('adapter');
    return { names, next: page.next === null ? null : uint(page.next) };
  }
  async close(handle: LinuxCapacityHandle): Promise<void> {
    const entry = this.entry(handle); entry.state = 'closing';
    try {
      if (this.held) await this.closed;
      else {
        const reply = row(await this.command('CLOSE\t' + entry.native, undefined), ['ok']);
        if (reply.ok !== true) throw failure('adapter');
      }
    } catch (error) { await this.stop(failure('adapter')); throw error; }
    finally { entry.state = 'closed'; this.handles.delete(handle); this.nativeHandles.delete(entry.native); }
  }
}
