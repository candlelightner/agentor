defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Move workspace entries',
    description:
      'Moves one or more files/directories/symlinks into an existing destination directory inside a running worker\'s `/workspace`. `paths` are the source entries (relative to /workspace); `destination` is an existing directory (relative to /workspace). With `overwrite` false (default), the full conflict list is returned via 409 before any move. Escaping symlinks or parent-traversal paths are rejected up front.',
    operationId: 'moveWorkspaceFiles',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/MoveRequest' } } },
    },
    responses: {
      200: { description: 'Move result', content: { 'application/json': { schema: { $ref: '#/components/schemas/MoveResult' } } } },
      400: { description: 'Invalid paths (traversal/escaping symlink)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker or a source path not found' },
      409: {
        description: 'Worker not running, destination not a directory, or overwrite=false conflicts',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/MoveConflictResponse' } } },
      },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const body = await readBody(event);
  if (!body || typeof body.destination !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'destination must be a string' });
  }
  try {
    return await cm.moveFiles(
      id,
      Array.isArray(body.paths) ? body.paths : [],
      body.destination,
      body.overwrite === true,
    );
  } catch (err: any) {
    // Surface the conflict list on 409 (set by the manager) as the response body.
    if (err?.statusCode === 409 && Array.isArray(err.conflicts)) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Move conflicts with existing paths',
        data: { conflicts: err.conflicts },
      });
    }
    rethrowAsHttpError(err);
  }
});