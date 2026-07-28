defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Download workspace files',
    description:
      'Downloads one or more files/folders from a running worker\'s `/workspace`. When `paths` contains exactly one regular file, the response is the raw file bytes (with a safe Content-Disposition). Otherwise a true ZIP archive is streamed: relative names are preserved, hidden files are included, and symlinks are stored without following external targets. The archive is streamed with backpressure; if the client disconnects early the underlying streams are torn down. Escaping symlinks are rejected.',
    operationId: 'downloadWorkspaceFiles',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/DownloadFilesRequest' } } },
    },
    responses: {
      200: {
        description: 'Raw file bytes (single file) or a ZIP archive (multiple/folder)',
        content: {
          'application/octet-stream': { schema: { type: 'string', format: 'binary' } },
          'application/zip': { schema: { type: 'string', format: 'binary' } },
        },
      },
      400: { description: 'Invalid paths (traversal/escaping symlink)' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker or a selected path not found' },
      409: { description: 'Worker not running' },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';

/** Build a safe Content-Disposition filename from a relative workspace path. */
function safeAttachmentName(rel: string): string {
  const base = rel === '' ? 'workspace' : rel.split('/').pop() || 'download';
  return base.replace(/[^a-zA-Z0-9._-]/g, '_') || 'download';
}

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  const body = await readBody(event);
  if (!body || !Array.isArray(body.paths)) {
    throw createError({ statusCode: 400, statusMessage: 'paths must be an array' });
  }

  let result: Awaited<ReturnType<typeof cm.downloadFiles>>;
  try {
    result = await cm.downloadFiles(id, body.paths);
  } catch (err) {
    rethrowAsHttpError(err);
  }

  if (result.kind === 'file') {
    const name = safeAttachmentName(result.entry.path);
    // If the client disconnects before the file is fully sent, destroy the
    // stream so the Docker tar source is torn down (backpressure cleanup).
    event.node.res.on('close', () => {
      if (!event.node.res.writableEnded) result.stream.destroy();
    });
    // Single file: the size is known from lstat, so set Content-Length and let
    // the HTTP layer frame the body (no chunked encoding) — clients can show
    // progress and resume cleanly. Close cleanup is retained above.
    setResponseHeaders(event, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Content-Length': String(result.entry.size),
    });
    return sendStream(event, result.stream);
  }

  // ZIP stream. Tear down on client close so the Docker tar sources + archiver
  // are aborted rather than buffering the whole archive after disconnect.
  event.node.res.on('close', () => {
    if (!event.node.res.writableEnded) result.stream.destroy();
  });
  setResponseHeaders(event, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="workspace-download.zip"',
  });
  return sendStream(event, result.stream);
});
