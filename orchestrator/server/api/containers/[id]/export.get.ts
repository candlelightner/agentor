defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Export a worker',
    description:
      'Legacy synchronous worker export. Streams a bundle containing settings, workspace, and agent data. Root filesystem and attached custom managed-volume capture are independent opt-ins. New clients should use the asynchronous export-jobs endpoint.',
    operationId: 'exportWorker',
    parameters: [
      { name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' },
      { name: 'includeRootfs', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Include a docker-export snapshot of the container filesystem (advanced and potentially slow)' },
      { name: 'includeManagedVolumes', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Include eligible attached custom volumes; detached volumes are excluded and running capture is best-effort' },
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

import { useContainerManager, useLogger } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';
import { requestCancellation } from '../../../utils/request-cancellation';
import { consumeWorkerExport } from '../../../utils/worker-export-consumer';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const mgr = useContainerManager();
  const info = mgr.get(id);
  requireContainerAccess(event, info);

  const q = getQuery(event);
  // Keep this compatibility endpoint, but make the safe/fast workspace-focused
  // bundle the default. Rootfs capture is now an explicit advanced option.
  const includeRootfs = q.includeRootfs === 'true' || q.includeRootfs === '1';
  if (q.includeManagedVolumes !== undefined && q.includeManagedVolumes !== 'true' && q.includeManagedVolumes !== 'false')
    throw createError({ statusCode: 400, statusMessage: 'includeManagedVolumes must be true or false' });
  const includeManagedVolumes = q.includeManagedVolumes === 'true';

  // Materialise the bundle before streaming — a bad-state worker throws a 409
  // here (mapped from the manager's statusCode-tagged error) rather than a 500.
  let bundle: Awaited<ReturnType<typeof mgr.exportWorker>>;
  const cancellation = requestCancellation(event);
  try {
    bundle = await mgr.exportWorker(id, {
      includeRootfs,
      includeManagedVolumes,
      signal: cancellation.signal,
    });
  } catch (err) {
    cancellation.detach();
    rethrowAsHttpError(err);
  }

  const abortStream = () => bundle.stream.destroy();
  cancellation.signal.addEventListener('abort', abortStream, { once: true });
  try {
    return await consumeWorkerExport(bundle, () => {
      // A disconnect can race with export preparation returning its stream.
      cancellation.signal.throwIfAborted();
      setResponseHeaders(event, {
        'Content-Type': 'application/x-tar',
        'Content-Disposition': `attachment; filename="${bundle.filename}"`,
        'Transfer-Encoding': 'chunked',
      });
      // The consumer's Node pipeline covers premature close and actual output
      // destruction; H3 sendStream only observes source end/error.
      return event.node.res;
    }, cancellation.signal);
  } catch (error) {
    // Bytes already delivered cannot be recalled or relabelled as an HTTP
    // failure. Retain accurate server-side accounting without logging secrets.
    useLogger().error('[export] legacy worker export transfer or cleanup failed');
    throw error;
  } finally {
    cancellation.signal.removeEventListener('abort', abortStream);
    cancellation.detach();
  }
});
