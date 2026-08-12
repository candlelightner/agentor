defineRouteMeta({ openAPI: { tags: ['Managed networks'], summary: 'Update managed network membership', operationId: 'updateManagedNetwork', responses: { 200: { description: 'Updated reconciliation' }, 400: { description: 'Invalid scope, group, or workers' } } } });
import { requireResourceAccess } from '../../utils/auth-helpers'; import { useManagedNetworkStore, useWorkerGroupStore, useWorkerStore } from '../../utils/services'; import { useManagedNetworkManager } from '../../utils/managed-network-manager'; import { verifyWorkerMutationUnlocks } from '../../utils/worker-protection-lock';
export default defineEventHandler(async event => { const id = getRouterParam(event, 'id')!, store = useManagedNetworkStore(), network = store.findById(id); requireResourceAccess(event, network, { allowGlobal: false }); const body: any = await readBody(event); const scope = body?.scope === undefined ? network!.scope : body.scope;
  if (!['all', 'selected', 'group'].includes(scope)) throw createError({ statusCode: 400, statusMessage: 'Invalid managed network scope' });
  if (body?.groupId !== undefined && typeof body.groupId !== 'string') throw createError({ statusCode: 400, statusMessage: 'groupId must be a string' });
  const groupId = scope === 'group' ? (body?.groupId ?? network!.groupId) : undefined;
  if (scope === 'group' && (!groupId || !useWorkerGroupStore().get(network!.userId, groupId))) throw createError({ statusCode: 400, statusMessage: 'Group not found' });
  if (body?.workerIds !== undefined) { if (!Array.isArray(body.workerIds)) throw createError({ statusCode: 400, statusMessage: 'workerIds must be an array' }); for (const workerId of body.workerIds) if (typeof workerId !== 'string' || !useWorkerStore().get(network!.userId, workerId)) throw createError({ statusCode: 400, statusMessage: 'Workers must belong to network owner' }); }
  if (body?.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100)) throw createError({ statusCode: 400, statusMessage: 'Valid name required' });
  const affected=(value:any)=>value.scope==='selected'?(value.workerIds||[]):value.scope==='group'?(useWorkerGroupStore().get(value.userId,value.groupId)?.workerIds||[]):useWorkerStore().listForUser(value.userId).map(worker=>worker.id);
  const proposed={...network,scope,groupId,workerIds:scope==='selected'?(body?.workerIds??network!.workerIds):[]};
  await verifyWorkerMutationUnlocks([...affected(network),...affected(proposed)],body?.lockPasswords);
  const updated = await store.update(network!.userId, id, { name: body?.name, scope, groupId, workerIds: scope === 'selected' ? body?.workerIds : [] }); return { ...updated, reconciliation: await useManagedNetworkManager().reconcile(updated) };
});
