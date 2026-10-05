import type { WorkerRuntimeKind } from '../../shared/types';
import type { WorkerBackupRuntime } from './worker-backup-runtime';

/** Origin/provenance and authorization are trusted internal caller facts,
 * never flags supplied by a manifest or inferred from encryption. Missing
 * artifact provenance is historical local compatibility, not portable input. */
export type WorkerImportOrigin =
  | { kind: 'portable' }
  | { kind: 'backup'; provenance?: 'local' | 'remote-adopted'; adminLegacyAuthorized?: boolean };

export interface WorkerImportRuntimePolicyInput {
  /** Already parsed descriptive metadata, not runtime authority. */
  runtime?: WorkerBackupRuntime;
  origin: WorkerImportOrigin;
  incusEnabled: boolean;
  capturedRootfs?: boolean;
  /** An explicit caller-selected import mode; never read from bundle flags. */
  ignoreCapturedRootfs?: 'replacement-image' | 'workspace-only';
}

const denied = (code: string, message: string) => Object.assign(new Error(message), { statusCode: 409, code });

/** Select only the durable runtime kind. Readiness, image resolution and
 * reconstruction belong to the existing create/restore operation. */
export function selectWorkerImportRuntime(input: WorkerImportRuntimePolicyInput): WorkerRuntimeKind {
  const { runtime, origin, incusEnabled } = input;
  if (!origin || !['portable', 'backup'].includes(origin.kind) || typeof incusEnabled !== 'boolean' ||
      origin.kind === 'backup' && origin.provenance !== undefined && !['local', 'remote-adopted'].includes(origin.provenance) ||
      runtime !== undefined && runtime?.kind !== 'legacy-docker' && runtime?.kind !== 'incus-vm')
    throw denied('INVALID_WORKER_IMPORT_RUNTIME_POLICY', 'Worker import runtime policy has invalid trusted inputs.');

  let selected: WorkerRuntimeKind;
  if (runtime?.kind === 'incus-vm') {
    if (!incusEnabled) throw denied('INCUS_RUNTIME_DISABLED', 'This data describes an Incus worker. Enable and validate Incus before restoring it; legacy fallback is not allowed.');
    selected = 'incus-vm';
  } else if (origin.kind === 'portable') {
    selected = incusEnabled ? 'incus-vm' : 'legacy-docker';
  } else {
    if (origin.provenance === 'remote-adopted' && incusEnabled && origin.adminLegacyAuthorized !== true)
      throw denied('REMOTE_LEGACY_RESTORE_AUTH_REQUIRED', 'Remote-adopted legacy backup requires explicit current platform-admin authorization for legacy runtime. Encryption does not grant that authority.');
    // Local historical backup restore is not automatic legacy→Incus migration.
    selected = 'legacy-docker';
  }
  if (selected === 'incus-vm' && input.capturedRootfs &&
      input.ignoreCapturedRootfs !== 'replacement-image' && input.ignoreCapturedRootfs !== 'workspace-only')
    throw denied('INCUS_CAPTURED_ROOTFS_UNSUPPORTED', 'A captured root filesystem cannot become an Incus worker image. Explicitly choose a replacement image or workspace-only import to ignore it.');
  return selected;
}
