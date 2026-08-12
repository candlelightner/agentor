defineRouteMeta({ openAPI: { tags: ['Managed networks'], summary: 'Create a managed bridge network', operationId: 'createManagedNetwork', responses: { 201: { description: 'Created and reconciled' }, 400: { description: 'Invalid scope or group' }, 409: { description: 'Docker reconciliation failed' } } } });
import { requireAuth } from '../../utils/auth-helpers';
import { useManagedNetworkStore, useWorkerGroupStore } from '../../utils/services';
import { useManagedNetworkManager } from '../../utils/managed-network-manager';
export default defineEventHandler(async event => {
  const { user } = requireAuth(event); const body: any = await readBody(event);
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 100 || !['all', 'selected', 'group'].includes(body.scope)) throw createError({ statusCode: 400, statusMessage: 'Valid name and scope are required' });
  if (body.scope === 'group' && (typeof body.groupId !== 'string' || !useWorkerGroupStore().get(user.id, body.groupId))) throw createError({ statusCode: 400, statusMessage: 'Group not found' });
  const store = useManagedNetworkStore(); const network = await store.create(user.id, body.name, body.scope, body.scope === 'group' ? body.groupId : undefined);
  try {
    const reconciliation = await useManagedNetworkManager().reconcile(network);
    if (reconciliation.partialFailures.length) throw new Error(reconciliation.partialFailures.join('; '));
    setResponseStatus(event, 201); return { ...network, reconciliation };
  } catch (error: any) {
    await useManagedNetworkManager().remove(network).catch(() => {}); await store.remove(user.id, network.id).catch(() => {});
    throw createError({ statusCode: 409, statusMessage: `Network creation failed: ${error?.message || 'Docker reconciliation failed'}` });
  }
});
