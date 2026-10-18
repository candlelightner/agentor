import { isSafeUserId } from './user-id';

/** Server-issued authority for one exact restore job, never bundle/request
 * metadata or a persisted management credential. */
export type BackupRestoreRuntimePrincipal =
  | { kind: 'admin-user'; userId: string }
  | { kind: 'platform-workspace'; workspaceId: string };

export function validBackupRestoreRuntimePrincipal(value: unknown): value is BackupRestoreRuntimePrincipal | undefined {
  if (value === undefined) return true; // Historical jobs carry no extra grant.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const principal = value as Record<string, unknown>, ownKeys = Reflect.ownKeys(principal);
  if (ownKeys.length !== 2 || ownKeys.some(key => typeof key !== 'string')) return false;
  const keys = (ownKeys as string[]).sort().join(',');
  const safe = (id: unknown) => typeof id === 'string' && id.length <= 200 && isSafeUserId(id);
  return principal.kind === 'admin-user'
    ? keys === 'kind,userId' && safe(principal.userId)
    : principal.kind === 'platform-workspace' && keys === 'kind,workspaceId' && safe(principal.workspaceId);
}

interface AuthorityDependencies {
  isAdminUser(userId: string): boolean | Promise<boolean>;
  platformWorkspace(): { id: string; kind: string; trusted: boolean } | undefined |
    Promise<{ id: string; kind: string; trusted: boolean } | undefined>;
  backupsEnabled(): boolean | Promise<boolean>;
}

const defaults: AuthorityDependencies = {
  async isAdminUser(userId) {
    const { isPlatformAdminUser } = await import('./auth');
    return isPlatformAdminUser(userId);
  },
  async platformWorkspace() {
    const { useAdminWorkspaceStore } = await import('./admin-workspace-store');
    const store = useAdminWorkspaceStore(); await store.init();
    return store.getRecord(); // Never ensure/create an administrative workspace.
  },
  async backupsEnabled() {
    const { useManagementMcpStore } = await import('./management-mcp-store');
    return (await useManagementMcpStore().getPolicy()).groups.backups.enabled;
  },
};

/** Recheck live platform authority at retry/provisioning boundaries. Workload
 * token expiry is intentionally irrelevant to an admitted asynchronous job. */
export async function isBackupRestoreLegacyAuthorized(
  principal?: BackupRestoreRuntimePrincipal,
  dependencies: AuthorityDependencies = defaults,
): Promise<boolean> {
  if (!principal || !validBackupRestoreRuntimePrincipal(principal)) return false;
  try {
    if (principal.kind === 'admin-user') return await dependencies.isAdminUser(principal.userId) === true;
    const bound = (record: Awaited<ReturnType<AuthorityDependencies['platformWorkspace']>>) =>
      record?.id === principal.workspaceId && record.kind === 'administrative' && record.trusted === true;
    if (!bound(await dependencies.platformWorkspace()) || await dependencies.backupsEnabled() !== true) return false;
    // The policy read may yield. Do not bless a workspace removed/replaced
    // while it was in flight, and never substitute a group workspace.
    return bound(await dependencies.platformWorkspace());
  } catch { return false; } // Unavailable authority is not legacy permission.
}

export async function assertBackupRestoreRuntimePrincipal(principal?: BackupRestoreRuntimePrincipal): Promise<void> {
  if (!validBackupRestoreRuntimePrincipal(principal))
    throw Object.assign(new Error('Invalid internal restore runtime principal'), { statusCode: 400 });
  if (principal && !await isBackupRestoreLegacyAuthorized(principal))
    throw Object.assign(new Error('Platform restore authorization is no longer current; submit a new authorized restore'),
      { statusCode: 403, code: 'BACKUP_RESTORE_RUNTIME_AUTH_REVOKED' });
}
