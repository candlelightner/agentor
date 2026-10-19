import { validateAdminMemoryLimit } from '../../shared/admin-workspace-memory';
import { validateVcpuCount } from '../../shared/vcpu-count';
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
  selectedVolumeIds?: string[];
  selectedOperation?: { volumeId: string; operationId: string; incarnation: string; kind: 'snapshot' | 'seed'; canonical?: true; device?: { state: 'unknown' | 'accepted' | 'settled'; operation?: string } };
  memoryLimit?: string;
  vcpuCount?: number;
  appliedStartupScriptRevision?: number;
  pending?: { kind: 'create' | 'start' | 'stop' | 'delete' | 'cpu'; operation?: string;
    cpu?: { previousCount: number; vcpuCount: number; definitionFingerprint: string; acknowledged?: true; rejected?: true } };
}
export interface AdminNativeMigration {
  version: 1;
  nonce: string;
  phase: 'prepared' | 'captured' | 'restored' | 'retained';
  source: { containerId: string; imageId: string; createdAt: string; wasRunning?: boolean };
}
export interface AdminNativeRuntimePatch {
  vcpuCount?: number;
  status?: 'running' | 'stopped';
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
  // Leave room for project-qualified virtiofs sockets, not just Incus names.
  const name = `agentor-admin-${record.id}`;
  return name.length <= 44 && /^[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]$/.test(name) ? name
    : `agentor-admin-${createHash('sha256').update(record.id).digest('hex').slice(0,30)}`;
}
export function validateAdminNativeState(record: Readonly<AdministrativeWorkspaceRecord>): void {
  if (record.vcpuCount !== undefined) validateVcpuCount(record.vcpuCount);
  if (record.nativeRuntime?.vcpuCount !== undefined) validateVcpuCount(record.nativeRuntime.vcpuCount);
  if (record.memoryLimit !== undefined) validateAdminMemoryLimit(record.memoryLimit);
  if (record.nativeRuntime?.memoryLimit !== undefined) validateAdminMemoryLimit(record.nativeRuntime.memoryLimit);
  if (record.runtimeKind === undefined) {
    if (record.nativeRuntime || record.nativeMigration) throw new Error('Administrative runtime selector is missing');
    return;
  }
  if (!['legacy-docker', 'incus-vm'].includes(record.runtimeKind)) throw new Error('Administrative runtime selector is invalid');
  if (record.nativeRuntime !== undefined && (!record.nativeRuntime || typeof record.nativeRuntime !== 'object' || Array.isArray(record.nativeRuntime)))
    throw new Error('Administrative native runtime identity is invalid');
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
        v.pending !== undefined && (!v.pending || !['create', 'start', 'stop', 'delete', 'cpu'].includes(v.pending.kind) ||
          v.pending.operation !== undefined && !/^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}(?:\?project=[A-Za-z0-9_-]+)?$/.test(v.pending.operation)))
      throw new Error('Administrative native runtime identity is invalid');
    const cpu = v.pending?.cpu;
    if (v.pending?.kind === 'cpu') {
      if (!v.incarnation || !cpu || typeof cpu !== 'object' || Array.isArray(cpu) ||
          Object.keys(v.pending).some(key => !['kind', 'operation', 'cpu'].includes(key)) ||
          Object.keys(cpu).some(key => !['previousCount', 'vcpuCount', 'definitionFingerprint', 'acknowledged', 'rejected'].includes(key)) ||
          typeof cpu.definitionFingerprint !== 'string' || !hex.test(cpu.definitionFingerprint) || cpu.acknowledged !== undefined && cpu.acknowledged !== true ||
          cpu.rejected !== undefined && (cpu.rejected !== true || cpu.acknowledged !== undefined || v.pending.operation !== undefined) ||
          v.pending.operation !== undefined && cpu.acknowledged !== true)
        throw new Error('Administrative CPU update intent is invalid');
      validateVcpuCount(cpu.previousCount); validateVcpuCount(cpu.vcpuCount);
      if (cpu.previousCount !== (v.vcpuCount ?? 2)) throw new Error('Administrative CPU update source changed');
    } else if (cpu !== undefined) throw new Error('Administrative CPU update intent is invalid');
    if (v.selectedVolumeIds !== undefined && (!Array.isArray(v.selectedVolumeIds) || v.selectedVolumeIds.length > 32 ||
        new Set(v.selectedVolumeIds).size !== v.selectedVolumeIds.length || v.selectedVolumeIds.some(id => typeof id !== 'string' || !ADMIN_NATIVE_UUID.test(id))))
      throw new Error('Administrative selected storage references are invalid');
    if (v.selectedOperation !== undefined && (!v.selectedOperation || typeof v.selectedOperation !== 'object' || Array.isArray(v.selectedOperation)))
      throw new Error('Administrative selected storage operation is invalid');
    if (v.selectedOperation && (Object.keys(v.selectedOperation).some(key => !['volumeId','operationId','incarnation','kind','canonical','device'].includes(key)) ||
        ![v.selectedOperation.volumeId,v.selectedOperation.operationId,v.selectedOperation.incarnation].every(id => typeof id === 'string' && ADMIN_NATIVE_UUID.test(id)) ||
        !['snapshot','seed'].includes(v.selectedOperation.kind) || !v.selectedVolumeIds?.includes(v.selectedOperation.volumeId) ||
        v.selectedOperation.incarnation !== v.incarnation ||
        v.selectedOperation.canonical !== undefined && (v.selectedOperation.canonical !== true || v.selectedOperation.kind !== 'seed'))) throw new Error('Administrative selected storage operation is invalid');
    const device = v.selectedOperation?.device;
    if (device !== undefined && (!device || typeof device !== 'object' || Array.isArray(device)))
      throw new Error('Administrative selected device acknowledgement is invalid');
    if (device && (Object.keys(device).some(key => !['state','operation'].includes(key)) ||
        !['unknown','accepted','settled'].includes(device.state) ||
        device.operation !== undefined && !/^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(device.operation) ||
        device.state === 'accepted' && !device.operation || device.state !== 'accepted' && device.operation !== undefined))
      throw new Error('Administrative selected device acknowledgement is invalid');
    validateIncusImageIdentity(v.image);
  }
  if (record.nativeMigration) {
    const m = record.nativeMigration;
    if (m.version !== 1 || !ADMIN_NATIVE_UUID.test(m.nonce) || !['prepared','captured','restored','retained'].includes(m.phase) ||
        !/^[a-f0-9]{64}$/.test(m.source?.containerId) || !/^sha256:[a-f0-9]{64}$/.test(m.source?.imageId) ||
        !Number.isFinite(Date.parse(m.source?.createdAt)) || m.source.wasRunning !== undefined && typeof m.source.wasRunning !== 'boolean') throw new Error('Administrative native migration identity is invalid');
  }
}
export function applyAdminNativePatch(record: AdministrativeWorkspaceRecord, patch: AdminNativeRuntimePatch): boolean {
  if (patch.status !== undefined && !['running','stopped'].includes(patch.status)) throw new Error('Administrative runtime status acknowledgement is invalid');
  const next = { ...record, ...(patch.status !== undefined ? {status:patch.status} : {}),
    ...(patch.vcpuCount !== undefined ? { vcpuCount: patch.vcpuCount } : {}), runtimeKind: patch.runtimeKind, nativeRuntime: patch.nativeRuntime && structuredClone(patch.nativeRuntime),
    nativeMigration: patch.nativeMigration && structuredClone(patch.nativeMigration) };
  validateAdminNativeState(next);
  if (isDeepStrictEqual(record, next)) return false;
  Object.assign(record, next); return true;
}

