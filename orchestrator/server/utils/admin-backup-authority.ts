import { isDeepStrictEqual } from 'node:util';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { AdminWorkspaceStore, useAdminWorkspaceStore } from './admin-workspace-store';
import { useGroupAdminWorkspaceStore } from './group-admin-workspace-store';
import { administrativeRuntimeOwner, validateAdminNativeState, type AdminNativeAcknowledge } from './admin-native-identity';
import { useConfig } from './services';
import { WorkerGroupStore } from './worker-group-store';
import { isPlatformAdminUser } from './auth';

const denied = () => Object.assign(new Error('Workspace not found'), { statusCode: 404 });
/** Runtime namespaces confer no account access. Recheck the authoritative
 * account role, dedicated identity and current group ownership on every use. */
export function assertAdministrativeBackupPrincipal(userId: string, record: Readonly<AdministrativeWorkspaceRecord>, platformAdmin: boolean) {
  const owner = administrativeRuntimeOwner(record);
  if (owner.groupId ? owner.userId !== userId : !platformAdmin || record.ownerId && record.ownerId !== userId) throw denied();
}
export async function administrativeBackupRecords(userId: string) {
  const global = new AdminWorkspaceStore(useConfig().dataDir), groups = new WorkerGroupStore(useConfig().dataDir);
  await Promise.all([global.init(), groups.init()]);
  groups.listForUser(userId); // Quarantined owner authority cannot become ordinary backup access.
  const records = [global.getRecord(), ...groups.list().filter(group => group.adminWorkspace)
    .map(group => group.adminWorkspace as AdministrativeWorkspaceRecord)]
    .filter((record): record is AdministrativeWorkspaceRecord => Boolean(record));
  if (new Set(records.map(record => record.id)).size !== records.length) throw Object.assign(new Error('Administrative backup identity is ambiguous'), { statusCode: 409 });
  return records;
}
export async function resolveAdministrativeBackup(userId: string, id: string) {
  const record = (await administrativeBackupRecords(userId)).find(record => record.id === id);
  if (!record) return;
  const global = useAdminWorkspaceStore();
  if (record.kind === 'administrative') await global.init();
  const current = record.kind === 'administrative' ? global.getRecord() : useGroupAdminWorkspaceStore().findByWorkspaceId(id);
  // Disk has no representation for own undefined properties. Verify every
  // persisted value, then retain the unchanged live shape for strict guards.
  if (!current || !isDeepStrictEqual(JSON.parse(JSON.stringify(current)), record))
    throw Object.assign(new Error('Administrative persisted and live authority differ'), { statusCode: 409 });
  assertAdministrativeBackupPrincipal(userId, current, current.kind === 'administrative' && isPlatformAdminUser(userId));
  validateAdminNativeState(current);
  if (current.runtimeKind !== 'incus-vm') throw Object.assign(new Error('Migrate the administrative workspace before portable backup'), { statusCode: 409 });
  return current;
}
export async function validateAdministrativeBackup(userId: string, expected: Readonly<AdministrativeWorkspaceRecord>) {
  const current = await resolveAdministrativeBackup(userId, expected.id);
  if (!current || !isDeepStrictEqual(current, expected)) throw Object.assign(new Error('Administrative backup authority changed'), { statusCode: 409 });
}
export async function withAdministrativeBackup<T>(userId: string, expected: Readonly<AdministrativeWorkspaceRecord>,
  operation: (record: AdministrativeWorkspaceRecord, acknowledge: AdminNativeAcknowledge, refreshRunningIdentity: () => Promise<void>) => Promise<T>) {
  const owner = administrativeRuntimeOwner(expected);
  const capture = async (record: AdministrativeWorkspaceRecord, acknowledge: AdminNativeAcknowledge, refreshRunningIdentity: () => Promise<void>) => {
    await validateAdministrativeBackup(userId, expected);
    if (!isDeepStrictEqual(record, expected)) throw denied();
    return operation(record, acknowledge, refreshRunningIdentity);
  };
  return owner.groupId
    ? useGroupAdminWorkspaceStore().withNativeRuntimeTransaction(owner.groupId, capture)
    : useAdminWorkspaceStore().withNativeRuntimeTransaction(capture);
}

/** Keep the short management identity alive while a read-only capture holds
 * its lifecycle fence. No ensure/start/metadata mutation is performed here. */
export async function withAdministrativeBackupIdentity<T>(signal: AbortSignal, validate: () => Promise<void>,
  refresh: () => Promise<void>, capture: (signal: AbortSignal) => Promise<T>, intervalMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(signal.reason);
  if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  let renewal: Promise<void> | undefined, closing = false;
  const renew = () => closing ? Promise.resolve() : renewal ??= (async () => {
    try { controller.signal.throwIfAborted(); await validate(); await refresh(); await validate(); }
    catch (error) { controller.abort(error); }
  })().finally(() => { renewal = undefined; });
  let timer: NodeJS.Timeout | undefined;
  try {
    await renew(); controller.signal.throwIfAborted();
    timer = setInterval(() => { void renew(); }, intervalMs); timer.unref?.();
    const result = await capture(controller.signal); controller.signal.throwIfAborted(); return result;
  } finally {
    closing = true;
    if (timer) clearInterval(timer);
    await renewal; signal.removeEventListener('abort', cancel);
    controller.signal.throwIfAborted();
  }
}
