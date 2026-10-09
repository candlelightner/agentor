import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp, rm, stat, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { ManagedVolumeStore, type StoredManagedVolume } from '../../orchestrator/server/utils/managed-volume-store';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { WorkerConfigStore, type WorkerAppliedBootstrap } from '../../orchestrator/server/utils/worker-config-store-core';
import { StorageManager } from '../../orchestrator/server/utils/storage';
import { UserCredentialManager } from '../../orchestrator/server/utils/user-credentials';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import type { WorkerBackupRuntimeSource } from '../../orchestrator/server/utils/worker-backup-runtime';
import { IncusManagedVolumeRuntime } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { backupInstallationId, readBackupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { createInstanceDataArchive, instanceVolumeArchiveName, instanceBundleFilename,
  packInstanceBundle, inspectInstanceBundle, prepareInstanceNativeVolumeArchive, sha256File, validateInstanceManifest } from '../../orchestrator/server/utils/instance-backup-bundle';
import { decryptInstanceBackup, encryptInstanceBackup, inspectInstanceBackup } from '../../orchestrator/server/utils/instance-backup-crypto';
import { backupKeyFingerprint, validateRecoveryKit } from '../../orchestrator/server/utils/backup-keyring';
import type { InstanceBackupArtifact, InstanceBackupJob, InstanceBackupManifest, InstanceRestorePreflight } from '../../orchestrator/server/utils/instance-backup-types';
import type { BackupArtifact, BackupJob } from '../../orchestrator/server/utils/backup-types';
import type { ImageBuild, ImageDefinition, NativeImageBinding } from '../../orchestrator/server/utils/image-catalog';
import { readCanonicalIncusBootstrap, incusConversionRecipeId } from '../../orchestrator/server/utils/incus-image-converter';
import { extractBundle, readWorkerReconstruction, validateGzipTarPayload } from '../../orchestrator/server/utils/worker-export';
import { snapshotIncusWorkerBackupRuntime } from '../../orchestrator/server/utils/worker-backup-runtime';
import type { PublicExportJob } from '../../orchestrator/server/utils/export-jobs';
import { legacyMigrationMountIdentity } from '../../orchestrator/server/utils/legacy-incus-migration-capture';

const run = promisify(execFile);
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const scp = ['-P', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts', '-o', 'BatchMode=yes',
  '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes'];
const root = async (command: string, timeout = 30_000) => (await run('ssh', [...ssh, command], { timeout, maxBuffer: 1024 * 1024 })).stdout.trim();
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Explicit approved guest only. Real constrained helper process, Docker stop/
 * restart, compiled native adapter and Incus data inverse. The target is an
 * isolated fixture, never the preserved acceptance installation. The app
 * variants run the current production build. Only app-rest-ordinary enters
 * through public kit import/upload/preflight/restore dispatch; other variants
 * explicitly exercise the controlled helper without claiming REST admission. */
for (const mode of ['retained', 'ordinary', 'omitted', 'rollback', 'app-retained', 'app-ordinary', 'app-rollback', 'app-rest-ordinary'] as const) test(mode === 'ordinary'
  ? 'real controlled helper process restores ordinary worker Docker data with stopped intent and exact account shares'
  : mode === 'omitted' ? 'real controlled helper process restores omitted agent state with writable private account parents'
  : mode === 'rollback' ? 'real controlled helper process rolls back acknowledged native data before restoring original control plane'
  : mode === 'app-retained' ? 'real running Orchestrator reloads authenticated native restore completion and retained data'
  : mode === 'app-ordinary' ? 'real running Orchestrator starts restored ordinary VM through authenticated REST with native Docker and worker identity'
  : mode === 'app-rollback' ? 'real running Orchestrator authenticates original control plane after witnessed native rollback'
  : mode === 'app-rest-ordinary' ? process.env.INCUS_HISTORICAL_INSTANCE_TEST === 'true'
    ? 'real runtime-less historical v1 instance restores legacy Docker directory data through authenticated REST with Incus enabled'
    : process.env.INCUS_ORIGINAL_PUBLIC_TEST === 'true'
    ? 'real authenticated worker backup restores its original Incus workspace without replacing other state'
    : process.env.INCUS_NEW_PUBLIC_TEST === 'true'
      ? 'real authenticated encrypted worker backup restores fresh Incus worker storage and selected native Docker data'
      : process.env.INCUS_CUSTOM_IMAGE_PUBLIC_TEST === 'true'
        ? process.env.INCUS_CUSTOM_IMAGE_CACHE_MISS_TEST === 'true'
          ? 'real archived custom Incus worker regenerates verified missing derived cache on HDD scratch and reuses it warmly'
          : process.env.INCUS_CUSTOM_IMAGE_INSTANCE_TEST === 'true'
          ? process.env.INCUS_CUSTOM_IMAGE_INSTANCE_RESTORE_TEST === 'true'
            ? 'real encrypted custom whole-instance backup restores into empty recovery controller through public cold helper'
            : 'real authenticated custom whole-instance producer validates encrypted SQLite and native cold-restore source'
          : process.env.INCUS_CUSTOM_IMAGE_PORTABLE_TEST === 'true'
          ? 'real authenticated portable custom worker export imports fresh Incus worker from private cache'
          : process.env.INCUS_CUSTOM_IMAGE_BACKUP_TEST === 'true'
          ? 'real authenticated encrypted custom worker backup restores fresh Incus worker from private cache'
          : 'real controlled catalog OCI creates and rebuilds ordinary Incus worker with private derived image cache reuse'
    : 'real public instance restore imports an encrypted native bundle and restores ordinary VM Docker data through authenticated REST'
  : 'real controlled helper process restores retained native data and restarts only its exact recovery target', async () => {
  const originalPublic = mode === 'app-rest-ordinary' && process.env.INCUS_ORIGINAL_PUBLIC_TEST === 'true';
  const historical = mode === 'app-rest-ordinary' && process.env.INCUS_HISTORICAL_INSTANCE_TEST === 'true';
  const newPublic = mode === 'app-rest-ordinary' && process.env.INCUS_NEW_PUBLIC_TEST === 'true';
  const customPublic = mode === 'app-rest-ordinary' && process.env.INCUS_CUSTOM_IMAGE_PUBLIC_TEST === 'true';
  const customBackup = customPublic && process.env.INCUS_CUSTOM_IMAGE_BACKUP_TEST === 'true';
  const customPortable = customPublic && process.env.INCUS_CUSTOM_IMAGE_PORTABLE_TEST === 'true';
  const customInstance = customPublic && process.env.INCUS_CUSTOM_IMAGE_INSTANCE_TEST === 'true';
  const customInverse = customInstance && process.env.INCUS_CUSTOM_IMAGE_INSTANCE_RESTORE_TEST === 'true';
  const customCache = customPublic && process.env.INCUS_CUSTOM_IMAGE_CACHE_MISS_TEST === 'true';
  const evictedCache = customCache && process.env.INCUS_CUSTOM_IMAGE_CACHE_EVICTED_TEST === 'true';
  if ([customBackup, customPortable, customInstance, customCache].filter(Boolean).length > 1) throw new Error('Choose one custom restore gate');
  if ([originalPublic, newPublic, customPublic, historical].filter(Boolean).length > 1) throw new Error('Choose exactly one public worker gate');
  const rest = mode === 'app-rest-ordinary' && !originalPublic && !newPublic && !customPublic, app = mode.startsWith('app-'), ordinary = !historical && (originalPublic || newPublic || rest || mode === 'app-ordinary' || mode !== 'retained' && !app),
    rollback = mode === 'rollback' || mode === 'app-rollback';
  test.skip(process.env.INCUS_INSTANCE_HELPER_PROCESS_TEST !== 'true', 'Explicit serial approved disposable helper-process gate');
  if (historical && !process.env.INCUS_ENDPOINT) throw new Error('Historical compatibility gate requires the current approved Incus HTTPS forward');
  const retryArtifactId = process.env.INCUS_CUSTOM_IMAGE_BACKUP_RETRY_ARTIFACT_ID;
  if (retryArtifactId && (!customBackup || retryArtifactId !== 'eab8a1c9-20f1-44dc-8d68-a9985fe6c8dc'))
    throw new Error('Same-artifact retry requires the exact accepted custom encrypted artifact');
  test.setTimeout(customPublic ? 5_400_000 : 900_000);
  let custom: { version: 1; project: string; projectMarker: string; credentialsDir: string; tlsRoot: string;
    seedFingerprint: string; converterStoragePool: string; workerImage: string; workerImageId: string;
    incusWorkerImage: string; network: string; internalGatewayHost: string; appBaseImage?: string; appBaseImageId?: string } | undefined;
  if (customPublic || historical) {
    if (!process.env.INCUS_CUSTOM_IMAGE_FIXTURE_JSON) throw new Error('Private root-owned custom-image context is required');
    const file = await open(process.env.INCUS_CUSTOM_IMAGE_FIXTURE_JSON, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await file.stat();
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size < 1 || s.size > 16_384)
        throw new Error('Custom-image context must be a bounded private regular file');
      custom = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    const sha = /^sha256:[a-f0-9]{64}$/, name = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
    if (custom?.version !== 1 || !/^agimg[A-Za-z0-9-]{1,8}$/.test(custom.project) || !/^[a-f0-9-]{36}$/.test(custom.projectMarker) ||
        !/^\/workspace\/agentor-incus-[A-Za-z0-9._/-]+$/.test(custom.credentialsDir) || custom.credentialsDir.includes('..') ||
        !/^\/var\/tmp\/agentor-[A-Za-z0-9._/-]+$/.test(custom.tlsRoot) || custom.tlsRoot.includes('..') ||
        !/^[a-f0-9]{64}$/.test(custom.seedFingerprint) || !name.test(custom.converterStoragePool) || !name.test(custom.incusWorkerImage) ||
        custom.workerImage !== 'agentor-custom-base:' + custom.projectMarker.slice(0, 8) || !sha.test(custom.workerImageId) || !name.test(custom.network) ||
        custom.internalGatewayHost !== '10.159.68.1' ||
        (custom.appBaseImage !== undefined ? custom.appBaseImage !== 'agentor-custom-app-base:' + custom.projectMarker.slice(0, 8) ||
          typeof custom.appBaseImageId !== 'string' || !sha.test(custom.appBaseImageId) : custom.appBaseImageId !== undefined))
      throw new Error('Custom-image fixture context is not the approved bounded operator configuration');
    const directory = await lstat(custom.credentialsDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077)) throw new Error('Fixture credential directory is not private');
  }
  let customRetained: { version: 1; jobId: string; localDir: string; remoteDir: string; ownerId: string; installationId: string;
    workerId: string; definitionId: string; sourceBuildId: string; nativeBuildId: string; sourceImageId: string; fingerprint: string;
    app: { Id: string; Image: string; Config: { Labels: Record<string, string>; Env: string[] }; Mounts: unknown[];
      NetworkSettings: { Networks: unknown } };
    instance: Awaited<ReturnType<IncusWorkerRuntime['client']['getInstance']>>;
    volumes: Array<Awaited<ReturnType<IncusWorkerRuntime['client']['getCustomVolume']>>>;
    definition: ImageDefinition; sourceBuild: ImageBuild; nativeBuild: ImageBuild; binding: NativeImageBinding;
    nft: { table: string; json: unknown }; gatewayPort?: number; scratch?: { path: string; dev: number; ino: number };
    evictedWorker?: WorkerRecord; interruptedNativeBuild?: ImageBuild; additionalInterruptedNativeBuild?: ImageBuild;
    thirdInterruptedNativeBuild?: ImageBuild; oldBindingKey?: string } | undefined;
  if (process.env.INCUS_CUSTOM_IMAGE_RETAINED_JSON) {
    if (!customPublic) throw new Error('Retained custom fixture requires its explicit public gate');
    const file = await open(process.env.INCUS_CUSTOM_IMAGE_RETAINED_JSON, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await file.stat();
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size < 1 || s.size > 1024 * 1024)
        throw new Error('Retained custom proof must be a bounded private regular file');
      customRetained = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (customRetained?.version !== 1 || customRetained.jobId !== '38172278-efe9-41f5-b6d0-742a4e2237dc' ||
        customRetained.localDir !== '/tmp/agentor-native-helper-process-bJ2zXk' ||
        customRetained.remoteDir !== (customCache ? '/var/tmp/agentor-native-custom-recovery.70c6cac5-210c-42e4-9ed8-3d1cd758c3ad' : '/var/tmp/agentor-native-helper-process.' + customRetained.jobId) ||
        customRetained.ownerId !== 'f915fa4a-8602-4597-a389-a1c5348195ae' || customRetained.installationId !== '2b4beed9-40fc-4456-948a-e630528c4fbb' ||
        customRetained.workerId !== 'd958a3cd-4630-49ae-9a57-899dc01e5980' || customRetained.definitionId !== '2a7df365-2c7d-407b-9bab-96191906804f' ||
        customRetained.sourceImageId !== 'sha256:f0bfcd056c7d27ead09025f91e53678fc6172dabfd130f216a7dedd7d572e2fc' ||
        customRetained.fingerprint !== '30e74cf8f70888092ff94e6386c7f0a7d675ba464425882b0d151325c28326f2' ||
        customRetained.app.Id !== (customCache ? '99dfa4d63c1f89ff75cb205a86a722e2910395fef0e24d7c47c84c8c2302d2fe' : customPortable || customInstance ? '576101a2d3381e136f699b085ddffd50f3fa9615779a355b8c28ab692acd5db3' : retryArtifactId ? '08adb9546de808c17b2389ccd129435c8f2460560c07b0ee1d5a9b47ac49839e' : '38271e5ea1ec10805ccb5bf14935a555f1e695ac66d1e0b12e283d26867f29de') ||
        customCache && (customRetained.app.Image !== 'sha256:a7177ef19047d9c0f56d1858599015f55f334831d3cc60b823cd915fa22c38e2' || customRetained.gatewayPort !== 39870 ||
          customRetained.scratch?.path !== '/mnt/kata-extra/agentor-custom-cache-scratch.A9pNtsBX' || customRetained.scratch.dev !== 64785 || customRetained.scratch.ino !== 5242881) ||
        (customPortable || customInstance) && customRetained.app.Image !== 'sha256:5ed3992c1027560b6ad5a303eed2d2d38671921f030f567a934cb1da7e0cd836' ||
        retryArtifactId && customRetained.app.Image !== 'sha256:43640a77dfb2c8c2d63d74cfefee487210f86978e3735e2f52cb0e02c0753c54' ||
        customRetained.instance.config['volatile.uuid'] !== (customCache ? 'fd03053b-3c0e-48f1-bf59-72fccf61ccbf' : customBackup || customPortable || customInstance ? '8ad56682-4fb6-420d-8e85-b0d3be659f46' : '2486a933-3268-4caa-9614-c11dd1cb4b44') ||
        !/^a9defe44-[a-f0-9-]{27}$/.test(customRetained.sourceBuildId) || !/^432c08ba-[a-f0-9-]{27}$/.test(customRetained.nativeBuildId) ||
        !/^sha256:[a-f0-9]{64}$/.test(customRetained.app.Image) || customRetained.volumes.length !== 2 || custom?.project !== 'agimg10b')
      throw new Error('Retained custom proof does not identify the explicitly approved source fixture');
    if (evictedCache && (customRetained.evictedWorker?.id !== customRetained.workerId || customRetained.evictedWorker.userId !== customRetained.ownerId ||
        customRetained.evictedWorker.runtimeKind !== 'incus-vm' || customRetained.evictedWorker.status !== 'archived' ||
        customRetained.evictedWorker.incusRecreation !== undefined || customRetained.interruptedNativeBuild?.id !== 'cf61b184-1b65-4e1d-b745-b4c3c4e5eec2' ||
        customRetained.additionalInterruptedNativeBuild?.id !== '2d2c5762-318a-4e65-9a9d-43d45ba694a5' ||
        customRetained.thirdInterruptedNativeBuild?.id !== '66a1e433-5b4c-4321-9753-06c53c6d0af4' ||
        typeof customRetained.oldBindingKey !== 'string' || !/^[a-f0-9]{64}$/.test(customRetained.oldBindingKey)))
      throw new Error('Evicted admission requires exact manually-settled worker/job facts');
  }
  if ((customBackup || customPortable || customInstance || customCache) && !customRetained) throw new Error('Custom restore gate requires the accepted retained source proof');
  let inverse: { version: 1; backupId: string; localCaptureDir: string; producerRequestId: string; artifact: InstanceBackupArtifact; fileSha256?: string } | undefined;
  if (customInverse) {
    if (!process.env.INCUS_CUSTOM_IMAGE_INSTANCE_RESTORE_JSON) throw new Error('Actual captured instance artifact context is required');
    const file = await open(process.env.INCUS_CUSTOM_IMAGE_INSTANCE_RESTORE_JSON, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const s = await file.stat();
      if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size < 1 || s.size > 1024 * 1024) throw new Error('Inverse input must be private and bounded');
      inverse = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (inverse?.version !== 1 || inverse.backupId !== '4d169c90-9111-47e3-b0a2-f34d88aae15c' ||
        inverse.localCaptureDir !== '/tmp/agentor-native-helper-process-q9uayF' || inverse.artifact.id !== inverse.backupId ||
        inverse.producerRequestId !== 'a6df3fcb-f073-472f-b7d4-372b94eb1081-capture' ||
        inverse.artifact.userId !== customRetained?.ownerId || inverse.artifact.integrityStatus !== 'verified' ||
        inverse.artifact.size !== 316783 || !/^[a-f0-9]{64}$/.test(inverse.artifact.sha256) ||
        inverse.fileSha256 !== undefined && !/^[a-f0-9]{64}$/.test(inverse.fileSha256)) throw new Error('Inverse input is not the accepted genuine producer artifact');
  }
  let retained: { version: 1; fixtureId: string; workerId: string; ownerId: string; volume: StoredManagedVolume;
    localDir: string; remoteDir: string; parentId: string; parentImageId: string; restoreJobId: string;
    failedCaptureJobId: string; incarnation: string; installation: string; source: WorkerBackupRuntimeSource;
    instance: Awaited<ReturnType<IncusWorkerRuntime['client']['getInstance']>>;
    volumes: Array<Awaited<ReturnType<IncusWorkerRuntime['client']['getCustomVolume']>>>;
    oldNft?: { table: string; json: unknown }; dockerArchive: { path: string; sha256: string } } | undefined;
  if (process.env.INCUS_INSTANCE_PRODUCER_FIXTURE_JSON) {
    if (!rest) throw new Error('Retained producer evidence only applies to app-rest-ordinary');
    const file = await open(process.env.INCUS_INSTANCE_PRODUCER_FIXTURE_JSON, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 || info.size > 1024 * 1024)
        throw new Error('Retained producer parameters must be a bounded private operator file');
      retained = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    if (retained?.version !== 1 || retained.fixtureId !== 'ca689b40-52c9-47e3-a474-dbca60ce9570' ||
        retained.workerId !== '226664b9-08c0-4a82-8330-1b522fb29041' || retained.ownerId !== 'bec36cc0-e87e-43b5-80be-e9b2ff0e9604' ||
        retained.installation !== '910d9899-a051-413c-8e25-20142c3b90c3' || retained.incarnation !== '9ac3524c-0eee-48ec-a7f0-2f564a0ebaa2' ||
        retained.localDir !== '/tmp/agentor-native-helper-process-lvq2bi' ||
        retained.remoteDir !== '/var/tmp/agentor-native-helper-process.' + retained.fixtureId ||
        !/^3d10abd1[a-f0-9]{51}a7d6d$/.test(retained.parentId) || !/^sha256:[a-f0-9]{64}$/.test(retained.parentImageId) ||
        !/^3918948d-[a-f0-9-]{27}$/.test(retained.restoreJobId) || !/^9c6678b3-[a-f0-9-]{27}$/.test(retained.failedCaptureJobId) ||
        retained.volume.workerId !== retained.workerId || retained.volume.userId !== retained.ownerId)
      throw new Error('Retained producer parameters do not identify the explicitly approved fixture');
  }
  // Admit every ordinary source input before creating even a local fixture,
  // packaging an App or reaching SSH/Incus. Hash the verified regular file
  // through its no-follow descriptor once; later setup reuses this proof.
  let dockerSource: string | undefined, dockerSourceDigest: string | undefined;
  if (ordinary) {
    dockerSource = retained?.dockerArchive.path ?? process.env.INCUS_INSTANCE_HELPER_DOCKER_ARCHIVE;
    if (!dockerSource) throw new Error('Ordinary gate requires the accepted raw Docker archive fixture');
    const file = await open(dockerSource, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0) throw new Error('Ordinary gate requires a nonempty regular Docker archive fixture');
      const hash = createHash('sha256');
      for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk);
      dockerSourceDigest = hash.digest('hex');
      if (retained) expect(dockerSourceDigest).toBe(retained.dockerArchive.sha256);
    } finally { await file.close(); }
  }
  const local = customRetained && !customBackup && !customInstance ? customRetained.localDir : await mkdtemp(join(tmpdir(), 'agentor-native-helper-process-'));
  const followupNonce = randomUUID();
  const source = join(customRetained?.localDir ?? retained?.localDir ?? local, 'source'), targetData = join(local, 'data'), build = join(local, 'image');
  let id = retained?.workerId ?? randomUUID();
  const volumeId = retained?.volume.id ?? randomUUID(), jobId = customRetained?.jobId ?? retained?.fixtureId ?? randomUUID();
  let restoreJobId: string = retained?.restoreJobId ?? jobId;
  let userId = retained?.ownerId ?? (ordinary ? 'ordinary-' : 'retained-') + randomUUID();
  let appPort = customCache ? customRetained!.gatewayPort! : 39000 + Number.parseInt(jobId.slice(0, 4), 16) % 1000;
  const remote = customInverse ? '/var/tmp/agentor-native-custom-recovery.' + followupNonce : customBackup ? '/var/tmp/agentor-native-custom-backup.' + followupNonce : customRetained?.remoteDir ?? (retained ? '/var/tmp/agentor-native-producer.' + followupNonce : '/var/tmp/agentor-native-helper-process.' + jobId);
  const image = 'agentor-native-helper-process:' + (retained || customBackup || customInverse ? followupNonce : jobId), targetName = 'native-recovery-' + (retained || customBackup || customInverse ? followupNonce : jobId),
    helperName = 'agentor-instance-restore-' + jobId;
  const legacyName = 'agentor-native-rollback-' + jobId;
  const stamp = new Date().toISOString();
  const volume: StoredManagedVolume = retained?.volume ?? { id: volumeId, userId, workerId: id, name: 'Retained native data',
    dockerName: 'agentor-persist-' + volumeId, target: '/srv/retained', purpose: 'persistent-path', storageRuntimeKind: 'incus-vm',
    attached: ordinary, seeded: true, state: ordinary ? 'ready' : 'detached',
    ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}), createdAt: stamp, updatedAt: stamp };
  let targetId: string | undefined, helperId: string | undefined, imageId: string | undefined, completed = false, cleaned = false;
  let startupHolderId: string | undefined, helperRemovedByManager = false;
  let incarnation: string | undefined, policyAdded = false, computeSettled = true;
  let worker: WorkerRecord | undefined, options: IncusWorkerOptions | undefined;
  let historicalSource: { controllerId: string; dataDir: string; installation: string;
    container: { Id: string; Image: string; Created: string; Config: { Labels: Record<string, string> }; State: { Running: boolean; Pid: number };
      Mounts: Parameters<typeof legacyMigrationMountIdentity>[0] }; bytes: unknown; directoryIdentity: string } | undefined;
  let stagingOwner = 'recovery-admin', restoredOwner = 'restored-admin';
  let originalInstallation: string | undefined;
  let sourceTable = 'agentor_restore_' + (retained || customBackup || customInverse ? followupNonce : jobId).slice(0, 8);
  let sourceRuleBaseline: string | undefined;
  const sourceRuleSnapshot = (value: string) => JSON.stringify(JSON.parse(value), (key, value) =>
    key === 'metainfo' ? undefined : key === 'counter' ? {} : value);
  let baseline: Awaited<ReturnType<IncusManagedVolumeRuntime['inspectVolume']>>;
  const config = { ...loadConfig(), dataDir: source, containerPrefix: app ? 'aphr-' + jobId.slice(0, 8) : 'agentor-worker', incusEnabled: true,
    incusEndpoint: historical ? process.env.INCUS_ENDPOINT! : 'https://127.0.0.1:18443', incusProject: custom?.project ?? 'agentor', incusStoragePool: 'default', incusNetwork: custom?.network ?? 'incusbr0',
    incusWorkerImage: custom?.incusWorkerImage ?? 'agentor-worker-phase10-preserve-ownership',
    incusConverterSeedFingerprint: custom?.seedFingerprint, incusConverterStoragePool: custom?.converterStoragePool,
    incusClientCertPath: custom ? join(custom.credentialsDir, 'client.crt') : '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: custom ? join(custom.credentialsDir, 'client.key') : '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: custom ? join(custom.credentialsDir, 'server.crt') : '/workspace/agentor-incus-tls/server.crt',
    incusDockerVolumeSize: '1GiB', incusInternalGatewayUrl: 'http://10.159.68.1:' + (app ? appPort : 38000) };
  const runtime = new IncusWorkerRuntime(config), managedRuntime = new IncusManagedVolumeRuntime(config, runtime);
  let remoteData = (customRetained?.remoteDir ?? retained?.remoteDir ?? remote) + '/data';
  const tlsRoot = custom?.tlsRoot ?? '/var/tmp/agentor-phase6-production.SSkg3hQz/tls';
  const mounts = ['client.crt', 'client.key', 'server.crt'].map(file =>
    `--mount type=bind,src=${tlsRoot}/${file},dst=/tls/${file},readonly`);
  const admin = { email: `restore-${jobId}@agentor.test`, password: 'isolated-native-restore-' + jobId, name: 'Native Recovery Acceptance' };
  const operatorEnv = ['CONTAINER_PREFIX=' + config.containerPrefix, 'DOCKER_NETWORK=agentor-phase6-net',
    'INCUS_ENABLED=true', 'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=' + config.incusProject,
    'INCUS_NETWORK=' + config.incusNetwork, 'INCUS_STORAGE_POOL=default', 'INCUS_WORKER_IMAGE=' + config.incusWorkerImage,
    'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=' + config.incusInternalGatewayUrl,
    'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt'];
  if (custom) operatorEnv.push('WORKER_IMAGE=' + custom.workerImage, 'WORKER_IMAGE_PREFIX=',
    'INCUS_CONVERTER_SEED_FINGERPRINT=' + custom.seedFingerprint, 'INCUS_CONVERTER_STORAGE_POOL=' + custom.converterStoragePool);
  const prepareImage = async () => {
    // BuildKit cannot resolve a bare local config SHA in FROM. These exact
    // fixture-owned tags are transport hints only, verified against immutable
    // operator pins before App/catalog builds; derived cache authority is OCI ID.
    if (custom) {
      expect(await root(`sudo docker image inspect ${quote(custom.workerImage)} --format '{{.Id}}'`)).toBe(custom.workerImageId);
      if (custom.appBaseImage) expect(await root(`sudo docker image inspect ${quote(custom.appBaseImage)} --format '{{.Id}}'`)).toBe(custom.appBaseImageId);
    }
    await run(process.execPath, [fileURLToPath(new URL('../../orchestrator/build-instance-restore-native.mjs', import.meta.url)),
      join(build, 'instance-restore-native')], { env: {}, timeout: 60_000 });
    await copyFile(fileURLToPath(new URL('../../orchestrator/instance-restore-helper.mjs', import.meta.url)), join(build, 'instance-restore-helper.mjs'));
    await copyFile(fileURLToPath(new URL(app ? '../fixtures/instance-native-app.Dockerfile' : '../fixtures/instance-native-helper.Dockerfile', import.meta.url)), join(build, 'Dockerfile'));
    if (app) await cp(fileURLToPath(new URL('../../orchestrator/.output', import.meta.url)), join(build, 'app-output'),
      { recursive: true, verbatimSymlinks: true });
    if (app) await run(process.execPath, ['--input-type=module', '-e',
      `const{default:WS}=await import(${JSON.stringify(join(build, 'app-output/server/node_modules/ws/wrapper.mjs'))});` +
      `if(typeof WS!=='function')throw Error('Fixture packaged WebSocket entry changed');`], { timeout: 10_000 });
    if (originalPublic) expect(await readFile(join(build, 'app-output/server/chunks/nitro/nitro.mjs'), 'utf8'))
      .toContain('replaceOriginalWorkspaceFromBackup'); // Cheap packaging seam before native source allocation.
    if (newPublic) expect(await readFile(join(build, 'app-output/server/chunks/nitro/nitro.mjs'), 'utf8'))
      .toContain('importWorkerFromBackup');
    if (customPublic) {
      expect(await readFile(join(build, 'app-output/server/chunks/nitro/nitro.mjs'), 'utf8')).toContain('IncusWorkerImageManager');
      const current = join(local, 'current-bootstrap');
      await run(process.execPath, [fileURLToPath(new URL('../../orchestrator/build-incus-worker-assets.mjs', import.meta.url)), current], { timeout: 30_000 });
      expect(await readCanonicalIncusBootstrap(join(build, 'app-output/server/incus-bootstrap'))).toEqual(await readCanonicalIncusBootstrap(current));
    }
    if (app) for (const file of ['volume-mount-helper.py', 'incus-volume-live-helper.py'])
      await copyFile(fileURLToPath(new URL('../../orchestrator/' + file, import.meta.url)), join(build, file));
    if (!retained) {
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(runtime.client.getCustomVolume(config.incusStoragePool, volume.dockerName)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await runtime.client.request<{ driver: string }>('GET', '/1.0/storage-pools/' + config.incusStoragePool)).driver).toBe('dir');
    await root(`test ! -e ${quote(remote)} && mkdir -m 700 ${quote(remote)}`);
    await run('scp', [...scp, '-r', ...(customBackup ? [build] : [targetData, build]), 'kata-test@172.19.0.1:' + remote + '/'], { timeout: 60_000 });
    imageId = await root(`sudo docker build -q --label agentor.native-helper-fixture=${jobId} --build-arg REMOVE_VOLUME_HELPER_SLEEP=${rollback} ` +
      (custom?.appBaseImage ? '--build-arg BASE_IMAGE=' + quote(custom.appBaseImage) + ' ' : '') +
      `-t ${quote(image)} ${quote(remote + '/image')}`, 120_000);
    expect(imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
      .toBe(imageId + ' ' + jobId);
  };
  const launchTarget = async (enabled = true, name = targetName, recoveryMode = true) => {
    const args = app ? `${operatorEnv.map(value => value.startsWith('INCUS_INTERNAL_GATEWAY_URL=') ? 'INCUS_INTERNAL_GATEWAY_URL=' + config.incusInternalGatewayUrl
      : value.startsWith('INCUS_ENABLED=') ? 'INCUS_ENABLED=' + enabled : value)
      .concat(['DATA_DIR=' + remoteData, 'BETTER_AUTH_URL=http://127.0.0.1:3000'])
      .map(v => '-e ' + quote(v)).join(' ')} ` +
      `--mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ${mounts.join(' ')}` : '';
    targetId = await root(`sudo docker run -d --name ${quote(name)} --label agentor.native-helper-fixture=${jobId} ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 -e AGENTOR_INSTANCE_RECOVERY_MODE=${recoveryMode} ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${app ? '-p 10.159.68.1:' + appPort + ':3000' : ''} ${args} ${quote(image)} ` +
      (app ? 'node .output/server/index.mjs' : `node -e 'setInterval(()=>{},1000)'`));
    expect(targetId).toMatch(/^[a-f0-9]{64}$/);
    if (app) {
      // Reuse the accepted Phase6 source-preservation rule on this exact App
      // IP/internal port. Own table only; no edits to Docker/Incus chains and
      // no blanket forwarding permission or worker-selected identity header.
      // Restricted project clients intentionally cannot read inherited bridge
      // configuration. Operator fixture discovery uses the authorized guest
      // CLI, never broader application credentials or a socket mount.
      const cidr = await root(`sudo incus network get ${quote(config.incusNetwork)} ipv4.address`);
      expect(cidr).toMatch(/^(?:\d+\.){3}\d+\/\d+$/);
      const dockerNetwork = JSON.parse(await root(`sudo docker network inspect agentor-phase6-net`)) as Array<{
        Id: string; Options: Record<string, string>;
      }>;
      expect(dockerNetwork[0]!.Id).toMatch(/^[a-f0-9]{64}$/);
      const bridge = dockerNetwork[0]!.Options['com.docker.network.bridge.name'] ?? 'br-' + dockerNetwork[0]!.Id.slice(0, 12);
      expect(bridge).toMatch(/^[A-Za-z0-9_.-]{1,15}$/);
      const ip = await root(`sudo docker inspect ${targetId} --format '{{(index .NetworkSettings.Networks "agentor-phase6-net").IPAddress}}'`);
      expect(ip).toMatch(/^(?:\d+\.){3}\d+$/);
      const spec = `table ip ${sourceTable} { chain postrouting { type nat hook postrouting priority 99; policy accept; ` +
        `iifname "${config.incusNetwork}" oifname "${bridge}" ip saddr ${cidr} ip daddr ${ip} tcp dport 3000 ` +
        `counter snat to ip saddr comment "agentor-restore-${jobId}";\n }\n}\n`;
      expect(await root(`sudo nft list tables`)).not.toContain('table ip ' + sourceTable);
      await root(`printf '%s\\n' ${quote(spec)} | sudo nft --check -f -`);
      await root(`printf '%s\\n' ${quote(spec)} | sudo nft -f -`);
      sourceRuleBaseline = sourceRuleSnapshot(await root(`sudo nft -j list table ip ${sourceTable}`));
    }
  };
  // Requests execute on loopback INSIDE only the exact fixture container.
  // Sign-in cookies stay inside the exact App fixture (including a private
  // producer session file) and never appear in tool/test output.
  const appRequest = async <T,>(path: string, body?: unknown, authenticated = true,
    timeoutMs = 30_000, privateFile?: { path: string; format: 'json' | 'binary'; contentType?: 'application/x-tar' }, sessionPath?: string,
    method?: 'PUT' | 'DELETE'): Promise<{ status: number; body: T }> => {
    if (privateFile && body !== undefined) throw new Error('Fixture request cannot mix a private file and an inline body');
    if (sessionPath && !authenticated) throw new Error('Fixture private session requires an authenticated request');
    if (privateFile?.contentType && (privateFile.format !== 'binary' || !path.startsWith('/api/containers/import?')))
      throw new Error('Fixture tar content type is only valid for portable worker import');
    // Node fetch has a shorter headers deadline than a real first conversion.
    // Only this explicitly long custom create or exact owned cache unarchive
    // uses bounded built-in HTTP;
    // authentication, request shape and all older fixture fetch paths stay put.
    const longCreate = customPublic && (path === '/api/containers' || customCache && path === '/api/archived/' + customRetained?.workerId + '/unarchive') &&
      timeoutMs > 300_000 && !privateFile && body !== undefined && method === undefined;
    const requestScript = longCreate ?
      `const{request}=await import('node:http');const payload=${JSON.stringify(JSON.stringify(body))};headers['Content-Length']=String(Buffer.byteLength(payload));` +
      `const result=await new Promise((resolve,reject)=>{let timer;const req=request(base+${JSON.stringify(path)},{method:'POST',headers},r=>{` +
      `const chunks=[];let bytes=0;r.on('error',reject);r.on('aborted',()=>reject(Error('Fixture response aborted')));` +
      `r.on('data',b=>{bytes+=b.length;if(bytes>262144){r.destroy();req.destroy(Error('Fixture response too large'));return}chunks.push(b)});` +
      `r.on('end',()=>{clearTimeout(timer);try{const text=Buffer.concat(chunks).toString('utf8');if(!Number.isInteger(r.statusCode))throw Error('Fixture response status invalid');` +
      `resolve({status:r.statusCode,body:String(r.headers['content-type']??'').includes('application/json')?JSON.parse(text):text})}catch{reject(Error('Fixture response invalid'))}})});` +
      `req.on('error',e=>{clearTimeout(timer);reject(e)});req.on('close',()=>clearTimeout(timer));` +
      `timer=setTimeout(()=>req.destroy(Error('Fixture create deadline')),${timeoutMs});req.end(payload)});` +
      `console.log(JSON.stringify(result));`
      : `const r=await fetch(base+${JSON.stringify(path)},{headers,redirect:'manual'` +
        (privateFile ? `,method:'POST',body:${privateFile.format === 'binary' ? "fs.createReadStream(p),duplex:'half'" : "fs.readFileSync(p,'utf8')"}`
          : body === undefined ? '' : ",method:" + JSON.stringify(method ?? 'POST') + ',body:' + JSON.stringify(JSON.stringify(body))) + `});` +
        `console.log(JSON.stringify({status:r.status,body:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()}));`;
    const script = `const base='http://127.0.0.1:3000';const headers={Origin:base,'Content-Type':'application/json'};` +
      (sessionPath ? `const{readFileSync:readSession,lstatSync:statSession}=await import('node:fs');const sp=${JSON.stringify(sessionPath)};` +
        `const ss=statSession(sp);if(!ss.isFile()||ss.isSymbolicLink()||(ss.mode&63)!==0)throw Error('Fixture session is not private');headers.Cookie=readSession(sp,'utf8');`
        : authenticated ? `const signed=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers,body:${JSON.stringify(JSON.stringify(admin))}});` +
        `if(!signed.ok)throw new Error('Fixture sign-in failed '+signed.status);` +
        (customRetained ? `if((await signed.json()).user?.id!==${JSON.stringify(stagingOwner)})throw Error('Fixture authenticated owner differs');` : '') +
        `headers.Cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');` : '') +
      (privateFile ? `const fs=await import('node:fs');const p=${JSON.stringify(privateFile.path)};const s=fs.lstatSync(p);` +
        `if(!s.isFile()||s.isSymbolicLink())throw Error('Fixture input is not a private regular file');` +
        (privateFile.format === 'binary' ? `headers['Content-Type']=${JSON.stringify(privateFile.contentType ?? 'application/octet-stream')};headers['Content-Length']=String(s.size);` : '') : '') +
      requestScript;
    try {
      return JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(script)}`, timeoutMs));
    } catch {
      // execFile errors include command arguments. Never print the synthetic
      // sign-in password or any cookie-bearing child-process diagnostics.
      throw new Error('Running fixture request failed: ' + path);
    }
  };
  const historicalMetadata = String.raw`import os,stat,json,base64,sys
paths=['/workspace/historical-proof','/home/agent/.agent-data/historical-proof']
if sys.argv[1]=='write':
 for p in paths:
  open(p,'wb').write(bytes([0,255,128,10,61,0]));os.link(p,p+'.hard');os.chown(p,1000,1000);os.chmod(p,0o640)
out=[]
for p in paths:
 s=os.stat(p);h=os.stat(p+'.hard');out.append(dict(data=base64.b64encode(open(p,'rb').read()).decode(),other=base64.b64encode(open(p+'.hard','rb').read()).decode(),
 uid=s.st_uid,gid=s.st_gid,mode=stat.S_IMODE(s.st_mode),otherUid=h.st_uid,otherGid=h.st_gid,otherMode=stat.S_IMODE(h.st_mode),hard=s.st_ino==h.st_ino))
print(json.dumps(out))`;
  const historicalHostMetadata = () => historicalMetadata.replace("paths=['/workspace/historical-proof','/home/agent/.agent-data/historical-proof']",
    'paths=' + JSON.stringify(['workspaces', 'agents'].map(role => historicalSource!.dataDir + '/users/' + userId + '/' + role + '/' + id + '/historical-proof')));
  const historicalDirectories = () => root(`sudo stat -c '%d:%i:%u:%g:%a' ${['workspaces', 'agents'].map(role =>
    quote(historicalSource!.dataDir + '/users/' + userId + '/' + role + '/' + id)).join(' ')}`);
  const accountPaths = () => ['credentials', 'kilo/config', 'kilo/data'].map(path => remoteData + '/users/' + userId + '/' + path);
  // Same exact fixture-only ETag delta used by accepted native account gates.
  // No change to production restrictions or generic host-path authorization.
  const policy = (add: boolean) => root('sudo python3 -c ' + quote(String.raw`
import http.client,json,socket,sys
class Unix(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX);self.sock.connect('/var/lib/incus/unix.socket')
c=Unix('localhost');c.request('GET','/1.0/projects/'+sys.argv[3]);r=c.getresponse();b=json.loads(r.read());etag=r.getheader('ETag')
assert r.status==200 and etag and b['type']=='sync'
p=b['metadata'];cfg=p['config'];assert cfg['restricted']=='true' and cfg['restricted.devices.disk']=='allow'
delta=json.loads(sys.argv[1]);paths=cfg.get('restricted.devices.disk.paths','').split(',')
if sys.argv[2]=='add':
 assert not any(x in paths for x in delta);paths+=delta
else:
 assert all(x in paths for x in delta);paths=[x for x in paths if x not in delta]
assert paths;cfg['restricted.devices.disk.paths']=','.join(paths)
c.request('PUT','/1.0/projects/'+sys.argv[3],json.dumps(dict(config=cfg,description=p['description'])),{'Content-Type':'application/json','If-Match':etag})
r=c.getresponse();b=json.loads(r.read());assert r.status==200 and b['type']=='sync',b
print('Exact account fixture delta confirmed')
`) + ' ' + quote(JSON.stringify(accountPaths())) + ' ' + (add ? 'add' : 'remove') + ' ' + quote(config.incusProject));
  const runCustomImage = async () => {
    if (!custom || !targetId) throw new Error('Exact custom App context is unavailable');
    if (customCache) await root('sudo test -d /sys/module/br_netfilter'); // Read-only host prerequisite; never load or relax filtering here.
    userId = stagingOwner;
    const privateCatalog = async () => JSON.parse(await root(`sudo python3 -c ${quote(
      'import json,os,stat,sys;p=sys.argv[1];s=os.lstat(p);assert stat.S_ISREG(s.st_mode) and s.st_size<1048576;fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW);print(os.read(fd,1048576).decode());os.close(fd)')} ` +
      quote(remoteData + '/image-catalog/image-catalog.json'))) as { definitions: ImageDefinition[]; builds: ImageBuild[]; nativeBindings: Record<string, NativeImageBinding> };
    if (customRetained) {
      const app = JSON.parse(await root(`sudo docker inspect ${targetId} --format '{{json .}}'`)) as typeof customRetained.app & { State: { Running: boolean } };
      const envKeys = new Set(['DATA_DIR', 'CONTAINER_PREFIX', 'DOCKER_NETWORK', 'INCUS_ENABLED', 'INCUS_ENDPOINT', 'INCUS_PROJECT',
        'INCUS_NETWORK', 'INCUS_STORAGE_POOL', 'INCUS_WORKER_IMAGE', 'INCUS_DOCKER_VOLUME_SIZE', 'INCUS_INTERNAL_GATEWAY_URL',
        'INCUS_CLIENT_CERT_PATH', 'INCUS_CLIENT_KEY_PATH', 'INCUS_SERVER_CERT_PATH', 'INCUS_CONVERTER_SEED_FINGERPRINT',
        'INCUS_CONVERTER_STORAGE_POOL', 'WORKER_IMAGE', 'WORKER_IMAGE_PREFIX', 'AGENTOR_INSTANCE_RECOVERY_MODE', 'BETTER_AUTH_URL']);
      expect({ Id: app.Id, Image: app.Image, Config: { Labels: app.Config.Labels,
        Env: app.Config.Env.filter(value => envKeys.has(value.split('=')[0]!)).sort() },
        Mounts: [...app.Mounts].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        NetworkSettings: { Networks: app.NetworkSettings.Networks } })
        .toEqual({ ...customRetained.app, Config: { ...customRetained.app.Config, Env: [...customRetained.app.Config.Env].sort() },
          Mounts: [...customRetained.app.Mounts].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
      expect(app.State.Running).toBe(true); expect(app.Config.Labels['agentor.native-helper-fixture']).toBe(jobId);
      const mounts = app.Mounts as Array<{ Source: string; Destination: string; Type: string; RW: boolean }>;
      expect(mounts.some(m => m.Type === 'bind' && m.Source === remoteData && m.Destination === remoteData && m.RW)).toBe(true);
      expect(mounts.some(m => m.Source.startsWith('/var/lib/incus') || m.Destination.startsWith('/var/lib/incus'))).toBe(false);
      for (const file of ['client.crt', 'client.key', 'server.crt'])
        expect(mounts.some(m => m.Source === tlsRoot + '/' + file && m.Destination === '/tls/' + file && !m.RW)).toBe(true);
      if (evictedCache) await expect(runtime.client.getInstance(customRetained.instance.name)).rejects.toMatchObject({ statusCode: 404 });
      else expect(await runtime.client.getInstance(customRetained.instance.name)).toEqual(customRetained.instance);
      expect(await Promise.all(customRetained.volumes.map(v => runtime.client.getCustomVolume(config.incusStoragePool, v.name)))).toEqual(customRetained.volumes);
      const catalog = await privateCatalog(), withoutLogs = (build: ImageBuild | undefined) => build && { ...build, logs: undefined };
      expect(catalog.definitions.find(d => d.id === customRetained.definitionId)).toEqual(customRetained.definition);
      expect(withoutLogs(catalog.builds.find(b => b.id === customRetained.sourceBuildId))).toEqual(withoutLogs(customRetained.sourceBuild));
      expect(withoutLogs(catalog.builds.find(b => b.id === customRetained.nativeBuildId))).toEqual(withoutLogs(customRetained.nativeBuild));
      expect(Object.values(catalog.nativeBindings)).toEqual(evictedCache ? [] : [customRetained.binding]);
      if (evictedCache) {
        expect(withoutLogs(catalog.builds.find(b => b.id === 'cf61b184-1b65-4e1d-b745-b4c3c4e5eec2'))).toEqual(withoutLogs(customRetained.interruptedNativeBuild));
        const interrupted = customRetained.interruptedNativeBuild!;
        expect(interrupted.status).toBe('failed'); expect(interrupted.nativeDerivation?.context).toEqual(customRetained.binding.context);
        expect(interrupted.nativeDerivation?.converter).toMatchObject({ name: 'aic-cf61b184-1b65-4e1d-b745-b4c3c4e5eec2',
          incarnation: '67994a62-e855-4cf2-b767-bd5be975dbc6', removed: true, project: custom!.project, sourceImageId: customRetained.sourceImageId });
        expect(interrupted.nativeDerivation?.converter?.pending).toBeUndefined(); expect(interrupted.nativeDerivation?.imageImport).toBeUndefined();
        await expect(runtime.client.getInstance('aic-cf61b184-1b65-4e1d-b745-b4c3c4e5eec2')).rejects.toMatchObject({ statusCode: 404 });
        const additional = customRetained.additionalInterruptedNativeBuild!;
        expect(withoutLogs(catalog.builds.find(b => b.id === additional.id))).toEqual(withoutLogs(additional));
        expect(additional.status).toBe('failed'); expect(additional.nativeDerivation?.context).toEqual(customRetained.binding.context);
        expect(additional.nativeDerivation?.source).toEqual(interrupted.nativeDerivation?.source);
        expect(additional.nativeDerivation?.converter).toMatchObject({ name: 'aic-2d2c5762-318a-4e65-9a9d-43d45ba694a5',
          incarnation: '8f76edcf-0804-431e-bee9-b216130e698e', removed: true, project: custom!.project, sourceImageId: customRetained.sourceImageId });
        expect(additional.nativeDerivation?.converter?.pending).toBeUndefined(); expect(additional.nativeDerivation?.imageImport).toBeUndefined();
        await expect(runtime.client.getInstance('aic-2d2c5762-318a-4e65-9a9d-43d45ba694a5')).rejects.toMatchObject({ statusCode: 404 });
        const third = customRetained.thirdInterruptedNativeBuild!;
        expect(withoutLogs(catalog.builds.find(b => b.id === third.id))).toEqual(withoutLogs(third));
        expect(third.status).toBe('failed'); expect(third.nativeDerivation?.context).toEqual(customRetained.binding.context);
        expect(third.nativeDerivation?.source).toEqual(interrupted.nativeDerivation?.source);
        expect(third.nativeDerivation?.converter).toMatchObject({ name: 'aic-66a1e433-5b4c-4321-9753-06c53c6d0af4',
          incarnation: '9a966eb3-d1e4-4d73-a9e1-c46b9ee3f59c', removed: true, project: custom!.project, sourceImageId: customRetained.sourceImageId });
        expect(third.nativeDerivation?.converter?.pending).toBeUndefined(); expect(third.nativeDerivation?.imageImport).toBeUndefined();
        await expect(runtime.client.getInstance('aic-66a1e433-5b4c-4321-9753-06c53c6d0af4')).rejects.toMatchObject({ statusCode: 404 });
      }
      expect(customRetained.sourceBuild.digest).toBe(customRetained.sourceImageId);
      if (evictedCache) await expect(runtime.client.getImage(customRetained.fingerprint)).rejects.toMatchObject({ statusCode: 404 });
      else expect(incusImageIdentity(await runtime.client.getImage(customRetained.fingerprint))).toEqual(customRetained.binding.identity);
      expect(customRetained.binding.identity.fingerprint).toBe(customRetained.fingerprint);
      expect(await root(`sudo docker image inspect ${quote(customRetained.sourceImageId)} --format '{{.Id}} {{index .Config.Labels "agentor.image-definition"}} {{index .Config.Labels "agentor.image-owner-hash"}}'`))
        .toBe(`${customRetained.sourceImageId} ${customRetained.definitionId} ${createHash('sha256').update(userId).digest('hex')}`);
      expect(customRetained.nft.table).toBe(customCache ? 'agentor_restore_70c6cac5' : customPortable || customInstance ? 'agentor_restore_021d9d16' : retryArtifactId ? 'agentor_restore_76e0284c' : 'agentor_restore_' + jobId.slice(0, 8));
      const oldRule = sourceRuleSnapshot(typeof customRetained.nft.json === 'string' ? customRetained.nft.json : JSON.stringify(customRetained.nft.json));
      expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${customRetained.nft.table}`))).toBe(oldRule);
      if (!customBackup) sourceRuleBaseline = oldRule;
      if (customPortable || customInstance || customCache) expect(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import fs from'node:fs';import crypto from'node:crypto';const p='/app/.output/server/chunks/nitro/nitro.mjs';const s=fs.lstatSync(p);` +
        `if(!s.isFile()||s.isSymbolicLink())throw Error('Current App program is not regular');const b=fs.readFileSync(p);` +
        `if(b.includes(Buffer.from('AGENTOR_DIAGNOSTIC')))throw Error('Diagnostic program is not portable gate authority');console.log(crypto.createHash('sha256').update(b).digest('hex'));`)}`))
        .toBe('d4bbceb4ee148308599e12cb4c8e47b16a6b9e2ea46a84a4c230ea61f65c96b9');
      const listed = await appRequest<Array<{ id: string; userId: string; runtimeKind: string }>>('/api/containers');
      expect(listed.status).toBe(200); expect(listed.body).toHaveLength(evictedCache ? 0 : 1);
      if (!evictedCache) expect(listed.body[0]).toMatchObject({ id: customRetained.workerId, userId, runtimeKind: 'incus-vm' });
    }
    if (customBackup && customRetained) {
      const boot = await runtime.client.exec(customRetained.instance.name, ['cat', '/proc/sys/kernel/random/boot_id']);
      expect(boot.returnCode, boot.stderr).toBe(0);
      await mkdir(build); await prepareImage(); // Fresh image/context only; never upload SAME DATA.
      expect(await root(`sudo docker inspect ${customRetained.app.Id} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{.State.Running}}'`))
        .toBe(`${customRetained.app.Id} ${customRetained.app.Image} ${jobId} true`);
      expect(await runtime.client.getInstance(customRetained.instance.name)).toEqual(customRetained.instance);
      expect(await Promise.all(customRetained.volumes.map(v => runtime.client.getCustomVolume(config.incusStoragePool, v.name)))).toEqual(customRetained.volumes);
      computeSettled = false;
      await root(`sudo docker stop --time 30 ${customRetained.app.Id}`, 60_000);
      expect(await root(`sudo docker inspect ${customRetained.app.Id} --format '{{.Id}} {{.Image}} {{.State.Running}}'`))
        .toBe(`${customRetained.app.Id} ${customRetained.app.Image} false`);
      await launchTarget(!historical);
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const app = JSON.parse(await root(`sudo docker inspect ${targetId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { Labels: Record<string, string> }; Mounts: Array<{ Source: string; Destination: string; RW: boolean }> };
      expect(app.Id).toBe(targetId); expect(app.Image).toBe(imageId); expect(app.Config.Labels['agentor.native-helper-fixture']).toBe(jobId);
      expect(app.Mounts.some(m => m.Source === remoteData && m.Destination === remoteData && m.RW)).toBe(true);
      expect(app.Mounts.some(m => m.Source.startsWith('/var/lib/incus') || m.Destination.startsWith('/var/lib/incus'))).toBe(false);
      for (const file of ['client.crt', 'client.key', 'server.crt'])
        expect(app.Mounts.some(m => m.Source === tlsRoot + '/' + file && m.Destination === '/tls/' + file && !m.RW)).toBe(true);
      expect(await runtime.client.getInstance(customRetained.instance.name)).toEqual(customRetained.instance);
      const sameBoot = await runtime.client.exec(customRetained.instance.name, ['cat', '/proc/sys/kernel/random/boot_id']);
      expect(sameBoot.returnCode, sameBoot.stderr).toBe(0); expect(sameBoot.stdout).toBe(boot.stdout);
      expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${customRetained.nft.table}`)))
        .toBe(sourceRuleSnapshot(typeof customRetained.nft.json === 'string' ? customRetained.nft.json : JSON.stringify(customRetained.nft.json)));
    }
    const project = await runtime.client.request<{ config: Record<string, string> }>('GET', '/1.0/projects/' + config.incusProject);
    expect(project.config).toMatchObject({ restricted: 'true', 'features.images': 'true', 'user.agentor.custom-image-fixture': custom.projectMarker });
    expect((await runtime.client.getImage(custom.seedFingerprint)).fingerprint).toBe(custom.seedFingerprint);
    const baselineImages = (await runtime.client.listImages()).map(image => image.fingerprint).filter(fp => fp !== customRetained?.fingerprint).sort();
    expect(await runtime.client.listInstances()).toEqual(customRetained && !evictedCache ? [customRetained.instance] : []);
    // Cheap executable prerequisites precede the controlled build and expensive
    // native conversion. The old App base may be used only if it has these tools.
    await root(`sudo docker exec ${targetId} sh -ec 'qemu-img --version >/dev/null; dd --version | grep -q GNU; test -f /app/.output/server/incus-bootstrap/manifest.json'`);
    expect(await root(`sudo docker image inspect ${quote(custom.workerImage)} --format '{{.Id}}'`)).toBe(custom.workerImageId);
    const installation = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(open(sys.argv[1]).read().strip()))')} ` +
      quote(remoteData + '/backup-installation-id'))) as string;
    expect(installation).toMatch(/^[a-f0-9-]{36}$/);
    if (customRetained) { expect(installation).toBe(customRetained.installationId); expect(await readBackupInstallationId(source)).toBe(installation); }
    else { await writeFile(join(source, 'backup-installation-id'), installation + '\n', { mode: 0o600 }); await policy(true); policyAdded = true; }
    const marker = 'custom-public-' + jobId;
    const definition = customRetained ? { status: 201, body: customRetained.definition } : await appRequest<ImageDefinition>('/api/image-catalog/definitions', {
      name: marker, description: 'Isolated real controlled OCI/native cache gate', baseImage: 'agentor-worker:approved-default',
      dockerfileFragment: 'COPY proof.txt /opt/agentor-custom-proof',
      contextFiles: [{ path: 'proof.txt', contentBase64: Buffer.from(marker + '\n').toString('base64') }], builder: 'controlled',
    });
    expect(definition.status).toBe(201); expect(definition.body.ownerId).toBe(userId);
    let built: ImageBuild | undefined = customRetained?.sourceBuild;
    if (!customRetained) {
    const building = await appRequest<ImageBuild>('/api/image-catalog/definitions/' + definition.body.id + '/builds',
      { builder: 'controlled', requestId: jobId + '-controlled' });
    expect(building.status).toBe(202);
    await expect.poll(async () => {
      const state = await appRequest<ImageBuild>('/api/image-builds/' + building.body.id); expect(state.status).toBe(200); built = state.body;
      expect(state.body).not.toHaveProperty('nativeDerivation');
      if (state.body.status === 'failed') throw new Error('Actual controlled OCI build failed: ' + (state.body.phase ?? 'unknown'));
      return state.body.status;
    }, { timeout: 900_000, intervals: [2000] }).toBe('succeeded');
    }
    if (!built?.version || !built.digest || !built.artifactTag) throw new Error('Controlled source acknowledgement is incomplete');
    expect(built).toMatchObject({ builder: 'controlled', ownerId: userId, dockerAttempted: true, imageCreated: true, compatibility: { coreState: 'passed' } });
    let owner: { id: string; userId: string; containerName: string };
    if (customRetained) owner = { id: customRetained.workerId, userId, containerName: customRetained.instance.name };
    else {
    const environment = await appRequest<{ id: string }>('/api/environments', { name: marker, dockerEnabled: false,
      networkMode: 'full', memoryLimit: '2GiB', cpuLimit: 2, envVars: 'CUSTOM_PUBLIC_RUNTIME_PROBE=' + marker,
      exposeApis: { portMappings: false, domainMappings: false, usage: false } });
    expect(environment.status).toBe(201);
    expect(Object.keys((await privateCatalog()).nativeBindings)).toHaveLength(0);
    computeSettled = false;
    const created = await appRequest<{ id: string; userId: string; runtimeKind: string; status: string; containerName: string }>('/api/containers',
      { displayName: marker, environmentId: environment.body.id, imageDefinitionId: definition.body.id, imageVersion: built.version }, true, 3_600_000);
    expect(created.status).toBe(201); expect(created.body).toMatchObject({ userId, runtimeKind: 'incus-vm', status: 'running' });
    owner = { id: created.body.id, userId, containerName: created.body.containerName };
    }
    expect(owner.id).toMatch(/^[a-f0-9-]{36}$/); expect(owner.containerName).toBe(config.containerPrefix + '-' + owner.id);
    const first = evictedCache ? customRetained!.instance : await runtime.client.getInstance(owner.containerName), firstUuid = first.config['volatile.uuid'];
    if (typeof firstUuid !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(firstUuid))
      throw new Error('Created custom worker omitted its exact native incarnation');
    expect(firstUuid).toMatch(/^[a-f0-9-]{36}$/); expect(await runtime.matchesWorkerIdentity(first, owner.id, userId)).toBe(true);
    const state = await privateCatalog(), bindings = Object.values(state.nativeBindings);
    expect(bindings).toHaveLength(evictedCache ? 0 : 1); const binding = evictedCache ? customRetained!.binding : bindings[0]!;
    expect(binding.capability).toBe('agentor-storage-ownership-v1');
    expect(binding.context).toMatchObject({ installationId: installation, project: custom.project, seedFingerprint: custom.seedFingerprint,
      sourceImageId: built.digest });
    expect(binding.context.recipeId).toBe(incusConversionRecipeId(built.digest, await readCanonicalIncusBootstrap(join(customInstance ? customRetained!.localDir : local, 'current-bootstrap'))));
    const native = state.builds.filter(build => build.nativeDerivation);
    expect(native).toHaveLength(evictedCache ? 4 : 1); const conversion = native.find(build => build.id === binding.buildId)!;
    expect(conversion).toMatchObject({ id: binding.buildId, status: 'succeeded' });
    expect(conversion.nativeDerivation?.source).toMatchObject({ requesterId: userId, definitionId: definition.body.id,
      definitionOwnerId: userId, version: built.version, sourceBuildId: built.id, sourceImageId: built.digest, scope: 'own' });
    expect(conversion.nativeDerivation?.converter).toMatchObject({ removed: true, project: custom.project, sourceImageId: built.digest,
      installationId: installation, seedFingerprint: custom.seedFingerprint, name: 'aic-' + conversion.id, recipeId: binding.context.recipeId });
    expect(conversion.nativeDerivation?.converter?.incarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(conversion.nativeDerivation?.converter?.pending).toBeUndefined();
    await expect(runtime.client.getInstance('aic-' + conversion.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(conversion.nativeDerivation?.imageImport).toMatchObject({ pending: false, fingerprint: binding.identity.fingerprint });
    expect(first.config['volatile.base_image']).toBe(binding.identity.fingerprint);
    let image: Awaited<ReturnType<typeof runtime.client.getImage>> | undefined;
    if (!evictedCache) {
      image = await runtime.client.getImage(binding.identity.fingerprint);
      expect(incusImageIdentity(image)).toEqual(binding.identity); expect(image.aliases).toEqual([]);
      expect(baselineImages).not.toContain(image.fingerprint);
    }
    const publicBuilds = await appRequest<ImageBuild[]>('/api/image-builds'); expect(publicBuilds.status).toBe(200);
    for (const build of publicBuilds.body) expect(build).not.toHaveProperty('nativeDerivation');
    const publicDefinition = await appRequest<ImageDefinition>('/api/image-catalog/definitions/' + definition.body.id);
    expect(publicDefinition.status).toBe(200); expect(publicDefinition.body).not.toHaveProperty('nativeBindings');
    const rows = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
      quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: owner.id, userId, runtimeKind: 'incus-vm', imageDefinitionId: definition.body.id,
      imageVersion: built.version, imageDigest: built.digest }); expect(rows[0]?.incusRecreation).toBeUndefined();
    if (evictedCache) expect(rows[0]).toEqual(customRetained!.evictedWorker);
    const volumeNames = ['workspace', 'agents'].map(role => owner.containerName + '-' + role);
    const volumes = await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    for (const [index, volume] of volumes.entries()) expect(volume).toMatchObject({ project: custom.project, type: 'custom', content_type: 'filesystem',
      created_at: expect.any(String), config: { 'user.agentor.installation': installation, 'user.agentor.owner': userId, 'user.agentor.id': owner.id,
        'user.agentor.storage-role': index ? 'agents' : 'workspace' } });
    const assertGuest = async (uuid: string, examined = owner) => {
      const current = await runtime.client.getInstance(examined.containerName);
      expect(current.config['volatile.uuid']).toBe(uuid); expect(current.config['volatile.base_image']).toBe(binding.identity.fingerprint);
      expect(await runtime.matchesWorkerIdentity(current, examined.id, userId)).toBe(true); expect(current.profiles).toEqual([]);
      expect(current.devices.eth0).toMatchObject({ network: custom!.network, 'security.mac_filtering': 'true',
        'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
      for (const device of Object.values(current.devices)) expect(JSON.stringify(device)).not.toContain(custom!.tlsRoot);
      const proof = await runtime.client.exec(examined.containerName, ['bash', '-ec',
        'test "$(cat /opt/agentor-custom-proof)" = "$1"; test "$(cat /proc/1/comm)" = systemd; ' +
        'systemctl is-active --quiet incus-agent agentor-worker; ! systemctl is-active --quiet docker; ' +
        'test ! -e /tls/client.key; test ! -e /tls/client.crt; . /run/agentor/worker.env; ' +
        'test "$(printf "%s" "$ENVIRONMENT" | jq -r .envVars)" = "CUSTOM_PUBLIC_RUNTIME_PROBE=$1"; ' +
        'test "$(runuser -u agent -- tmux show-environment -g CUSTOM_PUBLIC_RUNTIME_PROBE)" = "CUSTOM_PUBLIC_RUNTIME_PROBE=$1"; ' +
        'curl -fsS http://127.0.0.1:8443/ >/dev/null; curl -fsS http://127.0.0.1:6080/ >/dev/null', 'bash', marker]);
      expect(proof.returnCode, proof.stderr).toBe(0);
      const editor = await appRequest<string>('/editor/' + examined.id + '/?folder=/workspace'); expect(editor.status).toBe(200); expect(editor.body).toContain('code-server');
      const desktop = await appRequest<string>('/desktop/' + examined.id + '/agentor.html'); expect(desktop.status).toBe(200); expect(desktop.body).toContain('noVNC');
      const self = await runtime.client.exec(examined.containerName, ['curl', '--noproxy', '*', '-fsS', config.incusInternalGatewayUrl + '/api/worker-self/info']);
      expect(self.returnCode, self.stderr).toBe(0); expect(JSON.parse(self.stdout)).toMatchObject({ workerId: examined.id, userId });
    };
    if (customInverse && customRetained && inverse) {
      // Consume only the already authenticated producer output; no recapture,
      // synthetic restore plan/job, private binding or native acknowledgement.
      const sourceData = remoteData, sourceApp = targetId, sourceImage = imageId, sourceSnapshot = await runtime.client.getInstance(owner.containerName);
      expect(sourceSnapshot.status).toBe('Stopped'); expect(sourceSnapshot.config['volatile.uuid']).toBe(firstUuid);
      const sourceVolumes = await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      expect(sourceVolumes.toSorted((a, b) => a.name.localeCompare(b.name)))
        .toEqual(customRetained.volumes.toSorted((a, b) => a.name.localeCompare(b.name)));
      const producer = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + inverse.backupId);
      expect(producer.status).toBe(200); expect(producer.body).toMatchObject({ id: inverse.backupId, userId, operation: 'create', status: 'succeeded', requestId: inverse.producerRequestId });
      const published = await appRequest<InstanceBackupArtifact>('/api/admin/instance-backups/artifacts/' + inverse.backupId);
      expect(published.status).toBe(200); expect(isDeepStrictEqual(published.body, inverse.artifact)).toBe(true);
      const encrypted = join(inverse.localCaptureDir, 'captured.backup'), keyPath = join(inverse.localCaptureDir, 'captured-key.json');
      const captureDirectory = await lstat(inverse.localCaptureDir);
      expect(captureDirectory.isDirectory() && !captureDirectory.isSymbolicLink() && !(captureDirectory.mode & 0o077)).toBe(true);
      for (const path of [encrypted, keyPath]) {
        const s = await lstat(path); expect(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid?.() && !(s.mode & 0o077)).toBe(true);
        expect(path === encrypted ? s.size === inverse.artifact.size : s.size > 0 && s.size <= 16384).toBe(true);
      }
      if (inverse.fileSha256) expect(await sha256File(encrypted)).toBe(inverse.fileSha256);
      const recovery = JSON.parse(await readFile(keyPath, 'utf8')) as { keyMaterial: string; fingerprint: string };
      expect(backupKeyFingerprint(recovery.keyMaterial)).toBe(inverse.artifact.keyFingerprint);
      const header = await inspectInstanceBackup(encrypted);
      expect(header.keyFingerprint).toBe(inverse.artifact.keyFingerprint); expect(header.metadata.backupId).toBe(inverse.backupId);
      const plain = join(local, 'inverse-authenticated.tar'), inspectedDir = join(local, 'inverse-authenticated');
      await decryptInstanceBackup(encrypted, plain, recovery.keyMaterial, inverse.artifact.sha256); // Payload+tag digest, not whole-file SHA.
      const captured = await inspectInstanceBundle(plain, inspectedDir);
      expect(captured.manifest.backupId).toBe(inverse.backupId); expect(captured.manifest.sourceInstallationId).toBe(installation);
      expect(captured.manifest.volumes.map(v => v.runtime?.role).sort()).toEqual(['agents', 'workspace']);
      const capturedWorkers = JSON.parse((await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'users/' + userId + '/workers.json'], { maxBuffer: 1024 * 1024 })).stdout) as WorkerRecord[];
      expect(capturedWorkers).toHaveLength(1); expect(capturedWorkers[0]).toMatchObject({ id: owner.id, userId, runtimeKind: 'incus-vm', desiredRuntimeStatus: 'stopped',
        imageDefinitionId: definition.body.id, imageVersion: built.version, imageDigest: built.digest });
      const metadata = join(local, 'inverse-metadata'); await mkdir(join(metadata, 'users', userId), { recursive: true, mode: 0o700 });
      for (const member of ['backup-installation-id', 'worker-config.key', 'users/' + userId + '/worker-configurations.json', 'auth.db'])
        await writeFile(join(metadata, member), (await run('tar', ['-xzOf', captured.dataArchivePath, '--', member], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout, { mode: 0o600 });
      expect(await readBackupInstallationId(metadata)).toBe(installation);
      const bootstrap = await new WorkerConfigStore({ ...config, dataDir: metadata }).resolveAppliedBootstrap(userId, owner.id);
      expect(bootstrap?.dockerEnabled).toBe(false); expect(bootstrap?.workerJson.id).toBe(owner.id);
      expect(bootstrap?.environmentJson.envVars).toBe('CUSTOM_PUBLIC_RUNTIME_PROBE=' + marker);
      const sqlite = JSON.parse((await run('python3', ['-c',
        'import json,sqlite3,sys;c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(json.dumps(dict(integrity=c.execute("pragma integrity_check").fetchone()[0],user=c.execute("select id,email,role from user where id=?",(sys.argv[2],)).fetchone())));c.close()',
        join(metadata, 'auth.db'), userId])).stdout); expect(sqlite).toEqual({ integrity: 'ok', user: [userId, admin.email, 'admin'] });
      const archivedCatalog = JSON.parse((await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'image-catalog/image-catalog.json'], { maxBuffer: 1024 * 1024 })).stdout) as typeof state;
      expect(archivedCatalog.nativeBindings).toEqual(state.nativeBindings);
      expect(archivedCatalog.builds.map(b => ({ ...b, logs: undefined }))).toEqual(state.builds.map(b => ({ ...b, logs: undefined })));
      expect(archivedCatalog.definitions).toEqual(state.definitions);
      const rawRoot = join(local, 'inverse-raw'); await mkdir(rawRoot, { mode: 0o700 });
      for (const descriptor of captured.manifest.volumes) {
        expect(descriptor.ownerId).toBe(userId); expect(descriptor.workerId).toBe(owner.id);
        if (!descriptor.runtime || descriptor.runtime.role === 'managed') throw new Error('Cold custom capture has foreign storage');
        expect(descriptor.runtime.source).toEqual(snapshotIncusWorkerBackupRuntime(binding.identity).source);
        const raw = await prepareInstanceNativeVolumeArchive(captured.volumeArchives.get(descriptor.name)!, descriptor, rawRoot);
        const entry = descriptor.runtime.role === 'workspace' ? 'workspace/custom-cache-proof' : '.agent-data/custom-cache-proof';
        expect((await run('tar', ['-xOf', raw.archivePath, '--', entry], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout.equals(Buffer.from(marker))).toBe(true);
      }
      // Export the existing key's REAL kit and the pre-snapshot cookie privately.
      const sourceSession = '/tmp/agentor-producer-' + inverse.producerRequestId.slice(0, -8) + '/session';
      const privateInput = '/tmp/agentor-instance-inverse-' + followupNonce;
      const exportKit = `import fs from'node:fs';const p=${JSON.stringify(sourceSession)},s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&63))throw Error('Source session differs');` +
        `fs.mkdirSync(${JSON.stringify(privateInput)},{mode:448});const r=await fetch('http://127.0.0.1:3000/api/backups/recovery-key/export',{method:'POST',headers:{Origin:'http://127.0.0.1:3000','Content-Type':'application/json',Cookie:fs.readFileSync(p,'utf8')},` +
        `body:JSON.stringify({password:${JSON.stringify(admin.password)},fingerprint:${JSON.stringify(inverse.artifact.keyFingerprint)}})});if(!r.ok)throw Error('Actual recovery kit unavailable');const kit=await r.json();` +
        `if(kit.fingerprint!==${JSON.stringify(inverse.artifact.keyFingerprint)})throw Error('Actual recovery kit differs');fs.writeFileSync(${JSON.stringify(privateInput + '/kit.json')},JSON.stringify({kit}),{mode:384,flag:'wx'});` +
        `fs.copyFileSync(p,${JSON.stringify(privateInput + '/session')},fs.constants.COPYFILE_EXCL);fs.chmodSync(${JSON.stringify(privateInput + '/session')},384);console.log('Private inverse inputs prepared');`;
      try { await root(`sudo docker exec ${sourceApp} node --input-type=module -e ${quote(exportKit)}`); }
      catch { throw new Error('Private actual recovery inputs could not be prepared'); }
      await Promise.all([mkdir(join(targetData, 'admin'), { recursive: true, mode: 0o700 }), mkdir(build)]);
      await prepareImage(); // Fresh EMPTY recovery DATA, same restricted operator namespace/TLS.
      const sourcePort = appPort; appPort = 39000 + Number.parseInt(followupNonce.slice(0, 4), 16) % 1000;
      if (appPort === sourcePort) appPort = 39000 + (appPort - 39000 + 1) % 1000;
      remoteData = remote + '/data'; config.incusInternalGatewayUrl = 'http://10.159.68.1:' + appPort;
      await launchTarget(); await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
      const stageAdmin = await appRequest<{ id: string; role: string }>('/api/setup/create-admin', admin, false);
      expect(stageAdmin.status).toBe(201); expect(stageAdmin.body.role).toBe('admin'); stagingOwner = stageAdmin.body.id;
      expect((await appRequest<unknown[]>('/api/containers')).body).toEqual([]);
      // Scope only the restored account's exact directories in new recovery DATA.
      await policy(true);
      const incoming = remote + '/inverse-input'; await root(`test ! -e ${quote(incoming)} && mkdir -m 700 ${quote(incoming)}`);
      await run('scp', [...scp, encrypted, 'kata-test@172.19.0.1:' + incoming + '/captured.backup'], { timeout: 60_000 });
      for (const file of ['kit.json', 'session']) await root(`sudo docker cp ${sourceApp}:${quote(privateInput + '/' + file)} ${quote(incoming + '/' + file)} && sudo chmod 600 ${quote(incoming + '/' + file)}`);
      const targetInput = '/tmp/agentor-instance-recovery-' + followupNonce;
      await root(`sudo docker exec ${targetId} mkdir -m 700 ${quote(targetInput)}`);
      for (const file of ['captured.backup', 'kit.json', 'session']) await root(`sudo docker cp ${quote(incoming + '/' + file)} ${targetId}:${quote(targetInput + '/' + file)}`);
      const importedKit = await appRequest<{ imported: boolean; fingerprint: string }>('/api/backups/recovery-key/import', undefined, true, 30_000, { path: targetInput + '/kit.json', format: 'json' });
      expect(importedKit.status).toBe(200); expect(importedKit.body.fingerprint).toBe(inverse.artifact.keyFingerprint);
      const uploaded = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/import?requestId=' + followupNonce + '-upload', undefined, true, 180_000, { path: targetInput + '/captured.backup', format: 'binary' });
      expect(uploaded.status).toBe(202); await expect.poll(async () => {
        const job = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + uploaded.body.jobId);
        if (job.body.status === 'failed') throw new Error('Actual cold import verification failed: ' + job.body.errorCode); return job.body.status;
      }, { timeout: 180_000 }).toBe('succeeded');
      const before = await appRequest<InstanceRestorePreflight>('/api/admin/instance-backups/artifacts/' + inverse.backupId + '/preflight?restoreDockerVolumes=true&restoreHostMountPolicies=false');
      expect(before.status).toBe(200); expect(before.body.volumeConflicts.sort()).toEqual([...volumeNames].sort());
      expect([...before.body.blockers].sort()).toEqual([
        `Destination Incus instance ${owner.containerName} already exists; safe restore will not replace it.`,
        'One or more destination persistent volumes already exist. Agentor will not overwrite them during a safe instance restore.',
      ].sort());
      // ALL authenticated file/SQLite/source/cache checks succeeded above.
      // Stop only the source controller; never delete its DATA or records.
      expect(await root(`sudo docker inspect ${sourceApp} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{.State.Running}}'`)).toBe(`${sourceApp} ${sourceImage} ${jobId} true`);
      expect(await runtime.client.getInstance(owner.containerName)).toEqual(sourceSnapshot);
      expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
      computeSettled = false; await root(`sudo docker stop --time 30 ${sourceApp}`, 60_000);
      expect(await root(`sudo docker inspect ${sourceApp} --format '{{.Id}} {{.Image}} {{.State.Running}}'`)).toBe(`${sourceApp} ${sourceImage} false`);
      await runtime.remove(owner, firstUuid); await runtime.removeStorage(owner);
      await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
      for (const name of volumeNames) await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
      const preflight = await appRequest<InstanceRestorePreflight>('/api/admin/instance-backups/artifacts/' + inverse.backupId + '/preflight?restoreDockerVolumes=true&restoreHostMountPolicies=false');
      expect(preflight.status).toBe(200);
      expect(preflight.body).toMatchObject({ ready: true, blockers: [], volumeConflicts: [], sourceInstallationId: installation, destinationContainerPrefix: config.containerPrefix });
      const restoring = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/artifacts/' + inverse.backupId + '/restore',
        { options: { restoreDockerVolumes: true, restoreHostMountPolicies: false, confirmReplaceControlPlane: true, confirmExternalDependencies: true }, requestId: followupNonce + '-restore' });
      expect(restoring.status).toBe(202); restoreJobId = restoring.body.jobId;
      expect(restoreJobId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
      const stage = remoteData + '/instance-restore-staging/restore-' + restoreJobId;
      const ledger = async (): Promise<InstanceBackupJob | undefined> => JSON.parse(await root(`sudo python3 -c ${quote(
        'import json,sys;print(json.dumps(next((j for j in json.load(open(sys.argv[1]))["jobs"] if j["id"]==sys.argv[2]),None)))')} ` +
        quote(remoteData + '/admin/instance-backups.v1.json') + ' ' + quote(restoreJobId))) ?? undefined;
      let receipt: InstanceBackupJob['restoreHelper'];
      await expect.poll(async () => { receipt = (await ledger())?.restoreHelper; return Boolean(receipt); }, { timeout: 180_000, intervals: [250, 500] }).toBe(true);
      if (!receipt) throw new Error('Exact cold helper acknowledgement unavailable'); helperId = receipt.containerId;
      expect(helperId).toMatch(/^[a-f0-9]{64}$/);
      const helper = JSON.parse(await root(`sudo docker inspect ${helperId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { User: string; Labels: Record<string, string>; Env: string[] };
        HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; CapAdd: string[]; SecurityOpt: string[]; Privileged: boolean;
          RestartPolicy: { Name: string }; NetworkMode: string };
        Mounts: Array<{ Source: string; Destination: string; RW: boolean; Type: string }>;
      };
      expect(helper.Id).toBe(helperId); expect(helper.Image).toBe(imageId); expect(receipt.imageId).toBe(imageId);
      expect(helper.Config.Labels).toMatchObject({ 'agentor.instance-restore-helper': 'true', 'agentor.instance-restore-job': restoreJobId });
      expect(helper.Config.User).toBe('0:0'); expect(helper.HostConfig.ReadonlyRootfs).toBe(true);
      expect(helper.HostConfig.CapDrop).toEqual(['ALL']); expect([...helper.HostConfig.CapAdd].sort()).toEqual(['CHOWN', 'DAC_OVERRIDE', 'FOWNER']);
      expect(helper.HostConfig.SecurityOpt).toContain('no-new-privileges:true'); expect(helper.HostConfig.Privileged).toBe(false);
      expect(helper.HostConfig.RestartPolicy.Name).toBe('no');
      const controlNetwork = await root(`sudo docker inspect ${targetId} --format '{{.HostConfig.NetworkMode}}'`);
      expect(controlNetwork).toMatch(/^[A-Za-z0-9_.-]+$/); expect(helper.HostConfig.NetworkMode).toBe(controlNetwork);
      expect(helper.Mounts.some(m => m.Type === 'bind' && m.Source === remoteData && m.Destination === remoteData && m.RW)).toBe(true);
      for (const value of [`AGENTOR_INSTANCE_RESTORE_JOB=${restoreJobId}`, `AGENTOR_INSTANCE_RESTORE_STAGE=${stage}`, `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`, `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`]) expect(helper.Config.Env).toContain(value);
      expect(helper.Mounts.some(m => m.Source.startsWith('/var/lib/incus') || m.Destination.startsWith('/var/lib/incus'))).toBe(false);
      for (const file of ['client.crt', 'client.key', 'server.crt']) expect(helper.Mounts.some(m => m.Source === tlsRoot + '/' + file && m.Destination === '/tls/' + file && !m.RW)).toBe(true);
      const code = await root(`sudo docker wait ${helperId}`, 600_000); expect(code).toBe('0');
      stagingOwner = userId;
      await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
      const finished = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId, undefined, true, 30_000, undefined, targetInput + '/session');
      expect(finished.status).toBe(200); expect(finished.body).toMatchObject({ id: restoreJobId, userId, status: 'succeeded', phase: 'complete' }); expect(finished.body).not.toHaveProperty('restoreHelper');
      expect(await ledger()).not.toHaveProperty('restoreHelper'); await root(`sudo test ! -e ${quote(stage)}`);
      expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe(''); helperRemovedByManager = true;
      const recreated = await runtime.client.getInstance(owner.containerName), recreatedUuid = recreated.config['volatile.uuid'];
      if (typeof recreatedUuid !== 'string' || !/^[a-f0-9-]{36}$/.test(recreatedUuid)) throw new Error('Cold incarnation not acknowledged');
      expect(recreatedUuid).not.toBe(firstUuid); expect(recreated.status).toBe('Stopped'); expect(await runtime.matchesWorkerIdentity(recreated, owner.id, userId)).toBe(true);
      expect(recreated.config['volatile.base_image']).toBe(binding.identity.fingerprint); expect(recreated.config['user.agentor.restore']).toBeUndefined();
      const records = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` + quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ id: owner.id, userId, runtimeKind: 'incus-vm', desiredRuntimeStatus: 'stopped', imageDefinitionId: definition.body.id, imageVersion: built.version, imageDigest: built.digest }); expect(records[0]?.incusRecreation).toBeUndefined();
      const coldVolumes = await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      for (const [index, volume] of coldVolumes.entries()) {
        const createdAt = Date.parse(volume.created_at ?? '');
        expect(Number.isFinite(createdAt)).toBe(true);
        expect(volume.used_by).toEqual(['/1.0/instances/' + owner.containerName + '?project=' + custom.project]);
        expect(volume).toMatchObject({ project: custom.project, type: 'custom', content_type: 'filesystem', config: { 'user.agentor.installation': installation, 'user.agentor.owner': userId, 'user.agentor.id': owner.id, 'user.agentor.storage-role': index ? 'agents' : 'workspace' } });
      }
      expect((await privateCatalog()).nativeBindings).toEqual(state.nativeBindings);
      expect((await privateCatalog()).builds.filter(build => build.nativeDerivation)).toEqual(native);
      expect((await appRequest('/api/containers/' + owner.id + '/restart', {}, true, 360_000)).status).toBe(200); await assertGuest(recreatedUuid);
      const markers = await runtime.client.exec(owner.containerName, ['bash', '-ec', 'test "$(cat /workspace/custom-cache-proof)" = "$1"; test "$(cat /home/agent/.agent-data/custom-cache-proof)" = "$1"', 'bash', marker]); expect(markers.returnCode, markers.stderr).toBe(0);
      expect((await runtime.client.getInstance(owner.containerName)).config['volatile.uuid']).toBe(recreatedUuid);
      expect(await root(`sudo docker inspect ${sourceApp} --format '{{.Id}} {{.Image}} {{.State.Running}}'`)).toBe(`${sourceApp} ${sourceImage} false`);
      const originalRecords = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` + quote(sourceData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
      expect(originalRecords.find(record => record.id === owner.id)).toMatchObject({ userId, runtimeKind: 'incus-vm', desiredRuntimeStatus: 'stopped', imageDigest: built.digest });
      computeSettled = true;
      console.info('Actual custom whole-instance cold public restore passed authenticated original ciphertext, SQLite/bootstrap/catalog/private source, exact fixture retirement, empty-target admission/helper ACK/restart and fresh sameWorker native identity/bytes/services; original DATA/capture and healthy recovery retained',
        { local, remote, sourceData, sourceApp, sourceControllerMustRemainStopped: true, recoveryData: remoteData, recoveryApp: targetId, recoveryImage: imageId, gateway: config.incusInternalGatewayUrl, workerId: owner.id, incarnation: recreatedUuid, restoreJobId, backupId: inverse.backupId });
      return;
    }
    if (!evictedCache) await assertGuest(firstUuid);
    if (customCache && customRetained?.scratch) {
      const markerCommand = ['bash', '-ec', 'test "$(cat /workspace/custom-cache-proof)" = "$1"; test "$(cat /home/agent/.agent-data/custom-cache-proof)" = "$1"', 'bash', marker];
      const scratch = customRetained.scratch, scratchTarget = remoteData + '/incus-image-converters';
      if (!evictedCache) {
      expect((await runtime.client.exec(owner.containerName, markerCommand)).returnCode).toBe(0);
      computeSettled = false;
      expect((await appRequest('/api/containers/' + owner.id + '/archive', {}, true, 360_000)).status).toBe(200);
      await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
      const detached = volumes.map(volume => ({ ...volume, used_by: [] }));
      expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(detached);
      expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{.State.Running}}'`)).toBe(`${targetId} ${imageId} ${jobId} true`);
      // Operator fixture mount: only fresh reconstructable scratch, never
      // canonical state. Source originals remain stopped in this namespace.
      const checkScratch = String.raw`import os,stat,json,sys
p=sys.argv[1];s=os.lstat(p)
assert os.path.realpath(p)==p and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
assert (s.st_dev,s.st_ino)==(int(sys.argv[2]),int(sys.argv[3])) and not os.listdir(p)
print('Approved empty private HDD scratch verified')`;
      await root(`sudo python3 -c ${quote(checkScratch)} ${quote(scratch.path)} ${scratch.dev} ${scratch.ino}`);
      await root(`sudo docker stop --time 30 ${targetId}`, 60_000);
      expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{.State.Running}}'`)).toBe(`${targetId} ${imageId} false`);
      await root(`sudo python3 -c ${quote(String.raw`import os,stat,subprocess,sys
src,dst=sys.argv[1:3];s=os.lstat(src)
assert os.path.realpath(src)==src and stat.S_ISDIR(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o700
assert (s.st_dev,s.st_ino)==(int(sys.argv[3]),int(sys.argv[4])) and not os.listdir(src)
parent=os.path.dirname(dst);assert os.path.realpath(parent)==parent
if not os.path.lexists(dst):os.mkdir(dst,0o700)
t=os.lstat(dst);assert stat.S_ISDIR(t.st_mode) and not stat.S_ISLNK(t.st_mode) and not os.listdir(dst)
assert os.path.realpath(dst)==dst and t.st_dev!=s.st_dev and subprocess.run(['mountpoint','-q',dst]).returncode==32
subprocess.run(['mount','--bind',src,dst],check=True)
assert (os.stat(dst).st_dev,os.stat(dst).st_ino)==(s.st_dev,s.st_ino)
print('Regenerable scratch only mounted')`)} ${quote(scratch.path)} ${quote(scratchTarget)} ${scratch.dev} ${scratch.ino}`);
      await root(`sudo docker start ${targetId}`);
      expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{.State.Running}}'`)).toBe(`${targetId} ${imageId} ${jobId} true`);
      const networks = JSON.parse(await root(`sudo docker inspect ${targetId} --format '{{json .NetworkSettings.Networks}}'`)) as Record<string, { IPAddress: string }>;
      const originalNetworks = customRetained.app.NetworkSettings.Networks as Record<string, { IPAddress: string }>;
      expect(Object.keys(networks).sort()).toEqual(Object.keys(originalNetworks).sort());
      for (const key of Object.keys(networks)) expect(networks[key]!.IPAddress).toBe(originalNetworks[key]!.IPAddress); // Changed IP quarantines; no rule adoption.
      expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${customRetained.nft.table}`)))
        .toBe(sourceRuleSnapshot(typeof customRetained.nft.json === 'string' ? customRetained.nft.json : JSON.stringify(customRetained.nft.json)));
      const mounted = JSON.parse(await root(`sudo docker exec ${targetId} node -e ${quote(
        `const f=require('node:fs'),p=${JSON.stringify(scratchTarget)},s=f.lstatSync(p),d=f.statSync(${JSON.stringify(remoteData)});` +
        `if(!s.isDirectory()||s.isSymbolicLink()||f.readdirSync(p).length)throw Error('Scratch mount is not empty');console.log(JSON.stringify({dev:s.dev,ino:s.ino,parentDev:d.dev}));`)}`)) as { dev: number; ino: number; parentDev: number };
      expect(mounted.dev).toBe(scratch.dev); expect(mounted.ino).toBe(scratch.ino); expect(mounted.parentDev).not.toBe(scratch.dev);
      await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
      expect((await privateCatalog()).nativeBindings).toEqual(state.nativeBindings);
      const unused = await runtime.client.getImage(binding.identity.fingerprint); expect(incusImageIdentity(unused)).toEqual(binding.identity); expect(unused.aliases).toEqual([]);
      expect((await runtime.client.listInstances()).some(instance => instance.config['volatile.base_image'] === unused.fingerprint)).toBe(false);
      expect(await runtime.client.getImage(unused.fingerprint)).toEqual(unused);
      await root(`sudo incus image delete ${quote(unused.fingerprint)} --project ${quote(custom!.project)}`, 120_000);
      await expect(runtime.client.getImage(unused.fingerprint)).rejects.toMatchObject({ statusCode: 404 });
      } else {
        const mounted = JSON.parse(await root(`sudo docker exec ${targetId} node -e ${quote(
          `const f=require('node:fs'),s=f.lstatSync(${JSON.stringify(remoteData + '/incus-image-converters')}),d=f.statSync(${JSON.stringify(remoteData)});` +
          `if(!s.isDirectory()||s.isSymbolicLink())throw Error('Scratch mount unavailable');console.log(JSON.stringify({dev:s.dev,ino:s.ino,parentDev:d.dev}));`)}`)) as { dev: number; ino: number; parentDev: number };
        expect(mounted.dev).toBe(customRetained.scratch.dev); expect(mounted.ino).toBe(customRetained.scratch.ino); expect(mounted.parentDev).not.toBe(mounted.dev);
        for (const volume of volumes) expect(volume.used_by).toEqual([]);
        computeSettled = false;
      }
      // Production manager alone forgets this verified-missing cache hint;
      // old completed receipts remain authoritative history, never replayed.
      const unarchived = await appRequest<{ id: string; runtimeKind: string; status: string }>('/api/archived/' + owner.id + '/unarchive', {}, true, 3_600_000);
      expect(unarchived.status).toBe(200); expect(unarchived.body).toMatchObject({ id: owner.id, runtimeKind: 'incus-vm', status: 'running' });
      const after = await privateCatalog(), newNative = after.builds.filter(build => build.nativeDerivation);
      expect(newNative).toHaveLength(native.length + 1); for (const old of native) expect(newNative.find(build => build.id === old.id)).toEqual(old);
      expect(Object.keys(after.nativeBindings)).toEqual(evictedCache ? [customRetained.oldBindingKey!] : Object.keys(state.nativeBindings)); const regenerated = Object.values(after.nativeBindings)[0]!;
      expect(regenerated.buildId).not.toBe(binding.buildId); expect(regenerated.context).toEqual(binding.context);
      expect(regenerated.identity.sourceImageId).toBe(built.digest); expect(regenerated.capability).toBe(binding.capability);
      const regeneratedJob = newNative.find(build => build.id === regenerated.buildId)!;
      expect(regeneratedJob.status).toBe('succeeded'); expect(regeneratedJob.nativeDerivation?.converter).toMatchObject({ removed: true, sourceImageId: built.digest, project: custom!.project });
      expect(regeneratedJob.nativeDerivation?.converter?.pending).toBeUndefined();
      expect(regeneratedJob.nativeDerivation?.imageImport).toMatchObject({ pending: false, fingerprint: regenerated.identity.fingerprint });
      const current = await runtime.client.getInstance(owner.containerName), currentUuid = current.config['volatile.uuid'];
      if (typeof currentUuid !== 'string' || !/^[a-f0-9-]{36}$/.test(currentUuid)) throw new Error('Regenerated worker incarnation missing');
      expect(currentUuid).not.toBe(firstUuid); expect(current.config['volatile.base_image']).toBe(regenerated.identity.fingerprint);
      expect(await runtime.matchesWorkerIdentity(current, owner.id, userId)).toBe(true);
      const checkCurrent = async (uuid: string) => {
        // assertGuest checks the ORIGINAL binding; generation may legitimately
        // produce the same or different fingerprint, so validate new identity.
        const value = await runtime.client.getInstance(owner.containerName); expect(value.config['volatile.uuid']).toBe(uuid);
        expect(incusImageIdentity(await runtime.client.getImage(value.config['volatile.base_image']!))).toEqual(regenerated.identity);
        expect(value.profiles).toEqual([]); expect(value.devices.eth0).toMatchObject({ network: custom!.network,
          'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
        expect((await runtime.client.exec(owner.containerName, markerCommand)).returnCode).toBe(0);
        const guest = await runtime.client.exec(owner.containerName, ['bash', '-ec', 'test "$(cat /opt/agentor-custom-proof)" = "$1"; test "$(cat /proc/1/comm)" = systemd; ' +
          'systemctl is-active --quiet incus-agent agentor-worker; ! systemctl is-active --quiet docker; test ! -e /tls/client.key; test ! -e /tls/client.crt; . /run/agentor/worker.env; ' +
          'test "$(printf "%s" "$ENVIRONMENT" | jq -r .envVars)" = "CUSTOM_PUBLIC_RUNTIME_PROBE=$1"; ' +
          'test "$(runuser -u agent -- tmux show-environment -g CUSTOM_PUBLIC_RUNTIME_PROBE)" = "CUSTOM_PUBLIC_RUNTIME_PROBE=$1"', 'bash', marker]); expect(guest.returnCode, guest.stderr).toBe(0);
        const editor = await appRequest<string>('/editor/' + owner.id + '/?folder=/workspace'); expect(editor.status).toBe(200); expect(editor.body).toContain('code-server');
        const desktop = await appRequest<string>('/desktop/' + owner.id + '/agentor.html'); expect(desktop.status).toBe(200); expect(desktop.body).toContain('noVNC');
        const self = await runtime.client.exec(owner.containerName, ['curl', '--noproxy', '*', '-fsS', config.incusInternalGatewayUrl + '/api/worker-self/info']); expect(self.returnCode, self.stderr).toBe(0); expect(JSON.parse(self.stdout)).toMatchObject({ workerId: owner.id, userId });
      };
      await checkCurrent(currentUuid);
      const core = await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      for (const [index, volume] of core.entries()) {
        expect(volume.created_at).toBe(volumes[index]!.created_at); expect(volume.name).toBe(volumes[index]!.name);
        const expectedConfig = { ...volumes[index]!.config };
        if (index === 0) {
          const stored = volume.config['user.agentor.image-source']; if (typeof stored !== 'string') throw new Error('Acknowledged regenerated source metadata missing');
          expect(JSON.parse(stored)).toEqual(regenerated.identity); expectedConfig['user.agentor.image-source'] = stored;
        }
        expect(volume).toEqual({ ...volumes[index]!, config: expectedConfig,
          used_by: evictedCache ? ['/1.0/instances/' + owner.containerName + '?project=' + custom!.project] : volumes[index]!.used_by });
      }
      expect((await appRequest('/api/containers/' + owner.id + '/rebuild', {}, true, 360_000)).status).toBe(200);
      const warm = await runtime.client.getInstance(owner.containerName), warmUuid = warm.config['volatile.uuid'];
      if (typeof warmUuid !== 'string' || !/^[a-f0-9-]{36}$/.test(warmUuid)) throw new Error('Warm cache incarnation missing');
      expect(warmUuid).not.toBe(currentUuid); await checkCurrent(warmUuid);
      const warmCatalog = await privateCatalog(); expect(warmCatalog.nativeBindings).toEqual(after.nativeBindings); expect(warmCatalog.builds.filter(build => build.nativeDerivation)).toEqual(newNative);
      expect(await root(`sudo docker image inspect ${quote(built.digest!)} --format '{{.Id}} {{index .Config.Labels "agentor.image-definition"}} {{index .Config.Labels "agentor.image-owner-hash"}}'`))
        .toBe(`${built.digest} ${definition.body.id} ${createHash('sha256').update(userId).digest('hex')}`);
      expect(await root(`sudo docker inspect 576101a2d3381e136f699b085ddffd50f3fa9615779a355b8c28ab692acd5db3 --format '{{.State.Running}}'`)).toBe('false');
      computeSettled = true;
      console.info('Actual verified-missing private cache regenerated once via public archive/unarchive on HDD-only scratch; historical receipts/sourceOCI/persistent data retained, warm rebuild reused new binding; recovery remains active', { local, remoteData, targetId, imageId, workerId: owner.id, incarnation: warmUuid, regeneratedBuild: regenerated.buildId, fingerprint: regenerated.identity.fingerprint, scratch: scratch.path });
      return;
    }
    if (!image) throw new Error('Missing cache admission must finish through its explicit cache gate');
    if (customInstance && customRetained) {
      computeSettled = false;
      const produced = await runProducer(snapshotIncusWorkerBackupRuntime(binding.identity).source, installation,
        { owner, incarnation: firstUuid, marker, catalog: state });
      const same = await runtime.client.getInstance(owner.containerName);
      expect(same.config['volatile.uuid']).toBe(firstUuid); expect(same.status).toBe('Stopped');
      expect((await privateCatalog()).nativeBindings).toEqual(state.nativeBindings);
      computeSettled = true;
      console.info('Genuine custom encrypted whole-instance producer passed SQLite/admin, applied bootstrap, controlled catalog/native ACKs and two canonical archives; cold inverse pending; no source retirement/controller stop/data deletion',
        { local, sourceData: remoteData, sourceApp: targetId, sourceWorker: owner.id, incarnation: firstUuid,
          backupId: produced.manifest.backupId, ciphertext: produced.localEncrypted, privateKey: produced.localKey });
      return;
    }
    if ((customBackup || customPortable) && customRetained) {
      // Reuse the public encrypted worker-backup/new-restore flow, not instance
      // restore setup or a fabricated portable/native authority record.
      const markers = ['python3', '-c', String.raw`
import os,sys,stat,json,base64
out=[]
for p in sys.argv[1:]:
 s=os.stat(p);out.append(dict(data=base64.b64encode(open(p,'rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
 mode=stat.S_IMODE(s.st_mode),mtime=str(s.st_mtime_ns)))
print(json.dumps(out))
`, '/workspace/custom-cache-proof', '/home/agent/.agent-data/custom-cache-proof'];
      const original = await runtime.client.exec(owner.containerName, markers); expect(original.returnCode, original.stderr).toBe(0);
      const originalMarkers = JSON.parse(original.stdout) as Array<{ data: string; uid: number; gid: number; mode: number; mtime: string }>;
      expect(originalMarkers.map(value => value.data)).toEqual([Buffer.from(marker).toString('base64'), Buffer.from(marker).toString('base64')]);
      computeSettled = false;
      expect((await appRequest('/api/containers/' + owner.id + '/stop', {}, true, 360_000)).status).toBe(200);
      const sourceBefore = await runtime.client.getInstance(owner.containerName); expect(sourceBefore.status).toBe('Stopped');
      expect(sourceBefore.config['volatile.uuid']).toBe(firstUuid);
      const sourceVolumes = await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      expect(sourceVolumes).toEqual(volumes);
      let newId: string, retainedArtifactId: string;
      if (customPortable) {
        const privateRoot = '/tmp/agentor-custom-portable-' + followupNonce, sessionFile = privateRoot + '/session', tarFile = privateRoot + '/worker.tar';
        const sessionScript = `import fs from'node:fs';const base='http://127.0.0.1:3000';fs.mkdirSync(${JSON.stringify(privateRoot)},{mode:448});` +
          `const signed=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:${JSON.stringify(JSON.stringify(admin))}});` +
          `if(!signed.ok||(await signed.json()).user?.id!==${JSON.stringify(userId)})throw Error('Private portable sign-in differs');` +
          `fs.writeFileSync(${JSON.stringify(sessionFile)},signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; '),{mode:384,flag:'wx'});` +
          `console.log('Private portable session prepared');`;
        try { await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(sessionScript)}`); }
        catch { throw new Error('Private portable session preparation failed'); }
        const exported = await appRequest<PublicExportJob>('/api/containers/' + owner.id + '/export-jobs',
          { includeRootfs: false, includeManagedVolumes: false }, true, 30_000, undefined, sessionFile);
        expect(exported.status).toBe(202); expect(exported.body.workerId).toBe(owner.id); expect(exported.body.id).toMatch(/^[a-f0-9-]{36}$/);
        let ready: PublicExportJob | undefined;
        await expect.poll(async () => {
          const state = await appRequest<PublicExportJob>('/api/export-jobs/' + exported.body.id, undefined, true, 30_000, undefined, sessionFile);
          expect(state.status).toBe(200); ready = state.body;
          if (state.body.status === 'failed') throw new Error('Portable custom export failed: ' + state.body.phase);
          return state.body.status;
        }, { timeout: 360_000, intervals: [1000] }).toBe('succeeded');
        expect(ready).toMatchObject({ workerId: owner.id, includeRootfs: false, includeManagedVolumes: false, downloadReady: true });
        const downloadScript = `import fs from'node:fs';import{Readable,Transform}from'node:stream';import{pipeline}from'node:stream/promises';` +
          `const p=${JSON.stringify(sessionFile)},s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||(s.mode&63))throw Error('Private portable session differs');` +
          `const r=await fetch('http://127.0.0.1:3000/api/export-jobs/${exported.body.id}/download',{headers:{Origin:'http://127.0.0.1:3000',Cookie:fs.readFileSync(p,'utf8')},redirect:'manual',signal:AbortSignal.timeout(180000)});` +
          `const n=Number(r.headers.get('content-length'));if(r.status!==200||!r.body||!Number.isSafeInteger(n)||n<1||n>67108864||!r.headers.get('content-type')?.includes('application/x-tar'))throw Error('Private portable download invalid');` +
          `let bytes=0;const limit=new Transform({transform(b,e,cb){bytes+=b.length;cb(bytes>n?Error('Portable size bound exceeded'):null,b)}});` +
          `await pipeline(Readable.fromWeb(r.body),limit,fs.createWriteStream(${JSON.stringify(tarFile)},{mode:384,flags:'wx'}));` +
          `if(bytes!==n||fs.statSync(${JSON.stringify(tarFile)}).size!==n)throw Error('Portable size differs');console.log('Private portable download complete');`;
        try { await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(downloadScript)}`, 180_000); }
        catch { throw new Error('Private portable download failed'); }
        const remoteTar = customRetained.remoteDir + '/portable-' + followupNonce + '.tar', localTar = join(local, 'portable-' + followupNonce + '.tar');
        await root(`test ! -e ${quote(remoteTar)} && sudo docker cp ${targetId}:${quote(tarFile)} ${quote(remoteTar)} && sudo chown kata-test ${quote(remoteTar)} && sudo chmod 600 ${quote(remoteTar)}`);
        await expect(lstat(localTar)).rejects.toMatchObject({ code: 'ENOENT' });
        await run('scp', [...scp, 'kata-test@172.19.0.1:' + remoteTar, localTar], { timeout: 60_000 });
        const info = await lstat(localTar); expect(info.isFile() && !info.isSymbolicLink()).toBe(true); expect(info.mode & 0o077).toBe(0);
        const unpacked = join(local, 'portable-unpacked-' + followupNonce), bundle = await extractBundle(localTar, unpacked);
        const rawManifest = JSON.parse(await readFile(join(unpacked, 'manifest.json'), 'utf8')) as Record<string, unknown>;
        expect(rawManifest.runtime).toEqual(snapshotIncusWorkerBackupRuntime(binding.identity));
        expect(bundle.manifest.source.id).toBe(owner.id); expect(bundle.manifest.runtime).toEqual(snapshotIncusWorkerBackupRuntime(binding.identity));
        expect(bundle.manifest.contents).toMatchObject({ rootfs: false, workspace: true, agents: true });
        expect(bundle.rootfsPath).toBeUndefined(); expect(bundle.manifest.worker.mounts).toEqual([]);
        for (const key of ['devices', 'profiles', 'incusClientKey', 'incusClientCert', 'nativeBindings']) expect(rawManifest).not.toHaveProperty(key);
        if (!bundle.workspacePath || !bundle.agentsPath || !bundle.reconstructionPath) throw new Error('Portable custom canonical payload is incomplete');
        await validateGzipTarPayload(bundle.workspacePath); await validateGzipTarPayload(bundle.agentsPath);
        expect((await readWorkerReconstruction(bundle.reconstructionPath)).image)
          .toMatchObject({ kind: 'custom', definitionId: definition.body.id, version: built.version, digest: built.digest });
        expect(await runtime.client.getInstance(owner.containerName)).toEqual(sourceBefore);
        expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
        const imported = await appRequest<{ id: string; userId: string; runtimeKind: string; status: string }>('/api/containers/import?displayName=' +
          encodeURIComponent('Custom portable import ' + followupNonce), undefined, true, 360_000,
          { path: tarFile, format: 'binary', contentType: 'application/x-tar' }, sessionFile);
        expect(imported.status).toBe(201); expect(imported.body).toMatchObject({ userId, runtimeKind: 'incus-vm', status: 'running' });
        newId = imported.body.id; retainedArtifactId = exported.body.id;
      } else {
      let captured: BackupJob | undefined;
      if (retryArtifactId) {
        const capture = await appRequest<BackupJob>('/api/backup-jobs/1b996c89-518e-4a35-a135-2492c73a7843');
        expect(capture.status).toBe(200); captured = capture.body;
        expect(captured).toMatchObject({ id: '1b996c89-518e-4a35-a135-2492c73a7843', userId, status: 'succeeded',
          artifactId: retryArtifactId, workspaceIds: [owner.id], encrypted: true, integrityVerified: true });
      } else {
      const capture = await appRequest<BackupJob>('/api/backups', { workspaceIds: [owner.id], providerId: 'local', includeManagedVolumes: false });
      expect(capture.status).toBe(202);
      await expect.poll(async () => {
        const state = await appRequest<BackupJob>('/api/backup-jobs/' + capture.body.id); expect(state.status).toBe(200); captured = state.body;
        if (state.body.status === 'failed') throw new Error('Custom worker encrypted backup failed: ' + (state.body.errorCode ?? 'unknown'));
        return state.body.status;
      }, { timeout: 360_000, intervals: [1000] }).toBe('succeeded');
      }
      if (!captured?.artifactId) throw new Error('Custom encrypted artifact acknowledgement is missing');
      expect(captured).toMatchObject({ encrypted: true, integrityVerified: true });
      const artifact = await appRequest<BackupArtifact>('/api/backups/' + captured.artifactId);
      expect(artifact.status).toBe(200); expect(artifact.body).toMatchObject({ userId, provider: 'local', formatVersion: 2,
        workspaceIds: [owner.id], integrityStatus: 'verified' });
      if (retryArtifactId) {
        expect(artifact.body).toMatchObject({ id: retryArtifactId, size: 242078, sourceWorkerId: owner.id, sourceInstallationId: installation });
        expect(artifact.body.sha256).toMatch(/^[a-f0-9]{64}$/); expect(artifact.body.keyFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
      }
      expect(artifact.body.reconstruction?.find(item => item.workspaceId === owner.id)?.image)
        .toMatchObject({ kind: 'custom', definitionId: definition.body.id, version: built.version, digest: built.digest });
      expect(artifact.body.providerObjectId).toMatch(/^[a-f0-9-]{36}$/);
      const objectPath = remoteData + '/backup-objects/' + userId + '/' + artifact.body.providerObjectId + '.backup';
      const envelope = JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import fs from'node:fs';const p=${JSON.stringify(objectPath)};const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==${artifact.body.size})throw Error('Encrypted custom object differs');` +
        `const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const b=Buffer.alloc(16400);const n=fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);` +
        `const magic=Buffer.from('AGENTOR-BACKUP-2'+String.fromCharCode(10));if(!b.subarray(0,magic.length).equals(magic))throw Error('Custom object is not encrypted v2');` +
        `const e=b.indexOf(10,magic.length);if(e<0||e>=n)throw Error('Custom envelope invalid');console.log(b.subarray(magic.length,e).toString());`)}`));
      expect(envelope).toMatchObject({ version: 2, algorithm: 'aes-256-gcm', keyFingerprint: artifact.body.keyFingerprint,
        metadata: { workspaceIds: [owner.id], formatVersion: 2 } });
      expect(await runtime.client.getInstance(owner.containerName)).toEqual(sourceBefore);
      expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
      const restored = await appRequest<{ jobId: string }>('/api/backups/' + artifact.body.id + '/restore',
        { target: 'new', workspaceIds: [owner.id], displayName: 'Custom encrypted restore ' + followupNonce, requestId: followupNonce + '-new' });
      expect(restored.status).toBe(202); let result: BackupJob | undefined;
      await expect.poll(async () => {
        const state = await appRequest<BackupJob>('/api/backup-jobs/' + restored.body.jobId); expect(state.status).toBe(200); result = state.body;
        if (state.body.status === 'failed') throw new Error('Custom public new restore failed: ' + (state.body.errorCode ?? 'unknown'));
        return state.body.status;
      }, { timeout: 360_000, intervals: [1000] }).toBe('succeeded');
      expect(result).toMatchObject({ target: 'new', integrityVerified: true, selectedWorkspaceIds: [owner.id] });
      expect(result?.restoreMappings).toHaveLength(1); newId = result!.restoreMappings![0]!.workerId; retainedArtifactId = artifact.body.id;
      expect(result!.restoreMappings![0]!.sourceWorkspaceId).toBe(owner.id);
      }
      expect(newId).not.toBe(owner.id); expect(newId).toMatch(/^[a-f0-9-]{36}$/);
      const destination = { id: newId, userId, containerName: config.containerPrefix + '-' + newId };
      const fresh = await runtime.client.getInstance(destination.containerName), freshUuid = fresh.config['volatile.uuid'];
      if (typeof freshUuid !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(freshUuid))
        throw new Error('Custom restore destination omitted exact incarnation');
      expect(freshUuid).not.toBe(firstUuid); expect(fresh.status).toBe('Running'); await assertGuest(freshUuid, destination);
      const restoredMarkers = await runtime.client.exec(destination.containerName, markers); expect(restoredMarkers.returnCode, restoredMarkers.stderr).toBe(0);
      expect(JSON.parse(restoredMarkers.stdout)).toEqual(originalMarkers);
      const destinationNames = ['workspace', 'agents'].map(role => destination.containerName + '-' + role);
      const destinationVolumes = await Promise.all(destinationNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      for (const [index, nativeVolume] of destinationVolumes.entries()) {
        expect(volumeNames).not.toContain(nativeVolume.name); expect(Number.isFinite(Date.parse(nativeVolume.created_at ?? ''))).toBe(true);
        expect(nativeVolume).toMatchObject({ project: custom.project, type: 'custom', content_type: 'filesystem',
          config: { 'user.agentor.installation': installation, 'user.agentor.owner': userId, 'user.agentor.id': newId,
            'user.agentor.storage-role': index ? 'agents' : 'workspace' } });
        expect(nativeVolume.used_by).toEqual(['/1.0/instances/' + destination.containerName + '?project=' + custom.project]);
      }
      const records = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
        quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
      expect(records.find(row => row.id === newId)).toMatchObject({ userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running',
        imageDefinitionId: definition.body.id, imageVersion: built.version, imageDigest: built.digest });
      expect(records.find(row => row.id === newId)?.incusRecreation).toBeUndefined();
      const after = await privateCatalog(); expect(after.nativeBindings).toEqual(state.nativeBindings);
      expect(after.builds.filter(build => build.nativeDerivation)).toEqual(native);
      expect(await runtime.client.getInstance(owner.containerName)).toEqual(sourceBefore);
      expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
      const cleanup = await runtime.client.getInstance(destination.containerName);
      expect(cleanup.config['volatile.uuid']).toBe(freshUuid); expect(cleanup.devices).toEqual(fresh.devices); expect(cleanup.config).toEqual(fresh.config);
      expect(await runtime.matchesWorkerIdentity(cleanup, newId, userId)).toBe(true);
      expect(await Promise.all(destinationNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(destinationVolumes);
      expect((await appRequest('/api/containers/' + newId, {}, true, 360_000, undefined, undefined, 'DELETE')).status).toBe(200);
      await expect(runtime.client.getInstance(destination.containerName)).rejects.toMatchObject({ statusCode: 404 });
      for (const name of destinationNames) await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
      expect(await runtime.client.getInstance(owner.containerName)).toEqual(sourceBefore);
      expect((await appRequest('/api/containers/' + owner.id + '/restart', {}, true, 360_000)).status).toBe(200); await assertGuest(firstUuid);
      const sourceMarkers = await runtime.client.exec(owner.containerName, markers); expect(sourceMarkers.returnCode, sourceMarkers.stderr).toBe(0);
      expect(JSON.parse(sourceMarkers.stdout)).toEqual(originalMarkers);
      expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
      computeSettled = true;
      console.info(customPortable ? 'Actual custom portable export -> public import passed descriptive source/no rootfs, fresh native identity/core storage/custom OCI, workspace/agent bytes+metadata, services/proxies/self, unchanged stopped source and healthy original restart; only acknowledged destination deleted; source/current App/catalog/image/export retained'
        : 'Actual custom encrypted backup -> public new passed fresh UUID/core storage/custom OCI, workspace/agent bytes+numeric metadata, services/proxies/self, unchanged stopped source and healthy original restart; only acknowledged destination deleted; source/old+current Apps/catalog/image/artifact retained',
        { local, remote, sourceData: remoteData, oldApp: customRetained.app.Id, currentApp: targetId, artifactId: retainedArtifactId });
      return;
    }
    const seeded = await runtime.client.exec(owner.containerName, ['bash', '-ec',
      'printf "%s" "$1" > /workspace/custom-cache-proof; printf "%s" "$1" > /home/agent/.agent-data/custom-cache-proof', 'bash', marker]);
    expect(seeded.returnCode, seeded.stderr).toBe(0);
    expect((await appRequest('/api/containers/' + owner.id + '/stop', {}, true, 360_000)).status).toBe(200);
    expect((await runtime.client.getInstance(owner.containerName)).status).toBe('Stopped');
    expect((await appRequest('/api/containers/' + owner.id + '/restart', {}, true, 360_000)).status).toBe(200); await assertGuest(firstUuid);
    const rebuilt = await appRequest<{ id: string; runtimeKind: string }>('/api/containers/' + owner.id + '/rebuild', {}, true, 360_000);
    expect(rebuilt.status).toBe(200); expect(rebuilt.body).toMatchObject({ id: owner.id, runtimeKind: 'incus-vm' });
    const final = await runtime.client.getInstance(owner.containerName), finalUuid = final.config['volatile.uuid'];
    if (typeof finalUuid !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(finalUuid))
      throw new Error('Rebuilt custom worker omitted its exact native incarnation');
    expect(finalUuid).toMatch(/^[a-f0-9-]{36}$/); expect(finalUuid).not.toBe(firstUuid); await assertGuest(finalUuid);
    const persisted = await runtime.client.exec(owner.containerName, ['bash', '-ec',
      'test "$(cat /workspace/custom-cache-proof)" = "$1"; test "$(cat /home/agent/.agent-data/custom-cache-proof)" = "$1"', 'bash', marker]);
    expect(persisted.returnCode, persisted.stderr).toBe(0);
    const after = await privateCatalog(); expect(after.nativeBindings).toEqual(state.nativeBindings);
    expect(after.builds.filter(build => build.nativeDerivation)).toEqual(native);
    expect(await Promise.all(volumeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(volumes);
    expect((await runtime.client.listImages()).map(image => image.fingerprint).sort()).toEqual([...baselineImages, image.fingerprint].sort());
    if (customRetained) {
      computeSettled = true;
      console.info('Retained genuine custom source passed corrected runtime config/tmux, services/proxies/self, stop/start/rebuild, persistent markers and exact cached FP/binding/ACK/build count; source/App/catalog/DATA retained for Phase10c');
      return;
    }
    // Success-only cleanup checks the last captured incarnation/config, original
    // storage creation metadata/refs, private binding and exact imported image.
    expect(await runtime.client.getInstance(owner.containerName)).toEqual(final);
    await runtime.remove(owner, finalUuid); await runtime.removeStorage(owner);
    await expect(runtime.client.getInstance(owner.containerName)).rejects.toMatchObject({ statusCode: 404 });
    for (const name of volumeNames) await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
    expect(await runtime.client.listInstances()).toEqual([]);
    const cleanupImage = await runtime.client.getImage(image.fingerprint);
    expect(incusImageIdentity(cleanupImage)).toEqual(binding.identity); expect(cleanupImage.aliases).toEqual([]);
    expect(await runtime.client.getImage(image.fingerprint)).toEqual(cleanupImage);
    await root(`sudo incus image delete ${quote(image.fingerprint)} --project ${quote(custom.project)}`, 120_000);
    await expect(runtime.client.getImage(image.fingerprint)).rejects.toMatchObject({ statusCode: 404 });
    expect((await runtime.client.listImages()).map(image => image.fingerprint).sort()).toEqual(baselineImages);
    // Controlled OCI output is independently owned by this exact definition and
    // owner hash; never remove the pinned base or adopt a tag as its identity.
    const labels = await root(`sudo docker image inspect ${quote(built.artifactTag)} --format '{{.Id}} {{index .Config.Labels "agentor.image-definition"}} {{index .Config.Labels "agentor.image-owner-hash"}}'`);
    expect(labels).toBe(`${built.digest} ${definition.body.id} ${createHash('sha256').update(userId).digest('hex')}`);
    expect(built.digest).not.toBe(custom.workerImageId);
    await root(`sudo docker image rm ${quote(built.artifactTag)}`, 120_000);
    expect(await root(`sudo docker image inspect ${quote(custom.workerImage)} --format '{{.Id}}'`)).toBe(custom.workerImageId);
    computeSettled = true;
    console.info('Actual controlled catalog OCI -> normal Incus create/stop/start/rebuild passed marker, provisioning, services/proxies/self and unchanged private derivation cache; exact new native/OCI fixtures removed');
  };
  const runProducer = async (expectedSource: WorkerBackupRuntimeSource, installation: string, customCapture?: {
    owner: { id: string; userId: string; containerName: string }; incarnation: string; marker: string;
    catalog: { definitions: ImageDefinition[]; builds: ImageBuild[]; nativeBindings: Record<string, NativeImageBinding> };
  }) => {
    // Exercise the actual producer as well as the inverse: default SQLite
    // online backup, real quiescence checks, native inventory/capture and
    // encrypted publication through the configured local provider.
    if (retained) {
      // Read real current Docker proof, not guesses from an older archive.
      // Start/stop the SAME pinned VM once; never recreate or import its data.
      computeSettled = false;
      const started = await appRequest<{ ok: boolean }>('/api/containers/' + id + '/restart', {}, true, 360_000);
      expect(started.status).toBe(200); expect(started.body).toEqual({ ok: true });
      const current = await runtime.client.getInstance(options!.containerName);
      expect(current.config['volatile.uuid']).toBe(retained.incarnation);
      expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true); computeSettled = true;
    }
    const capturedOwner = customCapture?.owner ?? options!, capturedId = capturedOwner.id;
    let dockerIds: string[] = [], dockerVolumeBytes = Buffer.alloc(0);
    if (!customCapture) {
    const dockerProof = await runtime.client.exec(capturedOwner.containerName, ['bash', '-ec',
      'docker image inspect --format "{{.Id}}" agentor-archive-lower:proof; ' +
      'docker container inspect --format "{{.Id}}" archive-layer archive-stopped; ' +
      'base64 -w0 "$(docker volume inspect --format "{{.Mountpoint}}" archive-data)/ordinary"; echo']);
    expect(dockerProof.returnCode, dockerProof.stderr).toBe(0);
    const dockerProofLines = dockerProof.stdout.trim().split('\n'); expect(dockerProofLines).toHaveLength(4);
    dockerIds = dockerProofLines.slice(0, 3); dockerVolumeBytes = Buffer.from(dockerProofLines[3]!, 'base64');
    expect(dockerVolumeBytes.length).toBeGreaterThan(0); expect(dockerVolumeBytes.toString().trim()).toBe('persistent');
    expect(dockerIds[0]).toMatch(/^sha256:[a-f0-9]{64}$/);
    for (const container of dockerIds.slice(1)) expect(container).toMatch(/^[a-f0-9]{64}$/);
    }
    const stopped = await appRequest<{ ok: boolean }>('/api/containers/' + capturedId + '/stop', {}, true, 360_000);
    expect(stopped.status).toBe(200); expect(stopped.body).toEqual({ ok: true });
    const sourceInstance = await runtime.client.getInstance(capturedOwner.containerName);
    expect(sourceInstance.status).toBe('Stopped'); expect(sourceInstance.config['volatile.uuid']).toBe(customCapture?.incarnation ?? incarnation);
    expect(await runtime.matchesWorkerIdentity(sourceInstance, capturedId, userId)).toBe(true);
    const sourceNames = customCapture ? ['workspace', 'agents'].map(role => capturedOwner.containerName + '-' + role)
      : [...['workspace', 'agents', 'docker'].map(role => capturedOwner.containerName + '-' + role), volume.dockerName];
    const sourceVolumes = await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    const privateRoot = '/tmp/agentor-producer-' + (customCapture ? followupNonce : jobId), sessionFile = privateRoot + '/session',
      keyFile = privateRoot + '/recovery.json', encryptedFile = privateRoot + '/instance.backup';
    // Prepare one real session and freshly reauthenticated active key BEFORE
    // taking the write barrier. Polling uses that private cookie without an
    // auth POST or a waiver. Raw material stays outside snapshotted DATA_DIR.
    const prepare = `const fs=await import('node:fs');const base='http://127.0.0.1:3000';` +
      `const h={Origin:base,'Content-Type':'application/json'};` +
      `const signed=await fetch(base+'/api/auth/sign-in/email',{method:'POST',headers:h,body:${JSON.stringify(JSON.stringify(admin))}});` +
      `if(!signed.ok)throw Error('Private producer sign-in failed');` +
      (customCapture ? `if((await signed.json()).user?.id!==${JSON.stringify(userId)})throw Error('Private producer owner differs');` : '') +
      `h.Cookie=signed.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');` +
      `const revealed=await fetch(base+'/api/backups/recovery-key/reveal',{method:'POST',headers:h,body:JSON.stringify({password:${JSON.stringify(admin.password)}})});` +
      `if(!revealed.ok)throw Error('Private producer reauthentication failed');const key=await revealed.json();` +
      `if(typeof key.keyMaterial!=='string'||typeof key.fingerprint!=='string')throw Error('Private producer key response invalid');` +
      `fs.mkdirSync(${JSON.stringify(privateRoot)},{mode:448});` +
      `fs.writeFileSync(${JSON.stringify(sessionFile)},h.Cookie,{mode:384,flag:'wx'});` +
      `fs.writeFileSync(${JSON.stringify(keyFile)},JSON.stringify(key),{mode:384,flag:'wx'});console.log(JSON.stringify({ready:true,fingerprint:key.fingerprint}));`;
    let keyFingerprint: string;
    try {
      const prepared = JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(prepare)}`)) as { ready: boolean; fingerprint: string };
      expect(prepared.ready).toBe(true); expect(prepared.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/); keyFingerprint = prepared.fingerprint;
    } catch { throw new Error('Private producer session/key preparation failed'); }
      const capture = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups',
        { provider: 'local', options: { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true,
          includeLocalBackups: false, includeLogs: false }, requestId: (retained || customCapture ? followupNonce : jobId) + '-capture' }, true, 30_000, undefined, sessionFile);
    expect(capture.status).toBe(202); expect(capture.body.accepted).toBe(true); expect(capture.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
    await expect.poll(async () => {
      const state = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + capture.body.jobId,
        undefined, true, 30_000, undefined, sessionFile);
      expect(state.status).toBe(200); expect(state.body).not.toHaveProperty('restoreHelper');
      if (state.body.status === 'failed') throw new Error('Actual producer failed: ' + (state.body.errorCode ?? 'unknown'));
      return state.body.status;
    }, { timeout: 600_000, intervals: [1000, 2000] }).toBe('succeeded');
    const published = await appRequest<InstanceBackupArtifact>('/api/admin/instance-backups/artifacts/' + capture.body.jobId,
      undefined, true, 30_000, undefined, sessionFile);
    expect(published.status).toBe(200); expect(published.body).toMatchObject({ id: capture.body.jobId, userId,
      provider: 'local', formatVersion: 2, integrityStatus: 'verified', keyFingerprint, sourceInstallationId: installation });
    const download = `const fs=await import('node:fs');const{Readable}=await import('node:stream');const{pipeline}=await import('node:stream/promises');` +
      `const r=await fetch('http://127.0.0.1:3000/api/admin/instance-backups/artifacts/${capture.body.jobId}/download',` +
      `{headers:{Cookie:fs.readFileSync(${JSON.stringify(sessionFile)},'utf8')},redirect:'manual'});` +
      `if(r.status!==200||!r.body||Number(r.headers.get('content-length'))!==${published.body.size})throw Error('Private producer download failed');` +
      `await pipeline(Readable.fromWeb(r.body),fs.createWriteStream(${JSON.stringify(encryptedFile)},{mode:384,flags:'wx'}));` +
      `if(fs.statSync(${JSON.stringify(encryptedFile)}).size!==${published.body.size})throw Error('Private producer download length changed');console.log('Private encrypted producer download complete');`;
    try { await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(download)}`, 180_000); }
    catch { throw new Error('Private encrypted producer download failed'); }
    expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
      .toBe(`${targetId} ${imageId} ${jobId}`);
    // Only exact known private regular files are exported. The cookie never
    // leaves the App; key transfer has no stdout and remains mode0600.
    for (const [from, name] of [[encryptedFile, 'captured.backup'], [keyFile, 'captured-key.json']] as const) {
      await root(`sudo docker exec ${targetId} test -f ${quote(from)} && sudo docker exec ${targetId} test ! -L ${quote(from)}`);
      await root(`sudo docker cp ${targetId}:${quote(from)} ${quote(remote + '/export-' + name)} && ` +
        `sudo install -o kata-test -m 600 ${quote(remote + '/export-' + name)} ${quote(remote + '/' + name)}`);
      await run('scp', [...scp, 'kata-test@172.19.0.1:' + remote + '/' + name, join(local, name)], { timeout: 60_000 });
      const exported = await lstat(join(local, name)); expect(exported.isFile() && !exported.isSymbolicLink()).toBe(true);
      expect(exported.mode & 0o077).toBe(0);
    }
    let recovery: { keyMaterial: string; fingerprint: string };
    try { recovery = JSON.parse(await readFile(join(local, 'captured-key.json'), 'utf8')); }
    catch { throw new Error('Private producer recovery file invalid'); }
    expect(backupKeyFingerprint(recovery.keyMaterial)).toBe(keyFingerprint);
    const encryptedHeader = await inspectInstanceBackup(join(local, 'captured.backup'));
    expect(encryptedHeader.keyFingerprint).toBe(keyFingerprint); expect(encryptedHeader.metadata.backupId).toBe(capture.body.jobId);
    const capturedBundle = join(local, 'captured.tar'), capturedRoot = join(local, 'captured-unpacked'), rawRoot = join(local, 'captured-raw');
    await decryptInstanceBackup(join(local, 'captured.backup'), capturedBundle, recovery.keyMaterial, published.body.sha256);
    const captured = await inspectInstanceBundle(capturedBundle, capturedRoot);
    expect(captured.manifest).toMatchObject({ formatVersion: 2, backupId: capture.body.jobId, createdByUserId: userId,
      sourceInstallationId: installation, options: { includeWorkers: true, includeAgentData: true, includeDockerVolumes: true } });
    expect(captured.manifest.volumes.map(v => v.runtime?.role).sort()).toEqual(customCapture ? ['agents', 'workspace'] : ['agents', 'docker', 'managed', 'workspace']);
    const capturedWorkers = JSON.parse((await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'users/' + userId + '/workers.json'])).stdout) as WorkerRecord[];
    expect(capturedWorkers).toHaveLength(1); expect(capturedWorkers[0]).toMatchObject({ id: capturedId, userId, runtimeKind: 'incus-vm', desiredRuntimeStatus: 'stopped' });
    const snapshotDb = join(local, 'captured-auth.db');
    await writeFile(snapshotDb, (await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'auth.db'],
      { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout, { mode: 0o600 });
    const sqlite = JSON.parse((await run('python3', ['-c',
      'import json,sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(dict(integrity=c.execute("pragma integrity_check").fetchone()[0],user=c.execute("select id,email,role from user where id=?",(sys.argv[2],)).fetchone()))); c.close()',
      snapshotDb, userId])).stdout);
    expect(sqlite).toEqual({ integrity: 'ok', user: [userId, admin.email, 'admin'] });
    await mkdir(rawRoot, { mode: 0o700 });
    for (const descriptor of captured.manifest.volumes) {
      expect(descriptor.ownerId).toBe(userId); expect(descriptor.workerId).toBe(capturedId);
      if (!descriptor.runtime) throw new Error('Actual producer lost native volume authority');
      if (descriptor.runtime.role === 'managed') expect(descriptor.runtime).toEqual({ kind: 'incus-vm', role: 'managed', managedVolumeId: volumeId, target: volume.target });
      else expect(descriptor.runtime.source).toEqual(expectedSource);
      const raw = await prepareInstanceNativeVolumeArchive(captured.volumeArchives.get(descriptor.name)!, descriptor, rawRoot);
      const entry = customCapture ? (descriptor.runtime.role === 'workspace' ? 'workspace/custom-cache-proof' : '.agent-data/custom-cache-proof')
        : descriptor.runtime.role === 'workspace' ? 'workspace/marker' : descriptor.runtime.role === 'agents' ? '.agent-data/marker'
        : descriptor.runtime.role === 'managed' ? 'volume/data' : 'docker/volumes/archive-data/_data/ordinary';
      const bytes = (await run('tar', ['-xOf', raw.archivePath, '--', entry], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
      expect(bytes).toEqual(customCapture ? Buffer.from(customCapture.marker) : descriptor.runtime.role === 'docker' ? dockerVolumeBytes : Buffer.from([0, 255, 128, 10, 61, 0]));
      if (descriptor.runtime.role === 'workspace') expect(descriptor.runtime.dockerData).toBe(!customCapture);
      if (descriptor.runtime.role === 'docker') {
        const files = (await run('tar', ['-tf', raw.archivePath], { maxBuffer: 16 * 1024 * 1024 })).stdout.split('\n');
        expect(files).toContain('docker/image/overlay2/imagedb/content/sha256/' + dockerIds[0]!.slice(7));
        for (const container of dockerIds.slice(1)) expect(files).toContain('docker/containers/' + container + '/config.v2.json');
      }
    }
    expect(await runtime.client.getInstance(capturedOwner.containerName)).toEqual(sourceInstance);
    expect(await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(sourceVolumes);
    if (!customCapture) expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
    else {
      const metadata = join(local, 'captured-metadata'); await mkdir(join(metadata, 'users', userId), { recursive: true, mode: 0o700 });
      for (const member of ['backup-installation-id', 'worker-config.key', 'users/' + userId + '/worker-configurations.json']) {
        const bytes = (await run('tar', ['-xzOf', captured.dataArchivePath, '--', member], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
        await writeFile(join(metadata, member), bytes, { mode: 0o600 });
      }
      expect(await readBackupInstallationId(metadata)).toBe(installation);
      const bootstrap = await new WorkerConfigStore({ ...config, dataDir: metadata }).resolveAppliedBootstrap(userId, capturedId);
      expect(bootstrap?.dockerEnabled).toBe(false); expect(bootstrap?.workerJson.id).toBe(capturedId);
      expect(bootstrap?.environmentJson.envVars).toBe('CUSTOM_PUBLIC_RUNTIME_PROBE=' + customCapture.marker);
      const catalog = JSON.parse((await run('tar', ['-xzOf', captured.dataArchivePath, '--', 'image-catalog/image-catalog.json'],
        { maxBuffer: 1024 * 1024 })).stdout) as typeof customCapture.catalog;
      expect(catalog.nativeBindings).toEqual(customCapture.catalog.nativeBindings);
      const withoutLogs = (build: ImageBuild) => ({ ...build, logs: undefined });
      expect(catalog.builds.map(withoutLogs)).toEqual(customCapture.catalog.builds.map(withoutLogs));
      expect(catalog.definitions).toEqual(customCapture.catalog.definitions);
      const entries = (await run('tar', ['-tzf', captured.dataArchivePath], { maxBuffer: 1024 * 1024 })).stdout.split('\n');
      expect(entries.some(name => name === 'tls/client.key' || name.startsWith('var/lib/incus/'))).toBe(false);
      expect(captured.manifest.images.layersIncluded).toBe(false);
    }
    console.info(customCapture ? 'Actual custom REST producer passed: default SQLite integrity/admin, applied bootstrap, private controlled/native catalog acknowledgements, workspace/agent markers, exact immutable source and unchanged stopped incarnation/core storage'
      : 'Actual REST producer passed: default SQLite integrity/admin, v2 native roles and immutable source, binary workspace/agent/managed and Docker image/container/named-volume bytes, unchanged stopped source incarnation/devices/storage');
    return { manifest: captured.manifest, published: published.body, sessionFile, keyFile, encryptedFile,
      localEncrypted: join(local, 'captured.backup'), localKey: join(local, 'captured-key.json'), sourceInstance, sourceVolumes };
  };
  try {
    if (customRetained) {
      targetId = customRetained.app.Id; imageId = customRetained.app.Image;
      stagingOwner = restoredOwner = customRetained.ownerId;
      const localProof = await lstat(local);
      if (!localProof.isDirectory() || localProof.isSymbolicLink() || localProof.uid !== process.getuid?.() || (localProof.mode & 0o077))
        throw new Error('Exact retained local fixture is not private');
      await runCustomImage(); completed = true; return;
    }
    if (retained) {
      // This one approved retained fixture bypasses all source setup, admin
      // creation, synthetic plans/jobs, imports and inverse operations.
      expect(await readBackupInstallationId(source)).toBe(retained.installation);
      const oldParent = JSON.parse(await root(`sudo docker inspect ${retained.parentId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { Labels: Record<string, string> }; Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      };
      expect(oldParent.Id).toBe(retained.parentId); expect(oldParent.Image).toBe(retained.parentImageId);
      expect(oldParent.Config.Labels['agentor.native-helper-fixture']).toBe(jobId);
      expect(oldParent.Mounts.some(m => m.Type === 'bind' && m.Source === remoteData && m.Destination === remoteData && m.RW)).toBe(true);
      const ledger = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["jobs"]))')} ` +
        quote(remoteData + '/admin/instance-backups.v1.json'))) as InstanceBackupJob[];
      const previous = ledger.find(j => j.id === retained!.restoreJobId), failed = ledger.find(j => j.id === retained!.failedCaptureJobId);
      expect(previous).toMatchObject({ operation: 'restore', userId, status: 'succeeded' }); expect(previous).not.toHaveProperty('restoreHelper');
      expect(failed).toMatchObject({ operation: 'create', userId, status: 'failed' }); expect(failed).not.toHaveProperty('restoreHelper');
      await root(`sudo test ! -e ${quote(remoteData + '/incus-backup-helpers')}`);
      const name = config.containerPrefix + '-' + id;
      expect(await runtime.client.getInstance(name)).toEqual(retained.instance);
      expect(retained.instance.status).toBe('Stopped'); expect(retained.instance.config['volatile.uuid']).toBe(retained.incarnation);
      expect(await runtime.matchesWorkerIdentity(retained.instance, id, userId)).toBe(true);
      const names = [...['workspace', 'agents', 'docker'].map(role => name + '-' + role), volume.dockerName];
      expect(retained.volumes.map(v => v.name).sort()).toEqual(names.toSorted());
      const currentVolumes = await Promise.all(names.map(n => runtime.client.getCustomVolume(config.incusStoragePool, n)));
      for (const current of currentVolumes) expect(current).toEqual(retained.volumes.find(v => v.name === current.name));
      const bootstrap = await new WorkerConfigStore(config).resolveAppliedBootstrap(userId, id);
      if (!bootstrap) throw new Error('Retained fixture applied source bootstrap is missing');
      options = { ...bootstrap, id, userId, containerName: name, managedVolumes: [volume] };
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      storage.mode = 'directory'; storage.dataHostPath = remoteData; options.storageManager = storage;
      incarnation = retained.incarnation; baseline = await managedRuntime.inspectVolume(volume);
      expect(baseline).toEqual(retained.volumes.find(v => v.name === volume.dockerName));
      if (retained.oldNft) {
        expect(retained.oldNft.table).toBe('agentor_restore_' + jobId.slice(0, 8));
        expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${retained.oldNft.table}`)))
          .toBe(sourceRuleSnapshot(typeof retained.oldNft.json === 'string' ? retained.oldNft.json : JSON.stringify(retained.oldNft.json)));
      }
      await Promise.all([mkdir(targetData), mkdir(build)]);
      await prepareImage(); // Fresh context/tag only; SAME DATA source is not uploaded or overwritten.
      await root(`sudo docker stop --time 30 ${retained.parentId}`);
      expect(await root(`sudo docker inspect ${retained.parentId} --format '{{.Id}} {{.Image}} {{.State.Status}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
        .toBe(`${retained.parentId} ${retained.parentImageId} exited ${jobId}`);
      await launchTarget();
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const existing = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + retained.restoreJobId);
      expect(existing.status).toBe(200); expect(existing.body).toMatchObject({ id: retained.restoreJobId, userId, status: 'succeeded' });
      policyAdded = true; // Exact inherited fixture-only account-path delta; never add/widen it again.
      await runProducer(retained.source, retained.installation);
      completed = true;
      console.info('Retained producer passed without repeating source allocation/import/inverse; original stopped control-plane fixture retained until verified cleanup');
      return;
    }
    await Promise.all([mkdir(source), mkdir(join(targetData, 'admin'), { recursive: true }), mkdir(build)]);
    if (customPublic || historical) await backupInstallationId(targetData);
    if (app) {
      await prepareImage();
      if (mode === 'app-retained') {
        // A genuine running helper on this exact DATA mount must fence the
        // earliest service initialization, before auth migrations/secret writes.
        // The inert holder has no daemon socket or credentials and never writes.
        startupHolderId = await root(`sudo docker run -d --name ${quote('native-startup-holder-' + jobId)} ` +
          `--label agentor.native-helper-fixture=${jobId} --label agentor.instance-restore-helper=true ` +
          `--label agentor.instance-restore-job=${jobId} --network none --read-only --cap-drop ALL ` +
          `--security-opt no-new-privileges:true --pids-limit 16 --memory 64m ` +
          `--mount type=bind,src=${remoteData},dst=${remoteData} ${quote(image)} node -e 'setInterval(()=>{},1000)'`);
        expect(startupHolderId).toMatch(/^[a-f0-9]{64}$/);
        await root(`sudo test ! -e ${quote(remoteData + '/auth.db')} && sudo test ! -e ${quote(remoteData + '/auth.secret')}`);
      }
      await launchTarget(!historical);
      if (startupHolderId) {
        await expect.poll(() => root(`sudo docker logs --tail 80 ${targetId} 2>&1`), { timeout: 30_000 })
          .toContain('INSTANCE_RESTORE_HELPER_ACTIVE');
        expect(await root(`sudo docker logs --tail 80 ${targetId} 2>&1`))
          .toContain('A restore helper is still executing against this DATA mount');
        // Plugin rejection alone does not stop Nitro listening. Exercise real
        // HTTP handlers while the same-DATA holder is active: none may access
        // auth storage or proxies before the startup authority check passes.
        expect((await appRequest('/api/health', undefined, false)).status).toBe(503);
        expect((await appRequest('/api/auth/sign-in/email', admin, false)).status).toBe(503);
        expect((await appRequest('/editor/' + id + '/', undefined, false)).status).toBe(503);
        // Exercise the actual upgrade path, which bypasses event middleware.
        // A nonempty dummy cookie would open auth.db without the shared WS gate.
        const wsBlocked = await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
          `const{default:WS}=await import('/app/.output/server/node_modules/ws/wrapper.mjs');` +
          `const s=new WS('ws://127.0.0.1:3000/ws/logs',{headers:{Cookie:'invalid-fixture-cookie=present'}});let opened=false;` +
          `await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{s.terminate();reject(Error('Startup WS did not close'))},5000);` +
          `s.on('open',()=>{opened=true});s.on('close',()=>{clearTimeout(timer);resolve()});s.on('error',()=>{clearTimeout(timer);reject(Error('Fixture WS transport failed'))})});` +
          `console.log(JSON.stringify({opened,closed:true}));`)}`, 10_000);
        expect(JSON.parse(wsBlocked)).toEqual({ opened: true, closed: true });
        await root(`sudo test ! -e ${quote(remoteData + '/auth.db')} && sudo test ! -e ${quote(remoteData + '/auth.secret')}`);
        expect(await root(`sudo docker inspect ${startupHolderId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{index .Config.Labels "agentor.instance-restore-helper"}} {{index .Config.Labels "agentor.instance-restore-job"}}'`))
          .toBe(`${startupHolderId} ${imageId} ${jobId} true ${jobId}`);
        await root(`sudo docker stop --time 10 ${startupHolderId}`);
        expect(await root(`sudo docker inspect ${startupHolderId} --format '{{.Id}} {{.Image}} {{.State.Status}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${startupHolderId} ${imageId} exited ${jobId}`);
        await root(`sudo docker rm ${startupHolderId}`); startupHolderId = undefined;
        expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${targetId} ${imageId} ${jobId}`);
        await root(`sudo docker restart ${targetId}`);
      }
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const created = await appRequest<{ id: string; role: string }>('/api/setup/create-admin', admin, false);
      expect(created.status).toBe(201); expect(created.body.role).toBe('admin');
      stagingOwner = restoredOwner = created.body.id; expect(stagingOwner).toMatch(/^[A-Za-z0-9_-]+$/);
      originalInstallation = JSON.parse(await root(`sudo python3 -c ${quote(
        'import json,os,sys; p=sys.argv[1]; print(json.dumps(open(p).read().strip() if os.path.exists(p) else None))')} ` +
        quote(remoteData + '/backup-installation-id'))) ?? undefined;
      if (ordinary || historical) userId = volume.userId = stagingOwner;
    }
    if (customPublic) {
      // Real catalog/ordinary lifecycle only: do not synthesize an instance
      // manifest, restore ledger, helper acknowledgement or image binding.
      await runCustomImage(); completed = true; return;
    }
    if (historical) {
      const env = await appRequest<{ id: string }>('/api/environments', { name: 'Historical directory source', dockerEnabled: false, networkMode: 'full', memoryLimit: '1024m', cpuLimit: 1 });
      expect(env.status).toBe(201);
      const created = await appRequest<{ id: string; userId: string; containerId: string; containerName: string; runtimeKind: string }>('/api/containers',
        { displayName: 'Historical directory source', environmentId: env.body.id }, true, 180_000);
      expect(created.status).toBe(201); expect(created.body).toMatchObject({ userId, runtimeKind: 'legacy-docker' }); id = created.body.id;
      expect(created.body.containerId).toMatch(/^[a-f0-9]{64}$/); expect(created.body.containerName).toBe(config.containerPrefix + '-' + id);
      const container = JSON.parse(await root(`sudo docker inspect ${created.body.containerId} --format '{{json .}}'`)) as NonNullable<typeof historicalSource>['container'];
      expect(container.Config.Labels['agentor.id']).toBe(id); expect(container.Image).toBe(custom!.workerImageId);
      for (const [role, target] of [['workspaces', '/workspace'], ['agents', '/home/agent/.agent-data']] as const)
        expect(container.Mounts.find(m => m.Destination === target)).toMatchObject({ Type: 'bind', Source: remoteData + '/users/' + userId + '/' + role + '/' + id });
      const bytes = JSON.parse(await root(`sudo docker exec -u root ${container.Id} python3 -c ${quote(historicalMetadata)} write`));
      expect((await appRequest('/api/containers/' + id + '/stop', {}, true, 180_000)).status).toBe(200);
      const sourceId = await root(`sudo docker exec ${targetId} cat ${quote(remoteData + '/backup-installation-id')}`);
      historicalSource = { controllerId: targetId!, dataDir: remoteData, installation: sourceId, container, bytes, directoryIdentity: '' };
      historicalSource.directoryIdentity = await historicalDirectories();
      // Snapshot only this real controlled source. Existing v1 DATA traversal
      // performs the final archive; no source runtime fields are rewritten.
      const snapshot = remote + '/historical-source.tar.gz';
      await root(`sudo tar --numeric-owner -C ${quote(remoteData)} -czf ${quote(snapshot)} . && sudo chown kata-test ${quote(snapshot)} && sudo chmod 600 ${quote(snapshot)}`);
      await run('scp', [...scp, 'kata-test@172.19.0.1:' + snapshot, join(local, 'historical-source.tar.gz')], { timeout: 60_000 });
      await run('tar', ['--no-same-owner', '-xzf', join(local, 'historical-source.tar.gz'), '-C', source]);
      const recordPath = join(source, 'users', userId, 'workers.json'), records = JSON.parse(await readFile(recordPath, 'utf8')) as WorkerRecord[];
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ id, userId, runtimeKind: 'legacy-docker', desiredRuntimeStatus: 'stopped' });
      delete records[0]!.runtimeKind; await writeFile(recordPath, JSON.stringify(records), { mode: 0o600 });
    }
    const installation = historical ? historicalSource!.installation : await backupInstallationId(source);
    if (!historical) { const store = new ManagedVolumeStore(source); await store.init(); await store.save(volume);
      await writeFile(join(source, 'worker-config.key'), Buffer.alloc(32, 81).toString('base64') + '\n', { mode: 0o600 }); }
    if (ordinary) {
      // Reuse an operator-selected, previously accepted logical Docker capture,
      // unchanged. Never fabricate Docker internals or copy a physical device.
      // Required archive/path/digest were admitted before any fixture resources.
      const workers = new WorkerStore(source); await workers.init();
      await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'stopped',
        displayName: 'Controlled instance restored worker', createdAt: stamp, updatedAt: stamp });
      worker = workers.get(userId, id)!;
      const bootstrap: WorkerAppliedBootstrap = { version: 1, dockerEnabled: true, cpuLimit: 2, memoryLimit: '2GiB',
        userEnv: zeroUserEnvVars(userId), capabilitiesJson: [], instructionsJson: [],
        excludedGlobalEnvVarKeys: [], excludedGroupEnvVarKeys: [],
        environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
          exposeApis: { portMappings: false, domainMappings: false, usage: false } },
        workerJson: { id, displayName: worker.displayName, repos: [], initScript: '', gitName: '', gitEmail: '' } };
      await new WorkerConfigStore(config).markApplied(userId, id, bootstrap);
      options = { ...bootstrap, id, userId, containerName: config.containerPrefix + '-' + id };
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      await new UserCredentialManager(storage).ensureUserDir(userId);
      for (const path of ['credentials', 'kilo/config', 'kilo/data', 'ssh'])
        await mkdir(join(source, 'users', userId, path), { recursive: true, mode: 0o700 });
      await writeFile(join(source, 'users', userId, 'ssh/authorized_keys'), '', { mode: 0o600 });
    }
    const auth = join(local, 'auth.db');
    if (app) {
      // Same SQLite online-backup primitive as production capture. No manually
      // authored authentication schema or fabricated source account.
      const snapshot = remoteData + '/auth-fixture.snapshot';
      await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import{createRequire}from'node:module';import{chmodSync}from'node:fs';const r=createRequire('/app/.output/server/package.json');` +
        `const db=new(r('better-sqlite3'))(${JSON.stringify(remoteData + '/auth.db')},{readonly:true});await db.backup(${JSON.stringify(snapshot)});chmodSync(${JSON.stringify(snapshot)},0o600);db.close();`)}`);
      const bytes = (await run('ssh', [...ssh, `sudo cat ${quote(snapshot)}`], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
      await writeFile(auth, bytes, { mode: 0o600 });
      const secret = (await run('ssh', [...ssh, `sudo cat ${quote(remoteData + '/auth.secret')}`],
        { encoding: 'buffer', maxBuffer: 1024 })).stdout;
      await writeFile(join(source, 'auth.secret'), secret, { mode: 0o600 });
    } else await writeFile(auth, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096)]));
    const stage = join(targetData, 'instance-restore-staging', 'restore-' + jobId), unpacked = join(stage, 'unpacked');
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    const backupOptions = { includeWorkers: true, includeAgentData: mode !== 'omitted', includeDockerVolumes: !historical, includeLocalBackups: false, includeLogs: false };
    const data = await createInstanceDataArchive({ dataDir: source, authSnapshotPath: auth, output: join(unpacked, 'data.tar.gz'), options: backupOptions });
    let manifest: InstanceBackupManifest;
    if (historical) manifest = validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: 1, backupId: jobId,
      sourceInstallationId: installation, createdByUserId: restoredOwner, createdAt: stamp, agentorVersion: 'historical-v1-compatibility',
      storage: { mode: 'directory', containerPrefix: config.containerPrefix }, options: backupOptions,
      dataArchive: { archive: 'data.tar.gz', sha256: data.sha256, size: data.size }, volumes: [],
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 }, hostMounts: { configuredPaths: [], contentsIncluded: false },
      images: { definitions: 0, immutableDigests: [], layersIncluded: false }, excludedDataPaths: data.excludedDataPaths });
    else {
    const payload = join(local, 'payload'); await mkdir(join(payload, 'volume'), { recursive: true });
    await run('sudo', ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]))
os.link(f,p+'/hard');os.chown(f,12345,23456);os.chmod(f,0o640)
os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]));os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, join(payload, 'volume')]);
    const archiveName = instanceVolumeArchiveName(volume.dockerName), archive = join(unpacked, instanceBundleFilename(archiveName));
    await run('sudo', ['tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', payload, '-czf', archive, 'volume']);
    await run('sudo', ['chown', `${process.getuid!()}:${process.getgid!()}`, archive]);
    manifest = validateInstanceManifest({ kind: 'agentor-instance-backup', formatVersion: 2,
      backupId: jobId, sourceInstallationId: installation, createdByUserId: restoredOwner, createdAt: stamp, agentorVersion: 'test',
      storage: { mode: 'directory', containerPrefix: config.containerPrefix }, options: backupOptions,
      dataArchive: { archive: 'data.tar.gz', sha256: data.sha256, size: data.size },
      volumes: [{ name: volume.dockerName, kind: 'persistent-path', ownerId: userId, workerId: id, archive: archiveName,
        size: (await stat(archive)).size, sha256: await sha256File(archive),
        runtime: { kind: 'incus-vm', role: 'managed', managedVolumeId: volumeId, target: volume.target } }],
      plugins: { platformDefinitionCount: 0, ownerDefinitionCount: 0, installationCount: 0 },
      hostMounts: { configuredPaths: [], contentsIncluded: false }, images: { definitions: 0, immutableDigests: [], layersIncluded: false },
      excludedDataPaths: data.excludedDataPaths });
    }
    if (ordinary) {
      const identity = incusImageIdentity(await runtime.client.getImage((await runtime.client.getImageAlias(config.incusWorkerImage)).target));
      const imageSource: WorkerBackupRuntimeSource = { sourceImageId: identity.sourceImageId, recipeId: identity.recipeId,
        architecture: identity.architecture, converterVersion: identity.converterVersion, bootstrapGeneration: identity.bootstrapGeneration };
      for (const role of ['workspace', 'agents', 'docker'] as const) {
        if (role === 'agents' && mode === 'omitted') continue;
        const name = config.containerPrefix + '-' + id + '-' + role, archiveName = instanceVolumeArchiveName(name);
        const archive = join(unpacked, instanceBundleFilename(archiveName));
        if (role === 'docker') await pipeline(createReadStream(dockerSource!), createGzip(), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
        else {
          const stage = join(local, 'payload-' + role), wrapper = role === 'agents' ? '.agent-data' : role;
          await mkdir(join(stage, wrapper), { recursive: true });
          await writeFile(join(stage, wrapper, 'marker'), Buffer.from([0, 255, 128, 10, 61, 0]));
          await run('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-czf', archive, wrapper]);
        }
        manifest.volumes.push({ name, kind: role === 'workspace' ? 'worker-workspace' : role === 'agents' ? 'worker-agent-data' : 'worker-dind',
          ownerId: userId, workerId: id, archive: archiveName, size: (await stat(archive)).size, sha256: await sha256File(archive),
          runtime: role === 'workspace' ? { kind: 'incus-vm', role, source: imageSource, dockerData: true }
            : { kind: 'incus-vm', role, source: imageSource } });
      }
      manifest = validateInstanceManifest(manifest);
      expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
    }
    if (rollback) {
      // A valid legacy payload reaches the existing legacy extraction leaf
      // AFTER native apply. Only the fixture image lacks that leaf's sleep
      // executable, producing a real Docker start failure, not a fake Incus
      // acknowledgement or production failpoint.
      const legacyStage = join(local, 'legacy-payload'); await mkdir(join(legacyStage, 'source'), { recursive: true });
      await writeFile(join(legacyStage, 'source/marker'), 'rollback-payload');
      const archiveName = instanceVolumeArchiveName(legacyName), archive = join(unpacked, instanceBundleFilename(archiveName));
      await run('tar', ['-C', legacyStage, '-czf', archive, 'source']);
      manifest.volumes.push({ name: legacyName, kind: 'traefik-certificates', archive: archiveName,
        size: (await stat(archive)).size, sha256: await sha256File(archive) });
      manifest = validateInstanceManifest(manifest);
    }
    let remoteStage = remoteData + '/instance-restore-staging/restore-' + restoreJobId;
    const readRestoreJob = async (): Promise<InstanceBackupJob | undefined> => JSON.parse(await root(
      `sudo python3 -c ${quote('import json,sys; print(json.dumps(next((j for j in json.load(open(sys.argv[1]))["jobs"] if j["id"]==sys.argv[2]), None)))')} ` +
      `${quote(remoteData + '/admin/instance-backups.v1.json')} ${quote(restoreJobId)}`)) ?? undefined;
    if (rest) {
      // Enter through actual authenticated transport. Source inputs use the
      // accepted codecs, never an installed synthetic job/staged helper plan.
      const material = randomBytes(32).toString('base64');
      const kit = validateRecoveryKit({ kind: 'agentor-backup-recovery-kit', version: 1, encryptionFormat: 2,
        keyMaterial: material, fingerprint: backupKeyFingerprint(material), createdAt: stamp });
      const bundle = join(local, 'public-instance.tar'), encrypted = join(local, 'public-instance.backup'), kitPath = join(local, 'public-kit.json');
      await packInstanceBundle(manifest, join(unpacked, 'data.tar.gz'),
        manifest.volumes.map(v => ({ manifest: v, path: join(unpacked, instanceBundleFilename(v.archive)) })), bundle);
      const ciphertext = await encryptInstanceBackup(bundle, encrypted, material, { backupId: manifest.backupId,
        sourceInstallationId: manifest.sourceInstallationId, createdAt: manifest.createdAt, formatVersion: manifest.formatVersion });
      const header = await inspectInstanceBackup(encrypted);
      expect(header.keyFingerprint).toBe(kit.fingerprint); expect(header.metadata.formatVersion).toBe(historical ? 1 : 2);
      if (historical) {
        const verifiedBundle = join(local, 'historical-verified.tar'), verified = join(local, 'historical-verified');
        expect((await stat(encrypted)).size).toBe(ciphertext.size);
        await decryptInstanceBackup(encrypted, verifiedBundle, material, ciphertext.sha256);
        const inspected = await inspectInstanceBundle(verifiedBundle, verified); expect(inspected.manifest.formatVersion).toBe(1); expect(inspected.manifest.volumes).toEqual([]);
        const archived = JSON.parse((await run('tar', ['-xzOf', inspected.dataArchivePath, '--', 'users/' + userId + '/workers.json'])).stdout) as WorkerRecord[];
        expect(archived).toHaveLength(1); expect(archived[0]).toMatchObject({ id, userId }); expect(archived[0]).not.toHaveProperty('runtimeKind');
        const db = join(local, 'historical-auth.db'); await writeFile(db, (await run('tar', ['-xzOf', inspected.dataArchivePath, '--', 'auth.db'], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout, { mode: 0o600 });
        expect(JSON.parse((await run('python3', ['-c', 'import sqlite3,json,sys;c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(json.dumps([c.execute("pragma integrity_check").fetchone()[0],c.execute("select id,role from user where id=?",(sys.argv[2],)).fetchone()]));c.close()', db, userId])).stdout))
          .toEqual(['ok', [userId, 'admin']]);
        for (const role of ['workspaces', 'agents']) {
          const path = 'users/' + userId + '/' + role + '/' + id + '/historical-proof';
          for (const member of [path, path + '.hard']) expect((await run('tar', ['-xzOf', inspected.dataArchivePath, '--', member], { encoding: 'buffer' })).stdout).toEqual(Buffer.from([0, 255, 128, 10, 61, 0]));
        }
        expect(await historicalDirectories()).toBe(historicalSource!.directoryIdentity);
        expect(JSON.parse(await root(`sudo python3 -c ${quote(historicalHostMetadata())} read`))).toEqual(historicalSource!.bytes);
        const sourceContainer = historicalSource!.container, stopped = JSON.parse(await root(`sudo docker inspect ${sourceContainer.Id} --format '{{json .}}'`)) as typeof sourceContainer;
        expect(stopped).toMatchObject({ Id: sourceContainer.Id, Image: sourceContainer.Image, Created: sourceContainer.Created, Config: { Labels: sourceContainer.Config.Labels }, State: { Running: false, Pid: 0 } });
        expect(legacyMigrationMountIdentity(stopped.Mounts)).toEqual(legacyMigrationMountIdentity(sourceContainer.Mounts));
        expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`)).toBe(`${historicalSource!.controllerId} ${imageId} ${jobId}`);
        await root(`sudo docker stop --time 30 ${targetId}`); await root(`sudo docker rm ${sourceContainer.Id}`); // Disposable fixture compute ONLY, never DATA/volumes.
        sourceTable = 'agentor_restore_' + followupNonce.slice(0, 8); sourceRuleBaseline = undefined;
        remoteData = remote + '/historical-recovery-data'; await root(`test ! -e ${quote(remoteData)} && mkdir -m 700 ${quote(remoteData)}`);
        await launchTarget(true, targetName + '-v1');
        await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
        const created = await appRequest<{ id: string; role: string }>('/api/setup/create-admin', admin, false); expect(created.status).toBe(201); expect(created.body.role).toBe('admin'); stagingOwner = created.body.id;
        expect(stagingOwner).not.toBe(restoredOwner);
      }
      await writeFile(kitPath, JSON.stringify({ kit }), { mode: 0o600 });
      const incoming = remote + '/rest-incoming', transfer = remoteData + '/fixture-rest-input';
      await root(`test ! -e ${quote(incoming)} && mkdir -m 700 ${quote(incoming)} && sudo test ! -e ${quote(transfer)}`);
      await run('scp', [...scp, encrypted, kitPath, 'kata-test@172.19.0.1:' + incoming + '/'], { timeout: 60_000 });
      await root(`sudo install -d -m 700 ${quote(transfer)} && ` +
        `sudo install -m 600 ${quote(incoming + '/public-instance.backup')} ${quote(transfer + '/instance.backup')} && ` +
        `sudo install -m 600 ${quote(incoming + '/public-kit.json')} ${quote(transfer + '/kit.json')}`);
      // Key bytes and auth cookies remain inside the exact App child process.
      const importedKit = await appRequest<{ imported: boolean; fingerprint: string }>('/api/backups/recovery-key/import',
        undefined, true, 30_000, { path: transfer + '/kit.json', format: 'json' });
      expect(importedKit.status).toBe(200); expect(importedKit.body).toMatchObject({ imported: true, fingerprint: kit.fingerprint });
      const accepted = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/import?requestId=' + jobId + '-upload',
        undefined, true, 180_000, { path: transfer + '/instance.backup', format: 'binary' });
      expect(accepted.status).toBe(202); expect(accepted.body.accepted).toBe(true);
      expect(accepted.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
      await expect.poll(async () => {
        const verified = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + accepted.body.jobId);
        expect(verified.status).toBe(200); expect(verified.body).not.toHaveProperty('restoreHelper');
        if (verified.body.status === 'failed') throw new Error('Public fixture import verification failed: ' + (verified.body.errorCode ?? 'unknown'));
        return verified.body.status;
      }, { timeout: 180_000, intervals: [500, 1000] }).toBe('succeeded');
      if (ordinary) { await policy(true); policyAdded = true; }
      const preflight = await appRequest<InstanceRestorePreflight>('/api/admin/instance-backups/artifacts/' + jobId +
        '/preflight?restoreDockerVolumes=true&restoreHostMountPolicies=false');
      expect(preflight.status).toBe(200); expect(preflight.body).toMatchObject({ ready: true, blockers: [], volumeConflicts: [],
        sourceInstallationId: installation, destinationContainerPrefix: config.containerPrefix });
      const restoring = await appRequest<{ accepted: boolean; jobId: string }>('/api/admin/instance-backups/artifacts/' + jobId + '/restore',
        { options: { restoreDockerVolumes: true, restoreHostMountPolicies: false,
          confirmReplaceControlPlane: true, confirmExternalDependencies: true }, requestId: jobId + '-restore' });
      expect(restoring.status).toBe(202); expect(restoring.body.accepted).toBe(true);
      restoreJobId = restoring.body.jobId; expect(restoreJobId).toMatch(/^[a-f0-9-]{36}$/); expect(restoreJobId).not.toBe(jobId);
      remoteStage = remoteData + '/instance-restore-staging/restore-' + restoreJobId;
      // Poll the private ledger, not public status (which may settle the
      // helper). Never infer its identity from a name or disappearance.
      let receipt: InstanceBackupJob['restoreHelper'];
      await expect.poll(async () => {
        try { receipt = (await readRestoreJob())?.restoreHelper; } catch { receipt = undefined; }
        return Boolean(receipt);
      }, { timeout: 180_000, intervals: [250, 500] }).toBe(true);
      if (!receipt) throw new Error('Public restore helper acknowledgement was not observed');
      helperId = receipt.containerId;
      expect(helperId).toMatch(/^[a-f0-9]{64}$/); expect(receipt.imageId).toBe(imageId);
      const info = JSON.parse(await root(`sudo docker inspect ${helperId} --format '{{json .}}'`)) as {
        Id: string; Image: string; Config: { Labels: Record<string, string>; Env: string[] };
        Mounts: Array<{ Type: string; Source: string; Destination: string; RW: boolean }>;
      };
      expect(info.Id).toBe(helperId); expect(info.Image).toBe(imageId);
      expect(info.Config.Labels).toMatchObject({ 'agentor.instance-restore-helper': 'true', 'agentor.instance-restore-job': restoreJobId });
      for (const required of [`AGENTOR_INSTANCE_RESTORE_JOB=${restoreJobId}`, `AGENTOR_INSTANCE_RESTORE_STAGE=${remoteStage}`,
        `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`, `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`])
        expect(info.Config.Env.includes(required), 'Exact acknowledged helper environment matches operator authority').toBe(true);
      expect(info.Mounts.some(m => m.Source.startsWith('/var/lib/incus') || m.Destination.startsWith('/var/lib/incus'))).toBe(false);
      for (const path of ['/tls/client.crt', '/tls/client.key', '/tls/server.crt'])
        expect(info.Mounts.some(m => m.Destination === path && m.Type === 'bind' && !m.RW)).toBe(!historical);
      await expect.poll(() => root(`sudo docker inspect ${helperId} --format '{{.State.StartedAt}}'`),
        { timeout: 30_000 }).not.toMatch(/^0001-/);
      console.info('Public restore exact acknowledged fixture', { remote, id, jobId, restoreJobId, helperId, targetId });
    } else {
    await writeFile(join(stage, 'restore-plan.json'), JSON.stringify({ version: 1, formatVersion: 2, jobId,
      dataArchive: remoteStage + '/unpacked/data.tar.gz', sourceInstallationId: installation,
      restoredOwnerId: restoredOwner, stagingOwnerId: stagingOwner, restoreHostMountPolicies: false, manifest,
      volumes: manifest.volumes.map(v => ({ ...v, archive: remoteStage + '/unpacked/' + instanceBundleFilename(v.archive) })) }));
    const job: InstanceBackupJob = { schemaVersion: 1, id: jobId, userId: stagingOwner, operation: 'restore', provider: 'fake',
      status: 'running', phase: 'applying', progress: 70, bytesProcessed: 0, createdAt: stamp, updatedAt: stamp, logs: [] };
    await writeFile(join(targetData, 'admin/instance-backups.v1.json'), JSON.stringify({ schemaVersion: 1, jobs: [job], artifacts: [], remoteBackups: [] }));
    if (app) {
      // Normal App bootstrap owns DATA_DIR. Transfer through the exact private
      // fixture parent, then guest-only sudo installs staged inputs; never
      // widen production DATA or secret permissions to make scp succeed.
      const incoming = remote + '/incoming';
      await root(`test ! -e ${quote(incoming)} && mkdir -m 700 ${quote(incoming)}`);
      await run('scp', [...scp, '-r', join(targetData, 'instance-restore-staging'), join(targetData, 'admin'),
        'kata-test@172.19.0.1:' + incoming + '/'], { timeout: 60_000 });
      await root(`sudo cp -a ${quote(incoming + '/instance-restore-staging')} ${quote(remoteData + '/')} && ` +
        `sudo install -m 600 ${quote(incoming + '/admin/instance-backups.v1.json')} ${quote(remoteData + '/admin/instance-backups.v1.json')}`);
    }
    else {
      await writeFile(join(targetData, 'auth.db'), Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]));
      await prepareImage();
    }
    if (ordinary) { await policy(true); policyAdded = true; }
    if (!app) await launchTarget();
    const env = [ 'AGENTOR_INSTANCE_RESTORE_NATIVE=true', `AGENTOR_INSTANCE_RESTORE_JOB=${jobId}`,
      `AGENTOR_INSTANCE_RESTORE_STAGE=${remoteStage}`, `AGENTOR_INSTANCE_RESTORE_DATA_DIR=${remoteData}`,
      `AGENTOR_INSTANCE_RESTORE_ORCHESTRATOR=${targetId}`, 'CONTAINER_PREFIX=' + config.containerPrefix,
      'INCUS_ENDPOINT=https://agentor-kata-preflight:8443', 'INCUS_PROJECT=agentor', 'INCUS_NETWORK=incusbr0',
      'INCUS_STORAGE_POOL=default', 'INCUS_WORKER_IMAGE=agentor-worker-phase10-preserve-ownership',
      'INCUS_DOCKER_VOLUME_SIZE=1GiB', 'INCUS_INTERNAL_GATEWAY_URL=' + config.incusInternalGatewayUrl,
      'INCUS_CLIENT_CERT_PATH=/tls/client.crt', 'INCUS_CLIENT_KEY_PATH=/tls/client.key', 'INCUS_SERVER_CERT_PATH=/tls/server.crt' ];
    // Exact assigned credential files only; never inject them into the guest.
    console.info('Exact native helper-process fixture', { remote, id, jobId, volumeId, installation, targetId });
    helperId = await root(`sudo docker create --name ${quote(helperName)} --label agentor.native-helper-fixture=${jobId} ` +
      `--label agentor.instance-restore-helper=true --label agentor.instance-restore-job=${jobId} --user 0:0 ` +
      `--network agentor-phase6-net --add-host agentor-kata-preflight:172.22.0.1 --read-only --cap-drop ALL ` +
      `--cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges:true --pids-limit 64 --memory 256m ` +
      `--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16777216 --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock ` +
      `--mount type=bind,src=${remoteData},dst=${remoteData} ${mounts.join(' ')} ${env.map(v => '-e ' + quote(v)).join(' ')} ` +
      `${quote(image)} node .output/server/instance-restore-helper.mjs`);
    expect(helperId).toMatch(/^[a-f0-9]{64}$/);
    expect(await root(`sudo docker inspect ${helperId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}} {{index .Config.Labels "agentor.instance-restore-helper"}} {{index .Config.Labels "agentor.instance-restore-job"}}'`))
      .toBe(`${helperId} ${imageId} ${jobId} true ${jobId}`);
    job.restoreHelper = { containerId: helperId, imageId: imageId! };
    await writeFile(join(targetData, 'admin/instance-backups.v1.json'), JSON.stringify({ schemaVersion: 1, jobs: [job], artifacts: [], remoteBackups: [] }));
    const acknowledgement = remote + '/restore-helper-ack.json';
    await run('scp', [...scp, join(targetData, 'admin/instance-backups.v1.json'),
      'kata-test@172.19.0.1:' + acknowledgement], { timeout: 30_000 });
    await root(`sudo install -m 600 ${quote(acknowledgement)} ${quote(remoteData + '/admin/instance-backups.v1.json')}`);
    await root(`sudo docker start ${helperId}`);
    }
    if (!helperId) throw new Error('Exact helper acknowledgement is missing before terminal observation');
    const code = await root(`sudo docker wait ${helperId}`, 600_000);
    // Parent startup may remove a settled helper between wait and logs. Only
    // this acknowledged exact-ID terminal result permits optional diagnostics.
    const logs = await root(`sudo docker logs ${helperId}`).catch(error => {
      if (code === (rollback ? '1' : '0')) return 'Exact helper terminal result acknowledged; optional logs already removed';
      throw error;
    });
    expect(code, logs).toBe(rollback ? '1' : '0');
    const ledger = await readRestoreJob();
    if (!ledger) throw new Error('Exact restored job ledger is missing after helper completion');
    if (rollback) {
      // A prior native failure could otherwise satisfy rollback's final
      // absence assertions. This bounded exact-job daemon witness proves the
      // legacy leaf ran only AFTER acknowledged native apply returned.
      const witnessName = `agentor-instance-volume-${jobId}-${createHash('sha256').update(legacyName).digest('hex').slice(0, 12)}`;
      const eventOutput = await root(`sudo docker events --since ${Math.floor(Date.parse(stamp) / 1000)} --until ${Math.ceil(Date.now() / 1000)} ` +
        `--filter type=container --filter event=create --filter label=agentor.instance-restore-job=${jobId} ` +
        `--filter label=agentor.instance-restore-volume-helper=true --format '{{json .}}'`, 10_000);
      const witnesses = eventOutput.split('\n').filter(Boolean).map(line => JSON.parse(line) as {
        Actor: { ID: string; Attributes: Record<string, string> };
      });
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]!.Actor.ID).toMatch(/^[a-f0-9]{64}$/);
      expect(witnesses[0]!.Actor.Attributes).toMatchObject({ name: witnessName, image,
        'agentor.instance-restore-volume-helper': 'true', 'agentor.instance-restore-job': jobId });
      expect(ledger).toMatchObject({ id: restoreJobId, userId: stagingOwner, status: 'failed', phase: 'failed', retryable: true });
      expect(ledger.errorCode).not.toBe('INSTANCE_RESTORE_ROLLBACK_INCOMPLETE');
      expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
      if (app) {
        const restoredIdentity = JSON.parse(await root(`sudo python3 -c ${quote(
          'import json,os,sys; p=sys.argv[1]; print(json.dumps(open(p).read().strip() if os.path.exists(p) else None))')} ` +
          quote(remoteData + '/backup-installation-id'))) ?? undefined;
        expect(restoredIdentity).toBe(originalInstallation);
        expect(originalInstallation).not.toBe(installation);
        await expect.poll(async () => {
          try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
        }, { timeout: 60_000 }).toBe(200);
        const failed = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId);
        expect(failed.status).toBe(200); expect(failed.body).toMatchObject({ id: restoreJobId, userId: stagingOwner, status: 'failed', phase: 'failed' });
        expect(failed.body).not.toHaveProperty('restoreHelper');
        const settled = await readRestoreJob(); expect(settled).toBeDefined();
        expect(settled).not.toHaveProperty('restoreHelper');
        await root(`sudo test ! -e ${quote(remoteStage)}`);
        expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe('');
        helperRemovedByManager = true;
      } else {
        const oldDb = await root(`sudo python3 -c ${quote('import sys; print(open(sys.argv[1],"rb").read().hex())')} ${quote(remoteData + '/auth.db')}`);
        expect(oldDb).toBe(Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('old-target')]).toString('hex'));
      }
      await root(`test ! -e ${quote(remoteData + '/users' + (app ? '/' + userId : ''))} && test ! -e ${quote(remoteData + '/instance-restore-rollback/' + restoreJobId)}`);
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      for (const name of [...['workspace', 'agents', 'docker'].map(role => config.containerPrefix + '-' + id + '-' + role), volume.dockerName])
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
      expect(await root(`sudo docker volume ls --format '{{.Name}}' --filter name=^${legacyName}$`)).toBe('');
      expect(await root(`sudo docker ps -aq --filter label=agentor.instance-restore-job=${jobId} --filter label=agentor.instance-restore-volume-helper=true`)).toBe('');
      if (dockerSource) expect(await sha256File(dockerSource)).toBe(dockerSourceDigest);
      completed = true;
      console.info('Real legacy Docker start failure after acknowledged native apply: native cleanup settled BEFORE original control plane restored; only exact recovery target restarted');
      return;
    }
    expect(ledger).toMatchObject({ id: restoreJobId, userId: restoredOwner, status: 'succeeded', phase: 'complete' });
    expect(await root(`sudo docker inspect ${targetId} --format '{{.State.Running}}'`)).toBe('true');
    if (historical) {
      await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
      const finished = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId);
      expect(finished.status).toBe(200); expect(finished.body).toMatchObject({ status: 'succeeded', userId: restoredOwner }); expect(finished.body).not.toHaveProperty('restoreHelper');
      expect(await readRestoreJob()).not.toHaveProperty('restoreHelper');
      await root(`sudo test ! -e ${quote(remoteStage)}`); expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe(''); helperRemovedByManager = true;
      // Normal recovery archives missing legacy compute with stopped intent;
      // the existing explicit unarchive then recreates it from current OCI.
      expect(await root(`sudo docker image inspect ${imageId} --format '{{index .Config.Labels "agentor.admin.overlay"}}'`)).not.toBe('true');
      const guard = { schemaVersion: 1, id: randomUUID(), kind: 'administrative', trusted: true, status: 'stopped', createdAt: stamp, updatedAt: stamp, imageDigest: imageId };
      await root(`sudo docker exec ${targetId} node -e ${quote(`const f=require('node:fs');const p=${JSON.stringify(remoteData + '/admin/workspace.v1.json')};if(f.existsSync(p))throw Error('Unexpected admin record');f.writeFileSync(p,${JSON.stringify(JSON.stringify(guard))},{mode:384,flag:'wx'});`)}`);
      expect(await root(`sudo docker inspect ${targetId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`)).toBe(`${targetId} ${imageId} ${jobId}`);
      await root(`sudo docker stop --time 30 ${targetId}`); await root(`sudo docker rm ${targetId}`);
      expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${sourceTable}`))).toBe(sourceRuleBaseline); await root(`sudo nft delete table ip ${sourceTable}`); sourceRuleBaseline = undefined;
      await launchTarget(true, targetName + '-v1', false);
      await expect.poll(async () => { try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; } }, { timeout: 120_000 }).toBe(200);
      expect((await appRequest<WorkerRecord[]>('/api/archived')).body.find(v => v.id === id)).toMatchObject({ runtimeKind: 'legacy-docker', userId });
      expect((await appRequest('/api/archived/' + id + '/unarchive', {}, true, 180_000)).status).toBe(200);
      const restored = (await appRequest<Array<{ id: string; userId: string; runtimeKind: string; status: string; containerId: string }>>('/api/containers')).body.find(v => v.id === id)!;
      expect(restored).toMatchObject({ runtimeKind: 'legacy-docker', status: 'running', userId }); expect(restored.containerId).toMatch(/^[a-f0-9]{64}$/);
      const bytes = JSON.parse(await root(`sudo docker exec -u root ${restored.containerId} python3 -c ${quote(historicalMetadata)} read`));
      // Historical DATA writes regular files independently: supported v1
      // semantics flatten inode links, but preserve both paths/bytes/metadata.
      expect(bytes).toEqual((historicalSource!.bytes as Array<Record<string, unknown>>).map(v => ({ ...v, hard: false })));
      expect((await appRequest<string>('/editor/' + id + '/?folder=/workspace')).body).toContain('code-server');
      expect((await appRequest<string>('/desktop/' + id + '/agentor.html')).body).toContain('noVNC');
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      expect(await historicalDirectories()).toBe(historicalSource!.directoryIdentity);
      expect(JSON.parse(await root(`sudo python3 -c ${quote(historicalHostMetadata())} read`))).toEqual(historicalSource!.bytes);
      expect(await root(`sudo docker inspect ${historicalSource!.controllerId} --format '{{.State.Running}}'`)).toBe('false');
      const originalRecords = JSON.parse(await root(`sudo cat ${quote(historicalSource!.dataDir + '/users/' + userId + '/workers.json')}`)) as WorkerRecord[];
      expect(originalRecords[0]).toMatchObject({ id, runtimeKind: 'legacy-docker', desiredRuntimeStatus: 'stopped' });
      expect((await appRequest('/api/containers/' + id, undefined, true, 120_000, undefined, undefined, 'DELETE')).status).toBe(200);
      expect(await historicalDirectories()).toBe(historicalSource!.directoryIdentity);
      completed = true;
      console.info('Supported runtime-less v1 public instance restore stayed legacy with Incus enabled; exact disposable source compute retired only after authenticated capture; original DATA/records/linked bytes/ciphertext and stopped controller retained',
        { local, remote, jobId, restoreJobId, targetId, sourceController: historicalSource!.controllerId, sourceData: historicalSource!.dataDir, workerId: id });
      return;
    }
    const record = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))[0]))')} ` +
        quote(remoteData + (ordinary ? '/users/' : '/retained-storage/users/') + userId + '/managed-volumes.v1.json'))) as StoredManagedVolume;
    expect(record).toMatchObject({ id: volumeId, workerId: id, userId, seeded: true, attached: ordinary, state: ordinary ? 'ready' : 'detached',
      ...(!ordinary ? { retainedAfterAccountDeletion: true } : {}) });
    await root(`test ! -e ${quote(remoteData + '/instance-restore-rollback/' + restoreJobId)}`);
    if (!ordinary) {
      await root(`test ! -e ${quote(remoteData + '/users' + (app ? '/' + userId : ''))}`);
      await expect(runtime.client.getInstance(config.containerPrefix + '-' + id)).rejects.toMatchObject({ statusCode: 404 });
      for (const role of ['workspace', 'agents', 'docker'])
        await expect(runtime.client.getCustomVolume(config.incusStoragePool, config.containerPrefix + '-' + id + '-' + role)).rejects.toMatchObject({ statusCode: 404 });
    } else {
      const records = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys; print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
        quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
      expect(records).toEqual([worker]); // Original intent only after complete job.
      const instance = await runtime.client.getInstance(options!.containerName);
      incarnation = instance.config['volatile.uuid']; expect(incarnation).toBeTruthy();
      expect(instance.status).toBe('Stopped'); expect(instance.config['user.agentor.restore']).toBeUndefined();
      const storage = new StorageManager({} as ConstructorParameters<typeof StorageManager>[0], config);
      storage.mode = 'directory'; storage.dataHostPath = remoteData;
      options!.storageManager = storage; options!.managedVolumes = [record];
      computeSettled = false;
      if (app) {
        await expect.poll(async () => {
          try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
        }, { timeout: 60_000 }).toBe(200);
        // Existing dashboard restart starts stopped workers; no new endpoint
        // or frontend protocol is required for restored compute.
        const started = await appRequest<{ ok: boolean }>('/api/containers/' + id + '/restart', {}, true, 360_000);
        expect(started.status).toBe(200); expect(started.body).toEqual({ ok: true });
        const listed = await appRequest<Array<{ id: string; runtimeKind: string; status: string }>>('/api/containers');
        expect(listed.status).toBe(200); expect(listed.body.find(v => v.id === id)).toMatchObject({ runtimeKind: 'incus-vm', status: 'running' });
      } else await runtime.start(options!, incarnation);
      computeSettled = true;
      const checked = await runtime.client.exec(options!.containerName, ['bash', '-ec',
        (mode === 'omitted' ? 'test ! -e /home/agent/.agent-data/marker; ' : 'cmp /workspace/marker /home/agent/.agent-data/marker; ') +
        'runuser -u agent -- touch /home/agent/.agent-data/.kilo/state/helper-writable /home/agent/.agent-data/.codex/helper-writable; ' +
        'systemctl is-active --quiet agentor-worker; ' +
        'docker info --format "{{.Driver}}"; docker image inspect agentor-archive-lower:proof >/dev/null; ' +
        'docker container inspect archive-layer archive-stopped >/dev/null; docker volume inspect archive-data >/dev/null; ' +
        'docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec \'test "$(cat /data/ordinary)" = persistent\'; ' +
        'curl --fail --silent http://127.0.0.1:8443/ >/dev/null; curl --fail --silent http://127.0.0.1:6080/ >/dev/null']);
      expect(checked.returnCode, checked.stdout + checked.stderr).toBe(0); expect(checked.stdout.trim()).toBe('overlay2');
      expect(await sha256File(dockerSource!)).toBe(dockerSourceDigest);
      if (app && !originalPublic) {
        const editor = await appRequest<string>('/editor/' + id + '/?folder=/workspace');
        expect(editor.status).toBe(200); expect(editor.body).toContain('code-server');
        const desktop = await appRequest<string>('/desktop/' + id + '/agentor.html');
        expect(desktop.status).toBe(200); expect(desktop.body).toContain('noVNC');
        const self = await runtime.client.exec(options!.containerName,
          ['curl', '--noproxy', '*', '-fsS', config.incusInternalGatewayUrl + '/api/worker-self/info']);
        expect(self.returnCode, self.stderr).toBe(0);
        expect(JSON.parse(self.stdout)).toMatchObject({ workerId: id, userId });
      }
    }
    baseline = await managedRuntime.inspectVolume(record); if (!ordinary) expect(baseline?.used_by).toEqual([]);
    const physical = '/var/lib/incus/storage-pools/default/custom/agentor_' + volume.dockerName;
    const contents = JSON.parse(await root(`sudo python3 -c ${quote(String.raw`import os,sys,stat,json,base64
p=sys.argv[1];s=os.lstat(p+'/data');assert os.path.realpath(p)==p
print(json.dumps(dict(data=base64.b64encode(open(p+'/data','rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
mode=stat.S_IMODE(s.st_mode),mtime=s.st_mtime_ns,hard=s.st_ino==os.stat(p+'/hard').st_ino,
xattr=base64.b64encode(os.getxattr(p+'/data','user.binary')).decode())))`)} ${quote(physical)}`));
    expect(contents).toEqual({ data: 'AP+ACj0A', uid: 12345, gid: 23456, mode: 0o640, mtime: 1700000000987654321,
      hard: true, xattr: 'AP+ACj0A' });
    if (app) {
      await expect.poll(async () => {
        try { return (await appRequest('/api/health', undefined, false)).status; } catch { return 0; }
      }, { timeout: 60_000 }).toBe(200);
      const visible = await appRequest<InstanceBackupJob>('/api/admin/instance-backups/jobs/' + restoreJobId);
      expect(visible.status).toBe(200); expect(visible.body).toMatchObject({ id: restoreJobId, userId: restoredOwner, status: 'succeeded', phase: 'complete' });
      expect(visible.body).not.toHaveProperty('restoreHelper');
      const settled = await readRestoreJob(); expect(settled).toBeDefined();
      expect(settled).not.toHaveProperty('restoreHelper');
      await root(`sudo test ! -e ${quote(remoteStage)}`);
      expect(await root(`sudo docker ps -aq --no-trunc --filter id=${helperId}`)).toBe('');
      helperRemovedByManager = true;
      console.info('Current running Orchestrator authenticated against restored SQLite and exposed completed native job after exact restart');
    }
    if (originalPublic || newPublic) {
      // The existing controlled source setup is required; public whole-instance
      // inverse/producer acceptance is not repeated for this original-only gate.
      const path = '/workspace/public-original-' + id;
      const selectedPath = '/opt/public-new-' + id, agentPath = '/home/agent/.agent-data/public-new-' + id;
      await runtime.client.exec(options!.containerName, ['python3', '-c', String.raw`
import os,sys
p=sys.argv[1];os.mkdir(p);f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]));os.link(f,p+'/hard')
os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]))
os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, path]).then(result => expect(result.returnCode, result.stderr).toBe(0));
      if (newPublic) await runtime.client.exec(options!.containerName, ['python3', '-c', String.raw`
import os,sys
for p in sys.argv[1:]:
 os.mkdir(p);f=p+'/data';open(f,'wb').write(bytes([0,255,128,10,61,0]));os.link(f,p+'/hard')
 os.chown(f,12345,23456);os.chmod(f,0o640);os.setxattr(f,'user.binary',bytes([0,255,128,10,61,0]))
 os.utime(f,ns=(1700000000123456789,1700000000987654321))
`, selectedPath, agentPath]).then(result => expect(result.returnCode, result.stderr).toBe(0));
      const capture = await appRequest<BackupJob>('/api/backups', { workspaceIds: [id], providerId: 'local', includeManagedVolumes: newPublic,
        ...(newPublic ? { selectedPathsByWorkspace: { [id]: ['/workspace', '/home/agent/.agent-data', '/var/lib/docker', selectedPath] } } : {}) });
      expect(capture.status).toBe(202); expect(capture.body.id).toMatch(/^[a-f0-9-]{36}$/);
      let captured: BackupJob | undefined;
      await expect.poll(async () => {
        const state = await appRequest<BackupJob>('/api/backup-jobs/' + capture.body.id); expect(state.status).toBe(200); captured = state.body;
        if (state.body.status === 'failed') throw new Error('Public worker backup failed: ' + (state.body.errorCode ?? 'unknown'));
        return state.body.status;
      }, { timeout: 300_000, intervals: [1000] }).toBe('succeeded');
      if (!captured?.artifactId) throw new Error('Actual worker backup artifact acknowledgement missing');
      expect(captured).toMatchObject({ encrypted: true, integrityVerified: true });
      const artifact = await appRequest<BackupArtifact>('/api/backups/' + captured.artifactId);
      expect(artifact.status).toBe(200); expect(artifact.body).toMatchObject({ userId, provider: 'local', formatVersion: 2,
        workspaceIds: [id], integrityStatus: 'verified' });
      expect(artifact.body.providerObjectId).toMatch(/^[a-f0-9-]{36}$/);
      const objectPath = remoteData + '/backup-objects/' + userId + '/' + artifact.body.providerObjectId + '.backup';
      // Read only the bounded encrypted envelope, never raw key material.
      // Creation's actual decrypt/inspect pass and restore's actual AES-GCM
      // authentication provide authority, not this descriptive header alone.
      const envelope = JSON.parse(await root(`sudo docker exec ${targetId} node --input-type=module -e ${quote(
        `import fs from'node:fs';const p=${JSON.stringify(objectPath)};const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size!==${artifact.body.size})throw Error('Encrypted worker object differs');` +
        `const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const b=Buffer.alloc(16400);const n=fs.readSync(fd,b,0,b.length,0);fs.closeSync(fd);` +
        `const magic=Buffer.from('AGENTOR-BACKUP-2\\n');if(!b.subarray(0,magic.length).equals(magic))throw Error('Worker object is not encrypted v2');` +
        `const e=b.indexOf(10,magic.length);if(e<0||e>=n)throw Error('Worker envelope invalid');console.log(b.subarray(magic.length,e).toString());`)}`));
      expect(envelope).toMatchObject({ version: 2, algorithm: 'aes-256-gcm', keyFingerprint: artifact.body.keyFingerprint,
        metadata: { workspaceIds: [id], formatVersion: 2 } });
      if (newPublic) {
        expect(artifact.body.includeManagedVolumes).toBe(true);
        // Canonical workspace/agent roots are captured separately in this selection;
        // the public artifact records only normalized additional selections.
        expect(artifact.body.selectedPathsByWorkspace?.[id]).toEqual(['/var/lib/docker', selectedPath]);
        const dockerProof = ['bash', '-ec', 'docker image inspect --format "{{.Id}}" agentor-archive-lower:proof; ' +
          'docker container inspect --format "{{.Id}} {{.Image}} {{.Config.Image}}" archive-layer archive-stopped; ' +
          'docker volume inspect --format "{{.Name}} {{.Driver}}" archive-data; ' +
          'docker run --rm -v archive-data:/data busybox:1.37.0 cat /data/ordinary'];
        const originalDocker = await runtime.client.exec(options!.containerName, dockerProof);
        expect(originalDocker.returnCode, originalDocker.stderr).toBe(0);
        expect((await appRequest('/api/containers/' + id + '/stop', {}, true, 360_000)).status).toBe(200);
        const before = await runtime.client.getInstance(options!.containerName);
        expect(before.status).toBe('Stopped'); expect(before.config['volatile.uuid']).toBe(incarnation);
        const sourceNames = [...['workspace', 'agents', 'docker'].map(role => options!.containerName + '-' + role), volume.dockerName];
        const beforeVolumes = await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
        computeSettled = false; // Unknown new-worker allocation retains both exact source and destination.
        const restored = await appRequest<{ jobId: string }>('/api/backups/' + artifact.body.id + '/restore',
          { target: 'new', workspaceIds: [id], displayName: 'Public native new restore ' + jobId, requestId: jobId + '-new' });
        expect(restored.status).toBe(202); expect(restored.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
        let result: BackupJob | undefined;
        await expect.poll(async () => {
          const state = await appRequest<BackupJob>('/api/backup-jobs/' + restored.body.jobId); expect(state.status).toBe(200); result = state.body;
          if (state.body.status === 'failed') throw new Error('Public new restore failed: ' + (state.body.errorCode ?? 'unknown'));
          return state.body.status;
        }, { timeout: 360_000, intervals: [1000] }).toBe('succeeded');
        expect(result).toMatchObject({ target: 'new', integrityVerified: true, selectedWorkspaceIds: [id] });
        expect(result?.restoreMappings).toHaveLength(1);
        const newId = result!.restoreMappings![0]!.workerId;
        expect(result!.restoreMappings![0]!.sourceWorkspaceId).toBe(id); expect(newId).not.toBe(id); expect(newId).toMatch(/^[a-f0-9-]{36}$/);
        const rows = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
          quote(remoteData + '/users/' + userId + '/workers.json'))) as WorkerRecord[];
        expect(rows.find(row => row.id === newId)).toMatchObject({ userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'running' });
        expect(rows.find(row => row.id === newId)?.incusRecreation).toBeUndefined();
        const newOwner = { id: newId, userId, containerName: config.containerPrefix + '-' + newId };
        const fresh = await runtime.client.getInstance(newOwner.containerName), freshUuid = fresh.config['volatile.uuid'];
        expect(freshUuid).toMatch(/^[a-f0-9-]{36}$/); expect(freshUuid).not.toBe(incarnation);
        expect(await runtime.matchesWorkerIdentity(fresh, newId, userId)).toBe(true); expect(fresh.status).toBe('Running');
        expect(fresh.profiles).toEqual([]); expect(fresh.devices.eth0).toMatchObject({
          'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
        const records = JSON.parse(await root(`sudo python3 -c ${quote('import json,sys;print(json.dumps(json.load(open(sys.argv[1]))))')} ` +
          quote(remoteData + '/users/' + userId + '/managed-volumes.v1.json'))) as StoredManagedVolume[];
        const newVolumes = records.filter(record => record.workerId === newId); expect(newVolumes).toHaveLength(1);
        const newManaged = newVolumes[0]!;
        expect(newManaged).toMatchObject({ userId, target: volume.target, storageRuntimeKind: 'incus-vm', attached: true, seeded: true, state: 'ready' });
        expect(newManaged.id).not.toBe(volume.id); expect(newManaged.dockerName).not.toBe(volume.dockerName);
        const nativeNames = [...['workspace', 'agents', 'docker'].map(role => newOwner.containerName + '-' + role), newManaged.dockerName];
        const newNative = await Promise.all(nativeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
        for (const native of newNative) {
          expect(sourceNames).not.toContain(native.name); expect(native.created_at).toBeTruthy();
          expect(native.config).toMatchObject({ 'user.agentor.installation': installation, 'user.agentor.id': newId, 'user.agentor.owner': userId });
          expect(native.used_by).toEqual(['/1.0/instances/' + newOwner.containerName + '?project=agentor']);
        }
        const metadataCheck = ['python3', '-c', String.raw`
import os,stat,sys
for p in sys.argv[1:]:
 f=p+'/data';s=os.stat(f)
 assert open(f,'rb').read()==bytes([0,255,128,10,61,0]) and s.st_ino==os.stat(p+'/hard').st_ino
 assert (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_mtime_ns)==(12345,23456,0o640,1700000000987654321)
 assert os.getxattr(f,'user.binary')==bytes([0,255,128,10,61,0])
`, path, agentPath, selectedPath, volume.target];
        for (const command of [metadataCheck, dockerProof, ['bash', '-ec',
          'cmp /workspace/marker /home/agent/.agent-data/marker; systemctl is-active --quiet incus-agent agentor-worker docker; ' +
          'test ! -e /tls/client.crt; test ! -e /tls/client.key; curl -fsS http://127.0.0.1:8443/ >/dev/null; curl -fsS http://127.0.0.1:6080/ >/dev/null']]) {
          const proof = await runtime.client.exec(newOwner.containerName, command); expect(proof.returnCode, proof.stderr).toBe(0);
          if (command === dockerProof) expect(proof.stdout).toBe(originalDocker.stdout);
        }
        expect((await appRequest<string>('/editor/' + newId + '/?folder=/workspace')).body).toContain('code-server');
        expect((await appRequest<string>('/desktop/' + newId + '/agentor.html')).body).toContain('noVNC');
        const self = await runtime.client.exec(newOwner.containerName, ['curl', '--noproxy', '*', '-fsS', config.incusInternalGatewayUrl + '/api/worker-self/info']);
        expect(self.returnCode, self.stderr).toBe(0); expect(JSON.parse(self.stdout)).toMatchObject({ workerId: newId, userId });
        expect(await runtime.client.getInstance(options!.containerName)).toEqual(before);
        expect(await Promise.all(sourceNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(beforeVolumes);
        expect((await appRequest('/api/containers/' + id + '/restart', {}, true, 360_000)).status).toBe(200);
        expect((await runtime.client.getInstance(options!.containerName)).config['volatile.uuid']).toBe(incarnation);
        for (const command of [metadataCheck, dockerProof]) {
          const proof = await runtime.client.exec(options!.containerName, command); expect(proof.returnCode, proof.stderr).toBe(0);
          if (command === dockerProof) expect(proof.stdout).toBe(originalDocker.stdout);
        }
        // Success-only destruction: recheck the captured destination incarnation,
        // full configuration and every newly-created volume/ref before removal.
        expect(await runtime.client.getInstance(newOwner.containerName)).toEqual(fresh);
        expect(await Promise.all(nativeNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(newNative);
        await runtime.remove(newOwner, freshUuid); await runtime.removeStorage(newOwner);
        const detached = await managedRuntime.inspectVolume(newManaged);
        expect(detached).toEqual({ ...newNative[3]!, used_by: [] }); await managedRuntime.delete(newManaged);
        await expect(runtime.client.getInstance(newOwner.containerName)).rejects.toMatchObject({ statusCode: 404 });
        for (const name of nativeNames) await expect(runtime.client.getCustomVolume(config.incusStoragePool, name)).rejects.toMatchObject({ statusCode: 404 });
        computeSettled = true;
        console.info('Actual encrypted public target:new passed fresh native identity/storage, workspace/agents/managed/selected metadata, Docker image/container/named-volume state, services/proxies/self and unchanged source');
      } else {
      await runtime.client.exec(options!.containerName, ['python3', '-c',
        'import sys; p=sys.argv[1];open(p+"/data","wb").write(b"changed-after-capture");' +
        'open("/workspace/extra-after-"+sys.argv[2],"wb").write(b"must disappear");' +
        'open("/home/agent/.agent-data/marker","wb").write(b"agent-after-capture");' +
        'open("/root/original-public-"+sys.argv[2],"wb").write(b"compute-root-after-capture")', path, id])
        .then(result => expect(result.returnCode, result.stderr).toBe(0));
      const stopped = await appRequest('/api/containers/' + id + '/stop', {}, true, 360_000); expect(stopped.status).toBe(200);
      const before = await runtime.client.getInstance(options!.containerName); expect(before.status).toBe('Stopped');
      expect(before.config['volatile.uuid']).toBe(incarnation);
      const names = [...['workspace', 'agents', 'docker'].map(role => options!.containerName + '-' + role), volume.dockerName];
      const beforeVolumes = await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
      const lockPassword = 'original-fixture-' + jobId;
      expect((await appRequest('/api/containers/' + id + '/protection', { password: lockPassword }, true, 30_000, undefined, undefined, 'PUT')).status).toBe(200);
      const endpoint = '/api/backups/' + artifact.body.id + '/restore';
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id] })).status).toBe(409);
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true })).status).toBe(423);
      expect((await appRequest(endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true, lockPassword: 'incorrect-fixture' })).status).toBe(423);
      expect(await runtime.client.getInstance(options!.containerName)).toEqual(before);
      expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(beforeVolumes);
      {
        computeSettled = false; // Any unknown native replacement keeps the exact original source/receipt.
        const restored = await appRequest<{ jobId: string }> (endpoint, { target: 'original', workspaceIds: [id], confirmOverwrite: true,
          lockPassword, requestId: jobId + '-original' });
        expect(restored.status).toBe(202); expect(restored.body.jobId).toMatch(/^[a-f0-9-]{36}$/);
        await expect.poll(async () => {
          const state = await appRequest<BackupJob>('/api/backup-jobs/' + restored.body.jobId); expect(state.status).toBe(200);
          if (state.body.status === 'failed') throw new Error('Public original restore failed: ' + (state.body.errorCode ?? 'unknown'));
          return state.body.status;
        }, { timeout: 300_000, intervals: [1000] }).toBe('succeeded');
        expect(await runtime.client.getInstance(options!.containerName)).toEqual(before);
        const expectedVolumes = structuredClone(beforeVolumes); expectedVolumes[0]!.config['user.agentor.workspace-preserve-ownership'] = 'true';
        expect(await Promise.all(names.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)))).toEqual(expectedVolumes);
        await root(`sudo test ! -e ${quote(remoteData + '/incus-backup-helpers')} || sudo test -z "$(sudo ls -A ${quote(remoteData + '/incus-backup-helpers')})"`);
        const started = await appRequest('/api/containers/' + id + '/restart', { lockPassword }, true, 360_000); expect(started.status).toBe(200);
        expect((await runtime.client.getInstance(options!.containerName)).config['volatile.uuid']).toBe(incarnation);
        const checked = await runtime.client.exec(options!.containerName, ['python3', '-c', String.raw`
import os,stat,sys
p=sys.argv[1];f=p+'/data';s=os.stat(f)
assert open(f,'rb').read()==bytes([0,255,128,10,61,0]) and s.st_ino==os.stat(p+'/hard').st_ino
assert (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode),s.st_mtime_ns)==(12345,23456,0o640,1700000000987654321)
assert os.getxattr(f,'user.binary')==bytes([0,255,128,10,61,0])
assert not os.path.lexists('/workspace/extra-after-'+sys.argv[2])
assert open('/home/agent/.agent-data/marker','rb').read()==b'agent-after-capture'
assert open('/root/original-public-'+sys.argv[2],'rb').read()==b'compute-root-after-capture'
`, path, id]);
        expect(checked.returnCode, checked.stderr).toBe(0); computeSettled = true;
        const retained = await runtime.client.exec(options!.containerName, ['bash', '-ec',
          'docker image inspect agentor-archive-lower:proof >/dev/null; docker container inspect archive-layer archive-stopped >/dev/null; ' +
          'docker run --rm -v archive-data:/data busybox:1.37.0 sh -ec \'test "$(cat /data/ordinary)" = persistent\'; ' +
          'python3 -c \'import sys;assert open(sys.argv[1]+"/data","rb").read()==bytes([0,255,128,10,61,0])\' "$1"', 'bash', volume.target]);
        expect(retained.returnCode, retained.stderr).toBe(0);
      }
      console.info('Actual encrypted worker backup/public original dispatch passed protection rejects, native kind/durable identity fence, stopped sameVM replacement and metadata-only workspace acknowledgement; agents/Docker/managed state retained');
      }
    }
    if (rest) {
      const expectedSource = manifest.volumes.find(v => v.runtime?.role === 'workspace')!.runtime;
      if (expectedSource?.role !== 'workspace') throw new Error('Original native source proof missing');
      await runProducer(expectedSource.source, installation);
    }
    completed = true;
    console.info(ordinary ? 'Real constrained helper committed original stopped intent; explicit native start verified editor/desktop and Docker image/container/named-volume data'
      : 'Real constrained helper committed retained binary/native metadata, zero source references, no synthetic worker, exact Docker target restart');
  } catch (error) {
    console.error('Native helper-process gate primary failure', error instanceof Error ? error.message : 'Unknown failure');
    throw error;
  } finally {
    // A failed helper may have unknown native acknowledgement. Keep every
    // exact source/installed record and fixture; absence alone is not cleanup.
    if (completed && !customRetained && (customPublic || rollback || baseline)) {
      if (ordinary && !rollback) {
        if (!computeSettled || !incarnation) throw new Error('Unconfirmed ordinary compute cleanup authority');
        const current = await runtime.client.getInstance(options!.containerName);
        expect(current.config['volatile.uuid']).toBe(incarnation);
        expect(await runtime.matchesWorkerIdentity(current, id, userId)).toBe(true);
        await runtime.remove(options!, incarnation); await runtime.removeStorage(options!);
      }
      if (!rollback && !customPublic) {
        const current = await managedRuntime.inspectVolume(volume);
        if (!current || current.used_by.length || current.project !== baseline!.project || current.created_at !== baseline!.created_at ||
            !isDeepStrictEqual(current.config, baseline!.config)) throw new Error('Exact fixture cleanup authority changed');
        await managedRuntime.delete(volume);
      }
      for (const containerId of [helperRemovedByManager ? undefined : helperId, targetId, retained?.parentId]) if (containerId) {
        expect(await root(`sudo docker inspect ${containerId} --format '{{.Id}} {{.Image}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${containerId} ${containerId === retained?.parentId ? retained.parentImageId : imageId} ${jobId}`);
        await root(`sudo docker rm -f ${containerId}`);
      }
      if (sourceRuleBaseline) {
        expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${sourceTable}`))).toBe(sourceRuleBaseline);
        await root(`sudo nft delete table ip ${sourceTable}`);
      }
      expect(await root(`sudo docker image inspect ${quote(image)} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
        .toBe(imageId + ' ' + jobId);
      await root(`sudo docker image rm ${quote(imageId!)}`);
      if (retained) {
        if (retained.oldNft) {
          expect(sourceRuleSnapshot(await root(`sudo nft -j list table ip ${retained.oldNft.table}`)))
            .toBe(sourceRuleSnapshot(typeof retained.oldNft.json === 'string' ? retained.oldNft.json : JSON.stringify(retained.oldNft.json)));
          await root(`sudo nft delete table ip ${retained.oldNft.table}`);
        }
        expect(await root(`sudo docker image inspect ${retained.parentImageId} --format '{{.Id}} {{index .Config.Labels "agentor.native-helper-fixture"}}'`))
          .toBe(`${retained.parentImageId} ${jobId}`);
        await root(`sudo docker image rm ${retained.parentImageId}`);
      }
      if (policyAdded) { await policy(false); policyAdded = false; }
      await root(`sudo rm -rf ${quote(remote)}`);
      if (retained) await root(`sudo rm -rf ${quote(retained.remoteDir)}`);
      cleaned = true;
    }
    if (cleaned || !targetId && !helperId && !startupHolderId) await rm(local, { recursive: true, force: true });
    else if (completed && (customRetained || historical)) console.info('Exact accepted fixture/source DATA retained for next gate', { local, remote, jobId, targetId });
    else console.error('Retained exact unconfirmed helper-process fixture', { local, remote, id, jobId, restoreJobId, targetId, helperId, startupHolderId });
    // Do not replace the primary assertion with a cleanup failure. Unknown
    // native submission deliberately keeps every exact fixture for diagnosis.
    if (completed && !customRetained && !historical) expect(cleaned, 'Acknowledged fixture cleanup must complete').toBe(true);
  }
});
