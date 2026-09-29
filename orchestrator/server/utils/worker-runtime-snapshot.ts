import type Docker from 'dockerode';
import type { Readable } from 'node:stream';
import type { WorkerRecord } from './worker-store';
import { withOperationDeadline } from './operation-deadline';
import { readImageProof, type PortableImageIdentity } from './worker-runtime-image-proof';

const IMAGE_READ_TIMEOUT_MS = 8_000;
const IMAGE_PROOF_TIMEOUT_MS = 10 * 60_000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;

function safeImageError(error: unknown, operation: string): Error {
  const code = (error as { code?: string })?.code;
  if (code === 'OPERATION_ABORTED' || code === 'DOCKER_OPERATION_TIMEOUT') return error as Error;
  const statusCode = (error as { statusCode?: unknown })?.statusCode;
  return Object.assign(new Error(`Runtime snapshot image ${operation} failed`),
    typeof statusCode === 'number' && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {});
}

/** Only runtime migration mints this tag. Portable docker-import images use
 * the untagged form and still require the standard image's runtime config. */
export function isRuntimeSnapshotImage(reference: string): boolean {
  return /^agentor-import-[a-zA-Z0-9_-]+:runtime-[a-zA-Z0-9_-]+$/.test(reference);
}

/** Docker commit merges supplied Env with container Env. Absent keys would
 * therefore retain old account tokens and bootstrap flags. Restore image-baked
 * defaults and explicitly blank every runtime-only key; fresh create options
 * supply the current account/worker configuration on each recreation. */
export function runtimeSnapshotEnvironment(baked: string[] = [], runtime: string[] = []): string[] {
  const values = new Map(baked.map((entry) => [entry.split('=', 1)[0]!, entry]));
  for (const entry of runtime) {
    const key = entry.split('=', 1)[0]!;
    if (!values.has(key)) values.set(key, `${key}=`);
  }
  return [...values.values()];
}

export interface CapturedWorkerImage {
  workerId: string;
  reference: string;
  imageId: string;
  /** Exported image-config digest and platform survive Docker storage-driver
   * changes that may assign a different value to ImageInspect.Id. */
  portableIdentity?: PortableImageIdentity;
}

function imagePlatform(inspected: Docker.ImageInspectInfo): PortableImageIdentity['platform'] {
  if (typeof inspected.Os !== 'string' || !inspected.Os ||
      typeof inspected.Architecture !== 'string' || !inspected.Architecture)
    throw new Error('Runtime snapshot image platform is unavailable');
  return {
    os: inspected.Os,
    architecture: inspected.Architecture,
    ...(typeof inspected.Variant === 'string' && inspected.Variant ? { variant: inspected.Variant } : {}),
  };
}

async function inspectImage(docker: Docker, reference: string, signal?: AbortSignal): Promise<Docker.ImageInspectInfo> {
  try {
    return await withOperationDeadline(
      (operationSignal) => new Promise<Docker.ImageInspectInfo>((resolve, reject) => {
        // Image.inspect() passes abortSignal only as a query option in the
        // installed dockerode, so use the underlying modem request directly.
        docker.getImage(reference).modem.dial({
          path: `/images/${reference}/json`,
          method: 'GET',
          abortSignal: operationSignal,
          statusCodes: { 200: true, 404: 'no such image', 500: 'server error' },
        }, (error: Error | null, image?: Docker.ImageInspectInfo) => {
          if (error) reject(error);
          else if (image) resolve(image);
          else reject(new Error('Runtime snapshot image inspection returned no image'));
        });
      }),
      IMAGE_READ_TIMEOUT_MS,
      'Runtime snapshot image inspection',
      signal,
    );
  } catch (error) {
    throw safeImageError(error, 'inspection');
  }
}

/** Dockerode Image.get() accepts no options, so it cannot cancel its request.
 * Use its configured modem with an explicit abort signal and discard a stream
 * even when it arrives after the caller has already timed out. */
async function openImageExport(docker: Docker, imageId: string, signal: AbortSignal, parentSignal?: AbortSignal): Promise<Readable> {
  return new Promise<Readable>((resolve, reject) => {
    const image = docker.getImage(imageId);
    let settled = false;
    let received: Readable | undefined;
    const detach = () => {
      signal.removeEventListener('abort', onAbort);
      parentSignal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      received?.destroy();
      detach();
      if (!settled) {
        settled = true;
        reject(new Error('Runtime snapshot image export was cancelled'));
      }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    parentSignal?.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || parentSignal?.aborted) {
      onAbort();
      return;
    }
    try {
      image.modem.dial({
        path: `/images/${imageId}/get`,
        method: 'GET',
        isStream: true,
        abortSignal: signal,
        statusCodes: { 200: true, 404: 'no such image', 500: 'server error' },
      }, (error: Error | null, stream?: Readable) => {
        if (settled || signal.aborted || parentSignal?.aborted) {
          stream?.destroy();
          detach();
          return;
        }
        settled = true;
        if (error) { detach(); reject(error); }
        else if (stream) {
          received = stream;
          stream.once('close', detach);
          stream.once('end', detach);
          resolve(stream);
        } else { detach(); reject(new Error('Runtime snapshot image export returned no stream')); }
      });
    } catch (error) {
      detach();
      if (!settled) reject(error);
    }
  });
}

async function proveImage(docker: Docker, imageId: string, platform: PortableImageIdentity['platform'], signal?: AbortSignal): Promise<PortableImageIdentity> {
  if (!IMAGE_ID.test(imageId)) throw new Error('Runtime snapshot image identity is unavailable');
  let stream: Readable | undefined;
  try {
    stream = await withOperationDeadline(
      (operationSignal) => openImageExport(docker, imageId, operationSignal, signal),
      IMAGE_READ_TIMEOUT_MS,
      'Runtime snapshot image export setup',
      signal,
    );
    const source = stream;
    return await withOperationDeadline(
      (operationSignal) => {
        operationSignal.addEventListener('abort', () => source.destroy(), { once: true });
        return readImageProof(source, imageId, platform, { signal: operationSignal });
      },
      IMAGE_PROOF_TIMEOUT_MS,
      'Runtime snapshot image proof',
      signal,
    );
  } catch (error) {
    throw safeImageError(error, 'proof');
  } finally {
    stream?.destroy();
  }
}

/** DATA_DIR and volume archives do not contain these local image layers.
 * Capture the pinned local ID and a portable config/platform proof so restore
 * can require an operator-transferred docker-save archive across stores. */
export async function capturedWorkerImageInventory(docker: Docker, workers: WorkerRecord[], signal?: AbortSignal): Promise<CapturedWorkerImage[]> {
  const result: CapturedWorkerImage[] = [];
  const proven = new Map<string, PortableImageIdentity>();
  for (const worker of workers) {
    signal?.throwIfAborted();
    if (!worker.importedImage || !isRuntimeSnapshotImage(worker.importedImage)) continue;
    const image = await inspectImage(docker, worker.importedImage, signal);
    if (!IMAGE_ID.test(image.Id)) throw new Error('Runtime snapshot image identity is unavailable');
    let portableIdentity = proven.get(image.Id);
    if (!portableIdentity) {
      portableIdentity = await proveImage(docker, image.Id, imagePlatform(image), signal);
      proven.set(image.Id, portableIdentity);
    }
    // The export used the immutable ID. A tag repointed while it streamed is
    // still an inconsistent snapshot and must not enter a backup manifest.
    const after = await inspectImage(docker, worker.importedImage, signal);
    if (after.Id !== image.Id) throw new Error('Runtime snapshot image reference changed during inventory');
    result.push({ workerId: worker.id, reference: worker.importedImage, imageId: image.Id, portableIdentity });
  }
  return result;
}

export async function missingCapturedWorkerImages(docker: Docker, images: CapturedWorkerImage[], signal?: AbortSignal): Promise<string[]> {
  const missing: string[] = [];
  const proven = new Map<string, PortableImageIdentity>();
  for (const image of images) {
    signal?.throwIfAborted();
    try {
      const actual = await inspectImage(docker, image.reference, signal);
      if (!IMAGE_ID.test(actual.Id)) {
        missing.push(image.reference);
        continue;
      }
      if (!image.portableIdentity && actual.Id === image.imageId) continue;
      const platform = imagePlatform(actual);
      let proof = proven.get(actual.Id);
      if (!proof) {
        proof = await proveImage(docker, actual.Id, platform, signal);
        proven.set(actual.Id, proof);
      }
      const after = await inspectImage(docker, image.reference, signal);
      if (after.Id !== actual.Id ||
          (image.portableIdentity
            ? proof.configDigest !== image.portableIdentity.configDigest ||
              proof.platform.os !== image.portableIdentity.platform.os ||
              proof.platform.architecture !== image.portableIdentity.platform.architecture ||
              proof.platform.variant !== image.portableIdentity.platform.variant
            : proof.configDigest !== image.imageId)) missing.push(image.reference);
    } catch (error) {
      if ((error as any)?.statusCode !== 404) throw error;
      missing.push(image.reference);
    }
  }
  return missing;
}
