defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Rename workspace entry',
    description:
      'Renames a file/directory/symlink inside a running worker\'s `/workspace` to `newName` within the same parent directory. No overwrite: a 409 is returned when the target name already exists. `path` is the existing entry (relative to /workspace); `newName` is the replacement basename.',
    operationId: 'renameWorkspaceFile',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RenameRequest' } } },
    },
    responses: {
      200: { description: 'Renamed', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      400: { description: 'Invalid path or newName' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker or source path not found' },
      409: { description: 'Worker not running, or target name already exists' },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const body = await readBody(event);
  if (!body || typeof body.path !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'path must be a string' });
  }
  if (typeof body.newName !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'newName must be a string' });
  }
  try {
    return await cm.renameFile(id, body.path, body.newName);
  } catch (err) {
    rethrowAsHttpError(err);
  }
});