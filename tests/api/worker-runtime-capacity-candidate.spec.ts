import { expect, test } from '@playwright/test';
import { CAPACITY_CANDIDATE, CAPACITY_CANDIDATE_ROLES, mapCapacityCandidate,
  type CandidateMapPolicy, type CandidateScanRoot } from '../../orchestrator/server/utils/worker-runtime-capacity-candidate-map';
import { BoundedCapacityCandidateScanner, type CandidateNodeObservation, type CandidateTreeReader,
  type CandidateScanOptions } from '../../orchestrator/server/utils/worker-runtime-capacity-candidate-scan';

const identity = { hostId: 'fixture-host', serviceId: 'fixture-service', daemonId: 'fixture-daemon',
  layoutGeneration: '1', maintenanceEpoch: 'fixture-epoch' };
const builds = { engine: { packageVersion: '29.1.3-fixture', sha256: 'sha256:' + 'a'.repeat(64) },
  containerd: { packageVersion: '2.2.1-fixture', sha256: 'sha256:' + 'b'.repeat(64) },
  xfsTools: { packageVersion: 'fixture-build', sha256: 'sha256:' + 'c'.repeat(64) } };
function fixture() {
  const roots = CAPACITY_CANDIDATE_ROLES.map((role, index) => ({ id: role, role, path: '/data/' + role, projectId: String(index < 2 ? 10 : 20) }));
  const policy: CandidateMapPolicy = { adapter: CAPACITY_CANDIDATE, identity: structuredClone(identity), builds: structuredClone(builds),
    roots, physicalFloor: { bytes: '4096', inodes: '1' } };
  const input: any = { version: 1, kind: 'candidate-layout-input', identityBefore: structuredClone(identity), identityAfter: structuredClone(identity),
    platform: { os: 'ubuntu', release: '24.04', kernel: '6.8.0-142-generic', engine: '29.1.3', containerd: '2.2.1',
      kata: '4.2.0', qemu: '11.0.1', rootless: false, imageStore: 'classic', driver: 'overlay2', dockerOverlaySize: false, dind: false },
    builds: structuredClone(builds), mountinfo: '1 0 8:1 / / rw - ext4 /dev/root rw\n2 1 8:16 / /data rw - xfs /dev/fixture rw,prjquota\n',
    filesystem: { id: 'xfs-fixture', device: '8:16', type: 'xfs', ftype: 1, reflink: 0, backing: 'thick', encryption: 'none',
      projectQuotaFlags: 48, blockSize: '4096', blocks: '100000', blocksFree: '70000', blocksAvailable: '60000', inodes: '10000', inodesFree: '9000' },
    projects: [10, 20].map(id => ({ projectId: String(id), filesystemId: 'xfs-fixture',
      blockHardLimit512: '1000', blocksUsed512: '100', inodeHardLimit: '1000', inodesUsed: '100' })),
    roots: roots.map((r, index) => ({ ...r, canonicalPath: r.path, symlinkComponents: [], filesystemId: 'xfs-fixture',
      mountId: '2', inode: String(100 + index), projectInherit: true, kind: 'directory', volumeDriver: null })) };
  return { input, policy };
}
test('unsupported default never accepts observations without explicit separate candidate policy', () => {
  const { input, policy } = fixture();
  expect(() => mapCapacityCandidate(input)).toThrow();
  expect(() => mapCapacityCandidate(input, { ...policy, adapter: 'auto-detect' } as any)).toThrow();
  const mapped = mapCapacityCandidate(input, policy);
  expect(mapped.admissionReady).toBe(false); expect(mapped.kind).toBe('candidate-layout-observation');
  expect(mapped.constraints).toEqual([
    { id: 'fs:xfs-fixture', kind: 'filesystem', available: { bytes: '245760000', inodes: '9000' }, safetyFloor: { bytes: '4096', inodes: '1' } },
    { id: 'quota:xfs-fixture:10', kind: 'quota', available: { bytes: '460800', inodes: '900' }, safetyFloor: { bytes: '0', inodes: '0' } },
    { id: 'quota:xfs-fixture:20', kind: 'quota', available: { bytes: '460800', inodes: '900' }, safetyFloor: { bytes: '0', inodes: '0' } },
  ]);
});
for (const [field, value] of Object.entries({ os: 'debian', release: '22.04', kernel: 'other', engine: '29.8.1', containerd: '2.3.6',
  kata: '4.1.0', qemu: '10.0.0', rootless: true, imageStore: 'containerd', driver: 'vfs', dockerOverlaySize: true, dind: true }))
  test(`candidate rejects unsupported ${field}`, () => { const f = fixture(); f.input.platform[field] = value; expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow(); });
for (const [field, value] of Object.entries({ type: 'ext4', ftype: 0, reflink: 1, backing: 'thin', encryption: 'luks',
  projectQuotaFlags: 16, blocksAvailable: '70001', blocksFree: '100001', inodesFree: '10001', blockSize: '1000' }))
  test(`candidate rejects unsupported/contradictory filesystem ${field}`, () => { const f = fixture(); f.input.filesystem[field] = value; expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow(); });
for (const failure of ['missing-role', 'extra-root', 'symlink', 'canonical-path', 'remote-volume', 'changed-layout', 'changed-epoch',
  'changed-daemon', 'package-pin', 'mount-id', 'wrong-filesystem', 'project-inherit', 'nested-mount', 'read-only', 'quota-mount-option',
  'project-zero-limit', 'inode-zero-limit', 'unmapped-project', 'used-over-limit', 'unknown-field'])
  test(`candidate rejects ${failure}`, () => {
    const f = fixture(), r = f.input.roots[0];
    if (failure === 'missing-role') f.policy.roots.pop();
    if (failure === 'extra-root') f.input.roots.push({ ...r, id: 'foreign' });
    if (failure === 'symlink') r.symlinkComponents = ['/data/link'];
    if (failure === 'canonical-path') r.canonicalPath = '/elsewhere';
    if (failure === 'remote-volume') {
      f.policy.roots.push({ id: 'volume', role: 'worker-volume', path: '/data/volume', projectId: '30' });
      f.input.projects.push({ ...f.input.projects[0], projectId: '30' });
      f.input.roots.push({ ...r, id: 'volume', role: 'worker-volume', path: '/data/volume', canonicalPath: '/data/volume',
        projectId: '30', inode: '300', volumeDriver: 'nfs' });
    }
    if (failure === 'changed-layout') f.input.identityAfter.layoutGeneration = '2';
    if (failure === 'changed-epoch') f.input.identityAfter.maintenanceEpoch = 'next';
    if (failure === 'changed-daemon') f.input.identityBefore.daemonId = 'other';
    if (failure === 'package-pin') f.input.builds.engine.sha256 = 'sha256:' + 'd'.repeat(64);
    if (failure === 'mount-id') r.mountId = '3';
    if (failure === 'wrong-filesystem') r.filesystemId = 'other';
    if (failure === 'project-inherit') r.projectInherit = false;
    if (failure === 'nested-mount') f.input.mountinfo += '3 2 8:16 /nested /data/source-upper/nested rw - xfs /dev/fixture rw,prjquota\n';
    if (failure === 'read-only') f.input.mountinfo = f.input.mountinfo.replace('/data rw', '/data ro');
    if (failure === 'quota-mount-option') f.input.mountinfo = f.input.mountinfo.replace(',prjquota', '');
    if (failure === 'project-zero-limit') f.input.projects[0].blockHardLimit512 = '0';
    if (failure === 'inode-zero-limit') f.input.projects[0].inodeHardLimit = '0';
    if (failure === 'unmapped-project') f.input.projects.push({ ...f.input.projects[0], projectId: '99' });
    if (failure === 'used-over-limit') f.input.projects[0].blocksUsed512 = '1001';
    if (failure === 'unknown-field') f.input.quotaEnforced = true;
    expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
  });
for (const role of CAPACITY_CANDIDATE_ROLES) test(`every allocation role is mandatory: ${role}`, () => {
  const f = fixture(); f.policy.roots = f.policy.roots.filter(r => r.role !== role);
  f.input.roots = f.input.roots.filter((r: any) => r.role !== role);
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
test('inventory digest is ordered and excludes free/used counters but binds quota ceilings', () => {
  const f = fixture(), first = mapCapacityCandidate(f.input, f.policy);
  f.input.projects.reverse(); f.input.roots.reverse(); f.policy.roots.reverse();
  f.input.filesystem.blocksAvailable = '50000'; f.input.projects[0].blocksUsed512 = '200';
  expect(mapCapacityCandidate(f.input, f.policy).candidateInventoryDigest).toBe(first.candidateInventoryDigest);
  f.input.projects[0].blockHardLimit512 = '1001';
  expect(mapCapacityCandidate(f.input, f.policy).candidateInventoryDigest).not.toBe(first.candidateInventoryDigest);
});
test('distinct canonical volumes cannot share one project or borrow the daemon-store project', () => {
  const f = fixture();
  for (const id of ['volume-a', 'volume-b']) {
    f.policy.roots.push({ id, role: 'worker-volume', path: '/data/' + id, projectId: '30' });
    f.input.roots.push({ ...f.input.roots[0], id, role: 'worker-volume', path: '/data/' + id, canonicalPath: '/data/' + id,
      projectId: '30', inode: id === 'volume-a' ? '301' : '302', volumeDriver: 'local' });
  }
  f.input.projects.push({ ...f.input.projects[0], projectId: '30' });
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
  f.policy.roots.pop(); f.input.roots.pop();
  expect(mapCapacityCandidate(f.input, f.policy).roots).toHaveLength(13);
  f.policy.roots.at(-1)!.projectId = '20'; f.input.roots.at(-1).projectId = '20'; f.input.projects.pop();
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
test('bind aliases share one filesystem and one quota constraint with unchanged physical identity', () => {
  const f = fixture(), original = f.input.roots[2];
  f.policy.roots[3]!.path = '/alias/image-content';
  f.input.mountinfo += '3 1 8:16 / /alias rw - xfs /dev/fixture rw,prjquota\n';
  f.input.roots[3] = { ...original, id: 'image-layer', role: 'image-layer', path: '/alias/image-content',
    canonicalPath: '/alias/image-content', mountId: '3' };
  const mapped = mapCapacityCandidate(f.input, f.policy);
  expect(mapped.constraints).toHaveLength(3);
  expect(mapped.roots.find(r => r.id === 'image-layer')!.constraintIds).toEqual(mapped.roots.find(r => r.id === 'image-content')!.constraintIds);
  f.input.roots[3].inode = '999';
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
test('zero quota headroom stays zero and delayed frees cannot create available bytes', () => {
  const f = fixture(); f.input.projects[0].blocksUsed512 = '1000'; f.input.projects[0].inodesUsed = '1000';
  const first = mapCapacityCandidate(f.input, f.policy);
  expect(first.constraints[1]!.available).toEqual({ bytes: '0', inodes: '0' });
  f.input.filesystem.blocksAvailable = '1'; f.input.filesystem.inodesFree = '0';
  const next = mapCapacityCandidate(f.input, f.policy);
  expect(next.constraints[0]!.available).toEqual({ bytes: '4096', inodes: '0' });
  f.input.filesystem.expectedDeletionCredit = '1000000';
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
test('source writable quota cannot also be the daemon-store project', () => {
  const f = fixture();
  for (const root of f.policy.roots) root.projectId = '10';
  for (const root of f.input.roots) root.projectId = '10';
  f.input.projects = [f.input.projects[0]];
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
for (const superOptions of ['ro,prjquota', 'rw,ro,prjquota'])
  test(`superblock ${superOptions} rejects even when the VFS view says rw`, () => {
    const f = fixture();
    f.input.mountinfo = f.input.mountinfo.replace('rw,prjquota', superOptions);
    expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
  });
test('a filesystem directory inode cannot map to conflicting projects or physical paths', () => {
  const f = fixture();
  f.input.roots[2].inode = f.input.roots[0].inode;
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
  f.input.roots[2].inode = f.input.roots[3].inode;
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
});
test('mapper rejects quantity overflow and observation hooks without executing them', () => {
  const f = fixture(); f.input.filesystem.blocks = '18446744073709551615';
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow();
  let invoked = false;
  Object.defineProperty(f.input, 'roots', { enumerable: true, get() { invoked = true; return []; } });
  expect(() => mapCapacityCandidate(f.input, f.policy)).toThrow(); expect(invoked).toBe(false);
});

type Tree = { stat: CandidateNodeObservation; children?: Record<string, Tree> };
function metadata(kind: CandidateNodeObservation['kind'], inode: string, patch: Partial<CandidateNodeObservation> = {}): CandidateNodeObservation {
  return { filesystemId: 'xfs-fixture', mountId: '2', inode, projectId: '10', kind, projectInherit: kind === 'directory',
    size: kind === 'file' ? '20' : '0', blocks512: kind === 'file' ? '1' : '0', links: '1', mtimeNs: '1', ctimeNs: '1',
    xattrBytes: '0', aclBytes: '0', ...patch };
}
const scanRoot: CandidateScanRoot = { id: 'source-upper', path: '/data/source-upper', filesystemId: 'xfs-fixture', mountId: '2', inode: '100', projectId: '10' };
const limits: CandidateScanOptions = { timeoutMs: 1000, maxVisitedEntries: 100, maxDepth: 10, maxNameBytes: 10_000 };
function reader(tree: Tree) {
  const open = new Set<{ tree: Tree }>(), calls: string[] = [];
  const adapter: CandidateTreeReader<{ tree: Tree }> = {
    openRoot: async () => { calls.push('open-root'); const h = { tree }; open.add(h); return h; },
    openChild: async (parent, name) => { calls.push('open:' + name); if (!parent.tree.children?.[name]) throw new Error('missing');
      const h = { tree: parent.tree.children[name]! }; open.add(h); return h; },
    stat: async h => { calls.push('stat:' + h.tree.stat.inode); return structuredClone(h.tree.stat); },
    readDirectory: async h => ({ names: Object.keys(h.tree.children ?? {}), next: null }),
    close: async h => { calls.push('close:' + h.tree.stat.inode); expect(open.delete(h)).toBe(true); },
  };
  return { adapter, open, calls };
}
function simpleTree(): Tree { return { stat: metadata('directory', '100'), children: { data: { stat: metadata('file', '101') } } }; }
test('mapper root identity composes with injected scanner; completed observation remains non-authoritative', async () => {
  const f = fixture(), mapped = mapCapacityCandidate(f.input, f.policy), root = mapped.roots.find(r => r.id === 'source-upper')!;
  const r = reader(simpleTree());
  const result = await new BoundedCapacityCandidateScanner(r.adapter).scan([{ id: root.id, path: root.path, filesystemId: root.filesystemId,
    mountId: root.mountId, inode: root.inode, projectId: root.projectId }], limits);
  expect(result).toMatchObject({ status: 'complete', admissionReady: false, entries: '2', uniqueInodes: '2', regularFiles: '1',
    directories: '1', symlinks: '0', apparentCopyBytes: '20', observedAllocatedBytes: '512', observedMetadataBytes: '0' });
  expect(r.open.size).toBe(0); expect(r.calls.filter(c => c === 'open-root')).toHaveLength(2);
});
test('sparse/hardlinked contents count full apparent bytes per copy while allocated inode data is counted once', async () => {
  const file = { stat: metadata('file', '101', { size: '1000000', blocks512: '1', links: '2', xattrBytes: '10', aclBytes: '4' }) };
  const r = reader({ stat: metadata('directory', '100'), children: { a: file, b: file, link: { stat: metadata('symlink', '102', { size: '20' }) } } });
  const result = await new BoundedCapacityCandidateScanner(r.adapter).scan([scanRoot], limits);
  expect(result).toMatchObject({ status: 'complete', apparentCopyBytes: '2000020', observedAllocatedBytes: '512', observedMetadataBytes: '14',
    entries: '4', uniqueInodes: '3', regularFiles: '2', symlinks: '1' });
  expect(r.calls.filter(c => c === 'open:link')).toHaveLength(2); // no children or target-follow operation exists for symlink
});
for (const failure of ['device', 'mount', 'project', 'inherit', 'special', 'external-hardlink', 'stat-change', 'between-passes', 'permission',
  'depth', 'entries', 'name-budget', 'overflow', 'duplicate-name', 'path-name', 'cursor-cycle'])
  test(`scanner fails incomplete without counts for ${failure}`, async () => {
    const tree = simpleTree(), r = reader(tree), options = { ...limits }; let stats = 0;
    if (failure === 'device') tree.children!.data!.stat.filesystemId = 'other';
    if (failure === 'mount') tree.children!.data!.stat.mountId = '3';
    if (failure === 'project') tree.children!.data!.stat.projectId = '20';
    if (failure === 'inherit') tree.stat.projectInherit = false;
    if (failure === 'special') tree.children!.data!.stat.kind = 'fifo' as any;
    if (failure === 'external-hardlink') tree.children!.data!.stat.links = '2';
    if (failure === 'stat-change') { const original = r.adapter.stat; r.adapter.stat = async (h, s) => { const value: any = await original(h, s); value.mtimeNs = String(++stats); return value; }; }
    if (failure === 'between-passes') { const original = r.adapter.openRoot; r.adapter.openRoot = async (...args) => {
      if (++stats === 2) tree.children!.data!.stat.size = '21'; return original(...args); }; }
    if (failure === 'permission') r.adapter.openChild = async () => { throw new Error('EACCES'); };
    if (failure === 'depth') options.maxDepth = 0;
    if (failure === 'entries') options.maxVisitedEntries = 2;
    if (failure === 'name-budget') options.maxNameBytes = 3;
    if (failure === 'overflow') tree.children!.data!.stat.blocks512 = '18446744073709551615';
    if (failure === 'duplicate-name') r.adapter.readDirectory = async () => ({ names: ['data', 'data'], next: null });
    if (failure === 'path-name') r.adapter.readDirectory = async () => ({ names: ['../escape'], next: null });
    if (failure === 'cursor-cycle') r.adapter.readDirectory = async () => ({ names: ['data'], next: 'again' });
    const result = await new BoundedCapacityCandidateScanner(r.adapter).scan([scanRoot], options);
    expect(result.status).toBe('incomplete'); expect(result).not.toHaveProperty('entries'); expect(r.open.size).toBe(0);
  });
test('aliased roots cannot disguise an external hardlink as two observed directory entries', async () => {
  const tree = simpleTree(); tree.children!.data!.stat.links = '2'; const r = reader(tree);
  const result = await new BoundedCapacityCandidateScanner(r.adapter).scan([scanRoot, { ...scanRoot, id: 'alias', path: '/alias/source-upper' }], limits);
  expect(result).toMatchObject({ status: 'incomplete', reason: 'unsupported' }); expect(r.open.size).toBe(0);
});
test('timeout retains unsettled reader, forbids reuse, then closes the late exact handle before settlement', async () => {
  const r = reader(simpleTree()); let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const original = r.adapter.openRoot;
  r.adapter.openRoot = async (...args) => { entered(); await new Promise<void>(resolve => { release = resolve; }); return original(...args); };
  const scanner = new BoundedCapacityCandidateScanner(r.adapter), result = scanner.scan([scanRoot], { ...limits, timeoutMs: 25 });
  await started;
  expect(await result).toMatchObject({ status: 'incomplete', reason: 'timeout' });
  let settled = false; void scanner.settlement().then(() => { settled = true; });
  await expect(scanner.scan([scanRoot], limits)).rejects.toThrow(); expect(settled).toBe(false); expect(scanner.isHeld()).toBe(true);
  release(); await scanner.settlement(); expect(r.open.size).toBe(0); expect(r.calls).toEqual(['open-root', 'close:100']);
});
test('abort retains cleanup settlement and does not launch another walker', async () => {
  const r = reader(simpleTree()), cancel = new AbortController(); let release!: () => void;
  const close = r.adapter.close; r.adapter.close = async h => { await new Promise<void>(resolve => { release = resolve; }); return close(h); };
  const scanner = new BoundedCapacityCandidateScanner(r.adapter);
  const result = scanner.scan([scanRoot], { ...limits, signal: cancel.signal });
  await expect.poll(() => typeof release).toBe('function'); cancel.abort();
  expect(await result).toMatchObject({ status: 'incomplete', reason: 'cancelled' });
  r.adapter.close = close; release(); await scanner.settlement(); expect(r.open.size).toBe(0);
  await expect(scanner.scan([scanRoot], limits)).rejects.toThrow();
});
test('ambiguous close failure is never retried against a potentially reused descriptor', async () => {
  const r = reader(simpleTree()); let failed = 0; const close = r.adapter.close;
  r.adapter.close = async h => { await close(h); if (h.tree.stat.kind === 'file') { failed++; throw new Error('uncertain close'); } };
  const scanner = new BoundedCapacityCandidateScanner(r.adapter);
  expect(await scanner.scan([scanRoot], limits)).toMatchObject({ status: 'incomplete', reason: 'adapter' });
  await scanner.settlement(); expect(failed).toBe(1); expect(scanner.isHeld()).toBe(true); expect(r.open.size).toBe(0);
});
test('absolute deadline also rejects microtask-heavy adapters before a timer callback can run', async () => {
  const r = reader(simpleTree()), original = r.adapter.stat;
  r.adapter.stat = async (...args) => { const until = performance.now() + 8; while (performance.now() < until) { /* bounded synthetic CPU */ }
    return original(...args); };
  const scanner = new BoundedCapacityCandidateScanner(r.adapter);
  expect(await scanner.scan([scanRoot], { ...limits, timeoutMs: 2 })).toMatchObject({ status: 'incomplete', reason: 'timeout' });
  await scanner.settlement(); expect(scanner.isHeld()).toBe(true); expect(r.open.size).toBe(0);
});
test('settled complete scanner can be reused without leaking handles', async () => {
  const r = reader(simpleTree()), scanner = new BoundedCapacityCandidateScanner(r.adapter);
  expect((await scanner.scan([scanRoot], limits)).status).toBe('complete');
  await scanner.settlement();
  expect((await scanner.scan([scanRoot], limits)).status).toBe('complete'); expect(r.open.size).toBe(0);
});
test('no default reader and invalid bounds reject without filesystem access', async () => {
  await expect(new BoundedCapacityCandidateScanner().scan([scanRoot], limits)).rejects.toThrow();
  for (const patch of [{ timeoutMs: 0 }, { timeoutMs: 30001 }, { maxDepth: 65 }, { maxVisitedEntries: 10001 }, { maxNameBytes: 1048577 }]) {
    const r = reader(simpleTree()); await expect(new BoundedCapacityCandidateScanner(r.adapter).scan([scanRoot], { ...limits, ...patch })).rejects.toThrow();
    expect(r.calls).toEqual([]);
  }
});
