defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Export a worker',
    description:
      'Legacy synchronous worker export. Streams a bundle containing settings, workspace, and agent data. Root filesystem capture is opt-in with `?includeRootfs=true`. New clients should use the asynchronous export-jobs endpoint.',
    operationId: 'exportWorker',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' },
      { name: 'includeRootfs', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Include a docker-export snapshot of the container filesystem (advanced and potentially slow)' },
    ],
    responses: {
      200: { description: 'Worker export bundle (tar stream)', content: { 'application/x-tar': { schema: { type: 'string', format: 'binary' } } } },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker not in an exportable state (must be running or stopped)' },
    },
  },
});

import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';
import { requestCancellation } from '../../../utils/request-cancellation';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const mgr = useContainerManager();
  const info = mgr.get(id);
  requireContainerAccess(event, info);

  const q = getQuery(event);
  // Keep this compatibility endpoint, but make the safe/fast workspace-focused
  // bundle the default. Rootfs capture is now an explicit advanced option.
  const includeRootfs = q.includeRootfs === 'true' || q.includeRootfs === '1';

  // Materialise the bundle before streaming — a bad-state worker throws a 409
  // here (mapped from the manager's statusCode-tagged error) rather than a 500.
  let stream: Awaited<ReturnType<typeof mgr.exportWorker>>['stream'];
  let filename: string;
  const cancellation = requestCancellation(event);
  try {
    ({ stream, filename } = await mgr.exportWorker(id, {
      includeRootfs,
      signal: cancellation.signal,
    }));
  } catch (err) {
    cancellation.detach();
    rethrowAsHttpError(err);
  }

  const abortStream = () => stream.destroy();
  cancellation.signal.addEventListener('abort', abortStream, { once: true });
  stream.once('close', () => {
    cancellation.signal.removeEventListener('abort', abortStream);
    cancellation.detach();
  });

  setResponseHeaders(event, {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Transfer-Encoding': 'chunked',
  });
  return sendStream(event, stream);
});
