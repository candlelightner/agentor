import { validBackupRestoreRuntimePrincipal, type BackupRestoreRuntimePrincipal } from './backup-restore-runtime-authority';
import type { WorkerRecord } from './worker-store';

export type WorkerMigrationPrincipal = BackupRestoreRuntimePrincipal;
export interface WorkerIncusMigrationDependencies {
  isAdminUser(userId: string): boolean | Promise<boolean>;
  platformWorkspace(): { id: string; kind: string; trusted: boolean } | undefined |
    Promise<{ id: string; kind: string; trusted: boolean } | undefined>;
  workerLifecycleEnabled(): boolean | Promise<boolean>;
  findWorker(id: string): Promise<WorkerRecord | undefined>;
  verifyUnlock(id: string, password: unknown): Promise<unknown>;
  migrate(id: string, assertPrincipal: () => Promise<void>, lockPasswords?: Record<string, string>): Promise<unknown>;
  finalize(id: string, assertPrincipal: () => Promise<void>): Promise<void>;
}
const defaults: WorkerIncusMigrationDependencies = {
  async isAdminUser(id) { return (await import('./auth')).isPlatformAdminUser(id); },
  async platformWorkspace() {
    const store = (await import('./admin-workspace-store')).useAdminWorkspaceStore();
    await store.init(); return store.getRecord(); // Never creates/adopts an admin workspace.
  },
  async workerLifecycleEnabled() {
    return (await (await import('./management-mcp-store')).useManagementMcpStore().getPolicy()).groups['worker-lifecycle'].enabled;
  },
  async findWorker(id) { const store = (await import('./services')).useWorkerStore(); await store.init(); return store.findById(id); },
  async verifyUnlock(id, password) { return (await import('./worker-protection-lock')).useWorkerProtectionLockStore().verify(id, password); },
  async migrate(id, current, passwords) { return (await import('./services')).useContainerManager().migrateLegacyWorker(id, current, passwords); },
  async finalize(id, current) { return (await import('./services')).useContainerManager().finalizeLegacyMigration(id, current); },
};
const forbidden = () => Object.assign(new Error('Current platform-admin migration authority is required'),
  { statusCode: 403, code: 'WORKER_MIGRATION_AUTH_REVOKED' });
const badRequest = () => Object.assign(new Error('Invalid migration request'), { statusCode: 400 });

/** One business service for authenticated REST and platform Management MCP.
 * Migration/source/finalization authority remains entirely in ContainerManager. */
export class WorkerIncusMigrationService {
  constructor(private readonly dependencies: WorkerIncusMigrationDependencies = defaults) {}
  private principal(value: unknown): WorkerMigrationPrincipal {
    if (!value || !validBackupRestoreRuntimePrincipal(value)) throw forbidden();
    return { ...value };
  }
  private workerId(id: string): string {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw badRequest();
    return id;
  }
  private async authorize(principal: WorkerMigrationPrincipal): Promise<void> {
    try {
      if (principal.kind === 'admin-user') {
        if (await this.dependencies.isAdminUser(principal.userId) === true) return;
      } else {
        const bound = (record: Awaited<ReturnType<WorkerIncusMigrationDependencies['platformWorkspace']>>) =>
          record?.id === principal.workspaceId && record.kind === 'administrative' && record.trusted === true;
        if (bound(await this.dependencies.platformWorkspace()) && await this.dependencies.workerLifecycleEnabled() === true &&
            bound(await this.dependencies.platformWorkspace())) return;
      }
    } catch { /* Unavailable live authorization never grants mutation authority. */ }
    throw forbidden();
  }
  private async inspect(id: string, principal: WorkerMigrationPrincipal) {
    await this.authorize(principal);
    const record = await this.dependencies.findWorker(id);
    await this.authorize(principal);
    if (!record) throw Object.assign(new Error('Worker not found'), { statusCode: 404 });
    const marker = record.incusMigration;
    return { kind: record.runtimeKind ?? 'legacy-docker', phase: marker?.phase ?? 'none',
      recoveryRequired: Boolean(marker && marker.phase !== 'retained'), sourceRetained: Boolean(marker) };
  }
  async status(id: string, actor: WorkerMigrationPrincipal) {
    const principal = this.principal(actor); return this.inspect(this.workerId(id), principal);
  }
  private async mutate(operation: 'migrate' | 'finalize', id: string, actor: WorkerMigrationPrincipal, lockPassword?: string,
    lockPasswords?: Record<string, string>) {
    const principal = this.principal(actor); id = this.workerId(id);
    if (lockPassword !== undefined && (typeof lockPassword !== 'string' || lockPassword.length > 1024)) throw badRequest();
    const passwords = migrationPeerLockPasswords(lockPasswords);
    if (lockPassword !== undefined) passwords[id] = lockPassword;
    const current = async () => {
      await this.authorize(principal); await this.dependencies.verifyUnlock(id, lockPassword); await this.authorize(principal);
    };
    await current();
    if (operation === 'migrate') await this.dependencies.migrate(id, current, passwords);
    else await this.dependencies.finalize(id, current);
    return this.inspect(id, principal);
  }
  async migrate(id: string, actor: WorkerMigrationPrincipal, lockPassword?: string, lockPasswords?: Record<string, string>) {
    return this.mutate('migrate', id, actor, lockPassword, lockPasswords);
  }
  async finalize(id: string, actor: WorkerMigrationPrincipal, lockPassword?: string) { return this.mutate('finalize', id, actor, lockPassword); }
}

/** Request bodies never carry runtime/project/source/destination authority. */
export function migrationLockPassword(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Reflect.ownKeys(body).some(key => key !== 'lockPassword')) throw badRequest();
  const password = (body as { lockPassword?: unknown }).lockPassword;
  if (password !== undefined && (typeof password !== 'string' || password.length > 1024)) throw badRequest();
  return password;
}
/** Transient passwords only: this does not grant network membership or worker authority. */
export function migrationPeerLockPasswords(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Reflect.ownKeys(value).length > 1000) throw badRequest();
  const result: Record<string, string> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(key)) throw badRequest();
    const password = (value as Record<string, unknown>)[key];
    if (typeof password !== 'string' || password.length > 1024) throw badRequest();
    result[key] = password;
  }
  return result;
}
export function migrationStartRequest(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Reflect.ownKeys(body).some(key => key !== 'lockPassword' && key !== 'lockPasswords')) throw badRequest();
  const request = body as { lockPassword?: unknown; lockPasswords?: unknown };
  return { lockPassword: migrationLockPassword({ lockPassword: request.lockPassword }),
    lockPasswords: migrationPeerLockPasswords(request.lockPasswords) };
}
let singleton: WorkerIncusMigrationService | undefined;
export function useWorkerIncusMigrationService() { return singleton ??= new WorkerIncusMigrationService(); }
