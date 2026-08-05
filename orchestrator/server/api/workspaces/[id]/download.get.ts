defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Download offline workspace files in a native browser stream', operationId: 'downloadOfflineWorkspaceFilesGet',
  description: 'Cookie-authenticated GET variant used by browser navigation so the response streams to disk without JavaScript Blob buffering.',
  parameters: [
    { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
    { name: 'path', in: 'query', required: true, style: 'form', explode: true, schema: { type: 'array', maxItems: 100, items: { type: 'string' } } },
  ],
  responses: { 200: { description: 'Raw file or ZIP stream' }, 400: { description: 'Invalid path' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' }, 413: { description: 'Too many paths' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';

export default defineEventHandler(async (event) => {
  const { access } = await resolveOfflineWorkspace(event);
  const raw = getQuery(event).path;
  const paths = Array.isArray(raw) ? raw : [raw];
  const result = await access.download(paths);
  event.node.res.on('close', () => { if (!event.node.res.writableEnded) result.stream.destroy(); });
  if (result.kind === 'file') {
    const name = (result.entry!.name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
    setResponseHeaders(event, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(result.entry!.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  } else {
    setResponseHeaders(event, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="workspace-download.zip"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  }
  return sendStream(event, result.stream);
});
