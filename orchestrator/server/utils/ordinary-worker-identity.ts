import { useAdminWorkspaceStore } from './admin-workspace-store';
import { useGroupAdminWorkspaceStore } from './group-admin-workspace-store';
import { useWorkerGroupStore } from './services';

/** Startup loads these stores before ordinary APIs/reconciliation. Historical
 * WorkerRecords may share their IDs without carrying administrative metadata. */
export function isAdministrativeWorkspaceId(id: string, ownerId: string): boolean {
  // Global list() omits quarantined owner partitions. Never treat an unknown
  // group identity as ordinary when this owner's authoritative file is unreadable.
  useWorkerGroupStore().listForUser(ownerId);
  return useAdminWorkspaceStore().getRecord()?.id === id ||
    Boolean(useGroupAdminWorkspaceStore().findByWorkspaceId(id));
}

export function assertOrdinaryWorkerIdentity(id: string, ownerId: string): void {
  if (isAdministrativeWorkspaceId(id, ownerId))
    throw Object.assign(new Error('Administrative workspace lifecycle requires the dedicated confirmed admin API'),
      { statusCode: 409, code: 'ADMINISTRATIVE_WORKSPACE_LIFECYCLE_REQUIRED' });
}
