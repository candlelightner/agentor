/** OFFLINE candidate-layout interpreter; no host reader or enforcement adapter.
 *
 * Matching this proposed matrix means only that supplied observations are
 * internally consistent. It NEVER establishes support, quota enforcement,
 * maintenance exclusion, a complete envelope or admission. No default adapter
 * exists. Operator package pins and enrolled paths must be supplied separately
 * from observations; synthetic fixtures are not an acceptance manifest.
 *
 * A future Linux adapter must obtain these observations with pinned read-only
 * interfaces and no-follow handles, including effective Docker write paths,
 * xfs geometry/dquot state, backing topology and before/after generation. This
 * module cannot verify the truth or completeness of an adapter's observations.
 * This interpreter covers DATA allocation domains only. A separate mandatory
 * control-storage adapter must prove that broker ledger/orchestrator journals
 * are protected on a distinct domain before any reservation or phase grant.
 * That adapter is not implemented here; absence must never mean approval.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { capacityRpcRecord as row, encodeCapacityRpcFrame, decodeCapacityRpcPayload } from './worker-runtime-capacity-rpc-schema';

export const CAPACITY_CANDIDATE = 'ubuntu24.04-engine29.1.3-overlay2-xfs-v1';
export const CAPACITY_CANDIDATE_ROLES = ['source-upper', 'source-work', 'image-content', 'image-layer',
  'image-snapshot', 'commit-temporary', 'extract-temporary', 'daemon-metadata', 'volume-parent',
  'helper-parent', 'replacement-parent', 'rollback-parent'] as const;
type Role = typeof CAPACITY_CANDIDATE_ROLES[number] | 'worker-volume' | 'shared-account';
export interface CandidateScanRoot {
  id: string; path: string; filesystemId: string; mountId: string; inode: string; projectId: string;
}
export interface CandidateBuildPins {
  engine: { packageVersion: string; sha256: string };
  containerd: { packageVersion: string; sha256: string };
  xfsTools: { packageVersion: string; sha256: string };
}
export interface CandidateMapPolicy {
  adapter: typeof CAPACITY_CANDIDATE;
  identity: { hostId: string; serviceId: string; daemonId: string; layoutGeneration: string; maintenanceEpoch: string };
  builds: CandidateBuildPins;
  roots: Array<{ id: string; role: Role; path: string; projectId: string }>;
  physicalFloor: { bytes: string; inodes: string };
}
export interface CandidateMappedObservation {
  version: 1; kind: 'candidate-layout-observation'; admissionReady: false;
  candidateInventoryDigest: string;
  roots: Array<CandidateScanRoot & { role: Role; constraintIds: string[] }>;
  constraints: Array<{ id: string; kind: 'filesystem' | 'quota';
    available: { bytes: string; inodes: string }; safetyFloor: { bytes: string; inodes: string } }>;
}
const MAX = (1n << 64n) - 1n;
function fail(): never {
  throw Object.assign(new Error('Capacity candidate layout unsupported or inconsistent; no admission authority'),
    { code: 'WORKER_RUNTIME_CAPACITY_LAYOUT_UNSUPPORTED' });
}
function uint(value: unknown, positive = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > MAX || (positive && value === '0')) fail();
  return value;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) fail();
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/') || value === '/' ||
      /[\x00-\x1f\x7f]/.test(value) || posix.normalize(value) !== value || value.endsWith('/') ||
      Buffer.from(value).toString('utf8') !== value) fail();
  return value;
}
function array(value: unknown, maximum = 32): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) fail();
  return value;
}
function same(a: unknown, b: unknown): boolean { return encodeCapacityRpcFrame(a).equals(encodeCapacityRpcFrame(b)); }
function detached(value: unknown): unknown { return decodeCapacityRpcPayload(encodeCapacityRpcFrame(value).subarray(4)); }
function builds(value: unknown): CandidateBuildPins {
  const packages = row(value, ['engine', 'containerd', 'xfsTools']);
  for (const value of Object.values(packages)) {
    const entry = row(value, ['packageVersion', 'sha256']);
    if (typeof entry.packageVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.+:~_-]{0,127}$/.test(entry.packageVersion) ||
        typeof entry.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.sha256)) fail();
  }
  if (!/(^|:)29\.1\.3($|[-+~])/.test((packages.engine as { packageVersion: string }).packageVersion) ||
      !/(^|:)2\.2\.1($|[-+~])/.test((packages.containerd as { packageVersion: string }).packageVersion)) fail();
  return packages as unknown as CandidateBuildPins;
}
function role(value: unknown): Role {
  if (typeof value !== 'string' || ![...CAPACITY_CANDIDATE_ROLES, 'worker-volume', 'shared-account'].includes(value)) fail();
  return value as Role;
}
function identity(value: unknown) {
  const valueRow = row(value, ['hostId', 'serviceId', 'daemonId', 'layoutGeneration', 'maintenanceEpoch']);
  return { hostId: token(valueRow.hostId), serviceId: token(valueRow.serviceId), daemonId: token(valueRow.daemonId),
    layoutGeneration: uint(valueRow.layoutGeneration, true), maintenanceEpoch: token(valueRow.maintenanceEpoch) };
}
function contains(parent: string, child: string): boolean { return parent === '/' || child === parent || child.startsWith(parent + '/'); }
type Mount = { id: string; device: string; root: string; point: string; fs: string; options: string[]; superOptions: string[] };
/** Linux mountinfo syntax only; data is never opened or followed. */
function mounts(value: unknown): Mount[] {
  if (typeof value !== 'string' || value.length > 32_768 || !value.endsWith('\n')) fail();
  const lines = value.slice(0, -1).split('\n');
  if (!lines.length || lines.length > 128) fail();
  const ids = new Set<string>(), points = new Set<string>();
  const decode = (v: string) => {
    if (/\\(?!040|011|012|134)/.test(v)) fail();
    return v.replace(/\\(040|011|012|134)/g, (_, code) => String.fromCharCode(parseInt(code, 8)));
  };
  return lines.map(line => {
    const fields = line.split(' '), separator = fields.indexOf('-');
    if (separator < 6 || fields.length !== separator + 4 || fields.some(v => !v)) fail();
    const id = uint(fields[0], true); uint(fields[1]);
    if (ids.has(id) || !/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(fields[2]!)) fail();
    const root = decode(fields[3]!), point = decode(fields[4]!);
    if (root !== '/') path(root); if (point !== '/') path(point);
    if (points.has(point)) fail(); ids.add(id); points.add(point);
    return { id, device: fields[2]!, root, point, fs: fields[separator + 1]!,
      options: fields[5]!.split(','), superOptions: fields[separator + 3]!.split(',') };
  });
}
function multiply(a: string, b: string): string { const value = BigInt(a) * BigInt(b); if (value > MAX) fail(); return String(value); }

export function mapCapacityCandidate(observation: unknown, trustedPolicy?: CandidateMapPolicy): CandidateMappedObservation {
  try {
    if (!trustedPolicy) fail();
    const policy = row(detached(trustedPolicy), ['adapter', 'identity', 'builds', 'roots', 'physicalFloor']);
    if (policy.adapter !== CAPACITY_CANDIDATE) fail();
    const expectedIdentity = identity(policy.identity), expectedBuilds = builds(policy.builds);
    const input = row(detached(observation), ['version', 'kind', 'identityBefore', 'identityAfter', 'platform',
      'builds', 'mountinfo', 'filesystem', 'projects', 'roots']);
    if (input.version !== 1 || input.kind !== 'candidate-layout-input' ||
        !same(identity(input.identityBefore), expectedIdentity) || !same(identity(input.identityAfter), expectedIdentity) ||
        !same(builds(input.builds), expectedBuilds)) fail();
    const platform = row(input.platform, ['os', 'release', 'kernel', 'engine', 'containerd', 'kata', 'qemu',
      'rootless', 'imageStore', 'driver', 'dockerOverlaySize', 'dind']);
    if (!same(platform, { os: 'ubuntu', release: '24.04', kernel: '6.8.0-142-generic', engine: '29.1.3',
      containerd: '2.2.1', kata: '4.2.0', qemu: '11.0.1', rootless: false,
      imageStore: 'classic', driver: 'overlay2', dockerOverlaySize: false, dind: false })) fail();
    const filesystem = row(input.filesystem, ['id', 'device', 'type', 'ftype', 'reflink', 'backing', 'encryption',
      'projectQuotaFlags', 'blockSize', 'blocks', 'blocksFree', 'blocksAvailable', 'inodes', 'inodesFree']);
    const fsId = token(filesystem.id), device = filesystem.device;
    if (fsId.length > 64) fail(); // Keep derived accounting constraint IDs bounded.
    if (typeof device !== 'string' || !/^[0-9]+:[0-9]+$/.test(device) || filesystem.type !== 'xfs' ||
        filesystem.ftype !== 1 || filesystem.reflink !== 0 || filesystem.backing !== 'thick' || filesystem.encryption !== 'none' ||
        filesystem.projectQuotaFlags !== 48) fail(); // XFS project-accounting/enforcement bits, OBSERVED only.
    const blockSize = uint(filesystem.blockSize, true), blocks = uint(filesystem.blocks, true),
      free = uint(filesystem.blocksFree), available = uint(filesystem.blocksAvailable),
      inodes = uint(filesystem.inodes, true), inodesFree = uint(filesystem.inodesFree);
    if (BigInt(blockSize) < 512n || BigInt(blockSize) > 65_536n || (BigInt(blockSize) & (BigInt(blockSize) - 1n)) !== 0n ||
        BigInt(available) > BigInt(free) || BigInt(free) > BigInt(blocks) || BigInt(inodesFree) > BigInt(inodes)) fail();
    multiply(blockSize, blocks); // Overflow in total capacity also rejects.
    const floor = row(policy.physicalFloor, ['bytes', 'inodes']);
    const physicalFloor = { bytes: uint(floor.bytes, true), inodes: uint(floor.inodes, true) };
    const constraints: CandidateMappedObservation['constraints'] = [{ id: `fs:${fsId}`, kind: 'filesystem',
      available: { bytes: multiply(blockSize, available), inodes: inodesFree }, safetyFloor: physicalFloor }];
    const projectIds = new Set<string>();
    for (const value of array(input.projects)) {
      const project = row(value, ['projectId', 'filesystemId', 'blockHardLimit512', 'blocksUsed512', 'inodeHardLimit', 'inodesUsed']);
      const id = uint(project.projectId, true);
      if (BigInt(id) > 4_294_967_295n || projectIds.has(id) || project.filesystemId !== fsId) fail(); projectIds.add(id);
      const hard = uint(project.blockHardLimit512, true), used = uint(project.blocksUsed512),
        hardInodes = uint(project.inodeHardLimit, true), usedInodes = uint(project.inodesUsed);
      if (BigInt(used) > BigInt(hard) || BigInt(usedInodes) > BigInt(hardInodes)) fail();
      multiply(hard, '512');
      constraints.push({ id: `quota:${fsId}:${id}`, kind: 'quota',
        available: { bytes: multiply(String(BigInt(hard) - BigInt(used)), '512'), inodes: String(BigInt(hardInodes) - BigInt(usedInodes)) },
        safetyFloor: { bytes: '0', inodes: '0' } });
    }
    const table = mounts(input.mountinfo), expectedRoots = new Map<string, { id: string; role: Role; path: string; projectId: string }>();
    for (const value of array(policy.roots)) {
      const root = row(value, ['id', 'role', 'path', 'projectId']);
      const id = token(root.id);
      if (expectedRoots.has(id)) fail();
      expectedRoots.set(id, { id, role: role(root.role), path: path(root.path), projectId: uint(root.projectId, true) });
    }
    for (const required of CAPACITY_CANDIDATE_ROLES)
      if ([...expectedRoots.values()].filter(r => r.role === required).length !== 1) fail();
    const roots: CandidateMappedObservation['roots'] = [], seen = new Set<string>(), usedProjects = new Set<string>();
    const physicalPaths = new Map<string, string>();
    const physicalInodes = new Map<string, string>();
    const projectRoles = new Map<string, { roles: Set<Role>; paths: Set<string> }>();
    for (const value of array(input.roots)) {
      const root = row(value, ['id', 'role', 'path', 'canonicalPath', 'symlinkComponents', 'filesystemId', 'mountId', 'inode',
        'projectId', 'projectInherit', 'kind', 'volumeDriver']);
      const id = token(root.id), expected = expectedRoots.get(id), sourcePath = path(root.path), projectId = uint(root.projectId, true);
      if (!expected || seen.has(id) || !same(expected, { id, role: role(root.role), path: sourcePath, projectId }) ||
          root.canonicalPath !== sourcePath || !Array.isArray(root.symlinkComponents) || root.symlinkComponents.length ||
          root.filesystemId !== fsId || root.kind !== 'directory' || root.projectInherit !== true || !projectIds.has(projectId) ||
          root.volumeDriver !== (root.role === 'worker-volume' ? 'local' : null)) fail();
      const mounted = table.filter(m => contains(m.point, sourcePath)).sort((a, b) => b.point.length - a.point.length)[0];
      if (!mounted || mounted.id !== root.mountId || mounted.device !== device || mounted.fs !== 'xfs' ||
          !mounted.options.includes('rw') || mounted.options.includes('ro') ||
          !mounted.superOptions.includes('rw') || mounted.superOptions.includes('ro') ||
          !(mounted.superOptions.includes('prjquota') || mounted.superOptions.includes('pquota')) ||
          table.some(m => m.point !== sourcePath && m.point.startsWith(sourcePath + '/'))) fail();
      // Alias roots resolve to the same superblock-relative path. They must
      // retain identical inode/project identity, not create a second budget.
      const physical = posix.join(mounted.root, posix.relative(mounted.point, sourcePath));
      const inode = uint(root.inode, true), previous = physicalPaths.get(physical);
      if (previous && previous !== `${inode}:${projectId}`) fail();
      physicalPaths.set(physical, `${inode}:${projectId}`);
      // These roots are directories on one filesystem: hardlinked directory
      // aliases cannot legitimately assign one inode multiple physical paths
      // or projects. Bind aliases above resolve to the SAME physical path.
      const priorInode = physicalInodes.get(inode);
      if (priorInode && priorInode !== `${physical}:${projectId}`) fail();
      physicalInodes.set(inode, `${physical}:${projectId}`);
      const use = projectRoles.get(projectId) ?? { roles: new Set<Role>(), paths: new Set<string>() };
      use.roles.add(expected.role); use.paths.add(physical); projectRoles.set(projectId, use);
      usedProjects.add(projectId); seen.add(id);
      roots.push({ id, role: expected.role, path: sourcePath, filesystemId: fsId, mountId: mounted.id, inode, projectId,
        constraintIds: [`fs:${fsId}`, `quota:${fsId}:${projectId}`] });
    }
    if (seen.size !== expectedRoots.size || usedProjects.size !== projectIds.size) fail();
    const upper = roots.find(r => r.role === 'source-upper')!, work = roots.find(r => r.role === 'source-work')!;
    if (upper.projectId !== work.projectId || upper.inode === work.inode) fail();
    for (const use of projectRoles.values()) {
      if ((use.roles.has('source-upper') || use.roles.has('source-work')) &&
          [...use.roles].some(role => role !== 'source-upper' && role !== 'source-work')) fail();
      if (use.roles.has('worker-volume') && (use.roles.size !== 1 || use.paths.size !== 1)) fail();
      if (use.roles.has('shared-account') && use.roles.size !== 1) fail();
    }
    const byId = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    roots.sort(byId); constraints.sort(byId);
    const { blocksFree: _free, blocksAvailable: _available, inodesFree: _freeInodes, ...filesystemIdentity } = filesystem;
    const projectIdentity = (input.projects as Array<Record<string, unknown>>).map(project => {
      const { blocksUsed512: _used, inodesUsed: _usedInodes, ...identity } = project; return identity;
    }).sort((a, b) => String(a.projectId) < String(b.projectId) ? -1 : String(a.projectId) > String(b.projectId) ? 1 : 0);
    const digestInput = { version: 1, kind: 'candidate-inventory-digest', identity: expectedIdentity, platform,
      builds: expectedBuilds, filesystem: filesystemIdentity, projects: projectIdentity, roots };
    return { version: 1, kind: 'candidate-layout-observation', admissionReady: false,
      candidateInventoryDigest: 'sha256:' + createHash('sha256').update(encodeCapacityRpcFrame(digestInput).subarray(4)).digest('hex'), roots, constraints };
  } catch { fail(); }
}
