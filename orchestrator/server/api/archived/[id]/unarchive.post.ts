defineRouteMeta({
  openAPI: {
    tags: ['Archived Workers'],
    summary: 'Unarchive worker',
    description: 'Restores an archived worker. A legacy worker whose custom image was lost can explicitly select an authorized catalog replacement using imageResolution: { mode: replacement, imageDefinitionId, imageVersion }. The replacement is saved as desired configuration before compute creation; workspace, agent data, Docker data and other settings are preserved. Admins may unarchive any user\'s worker; regular users only their own.',
    operationId: 'unarchiveWorker',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID (internal identity)' },
    ],
    responses: {
      200: { description: 'Restored container info', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContainerInfo' } } } },
      403: { description: 'Not the worker owner', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      404: { description: 'Archived worker not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { useContainerManager, useWorkerStore } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';
import { parseWorkerImportImageResolution } from '../../../utils/worker-import-image-resolution';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  // Resolve the worker globally by id (the admin archived-list returns every
  // user's workers, so an admin must be able to act on any of them) and
  // ownership-check admin-or-owner. The record already knows its owner, so the
  // owning userId is derived from it — no ?userId= query hack.
  const worker = useWorkerStore().findById(id);
  if (!worker || worker.status !== 'archived') {
    throw createError({ statusCode: 404, statusMessage: 'Archived worker not found' });
  }
  requireContainerAccess(event, worker);
  const body = await readBody<any>(event);
  await useWorkerProtectionLockStore().verify(id, body?.lockPassword);
  const imageResolution = parseWorkerImportImageResolution(body?.imageResolution);
  if (imageResolution && imageResolution.mode !== 'replacement')
    throw createError({ statusCode: 400, statusMessage: 'Unarchive supports a catalog replacement; workspace-only recovery is unavailable' });
  return useContainerManager().unarchive(worker.userId, id, imageResolution);
});
