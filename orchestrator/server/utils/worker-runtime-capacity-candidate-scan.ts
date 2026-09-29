/** Bounded, injected-handle tree observation. NO concrete Linux filesystem
 * reader, quota/fence proof or allocation-envelope rule is implemented here.
 *
 * A future adapter must use no-follow root/openat-style child handles and
 * statx/xattr/project metadata without traversing symlinks or mount boundaries.
 * Strings here are registry identities/entry names, not an invitation to join
 * paths and follow ancestors. Directory pages must describe that same handle.
 * close() must release the exact handle. The adapter must independently bound
 * native I/O/metadata reads. Synchronous blocked native code cannot be preempted
 * by a JavaScript timer; use an isolated bounded reader process if necessary.
 *
 * Two matching passes detect observed changes; they are NOT a filesystem
 * snapshot or proof of source quiescence. Counts omit unproven allocation
 * overhead, delayed allocation, open-unlinked files and Docker intermediates.
 * No count returned here may be used as a complete demand envelope.
 */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { capacityRpcRecord as row, encodeCapacityRpcFrame, decodeCapacityRpcPayload } from './worker-runtime-capacity-rpc-schema';
import type { CandidateScanRoot } from './worker-runtime-capacity-candidate-map';

export interface CandidateNodeObservation {
  filesystemId: string; mountId: string; inode: string; projectId: string;
  kind: 'file' | 'directory' | 'symlink'; projectInherit: boolean;
  size: string; blocks512: string; links: string; mtimeNs: string; ctimeNs: string;
  xattrBytes: string; aclBytes: string;
}
export interface CandidateTreeReader<Handle> {
  openRoot(root: CandidateScanRoot, signal: AbortSignal): Promise<Handle>;
  openChild(parent: Handle, name: string, signal: AbortSignal): Promise<Handle>;
  stat(handle: Handle, signal: AbortSignal): Promise<unknown>;
  readDirectory(handle: Handle, cursor: string | null, maximum: number, signal: AbortSignal): Promise<unknown>;
  close(handle: Handle): Promise<void>;
}
export interface CandidateScanOptions {
  timeoutMs: number; maxVisitedEntries: number; maxDepth: number; maxNameBytes: number; signal?: AbortSignal;
}
type Reason = 'unsupported' | 'changed' | 'limit' | 'adapter' | 'timeout' | 'cancelled';
export type CandidateScanResult = {
  version: 1; kind: 'candidate-tree-observation'; status: 'complete'; admissionReady: false;
  metadataDigest: string; entries: string; uniqueInodes: string; regularFiles: string; directories: string; symlinks: string;
  /** Each directory entry is charged separately, even when hardlinked. This
   * anticipates possible sparse/hardlink expansion but excludes copy overhead. */
  apparentCopyBytes: string;
  /** Observed st_blocks*512, deduplicated by filesystem/inode. Not new headroom. */
  observedAllocatedBytes: string;
  observedMetadataBytes: string;
} | { version: 1; kind: 'candidate-tree-observation'; status: 'incomplete'; admissionReady: false; reason: Reason };
const MAX = (1n << 64n) - 1n;
function fail(reason: Reason): never { throw Object.assign(new Error('Candidate scan incomplete'), { scanReason: reason }); }
function uint(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX || (positive && value === '0')) fail('unsupported');
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail('unsupported');
  return value;
}
function data(value: unknown): unknown { return decodeCapacityRpcPayload(encodeCapacityRpcFrame(value).subarray(4)); }
function node(value: unknown): CandidateNodeObservation {
  const raw = row(data(value), ['filesystemId', 'mountId', 'inode', 'projectId', 'kind', 'projectInherit',
    'size', 'blocks512', 'links', 'mtimeNs', 'ctimeNs', 'xattrBytes', 'aclBytes']);
  if (!['file', 'directory', 'symlink'].includes(raw.kind as string) || typeof raw.projectInherit !== 'boolean') fail('unsupported');
  return { filesystemId: token(raw.filesystemId), mountId: uint(raw.mountId, true), inode: uint(raw.inode, true),
    projectId: uint(raw.projectId, true), kind: raw.kind as CandidateNodeObservation['kind'], projectInherit: raw.projectInherit,
    size: uint(raw.size), blocks512: uint(raw.blocks512), links: uint(raw.links, true),
    mtimeNs: uint(raw.mtimeNs), ctimeNs: uint(raw.ctimeNs), xattrBytes: uint(raw.xattrBytes), aclBytes: uint(raw.aclBytes) };
}
function root(value: unknown): CandidateScanRoot {
  const raw = row(data(value), ['id', 'path', 'filesystemId', 'mountId', 'inode', 'projectId']);
  if (typeof raw.path !== 'string' || raw.path.length > 1024 || !raw.path.startsWith('/') || raw.path === '/' ||
      raw.path.endsWith('/') || /[\x00-\x1f\x7f]/.test(raw.path) || Buffer.from(raw.path).toString('utf8') !== raw.path ||
      raw.path.split('/').slice(1).some(p => !p || p === '.' || p === '..')) fail('unsupported');
  return { id: token(raw.id), path: raw.path, filesystemId: token(raw.filesystemId), mountId: uint(raw.mountId, true),
    inode: uint(raw.inode, true), projectId: uint(raw.projectId, true) };
}
function reason(error: unknown): Reason {
  const value = (error as { scanReason?: unknown } | null)?.scanReason;
  return ['unsupported', 'changed', 'limit', 'adapter', 'timeout', 'cancelled'].includes(value as string) ? value as Reason : 'adapter';
}

/** Single owner. Abort/timeout returns incomplete promptly but retains the
 * underlying walk and exact handle cleanup in settlement(). This instance is
 * permanently held after interruption; it never launches replacement walkers.
 * Await actual settlement before disposing the reader or assuming closure.
 */
export class BoundedCapacityCandidateScanner<Handle> {
  private active = false;
  private held = false;
  private lastSettlement: Promise<void> = Promise.resolve();
  constructor(private readonly reader?: CandidateTreeReader<Handle>) {}
  settlement(): Promise<void> { return this.lastSettlement; }
  isHeld(): boolean { return this.held; }
  async scan(values: readonly CandidateScanRoot[], input: CandidateScanOptions): Promise<CandidateScanResult> {
    if (!this.reader || this.active || this.held) fail('unsupported');
    const options = { timeoutMs: input.timeoutMs, maxVisitedEntries: input.maxVisitedEntries,
      maxDepth: input.maxDepth, maxNameBytes: input.maxNameBytes, signal: input.signal };
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 30_000 ||
        !Number.isInteger(options.maxVisitedEntries) || options.maxVisitedEntries < 2 || options.maxVisitedEntries > 10_000 ||
        !Number.isInteger(options.maxDepth) || options.maxDepth < 0 || options.maxDepth > 64 ||
        !Number.isInteger(options.maxNameBytes) || options.maxNameBytes < 1 || options.maxNameBytes > 1_048_576 ||
        !Array.isArray(values) || !values.length || values.length > 32) fail('unsupported');
    const roots = values.map(root).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (new Set(roots.map(r => r.id)).size !== roots.length) fail('unsupported');
    this.active = true;
    const controller = new AbortController();
    const incomplete = (cause: Reason): CandidateScanResult => ({ version: 1, kind: 'candidate-tree-observation',
      status: 'incomplete', admissionReady: false, reason: cause });
    let finish!: (value: CandidateScanResult) => void, published = false;
    const result = new Promise<CandidateScanResult>(resolve => { finish = value => { if (!published) { published = true; resolve(value); } }; });
    const interrupt = (cause: 'timeout' | 'cancelled') => { this.held = true; controller.abort(); finish(incomplete(cause)); };
    const cancel = () => interrupt('cancelled');
    const timer = setTimeout(() => interrupt('timeout'), options.timeoutMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const running = this.walk(roots, options, controller.signal, performance.now() + options.timeoutMs);
    this.lastSettlement = running.then(value => { if (!controller.signal.aborted) finish(value); }, error => {
      const cause = reason(error);
      if (cause === 'timeout' || cause === 'cancelled') { this.held = true; controller.abort(); }
      finish(incomplete(cause));
    })
      .finally(() => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); this.active = false; });
    return result;
  }
  private async walk(roots: CandidateScanRoot[], options: CandidateScanOptions, signal: AbortSignal, deadline: number): Promise<CandidateScanResult> {
    const reader = this.reader!, opened = new Set<Handle>();
    let visited = 0, nameBytes = 0;
    const check = () => { if (signal.aborted) fail('cancelled'); if (performance.now() >= deadline) fail('timeout'); };
    const close = async (handle: Handle) => {
      // A failed close may already have released/reused a native descriptor.
      // Never retry it by numeric handle; retain an explicit held instance.
      opened.delete(handle);
      try { await reader.close(handle); } catch { this.held = true; fail('adapter'); }
    };
    try {
      const pass = async () => {
        const hash = createHash('sha256');
        let entries = 0n, files = 0n, directories = 0n, symlinks = 0n, apparent = 0n, allocated = 0n, metadata = 0n;
        const inodes = new Map<string, { observation: CandidateNodeObservation; entries: Set<string> }>();
        const add = (a: bigint, b: bigint) => { if (a + b > MAX) fail('limit'); return a + b; };
        const visit = async (handle: Handle, expected: CandidateScanRoot, relative: string, depth: number, entryKey: string) => {
          check(); if (++visited > options.maxVisitedEntries || depth > options.maxDepth || relative.length > 4096) fail('limit');
          const before = node(await reader.stat(handle, signal)); check();
          if (before.filesystemId !== expected.filesystemId || before.mountId !== expected.mountId || before.projectId !== expected.projectId ||
              (depth === 0 && (before.inode !== expected.inode || before.kind !== 'directory')) ||
              (before.kind === 'directory' && !before.projectInherit)) fail('changed');
          entries++;
          hash.update(encodeCapacityRpcFrame({ rootId: expected.id, relative, observation: before }));
          const inodeKey = before.filesystemId + ':' + before.inode;
          const previous = inodes.get(inodeKey);
          // mount IDs may differ only for separately mapped aliases of one
          // filesystem. All actual inode metadata must still agree.
          const inodeMetadata = (n: CandidateNodeObservation) => ({ ...n, mountId: '1' });
          if (previous && !encodeCapacityRpcFrame(inodeMetadata(previous.observation)).equals(encodeCapacityRpcFrame(inodeMetadata(before)))) fail('changed');
          if (previous) previous.entries.add(entryKey);
          else {
            inodes.set(inodeKey, { observation: before, entries: new Set([entryKey]) });
            allocated = add(allocated, BigInt(before.blocks512) * 512n);
            metadata = add(metadata, BigInt(before.xattrBytes) + BigInt(before.aclBytes));
          }
          if (before.kind === 'file') { files++; apparent = add(apparent, BigInt(before.size)); }
          else if (before.kind === 'symlink') { symlinks++; apparent = add(apparent, BigInt(before.size)); }
          else {
            directories++;
            const names = new Set<string>(), cursors = new Set<string>();
            let cursor: string | null = null;
            do {
              check();
              const page = row(data(await reader.readDirectory(handle, cursor, 64, signal)), ['names', 'next']); check();
              if (!Array.isArray(page.names) || page.names.length > 64 || (!page.names.length && page.next !== null) ||
                  (page.next !== null && (typeof page.next !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(page.next) || cursors.has(page.next)))) fail('unsupported');
              for (const name of page.names) {
                if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\x00-\x1f\x7f/]/.test(name) ||
                    Buffer.byteLength(name) > 255 || Buffer.from(name).toString('utf8') !== name || names.has(name)) fail('unsupported');
                nameBytes += Buffer.byteLength(name);
                if (nameBytes > options.maxNameBytes || names.size + visited >= options.maxVisitedEntries) fail('limit');
                names.add(name);
              }
              cursor = page.next as string | null;
              if (cursor !== null) cursors.add(cursor);
            } while (cursor !== null);
            for (const name of [...names].sort()) {
              check();
              const child = await reader.openChild(handle, name, signal);
              if (opened.has(child)) fail('unsupported'); opened.add(child);
              try { await visit(child, expected, relative ? relative + '/' + name : name, depth + 1,
                before.filesystemId + ':' + before.inode + ':' + name); }
              finally { await close(child); }
            }
          }
          const after = node(await reader.stat(handle, signal)); check();
          if (!encodeCapacityRpcFrame(before).equals(encodeCapacityRpcFrame(after))) fail('changed');
        };
        for (const expected of roots) {
          check(); const handle = await reader.openRoot(structuredClone(expected), signal);
          if (opened.has(handle)) fail('unsupported'); opened.add(handle);
          try { await visit(handle, expected, '', 0, 'root:' + expected.filesystemId + ':' + expected.inode); }
          finally { await close(handle); }
        }
        // Hardlinks outside the enrolled roots are not a proven bounded copy
        // source. Parent-inode/name identities keep aliases from counting the
        // same directory entry twice and hiding an external hardlink.
        for (const { observation, entries } of inodes.values())
          if (observation.kind === 'file' && BigInt(observation.links) !== BigInt(entries.size)) fail('unsupported');
        return { metadataDigest: 'sha256:' + hash.digest('hex'), entries: String(entries), uniqueInodes: String(inodes.size),
          regularFiles: String(files), directories: String(directories), symlinks: String(symlinks),
          apparentCopyBytes: String(apparent), observedAllocatedBytes: String(allocated), observedMetadataBytes: String(metadata) };
      };
      const first = await pass(), second = await pass(); check();
      if (!encodeCapacityRpcFrame(first).equals(encodeCapacityRpcFrame(second))) fail('changed');
      return { version: 1, kind: 'candidate-tree-observation', status: 'complete', admissionReady: false, ...first };
    } finally {
      // A stuck adapter close keeps settlement pending and the instance held;
      // no detached replacement cleanup loop or walker is launched.
      for (const handle of [...opened].reverse()) {
        try { await close(handle); } catch { this.held = true; }
      }
      if (opened.size) { this.held = true; fail('adapter'); }
    }
  }
}
