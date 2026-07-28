defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Create workspace directory',
    description:
      'Creates a directory (and any missing parents) inside a running worker\'s `/workspace`. Idempotent when the directory already exists; returns 409 when a non-directory file already blocks the path. `path` is relative to the workspace root.',
    operationId: 'mkdirWorkspaceFile',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/MkdirRequest' } } },
    },
    responses: {
      200: { description: 'Directory created (or already existed)', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      400: { description: 'Invalid path (traversal/empty/root)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker not running, or a file blocks the path' },
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
  try {
    return await cm.mkdirFiles(id, body.path);
  } catch (err) {
    rethrowAsHttpError(err);
  }
});