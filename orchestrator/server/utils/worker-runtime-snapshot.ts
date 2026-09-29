import type Docker from 'dockerode';
import type { Readable } from 'node:stream';
import type { WorkerRecord } from './worker-store';
import { validRuntimeSnapshotIdentity } from './worker-store';
import type { RuntimeSnapshotIdentity } from '../../shared/types';
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

async function inspectedSourceContainerImage(
  docker: Docker, worker: WorkerRecord, containerPrefix: string, signal?: AbortSignal,
): Promise<string> {
  if (worker.status !== 'active' || worker.runtimeRestoreApprovalRequired ||
      typeof worker.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(worker.id) ||
      typeof worker.importedImage !== 'string' ||
      !worker.importedImage.startsWith(`agentor-import-${worker.id}:runtime-`) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(containerPrefix))
    throw Object.assign(new Error('Runtime snapshot identity needs verified active-container evidence'), {
      statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_MISSING',
    });
  const name = `${containerPrefix}-${worker.id}`;
  let inspected: Docker.ContainerInspectInfo;
  try {
    inspected = await withOperationDeadline(
      (operationSignal) => new Promise<Docker.ContainerInspectInfo>((resolve, reject) => {
        docker.getContainer(name).modem.dial({
          path: `/containers/${name}/json`, method: 'GET', abortSignal: operationSignal,
          statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
        }, (error: Error | null, value?: Docker.ContainerInspectInfo) => {
          if (error) reject(error);
          else if (value) resolve(value);
          else reject(new Error('Runtime snapshot source container inspection returned no container'));
        });
      }), IMAGE_READ_TIMEOUT_MS, 'Runtime snapshot source container inspection', signal,
    );
  } catch (error) {
    const failure = safeImageError(error, 'source container inspection');
    if ((failure as { statusCode?: number }).statusCode === 404)
      throw Object.assign(new Error('Runtime snapshot identity needs verified active-container evidence'), {
        statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_MISSING',
      });
    throw failure;
  }
  const labels = inspected.Config?.Labels ?? {};
  if (inspected.Name !== `/${name}` ||
      typeof inspected.Id !== 'string' || !/^[a-f0-9]{64}$/.test(inspected.Id) ||
      labels['agentor.managed'] !== 'true' || labels['agentor.id'] !== worker.id ||
      (labels['agentor.owner-id'] !== undefined && labels['agentor.owner-id'] !== worker.userId) ||
      (labels['agentor.worker-id'] !== undefined && labels['agentor.worker-id'] !== worker.id) ||
      inspected.Config?.Image !== worker.importedImage ||
      inspected.State?.Running !== false ||
      typeof inspected.Image !== 'string' || !IMAGE_ID.test(inspected.Image))
    throw Object.assign(new Error('Runtime snapshot source container does not match the worker record'), {
      statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_MISSING',
    });
  return inspected.Image;
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
export async function capturedWorkerImageInventory(
  docker: Docker, workers: WorkerRecord[], signal?: AbortSignal, options?: { containerPrefix: string },
): Promise<CapturedWorkerImage[]> {
  const result: CapturedWorkerImage[] = [];
  const proven = new Map<string, PortableImageIdentity>();
  for (const worker of workers) {
    signal?.throwIfAborted();
    if (!worker.importedImage || !isRuntimeSnapshotImage(worker.importedImage)) continue;
    const expected = worker.runtimeSnapshotIdentity ??
      (options?.containerPrefix ? {
        reference: worker.importedImage,
        imageId: await inspectedSourceContainerImage(docker, worker, options.containerPrefix, signal),
      } : undefined);
    if (!expected)
      throw Object.assign(new Error('Runtime snapshot identity is unavailable for backup'), {
        statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_MISSING',
      });
    if (!validRuntimeSnapshotIdentity(expected, worker.importedImage, worker.id))
      throw Object.assign(new Error('Stored runtime snapshot identity is invalid'), {
        statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_INVALID',
      });
    const image = await inspectImage(docker, worker.importedImage, signal);
    if (typeof image.Id !== 'string' || !IMAGE_ID.test(image.Id)) throw new Error('Runtime snapshot image identity is unavailable');
    if (!worker.runtimeSnapshotIdentity && image.Id !== expected.imageId)
      throw Object.assign(new Error('Runtime snapshot tag no longer names the source container image'), {
        statusCode: 409, code: 'RUNTIME_SNAPSHOT_IMAGE_MISMATCH',
      });
    let portableIdentity = proven.get(image.Id);
    if (!portableIdentity) {
      portableIdentity = await proveImage(docker, image.Id, imagePlatform(image), signal);
      proven.set(image.Id, portableIdentity);
    }
    // The export used the immutable ID. A tag repointed while it streamed is
    // still an inconsistent snapshot and must not enter a backup manifest.
    const after = await inspectImage(docker, worker.importedImage, signal);
    if (after.Id !== image.Id) throw new Error('Runtime snapshot image reference changed during inventory');
    if (expected.portableIdentity
      ? portableIdentity.configDigest !== expected.portableIdentity.configDigest ||
        portableIdentity.platform.os !== expected.portableIdentity.platform.os ||
        portableIdentity.platform.architecture !== expected.portableIdentity.platform.architecture ||
        portableIdentity.platform.variant !== expected.portableIdentity.platform.variant
      : image.Id !== expected.imageId && portableIdentity.configDigest !== expected.imageId)
      throw Object.assign(new Error('Runtime snapshot image does not match stored worker identity'), {
        statusCode: 409, code: 'RUNTIME_SNAPSHOT_IMAGE_MISMATCH',
      });
    result.push({ workerId: worker.id, reference: worker.importedImage, imageId: image.Id, portableIdentity });
  }
  return result;
}

async function matchingDestinationImageId(
  docker: Docker,
  expected: RuntimeSnapshotIdentity,
  proven: Map<string, PortableImageIdentity>,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const identity = expected && typeof expected === 'object' ? {
    reference: expected.reference,
    imageId: expected.imageId,
    ...(Object.prototype.hasOwnProperty.call(expected, 'portableIdentity')
      ? { portableIdentity: expected.portableIdentity } : {}),
  } : undefined;
  if (!validRuntimeSnapshotIdentity(identity, identity?.reference))
    throw Object.assign(new Error('Captured runtime snapshot image expectation is invalid'), { statusCode: 409 });
  try {
    const actual = await inspectImage(docker, expected.reference, signal);
    if (typeof actual.Id !== 'string' || !IMAGE_ID.test(actual.Id)) return undefined;
    // Old manifests have no portable identity. Equal Docker IDs remain an
    // exact match; a changed ID needs a verified classic config digest.
    if (!expected.portableIdentity && actual.Id === expected.imageId) return actual.Id;
    let proof = proven.get(actual.Id);
    if (!proof) {
      proof = await proveImage(docker, actual.Id, imagePlatform(actual), signal);
      proven.set(actual.Id, proof);
    }
    const after = await inspectImage(docker, expected.reference, signal);
    if (after.Id !== actual.Id) return undefined;
    if (expected.portableIdentity) {
      if (proof.configDigest !== expected.portableIdentity.configDigest ||
          proof.platform.os !== expected.portableIdentity.platform.os ||
          proof.platform.architecture !== expected.portableIdentity.platform.architecture ||
          proof.platform.variant !== expected.portableIdentity.platform.variant) return undefined;
    } else if (proof.configDigest !== expected.imageId) return undefined;
    return actual.Id;
  } catch (error) {
    if ((error as { statusCode?: number })?.statusCode === 404) return undefined;
    throw error;
  }
}

/** Resolve only the image ID proved at final use. Docker create must consume
 * this returned immutable ID, never the mutable tag checked on entry. */
export async function resolveRuntimeSnapshotImage(docker: Docker, expected: RuntimeSnapshotIdentity, signal?: AbortSignal): Promise<string> {
  if (!validRuntimeSnapshotIdentity(expected, expected?.reference))
    throw Object.assign(new Error('Captured runtime snapshot image expectation is invalid'), {
      statusCode: 409, code: 'RUNTIME_SNAPSHOT_IDENTITY_INVALID',
    });
  const imageId = await matchingDestinationImageId(docker, expected, new Map(), signal);
  if (!imageId)
    throw Object.assign(new Error('Captured runtime snapshot image does not match the restored worker'), {
      statusCode: 409, code: 'RUNTIME_SNAPSHOT_IMAGE_MISMATCH',
    });
  return imageId;
}

export async function missingCapturedWorkerImages(docker: Docker, images: CapturedWorkerImage[], signal?: AbortSignal): Promise<string[]> {
  const missing: string[] = [];
  const proven = new Map<string, PortableImageIdentity>();
  for (const image of images) {
    signal?.throwIfAborted();
    if (!await matchingDestinationImageId(docker, image, proven, signal)) missing.push(image.reference);
  }
  return missing;
}
