defineRouteMeta({ openAPI: { tags: ['Managed networks'], summary: 'Create a managed bridge network', description: 'Serializes group reference creation with worker-group mutation and reconciles actual Docker membership.', operationId: 'createManagedNetwork', responses: { 201: { description: 'Created and reconciled' }, 400: { description: 'Invalid scope or group' }, 409: { description: 'Docker reconciliation failed' }, 423: { description: 'A selected or group member worker is protected' } } } });
import { requireAuth } from '../../utils/auth-helpers';
import { useManagedNetworkStore, useWorkerGroupStore, useWorkerStore } from '../../utils/services';
import { useManagedNetworkManager } from '../../utils/managed-network-manager';
import { verifyWorkerMutationUnlocks } from '../../utils/worker-protection-lock';
import { withWorkerNetworkMutation } from '../../utils/worker-group-manager';
export default defineEventHandler(async event => {
  const { user } = requireAuth(event); const body: any = await readBody(event);
  return withWorkerNetworkMutation(user.id, async () => {
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 100 || !['all', 'selected', 'group'].includes(body.scope)) throw createError({ statusCode: 400, statusMessage: 'Valid name and scope are required' });
  if (body.scope === 'group' && (typeof body.groupId !== 'string' || !useWorkerGroupStore().get(user.id, body.groupId))) throw createError({ statusCode: 400, statusMessage: 'Group not found' });
  if(body.scope==='selected'){if(!Array.isArray(body.workerIds)||body.workerIds.some((id:any)=>typeof id!=='string'||!useWorkerStore().get(user.id,id)))throw createError({statusCode:400,statusMessage:'Selected workers must belong to the network owner'});}
  const affected = body.scope === 'selected' ? body.workerIds || [] : body.scope === 'group' ? useWorkerGroupStore().get(user.id, body.groupId)?.workerIds || [] : useWorkerStore().listForUser(user.id).map(worker=>worker.id);
  await verifyWorkerMutationUnlocks(affected, body.lockPasswords);
  const store = useManagedNetworkStore(); let network = await store.create(user.id, body.name, body.scope, body.scope === 'group' ? body.groupId : undefined); if(body.scope==='selected')network=await store.update(user.id,network.id,{workerIds:body.workerIds});
  try {
    const reconciliation = await useManagedNetworkManager().reconcile(network);
    if (reconciliation.partialFailures.length) throw new Error(reconciliation.partialFailures.join('; '));
    setResponseStatus(event, 201); return { ...network, reconciliation };
  } catch (error: any) {
    await useManagedNetworkManager().remove(network).catch(() => {}); await store.remove(user.id, network.id).catch(() => {});
    throw createError({ statusCode: 409, statusMessage: `Network creation failed: ${error?.message || 'Docker reconciliation failed'}` });
  }
  });
});
