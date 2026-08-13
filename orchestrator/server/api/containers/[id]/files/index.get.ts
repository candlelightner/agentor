defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'List workspace directory',
    description:
      'Returns a one-level directory listing of a path inside a running worker\'s `/workspace`. `path` is relative to the workspace root (defaults to the root). Entries are sorted directories first, then by name. Symlink entries include `linkTarget` (raw) and `linkEscapes` (true when the symlink resolves outside `/workspace`).',
    operationId: 'listWorkspaceFiles',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' },
      { name: 'path', in: 'query', required: false, schema: { type: 'string', default: '' }, description: 'Path relative to /workspace (defaults to the root).' },
    ],
    responses: {
      200: { description: 'Directory listing', content: { 'application/json': { schema: { $ref: '#/components/schemas/FileListing' } } } },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker or path not found' },
      409: { description: 'Worker not running, or path is not a directory' },
    },
    $global: {
      components: {
        schemas: {
          FileEntry: {
            type: 'object',
            description: 'Metadata for one filesystem entry inside /workspace.',
            properties: {
              name: { type: 'string', description: 'Basename (`.` for the workspace root).' },
              path: { type: 'string', description: 'POSIX path relative to /workspace (no leading slash; `` for the root).' },
              type: { type: 'string', enum: ['file', 'directory', 'symlink'] },
              size: { type: 'integer', description: 'Size in bytes (0 for directories and symlinks).' },
              mtime: { type: 'string', format: 'date-time', description: 'ISO 8601 modification time (UTC).' },
              linkTarget: { type: 'string', description: 'Raw symlink target (only for symlinks).' },
              linkEscapes: { type: 'boolean', description: 'True when a symlink resolves outside /workspace.' },
            },
            required: ['name', 'path', 'type', 'size', 'mtime'],
          },
          FileListing: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Listed path relative to /workspace (`` for the root).' },
              entries: { type: 'array', items: { $ref: '#/components/schemas/FileEntry' } },
            },
            required: ['path', 'entries'],
          },
          MkdirRequest: {
            type: 'object',
            properties: { path: { type: 'string', description: 'Directory to create, relative to /workspace.' }, lockPassword: { type: 'string', writeOnly: true } },
            required: ['path'],
          },
          RenameRequest: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Existing entry, relative to /workspace.' },
              newName: { type: 'string', description: 'Replacement basename within the same parent.' },
              lockPassword: { type: 'string', writeOnly: true },
            },
            required: ['path', 'newName'],
          },
          MoveRequest: {
            type: 'object',
            properties: {
              paths: { type: 'array', items: { type: 'string' }, description: 'Source entries to move, relative to /workspace.' },
              destination: { type: 'string', description: 'Existing destination directory, relative to /workspace.' },
              overwrite: { type: 'boolean', default: false },
              lockPassword: { type: 'string', writeOnly: true },
            },
            required: ['paths', 'destination'],
          },
          MoveConflict: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              target: { type: 'string' },
            },
            required: ['source', 'target'],
          },
          MoveConflictResponse: {
            type: 'object',
            properties: { conflicts: { type: 'array', items: { $ref: '#/components/schemas/MoveConflict' } } },
            required: ['conflicts'],
          },
          MoveResult: {
            type: 'object',
            properties: { moved: { type: 'integer' } },
            required: ['moved'],
          },
          DeleteFilesRequest: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } }, lockPassword: { type: 'string', writeOnly: true } },
            required: ['paths'],
          },
          DeleteFilesResult: {
            type: 'object',
            properties: { deleted: { type: 'integer', description: 'Number of paths that existed and were removed.' } },
            required: ['deleted'],
          },
          DownloadFilesRequest: {
            type: 'object',
            properties: { paths: { type: 'array', items: { type: 'string' } } },
            required: ['paths'],
          },
          UploadFilesResult: {
            type: 'object',
            properties: { uploaded: { type: 'integer', description: 'Number of tar entries written.' } },
            required: ['uploaded'],
          },
        },
      },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const q = getQuery(event);
  const path = typeof q.path === 'string' ? q.path : '';
  try {
    return await cm.listFiles(id, path);
  } catch (err) {
    rethrowAsHttpError(err);
  }
});
