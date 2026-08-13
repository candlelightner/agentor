defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Delete workspace files',
    description:
      'Deletes one or more files/directories/symlinks inside a running worker\'s `/workspace`. Paths are relative to the workspace root. The workspace root itself is never deletable. Missing paths are ignored (idempotent). Escaping symlinks or parent-traversal paths are rejected before any deletion.',
    operationId: 'deleteWorkspaceFiles',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/DeleteFilesRequest' },
        },
      },
    },
    responses: {
      200: { description: 'Deletion result', content: { 'application/json': { schema: { $ref: '#/components/schemas/DeleteFilesResult' } } } },
      400: { description: 'Invalid paths (traversal/escaping symlink/root)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker not running, or a deletion failed' },
      423: { description: 'Correct worker lock password required' },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const body = await readBody(event);
  try {
    await useWorkerProtectionLockStore().verify(id, body?.lockPassword);
    return await cm.deleteFiles(id, Array.isArray(body?.paths) ? body.paths : []);
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
