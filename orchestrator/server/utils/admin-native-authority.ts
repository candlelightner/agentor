export * from './admin-native-identity';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner, validateAdminNativeState } from './admin-native-identity';

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
