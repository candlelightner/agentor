import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { validateIncusImageIdentity, type IncusWorkerImageIdentity } from './incus-worker-image';

export interface AdminNativeRuntimeIdentity {
  version: 1;
  name: string;
  installationId: string;
  nonce: string;
  incarnation?: string;
  image: IncusWorkerImageIdentity;
  overlayVersion: '6';
  overlaySha256: string;
  storageReady?: true;
  storageInitialized?: true;
  /** Retains exact storage deletion authority across a partial explicit remove. */
  deleting?: true;
  appliedStartupScriptRevision?: number;
  pending?: { kind: 'create' | 'start' | 'stop' | 'delete'; operation?: string };
}
export interface AdminNativeMigration {
  version: 1;
  nonce: string;
  phase: 'prepared' | 'captured' | 'restored' | 'retained';
  source: { containerId: string; imageId: string; createdAt: string };
}
export interface AdminNativeRuntimePatch {
  runtimeKind: 'legacy-docker' | 'incus-vm';
  nativeRuntime?: AdminNativeRuntimeIdentity;
  nativeMigration?: AdminNativeMigration;
}
export type AdminNativeAcknowledge = (patch: AdminNativeRuntimePatch) => Promise<void>;
export const ADMIN_NATIVE_UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
export function administrativeRuntimeOwner(record: Readonly<AdministrativeWorkspaceRecord>) {
  if (!record || record.schemaVersion !== 1 || record.trusted !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(record.id) ||
      !['administrative', 'group-administrative'].includes(record.kind)) throw new Error('Administrative runtime authority is invalid');
  const groupId = (record as AdministrativeWorkspaceRecord & { groupId?: string }).groupId;
  if (record.kind === 'group-administrative' && (!/^[A-Za-z0-9_-]{1,128}$/.test(groupId ?? '') ||
      typeof record.ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(record.ownerId)))
    throw new Error('Group administrative runtime authority is invalid');
  if (record.kind === 'administrative' && groupId !== undefined) throw new Error('Platform administrative group authority is invalid');
  return { id: record.id, userId: record.kind === 'administrative' ? '__agentor_admin__' : record.ownerId!,
    kind: record.kind, groupId };
}
export function adminNativeInstanceName(record: Readonly<AdministrativeWorkspaceRecord>): string {
  administrativeRuntimeOwner(record);
  const name = `agentor-admin-${record.id}`;
  return name.length <= 53 && /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/.test(name) ? name
    : `agentor-admin-${createHash('sha256').update(record.id).digest('hex').slice(0,32)}`;
}
export function validateAdminNativeState(record: Readonly<AdministrativeWorkspaceRecord>): void {
  if (record.runtimeKind === undefined) {
    if (record.nativeRuntime || record.nativeMigration) throw new Error('Administrative runtime selector is missing');
    return;
  }
  if (!['legacy-docker', 'incus-vm'].includes(record.runtimeKind)) throw new Error('Administrative runtime selector is invalid');
  if (record.nativeRuntime) {
    administrativeRuntimeOwner(record);
    const v = record.nativeRuntime;
    if (v.version !== 1 || v.name !== adminNativeInstanceName(record) || !ADMIN_NATIVE_UUID.test(v.installationId) ||
        !ADMIN_NATIVE_UUID.test(v.nonce) || v.incarnation !== undefined && !ADMIN_NATIVE_UUID.test(v.incarnation) ||
        v.overlayVersion !== '6' || !hex.test(v.overlaySha256) ||
        v.storageReady !== undefined && v.storageReady !== true ||
        v.storageInitialized !== undefined && v.storageInitialized !== true ||
        v.deleting !== undefined && v.deleting !== true ||
        v.appliedStartupScriptRevision !== undefined && (!Number.isSafeInteger(v.appliedStartupScriptRevision) || v.appliedStartupScriptRevision < 0) ||
        v.pending && (!['create', 'start', 'stop', 'delete'].includes(v.pending.kind) ||
          v.pending.operation !== undefined && !/^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:\?project=[A-Za-z0-9_-]+)?$/.test(v.pending.operation)))
      throw new Error('Administrative native runtime identity is invalid');
    validateIncusImageIdentity(v.image);
  }
  if (record.nativeMigration) {
    const m = record.nativeMigration;
    if (m.version !== 1 || !ADMIN_NATIVE_UUID.test(m.nonce) || !['prepared','captured','restored','retained'].includes(m.phase) ||
        !/^[a-f0-9]{64}$/.test(m.source?.containerId) || !/^sha256:[a-f0-9]{64}$/.test(m.source?.imageId) ||
        !Number.isFinite(Date.parse(m.source?.createdAt))) throw new Error('Administrative native migration identity is invalid');
  }
}
export function applyAdminNativePatch(record: AdministrativeWorkspaceRecord, patch: AdminNativeRuntimePatch): boolean {
  const next = { ...record, runtimeKind: patch.runtimeKind, nativeRuntime: patch.nativeRuntime && structuredClone(patch.nativeRuntime),
    nativeMigration: patch.nativeMigration && structuredClone(patch.nativeMigration) };
  validateAdminNativeState(next);
  if (isDeepStrictEqual(record, next)) return false;
  Object.assign(record, next); return true;
}

/** Fresh dedicated authority, never an ordinary shadow worker or a public record. */
export async function readAdministrativeRuntimeRecord(id: string): Promise<AdministrativeWorkspaceRecord> {
  const [{ useAdminWorkspaceStore }, { useGroupAdminWorkspaceStore }] = await Promise.all([
    import('./admin-workspace-store'), import('./group-admin-workspace-store')]);
  const { useWorkerGroupStore } = await import('./services');
  const store = useAdminWorkspaceStore(); await Promise.all([store.init(), useWorkerGroupStore().init()]);
  const global = store.getRecord();
  const record = global?.id === id ? global : useGroupAdminWorkspaceStore().findByWorkspaceId(id);
  if (!record) throw Object.assign(new Error('Administrative runtime authority is unavailable'), { statusCode: 404 });
  administrativeRuntimeOwner(record); validateAdminNativeState(record); return record;
}
