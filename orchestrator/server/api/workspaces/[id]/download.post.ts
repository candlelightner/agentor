defineRouteMeta({ openAPI: {
  tags: ['Workspaces'], summary: 'Download offline workspace files', operationId: 'downloadOfflineWorkspaceFiles',
  description: 'Streams a regular file directly or multiple/files directories as ZIP. Helpers and source streams are destroyed when the response closes.',
  parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
  requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { paths: { type: 'array', maxItems: 100, items: { type: 'string' } } }, required: ['paths'] } } } },
  responses: { 200: { description: 'Raw file or ZIP stream' }, 400: { description: 'Invalid/escaping/symlink path' }, 401: { description: 'Unauthorized' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' }, 413: { description: 'Too many paths' } },
} });

import { resolveOfflineWorkspace } from '../../../utils/workspace-api-access';
import { requestCancellation } from '../../../utils/request-cancellation';
export default defineEventHandler(async (event) => {
  // Authorization and workspace resolution intentionally precede body parsing.
  const { access } = await resolveOfflineWorkspace(event);
  const body = await readBody<{ paths?: unknown }>(event);
  const cancellation = requestCancellation(event);
  let result: Awaited<ReturnType<typeof access.download>>;
  try {
    result = await access.download(body?.paths, cancellation.signal);
  } catch (error) {
    cancellation.detach();
    throw error;
  }
  const abortStream = () => result.stream.destroy();
  cancellation.signal.addEventListener('abort', abortStream, { once: true });
  result.stream.once('close', () => {
    cancellation.signal.removeEventListener('abort', abortStream);
    cancellation.detach();
  });
  if (result.kind === 'file') {
    const name = (result.entry!.name || 'download').replace(/[^a-zA-Z0-9._-]/g, '_');
    setResponseHeaders(event, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': String(result.entry!.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  } else {
    setResponseHeaders(event, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="workspace-download.zip"', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  }
  return sendStream(event, result.stream);
});
