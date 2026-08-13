defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Upload files to workspace',
    description:
      'Uploads one or more files (and optional relative folder paths) into a destination directory inside a running worker\'s `/workspace`. Multipart form fields: `path` (destination directory, relative to /workspace, defaults to the root), `overwrite` (`"true"`/`"false"`, default false), and one or more `file` parts whose `filename` may carry a relative folder path. The destination must exist and resolve inside /workspace. With `overwrite=false`, conflicting existing paths are reported via 409 before any byte is written. Total request data is capped (100 MiB) and the entry count is capped (1000) — both return 413. Tar entries are written uid/gid 1000.',
    operationId: 'uploadWorkspaceFiles',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: {
        'multipart/form-data': {
          schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Destination directory relative to /workspace (defaults to the root).' },
              overwrite: { type: 'string', enum: ['true', 'false'], default: 'false' },
              lockPassword: { type: 'string', writeOnly: true },
              file: { type: 'array', items: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Upload result', content: { 'application/json': { schema: { $ref: '#/components/schemas/UploadFilesResult' } } } },
      400: { description: 'Invalid paths / no files / traversal' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker or destination not found' },
      409: { description: 'Worker not running, destination not a directory, or overwrite=false conflicts', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      413: { description: 'Upload exceeds the total size or entry cap' },
      423: { description: 'Correct worker lock password required' },
    },
  },
});

import { resolveFilesAccess } from '../../../../utils/files-route-helpers';
import { rethrowAsHttpError } from '../../../../utils/http-errors';
import { normalizeClientPath, MAX_UPLOAD_TOTAL_BYTES } from '../../../../utils/workspace-path';
import { useWorkerProtectionLockStore } from '../../../../utils/worker-protection-lock';

export default defineEventHandler(async (event) => {
  const { cm, id } = resolveFilesAccess(event);
  // Reject oversized fixed-length multipart requests before H3 buffers them.
  // Multipart framing adds limited overhead above the 100 MiB payload cap;
  // chunked requests remain subject to the post-parse cap below.
  const contentLength = Number(getRequestHeader(event, 'content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024) {
    throw createError({ statusCode: 413, statusMessage: 'Upload exceeds the size limit' });
  }
  const formData = await readMultipartFormData(event);

  if (!formData || formData.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No files provided' });
  }

  let destRaw = '';
  let overwrite = false;
  let lockPassword: string | undefined;
  const entries: { rel: string; data: Buffer; isDir?: boolean }[] = [];
  let totalBytes = 0;

  for (const part of formData) {
    if (!part.filename) {
      // Form field: `path` or `overwrite`.
      const name = part.name;
      const value = part.data?.toString('utf8') ?? '';
      if (name === 'path') destRaw = value;
      else if (name === 'overwrite') overwrite = value === 'true' || value === '1';
      else if (name === 'lockPassword') lockPassword = value;
      continue;
    }

    if (!part.data) continue;

    // Sanitise the part's filename to a relative path (reject traversal). This
    // is re-validated in the manager; doing it here keeps the cap math honest.
    const rel = normalizeClientPath(part.filename.replace(/^\/+/, ''), { allowRoot: false });
    totalBytes += part.data.length;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw createError({ statusCode: 413, statusMessage: `Upload exceeds the ${MAX_UPLOAD_TOTAL_BYTES} byte limit` });
    }
    entries.push({ rel, data: part.data });
  }

  try {
    await useWorkerProtectionLockStore().verify(id, lockPassword);
    return await cm.uploadFiles(id, destRaw, entries, overwrite);
  } catch (err: any) {
    // Surface the conflict list on 409 (set by the manager) as the response body.
    if (err?.statusCode === 409 && Array.isArray(err.conflicts)) {
      throw createError({
        statusCode: 409,
        statusMessage: 'Upload conflicts with existing paths',
        data: { conflicts: err.conflicts },
      });
    }
    rethrowAsHttpError(err);
  }
});
