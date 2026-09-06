defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Download workspace',
    description: 'Downloads the workspace directory as a .tar.gz archive.',
    operationId: 'downloadWorkspace',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' }],
    responses: {
      200: { description: 'Workspace archive', content: { 'application/gzip': { schema: { type: 'string', format: 'binary' } } } },
      404: { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
    },
  },
});

import { createGzip } from 'node:zlib';
import type { Readable } from 'node:stream';
import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { requestCancellation } from '../../../utils/request-cancellation';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();

  const info = containerManager.get(id);
  requireContainerAccess(event, info);
  if (!info) {
    throw createError({ statusCode: 404, statusMessage: 'Container not found' });
  }

  const safeName = (info.displayName || id.slice(0, 12)).replace(/[^a-zA-Z0-9_-]/g, '_');
  const cancellation = requestCancellation(event);
  let tarStream: Awaited<ReturnType<typeof containerManager.downloadWorkspace>>;
  try {
    tarStream = await containerManager.downloadWorkspace(
      id,
      cancellation.signal,
    );
  } catch (error) {
    cancellation.detach();
    throw error;
  }
  const source = tarStream as Readable;
  const gzip = createGzip();
  const abortStreams = () => {
    source.destroy();
    gzip.destroy();
  };
  const forwardSourceError = (error: Error) => gzip.destroy(error);
  source.once('error', forwardSourceError);
  source.once('close', () => source.off('error', forwardSourceError));
  cancellation.signal.addEventListener('abort', abortStreams, { once: true });
  gzip.once('close', () => {
    cancellation.signal.removeEventListener('abort', abortStreams);
    source.destroy();
    cancellation.detach();
  });
  // AbortSignal does not replay an abort that occurred while the Docker
  // archive setup promise was settling.
  if (cancellation.signal.aborted) abortStreams();

  setResponseHeaders(event, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': `attachment; filename="${safeName}-workspace.tar.gz"`,
    'Transfer-Encoding': 'chunked',
  });

  return sendStream(event, source.pipe(gzip));
});
