defineRouteMeta({
  openAPI: {
    tags: ['Containers'],
    summary: 'Set worker clipboard',
    description:
      'Sets the X11 CLIPBOARD selection of a running worker from a raw `image/png` or UTF-8 `text/plain` body. ' +
      'Ownership and running state are verified BEFORE the body is read. Image payloads are capped at 16 MiB, ' +
      'text at 1 MiB; empty bodies return 400, oversized bodies 413, unsupported MIME / bad PNG signature / ' +
      'invalid UTF-8 return 415. PNG is validated (signature + IHDR + sane nonzero dimensions). On success ' +
      'returns `{ ok, type, width?, height? }`; the response never includes clipboard contents. Helper failure ' +
      'is mapped precisely by exit code to an HTTP status without echoing data.',
    operationId: 'setContainerClipboard',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Worker UUID' }],
    requestBody: {
      required: true,
      content: {
        'image/png': { schema: { type: 'string', format: 'binary' } },
        'text/plain': { schema: { type: 'string' } },
      },
    },
    responses: {
      200: {
        description: 'Clipboard set',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                type: { type: 'string', enum: ['image/png', 'text/plain'] },
                width: { type: 'integer', description: 'PNG width in pixels (image/png only)' },
                height: { type: 'integer', description: 'PNG height in pixels (image/png only)' },
              },
            },
          },
        },
      },
      400: { description: 'Empty body' },
      401: { description: 'Unauthorized' },
      403: { description: 'Forbidden — not the worker owner' },
      404: { description: 'Worker not found' },
      409: { description: 'Worker not running' },
      413: { description: 'Body exceeds the size cap' },
      415: { description: 'Unsupported MIME type, bad PNG signature/IHDR, or invalid UTF-8' },
      422: { description: 'Clipboard helper could not serve the selection' },
    },
  },
});

import { useContainerManager } from '../../../utils/services';
import { requireContainerAccess } from '../../../utils/auth-helpers';
import { rethrowAsHttpError } from '../../../utils/http-errors';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MiB
const MAX_TEXT_BYTES = 1 * 1024 * 1024;   // 1 MiB

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse the Content-Type into a base media type, ignoring parameters, lower-cased. */
function baseContentType(header: string | undefined): string {
  if (!header) return '';
  return header.split(';')[0]!.trim().toLowerCase();
}

/** Validate a PNG buffer: 8-byte signature, IHDR chunk tag, and sane nonzero
 *  big-endian width/height (offsets 16 and 20). Returns `{ width, height }` or
 *  null when the signature/IHDR/dimensions are invalid. */
function validatePng(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  if (buf.subarray(0, 8).compare(PNG_SIG) !== 0) return null;
  // IHDR chunk tag at offset 12: "IHDR" (0x49 0x48 0x44 0x52)
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) return null;
  return { width, height };
}

/** Read the request body as a Buffer with a hard size cap. Returns 413 (via
 *  thrown createError) when the body exceeds `cap`. Uses the web stream so the
 *  cap is enforced byte-by-byte without relying on a global body-size limit. */
async function readCappedBody(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0], cap: number): Promise<Buffer> {
  const stream = getRequestWebStream(event);
  if (!stream) {
    // Fallback: no web stream (shouldn't happen for a normal POST); read raw.
    const raw = await readRawBody(event, false);
    return raw ?? Buffer.alloc(0);
  }
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw createError({ statusCode: 413, statusMessage: 'Clipboard payload exceeds the size limit' });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')!;
  const containerManager = useContainerManager();

  // Ownership/404/401/403 checks BEFORE the body is read, so an unauthenticated
  // or non-owning caller can never trigger body parsing or worker-side work.
  // `requireContainerAccess` throws 404 for an unknown worker (null) and 403
  // for an owner mismatch; it returns the auth context, so re-fetch the
  // container info to assert the running state (409) before reading the body.
  const containerInfo = containerManager.get(id);
  requireContainerAccess(event, containerInfo);
  if (!containerInfo || containerInfo.status !== 'running') {
    throw createError({ statusCode: 409, statusMessage: 'Worker container is not running' });
  }

  const mime = baseContentType(getRequestHeader(event, 'content-type'));
  if (mime !== 'image/png' && mime !== 'text/plain') {
    throw createError({ statusCode: 415, statusMessage: 'Unsupported clipboard MIME type (image/png or text/plain only)' });
  }

  const cap = mime === 'image/png' ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  const bytes = await readCappedBody(event, cap);

  if (bytes.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Empty clipboard payload' });
  }

  let width: number | undefined;
  let height: number | undefined;

  if (mime === 'image/png') {
    const dims = validatePng(bytes);
    if (!dims) {
      throw createError({ statusCode: 415, statusMessage: 'Invalid PNG: bad signature, IHDR, or dimensions' });
    }
    width = dims.width;
    height = dims.height;
  } else {
    // Strict UTF-8 validation: TextDecoder with fatal:true throws on any
    // invalid byte sequence, surfacing a 415 instead of silently replacing.
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw createError({ statusCode: 415, statusMessage: 'Invalid UTF-8 in text/plain payload' });
    }
  }

  try {
    await containerManager.setClipboard(id, mime, bytes);
  } catch (err: any) {
    rethrowAsHttpError(err);
  }

  return { ok: true, type: mime, ...(width !== undefined ? { width, height } : {}) };
});