defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Preview an offline workspace file', operationId: 'previewOfflineWorkspaceFile',
  description: 'Returns bounded plain text or magic-byte-validated PNG, JPEG, GIF, or WebP content. Active formats and symlinks are rejected.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'path', in: 'query', required: true, schema: { type: 'string' } }],
  responses: { 200: { description: 'Safe text or image preview' }, 400: { description: 'Invalid/escaping path' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' }, 413: { description: 'Too large' }, 415: { description: 'Unsupported preview type' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';
export default defineEventHandler(async (event) => {
  const { access } = await resolveOfflineWorkspace(event);
  const q = getQuery(event);
  const result = await access.preview(q.path);
  setResponseHeaders(event, { 'Content-Type': result.contentType, 'Content-Length': String(result.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  if (result.kind === 'text') return result.text;
  return sendStream(event, result.stream!);
});
