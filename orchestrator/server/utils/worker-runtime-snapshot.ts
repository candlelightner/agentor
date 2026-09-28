import type Docker from 'dockerode';
import type { WorkerRecord } from './worker-store';
import { withOperationDeadline } from './operation-deadline';

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
}

/** DATA_DIR and volume archives do not contain these local image layers.
 * Capture the exact image identity so destination preflight can require an
 * operator-transferred docker-save archive, not silently rebuild a base image. */
export async function capturedWorkerImageInventory(docker: Docker, workers: WorkerRecord[]): Promise<CapturedWorkerImage[]> {
  const result: CapturedWorkerImage[] = [];
  for (const worker of workers) {
    if (!worker.importedImage || !isRuntimeSnapshotImage(worker.importedImage)) continue;
    const image = await withOperationDeadline((signal) => docker.getImage(worker.importedImage!).inspect({ abortSignal: signal } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }), 8_000, 'Runtime snapshot image inventory');
    if (!/^sha256:[a-f0-9]{64}$/.test(image.Id)) throw new Error('Runtime snapshot image identity is unavailable');
    result.push({ workerId: worker.id, reference: worker.importedImage, imageId: image.Id });
  }
  return result;
}

export async function missingCapturedWorkerImages(docker: Docker, images: CapturedWorkerImage[]): Promise<string[]> {
  const missing: string[] = [];
  for (const image of images) {
    try {
      const actual = await withOperationDeadline((signal) => docker.getImage(image.reference).inspect({ abortSignal: signal } as Docker.ImageInspectOptions & { abortSignal: AbortSignal }), 8_000, 'Runtime snapshot destination inspection');
      if (actual.Id !== image.imageId) missing.push(image.reference);
    } catch (error) {
      if ((error as any)?.statusCode !== 404) throw error;
      missing.push(image.reference);
    }
  }
  return missing;
}
