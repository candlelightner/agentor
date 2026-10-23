defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Emergency stop a worker',
    description: 'Immediately force-stops the existing worker without a graceful shutdown. Requires explicit confirmation and the protection-lock password when protected. Administrative workspaces retain their dedicated authorization. Pending lifecycle or recovery operations must settle before this action is allowed.',
    operationId: 'emergencyStopContainer',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
    requestBody: { required: true, content: { 'application/json': { schema: {
      type: 'object', required: ['confirmed'], properties: {
        confirmed: { type: 'boolean', enum: [true] }, lockPassword: { type: 'string' },
      },
    } } } },
    responses: {
      200: { description: 'Worker stopped' },
      400: { description: 'Explicit confirmation required' },
      403: { description: 'Worker access denied' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker lifecycle or recovery operation pending' },
      423: { description: 'Protection-lock password required' },
      503: { description: 'Runtime unavailable or stopped state cannot be confirmed; refresh status' },
      504: { description: 'Stop deadline exceeded; lifecycle remains fenced until runtime settlement' },
    },
  },
});

import { createError } from 'h3';
import { requireAdmin, requireAuth, requireContainerAccess, requireResourceAccess } from '../../../utils/auth-helpers';
import { useContainerManager, useWorkerGroupStore } from '../../../utils/services';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
import { readAdministrativeRuntimeRecord } from '../../../utils/admin-native-authority';
import { useAdminWorkspaceStore } from '../../../utils/admin-workspace-store';
import { useGroupAdminWorkspaceStore, type GroupAdministrativeWorkspaceRecord } from '../../../utils/group-admin-workspace-store';
import { isWorkerLifecycleMutationPending } from '../../../utils/worker-lifecycle-coordinator';
import { rethrowAsHttpError } from '../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  try {
    requireAuth(event);
    const id = getRouterParam(event, 'id')!;
    const cm = useContainerManager(), worker = cm.get(id);
    let administrative: Awaited<ReturnType<typeof readAdministrativeRuntimeRecord>> | undefined;
    if (!worker || worker.administrativeKind || worker.userId === '__agentor_admin__') {
      administrative = await readAdministrativeRuntimeRecord(id);
      if (administrative.kind === 'administrative') requireAdmin(event);
      else requireResourceAccess(event, useWorkerGroupStore().findById((administrative as GroupAdministrativeWorkspaceRecord).groupId), { allowGlobal: false });
    } else requireContainerAccess(event, worker);
    const body = await readBody<{ confirmed?: unknown; lockPassword?: unknown }>(event);
    if (body?.confirmed !== true)
      throw createError({ statusCode: 400, statusMessage: 'Explicit confirmation is required for emergency stop' });
    await useWorkerProtectionLockStore().verify(id, body.lockPassword);
    if (isWorkerLifecycleMutationPending(id))
      throw createError({ statusCode: 409, statusMessage: 'Worker lifecycle operation is still pending; refresh status before retrying emergency stop' });
    if (administrative?.kind === 'administrative') await useAdminWorkspaceStore().setStatus('stopped', true, id);
    else if (administrative) {
      const groupId = (administrative as GroupAdministrativeWorkspaceRecord).groupId;
      await useGroupAdminWorkspaceStore().setStatus(groupId, 'stopped', () => {
        requireResourceAccess(event, useWorkerGroupStore().findById(groupId), { allowGlobal: false });
      }, true, id);
    } else await cm.emergencyStop(id);
    return { ok: true };
  } catch (error) { rethrowAsHttpError(error); }
});
