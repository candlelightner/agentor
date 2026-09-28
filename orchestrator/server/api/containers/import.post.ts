defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Import a worker',
    description:
      'Restores a worker from an export bundle as a brand-new worker (fresh UUID). The request body is the raw `.tar` bundle produced by the export endpoint (Content-Type `application/x-tar`). Recreates the environment, restores the workspace + agent-data volumes, imports any captured filesystem into a per-worker image, and recreates port/domain mappings (skipping conflicts). Pass `?displayName=` to override the restored worker\'s label.',
    operationId: 'importWorker',
    parameters: [
      { name: 'runtimeProfile', in: 'query', required: false, schema: { type: 'string', enum: ['kata-qemu', 'legacy-runc'] }, description: 'Destination selection, independent of bundle metadata. Legacy requires current platform administrator authority.' },
      { name: 'acknowledgeHostPrivilege', in: 'query', required: false, schema: { type: 'string', enum: ['true'] }, description: 'Required for explicit legacy restore.' },
      { name: 'displayName', in: 'query', required: false, schema: { type: 'string' }, description: 'Display name for the restored worker' },
    ],
    requestBody: {
      required: true,
      content: { 'application/x-tar': { schema: { type: 'string', format: 'binary' } } },
    },
    responses: {
      201: { description: 'Imported worker', content: { 'application/json': { schema: { $ref: '#/components/schemas/ContainerInfo' } } } },
      400: { description: 'Invalid bundle' },
      401: { description: 'Unauthorized' },
      409: { description: 'Another import is already active for this user' },
      413: { description: 'Import bundle exceeds the upload or expanded archive limit' },
      507: { description: 'Insufficient temporary storage' },
    },
  },
});

import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, statfs } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { useContainerManager, useConfig } from '../../utils/services';
import { requireAuth } from '../../utils/auth-helpers';
import { isPlatformAdminUser } from '../../utils/auth';
import { authorizeRuntimeSelection } from '../../utils/worker-runtime-admin';

const MAX_IMPORT_UPLOAD_BYTES = 40 * 1024 * 1024 * 1024;
const MIN_IMPORT_FREE_BYTES = 512 * 1024 * 1024;
const activeImports = new Set<string>();

export default defineEventHandler(async (event) => {
  const { user } = requireAuth(event);
  const q = getQuery(event);
  const displayName = typeof q.displayName === 'string' ? q.displayName : undefined;
  const runtimeActor = { authorize: async () => {
    if (!isPlatformAdminUser(user.id)) throw createError({ statusCode: 403, statusMessage: 'Current platform administrator required for legacy restore' });
  } };
  const runtimeAuthorization = await authorizeRuntimeSelection(runtimeActor, q.runtimeProfile, q.acknowledgeHostPrivilege === 'true');

  if (activeImports.has(user.id)) {
    throw createError({ statusCode: 409, statusMessage: 'An import is already active for this user' });
  }
  const declaredLength = Number(getHeader(event, 'content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_UPLOAD_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'Worker import bundle is too large' });
  }

  const tmpDir = join(useConfig().dataDir, 'tmp', `import-upload-${randomUUID()}`);
  const bundlePath = join(tmpDir, 'bundle.tar');
  activeImports.add(user.id);

  try {
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const fsInfo = await statfs(tmpDir);
    if (fsInfo.bavail * fsInfo.bsize < MIN_IMPORT_FREE_BYTES) {
      throw createError({ statusCode: 507, statusMessage: 'Insufficient temporary storage for import' });
    }
    // Stream the upload straight to disk — bundles can be multi-GB (rootfs).
    let uploaded = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        uploaded += Buffer.byteLength(chunk);
        if (uploaded > MAX_IMPORT_UPLOAD_BYTES) {
          callback(createError({ statusCode: 413, statusMessage: 'Worker import bundle is too large' }));
          return;
        }
        callback(null, chunk);
      },
    });
    await pipeline(event.node.req, limit, createWriteStream(bundlePath, { mode: 0o600 }));
    // Uploads can take a long time; recheck privilege immediately before use.
    if (runtimeAuthorization) await runtimeActor.authorize();
    const info = await useContainerManager().importWorker(user.id, bundlePath, { displayName }, runtimeAuthorization);
    setResponseStatus(event, 201);
    return info;
  } catch (err) {
    const statusCode = Number((err as { statusCode?: unknown })?.statusCode);
    if (statusCode >= 400 && statusCode < 600) throw err;
    const message = err instanceof Error ? err.message : '';
    const safe = /^(Invalid|Unsupported) worker export/.test(message) ? message : 'Worker import failed';
    throw createError({ statusCode: 400, statusMessage: safe });
  } finally {
    activeImports.delete(user.id);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
