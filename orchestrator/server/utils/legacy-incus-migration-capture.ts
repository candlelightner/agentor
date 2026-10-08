import Docker from 'dockerode';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { DockerService } from './docker';
import { operationSettlement, withOperationDeadline, type OperationFailureWithSettlement } from './operation-deadline';
import { MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES,
  validateIncusCanonicalRestoreArchive, validateIncusDockerRestoreArchive,
  validatePortableManagedVolumeArchive } from './portable-managed-volume-archive';

export interface LegacyMigrationCaptureOptions {
  docker: Pick<DockerService, 'execCapture'>;
  /** Same host Docker daemon as docker. No client from portable input. */
  client?: Docker;
  trustedImageId: string;
  source: { containerId: string; createdAt: string; imageId: string };
  mount: { Type: 'volume' | 'bind'; Source: string; Destination: string };
  /** Server-authorized retained volume only; never a detached host bind. */
  allowDetached?: boolean;
  role: 'workspace' | 'agents' | 'docker' | 'managed';
  outputPath: string;
  /** Operator-resolved host counterpart of dirname(outputPath), not user input. */
  stagingHostPath?: string;
  /** Caller holds lifecycle/storage fences and rechecks record/grant/volume authority. */
  validate: () => Promise<void>;
  signal?: AbortSignal;
}
export type LegacyMigrationReaderOptions = Docker.ContainerCreateOptions;
export type LegacyMigrationDockerClient = Docker;
/** Docker assembles Mounts from a map: wire order is not identity. Preserve
 * every mount field/count while comparing the destination-keyed collection. */
export function legacyMigrationMountIdentity(mounts: Docker.ContainerInspectInfo['Mounts']) {
  return [...mounts].sort((left, right) => left.Destination.localeCompare(right.Destination));
}

/** Fixed trusted-reader leaf. GNU/PAX bytes are validated, never repacked.
 * Failure retains the exact helper/scratch for bounded manual recovery. */
export async function captureLegacyMigrationArchive(options: LegacyMigrationCaptureOptions): Promise<string> {
  // Clone mutable caller identity before the first await.
  const { docker, validate, signal } = options;
  const client = options.client ?? new Docker({ socketPath: '/var/run/docker.sock' });
  const source = { ...options.source }, mount = { ...options.mount };
  const { trustedImageId, role, outputPath, allowDetached } = options;
  const parent = dirname(outputPath), hostParent = options.stagingHostPath ?? parent;
  const root = { workspace: 'workspace', agents: '.agent-data', docker: 'docker', managed: 'volume' }[role];
  const absolute = (path: string) => typeof path === 'string' && isAbsolute(path) && normalize(path) === path &&
    !/[\x00-\x1f\x7f,]/.test(path);
  if (!/^[a-f0-9]{64}$/.test(source.containerId) || !/^sha256:[a-f0-9]{64}$/.test(source.imageId) ||
      !/^sha256:[a-f0-9]{64}$/.test(trustedImageId) || !source.createdAt || !root ||
      !absolute(outputPath) || !absolute(hostParent) || !absolute(mount.Destination) ||
      mount.Destination === '/' || mount.Type !== 'volume' && mount.Type !== 'bind' ||
      mount.Type === 'volume' && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(mount.Source) ||
      mount.Type === 'bind' && (!absolute(mount.Source) || mount.Source === '/'))
    throw new Error('Invalid legacy migration capture authority');
  const io = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) =>
    withOperationDeadline(operation, 15_000, label, signal);
  const checkParent = async () => {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid?.() ||
        (info.mode & 0o077) !== 0 || await realpath(parent) !== parent)
      throw new Error('Legacy migration staging must be a caller-owned private directory');
    return info;
  };
  const parentIdentity = await checkParent();
  // Never overwrite an earlier capture or follow an output symlink.
  try { await lstat(outputPath); throw new Error('Legacy migration capture output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let sourceMounts: Docker.ContainerInspectInfo['Mounts'] | undefined;
  let detachedIdentity: Docker.VolumeInspectInfo | undefined;
  let helper: Docker.Container | undefined, acknowledged: Docker.ContainerInspectInfo | undefined;
  const checkSource = async () => {
    signal?.throwIfAborted(); await validate();
    const info = await io('Legacy migration source inspection', abortSignal =>
      client.getContainer(source.containerId).inspect({ abortSignal }));
    if (info.Id !== source.containerId || info.Created !== source.createdAt || info.Image !== source.imageId ||
        info.State.Running || info.State.Paused || info.State.Restarting || info.State.Pid !== 0 ||
        !['exited', 'created'].includes(info.State.Status) || sourceMounts && !isDeepStrictEqual(legacyMigrationMountIdentity(info.Mounts), sourceMounts))
      throw new Error('Legacy migration source identity or stopped state changed');
    const matches = info.Mounts.filter(item => item.Destination === mount.Destination);
    if (matches.length === 0 && allowDetached === true && mount.Type === 'volume') {
      const volume = await io('Legacy migration retained volume inspection', abortSignal =>
        client.getVolume(mount.Source).inspect({ abortSignal }));
      const references = await io('Legacy migration retained volume references', abortSignal =>
        client.listContainers({ all: true, filters: { volume: [mount.Source] }, abortSignal }));
      if (volume.Name !== mount.Source || !volume.Mountpoint || references.some(item => item.Id !== helper?.id) ||
          detachedIdentity && !isDeepStrictEqual(volume, detachedIdentity))
        throw new Error('Legacy migration detached volume identity or references changed');
      detachedIdentity ??= structuredClone(volume);
    } else if (matches.length !== 1 || matches[0]!.Type !== mount.Type ||
        (mount.Type === 'volume' ? matches[0]!.Name : matches[0]!.Source) !== mount.Source)
      throw new Error('Legacy migration source mount changed');
    sourceMounts ??= structuredClone(legacyMigrationMountIdentity(info.Mounts));
  };
  await checkSource();
  const image = await io('Legacy migration trusted image inspection', abortSignal =>
    client.getImage(trustedImageId).inspect({ abortSignal } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }));
  if (image.Id !== trustedImageId || (image.Config?.Env ?? []).some(value =>
    !/^(?:PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|LANG|LC_ALL|TZ)=/.test(value)))
    throw new Error('Legacy migration reader image must be exact and credential-free');
  const scratch = await mkdtemp(join(parent, '.legacy-migration-capture-'));
  const scratchIdentity = await lstat(scratch), job = randomUUID();
  const hostScratch = join(hostParent, basename(scratch)), raw = join(scratch, 'archive.tar');
  let checkHelper: (() => Promise<Docker.ContainerInspectInfo>) | undefined;
  let execSettled = false, removeAttempted = false, stopAttempted = false, stopKnown = false;
  let outputIdentity: { dev: number; ino: number } | undefined;
  const checkScratch = async () => {
    const currentParent = await checkParent(), currentScratch = await lstat(scratch);
    if (currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino ||
        currentScratch.dev !== scratchIdentity.dev || currentScratch.ino !== scratchIdentity.ino ||
        !currentScratch.isDirectory() || currentScratch.isSymbolicLink() || await realpath(scratch) !== scratch)
      throw new Error('Legacy migration capture staging identity changed');
  };
  try {
    await checkSource();
    helper = await io('Legacy migration reader creation', abortSignal => client.createContainer({
      name: 'agentor-migration-capture-' + job, Image: trustedImageId, Entrypoint: ['/bin/sleep'], Cmd: ['infinity'],
      User: '0:0', Env: ['LC_ALL=C', 'LANG=C'], Healthcheck: { Test: ['NONE'] }, NetworkDisabled: true,
      Labels: { 'agentor.migration-capture-helper': 'true', 'agentor.helper.operation-id': job },
      HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Privileged: false, CapDrop: ['ALL'],
        // The accepted leaf gate proves DAC reads and trusted.overlay.* need these two capabilities.
        CapAdd: ['DAC_READ_SEARCH', 'SYS_ADMIN'], SecurityOpt: ['no-new-privileges:true'],
        RestartPolicy: { Name: 'no' }, PidsLimit: 64, Memory: 256 * 1024 * 1024,
        LogConfig: { Type: 'none', Config: {} },
        Mounts: [{ Type: mount.Type, Source: mount.Source, Target: '/source/' + root, ReadOnly: true,
          ...(mount.Type === 'volume' ? { VolumeOptions: { NoCopy: true } } : {}) },
        { Type: 'bind', Source: hostScratch, Target: '/out', ReadOnly: false }] as Docker.MountSettings[],
      }, abortSignal,
    }));
    acknowledged = await io('Legacy migration reader acknowledgment', abortSignal => helper!.inspect({ abortSignal }));
    checkHelper = async () => {
      const info = await io('Legacy migration reader identity inspection', abortSignal => helper!.inspect({ abortSignal }));
      if (!/^[a-f0-9]{64}$/.test(helper!.id) || info.Id !== helper!.id || info.Id !== acknowledged!.Id ||
          !acknowledged!.Created || info.Created !== acknowledged!.Created || info.Image !== trustedImageId ||
          !isDeepStrictEqual(legacyMigrationMountIdentity(info.Mounts), legacyMigrationMountIdentity(acknowledged!.Mounts)) ||
          info.Config.Labels?.['agentor.helper.operation-id'] !== job ||
          info.Config.Labels?.['agentor.migration-capture-helper'] !== 'true' || info.Config.User !== '0:0' ||
          info.HostConfig.NetworkMode !== 'none' || !info.HostConfig.ReadonlyRootfs || info.HostConfig.Privileged ||
          !isDeepStrictEqual(info.HostConfig.CapDrop, ['ALL']) ||
          !isDeepStrictEqual((info.HostConfig.CapAdd as string[] ?? []).map(cap => cap.replace(/^CAP_/, '')).sort(), ['DAC_READ_SEARCH', 'SYS_ADMIN']) ||
          !info.HostConfig.SecurityOpt?.includes('no-new-privileges:true') || info.HostConfig.RestartPolicy?.Name !== 'no' ||
          info.Mounts.length !== 2 || info.Mounts.filter(item => item.Destination === '/source/' + root && !item.RW &&
            item.Type === mount.Type && (mount.Type === 'volume' ? item.Name : item.Source) === mount.Source).length !== 1 ||
          info.Mounts.filter(item => item.Type === 'bind' && item.Source === hostScratch && item.Destination === '/out' && item.RW).length !== 1)
        throw new Error('Legacy migration reader identity or confinement changed');
      return info;
    };
    await checkHelper(); await checkSource();
    await io('Legacy migration reader start', abortSignal => helper!.start({ abortSignal }));
    await checkHelper();
    const result = await docker.execCapture(helper.id, ['/bin/sh', '-ec',
      "tar --version | grep -q 'GNU tar'; exec tar --sort=name --format=pax --numeric-owner --acls --xattrs --xattrs-include='*' -cpf /out/archive.tar -C /source " + root],
    { user: '0:0', signal, timeoutMs: 45 * 60_000, operationLabel: 'Legacy migration GNU metadata capture' });
    execSettled = true;
    if (result.exitCode !== 0) throw new Error('Legacy migration GNU metadata capture failed');
    await checkSource(); await checkHelper();
    stopAttempted = true;
    await io('Legacy migration reader stop', abortSignal => helper!.stop({ t: 10, abortSignal }));
    const stopped = await checkHelper();
    if (stopped.State.Running || stopped.State.Pid !== 0 || stopped.State.Status !== 'exited')
      throw new Error('Legacy migration reader termination is unconfirmed');
    stopKnown = true;
    const input = await open(raw, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await input.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_PORTABLE_MANAGED_VOLUME_PAYLOAD_BYTES)
        throw new Error('Legacy migration raw capture is not a bounded regular file');
      if (role === 'workspace' || role === 'agents') await validateIncusCanonicalRestoreArchive(raw, role, { signal });
      else if (role === 'docker') await validateIncusDockerRestoreArchive(raw, { signal });
      else await validatePortableManagedVolumeArchive(raw, { target: mount.Destination, requirePosixUstar: true, signal });
      await checkSource();
      await checkScratch();
      const current = await lstat(raw);
      if (!current.isFile() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size)
        throw new Error('Legacy migration raw capture identity changed');
      await input.chmod(0o600);
      // Exclusive hardlink publishes these exact validated RAW bytes: no overwrite, gzip or second copy.
      await link(raw, outputPath); outputIdentity = { dev: info.dev, ino: info.ino };
    } finally { await input.close().catch(() => {}); }
    await checkSource(); await checkHelper();
    await checkScratch(); removeAttempted = true;
    await io('Legacy migration reader removal', abortSignal => helper!.remove({ abortSignal }));
    await rm(scratch, { recursive: true });
    return outputPath;
  } catch (error) {
    if (execSettled && checkHelper && !removeAttempted && (!stopAttempted || stopKnown)) {
      try {
        // A definite GNU exit/schema error can roll back only after exact reader termination.
        let current = await checkHelper();
        if (current.State.Running) {
          stopAttempted = true;
          await io('Legacy migration failed reader stop', abortSignal => helper!.stop({ t: 10, abortSignal }));
          current = await checkHelper();
        }
        if (current.State.Running || current.State.Pid !== 0 || current.State.Status !== 'exited')
          throw new Error('Legacy migration failed reader termination is unconfirmed');
        await checkScratch(); removeAttempted = true;
        await io('Legacy migration failed reader removal', abortSignal => helper!.remove({ abortSignal }));
        if (outputIdentity) {
          const output = await lstat(outputPath);
          if (!output.isFile() || output.isSymbolicLink() || output.dev !== outputIdentity.dev || output.ino !== outputIdentity.ino)
            throw new Error('Legacy migration failed output identity changed');
          await rm(outputPath);
        }
        await rm(scratch, { recursive: true });
        throw error;
      } catch (cleanupError) { if (cleanupError === error) throw error; }
    }
    // No name-based adoption, force removal, retry, or claimed success after uncertain exec/start/remove.
    const retained = Object.assign(new Error('Legacy migration capture failed; retain exact reader and staging for manual recovery', { cause: error }),
      { code: 'LEGACY_MIGRATION_CAPTURE_RETAINED', helperId: helper?.id, helperCreatedAt: acknowledged?.Created,
        helperImageId: trustedImageId, helperName: 'agentor-migration-capture-' + job, scratch, outputPath });
    const settlement = (error as OperationFailureWithSettlement | undefined)?.[operationSettlement];
    if (settlement) Object.defineProperty(retained, operationSettlement, { value: settlement, enumerable: false });
    throw retained;
  }
}
