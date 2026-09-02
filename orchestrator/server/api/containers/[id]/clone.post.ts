defineRouteMeta({ openAPI: {
  tags: ['Containers'], summary: 'Clone a workspace into a new worker', operationId: 'cloneWorkerWorkspace',
  description: 'Creates a new worker with the source settings and workspace. Non-secret worker variables are copied; secret names are reported as missing without values.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  responses: { 201: { description: 'Cloned worker and omitted secret names' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Worker not found' } },
} });

import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useContainerManager, useWorkerStore, useWorkerGroupStore, usePluginDefinitionStore, usePluginInstallationStore, usePluginRuntimeManager } from '../../../utils/services';
import { addWorkerToGroupWithNetworks } from '../../../utils/worker-group-manager';
import { useWorkerConfigStore } from '../../../utils/worker-config-store';
import { restoreWorkerPlugins, snapshotWorkerPlugins } from '../../../utils/plugin-portability';
import { findWorkspaceInventory } from '../../../utils/workspace-inventory';
import { OfflineWorkspaceAccess } from '../../../utils/workspace-access';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const source = useContainerManager().get(id) ?? useWorkerStore().findById(id);
  const { user } = requireContainerAccess(event, source);
  const body = await readBody<{ displayName?: unknown }>(event);
  if (body?.displayName !== undefined && typeof body.displayName !== 'string') throw createError({ statusCode: 400, statusMessage: 'displayName must be a string' });
  const resolved = await useWorkerConfigStore().resolveValues(source!.userId, id);
  const variables = resolved.filter((entry) => entry.kind === 'variable').map(({ key, value }) => ({ key, value }));
  const missingSecrets = resolved.filter((entry) => entry.kind !== 'variable').map((entry) => entry.key);
  const pluginConfiguration = snapshotWorkerPlugins(
    source!.userId,
    id,
    usePluginDefinitionStore(),
    usePluginInstallationStore(),
  );
  const sourceMemberships = useWorkerGroupStore()
    .listForUser(user.id)
    .filter((group) => group.workerIds.includes(source!.id));
  if (sourceMemberships.length > 1)
    throw createError({ statusCode: 409, statusMessage: 'Source worker has conflicting group memberships' });
  const targetWorkerGroupId = sourceMemberships[0]?.id;
  const cloned = await useContainerManager().create({
    userId: user.id,
    displayName: typeof body?.displayName === 'string' ? body.displayName : `${source!.displayName || 'worker'} copy`,
    repos: source!.repos,
    mounts: source!.mounts,
    targetWorkerGroupId,
    environmentId: source!.environmentId,
    initScript: source!.initScript,
    workerConfiguration: { variables },
  });
  try {
    if (targetWorkerGroupId)
      await addWorkerToGroupWithNetworks(user.id, targetWorkerGroupId, cloned.id);
    const item = await findWorkspaceInventory(id, user.role === 'admin');
    if (!item || item.state === 'orphaned') throw new Error('Source workspace not found');
    await new OfflineWorkspaceAccess(item).cloneInto(cloned.containerId);
    const restored = await restoreWorkerPlugins(
      pluginConfiguration,
      user.id,
      cloned.id,
      usePluginDefinitionStore(),
      usePluginInstallationStore(),
    );
    missingSecrets.push(...restored.missingSecretNames);
    await usePluginRuntimeManager().reconcileWorker(user.id, cloned.id, cloned.containerId);
  } catch (err) {
    await useContainerManager().remove(cloned.id).catch(() => {});
    throw err;
  }
  setResponseStatus(event, 201);
  return { ...cloned, missingSecrets: [...new Set(missingSecrets)].sort() };
});
