defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Upload to workspace',
    description: 'Uploads files to the workspace directory of a running container.',
    operationId: 'uploadToWorkspace',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Container ID' }],
    requestBody: {
      required: true,
      content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, lockPassword: { type: 'string', writeOnly: true } } } } },
    },
    responses: {
      200: { description: 'Upload result', content: { 'application/json': { schema: { $ref: '#/components/schemas/SuccessResponse' } } } },
      404: { description: 'Container not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } },
      423: { description: 'Correct worker lock password required' },
    },
  },
});

import * as tar from 'tar-stream';
import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { useWorkerProtectionLockStore } from '../../../utils/worker-protection-lock';

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();
  requireContainerAccess(event, containerManager.get(id));
  const formData = await readMultipartFormData(event);

  if (!formData || formData.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No files provided' });
  }

  const pack = tar.pack();
  let fileCount = 0;
  let lockPassword: string | undefined;

  for (const part of formData) {
    if (!part.filename && part.name === 'lockPassword') {
      lockPassword = part.data?.toString('utf8') ?? '';
      continue;
    }
    if (!part.filename || !part.data) continue;

    // Sanitize path: strip leading slashes, reject traversal
    const filePath = part.filename.replace(/^\/+/, '');
    if (filePath.includes('..')) {
      throw createError({ statusCode: 400, statusMessage: 'Path traversal not allowed' });
    }

    pack.entry({ name: filePath, size: part.data.length, uid: 1000, gid: 1000 }, part.data);
    fileCount++;
  }

  pack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of pack) {
    chunks.push(chunk as Buffer);
  }
  const tarBuffer = Buffer.concat(chunks);

  await useWorkerProtectionLockStore().verify(id, lockPassword);
  await containerManager.uploadToWorkspace(id, tarBuffer);

  return { uploaded: fileCount };
});
