import { expect, test } from '@playwright/test';
import { capturedWorkerImageInventory, isRuntimeSnapshotImage, missingCapturedWorkerImages, runtimeSnapshotEnvironment } from '../../orchestrator/server/utils/worker-runtime-snapshot';
import { ContainerManager } from '../../orchestrator/server/utils/container';

test('snapshot defaults cannot resurrect removed account tokens, local variables or secret handshakes', () => {
  const sanitized = runtimeSnapshotEnvironment(['PATH=/custom/bin', 'DEFAULT=baked'], [
    'PATH=/custom/bin', 'DEFAULT=account-override', 'ARBITRARY_TOKEN=old-token',
    'WORKER_LOCAL_ENV={"REMOVED":"old"}', 'WORKER_SECRET_HANDSHAKE=1',
  ]);
  expect(sanitized).toEqual(['PATH=/custom/bin', 'DEFAULT=baked', 'ARBITRARY_TOKEN=', 'WORKER_LOCAL_ENV=', 'WORKER_SECRET_HANDSHAKE=']);
  expect(sanitized.join('\n')).not.toMatch(/old-token|account-override|REMOVED/);
});

test('migration snapshots retain their image configuration while raw imports use the standard contract', async () => {
  const snapshot = 'agentor-import-worker-1:runtime-operation-1';
  const calls: string[] = [];
  const manager = { config: { workerImagePrefix: '', workerImage: 'standard' }, dockerService: {
    imageExists: async () => true,
    ensureImage: async (name: string) => { calls.push(name); },
    inspectImageConfig: async () => ({ Entrypoint: ['standard-entrypoint'] }),
  } };
  const resolve = (ContainerManager.prototype as any).resolveImageOpts.bind(manager);
  expect(await resolve(snapshot)).toEqual({ image: snapshot });
  expect(calls).toEqual([]);
  expect(await resolve('agentor-import-worker-2')).toEqual({ image: 'agentor-import-worker-2', imageConfig: { Entrypoint: ['standard-entrypoint'] } });
  expect(calls).toEqual(['standard']);
  manager.dockerService.imageExists = async () => false;
  await expect(resolve(snapshot)).rejects.toMatchObject({ code: 'IMPORTED_WORKER_IMAGE_MISSING' });
});

test('instance inventory records exact migration snapshot identity without reading image contents', async () => {
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const imageId = `sha256:${'a'.repeat(64)}`;
  const reads: string[] = [];
  const docker = { getImage: (name: string) => ({ inspect: async () => { reads.push(name); return { Id: imageId }; } }) } as any;
  const inventory = await capturedWorkerImageInventory(docker, [
    { id: 'worker-1', importedImage: reference }, { id: 'worker-2' }, { id: 'worker-3', importedImage: 'agentor-import-worker-3' },
  ] as any);
  expect(inventory).toEqual([{ workerId: 'worker-1', reference, imageId }]);
  expect(reads).toEqual([reference]);
  expect(isRuntimeSnapshotImage('agentor-import-worker-3')).toBe(false);
  expect(isRuntimeSnapshotImage('registry/image:runtime-x')).toBe(false);
});

test('destination requires exact loaded snapshot identity, not merely a matching tag', async () => {
  const expected = [{ workerId: 'worker-1', reference: 'agentor-import-worker-1:runtime-operation-1', imageId: `sha256:${'a'.repeat(64)}` }];
  let observed = `sha256:${'b'.repeat(64)}`;
  let failure: number | undefined;
  const docker = { getImage: () => ({ inspect: async () => {
    if (failure) throw Object.assign(new Error('inspection failed'), { statusCode: failure });
    return { Id: observed };
  } }) } as any;
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([expected[0]!.reference]);
  failure = 404;
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([expected[0]!.reference]);
  failure = 503;
  await expect(missingCapturedWorkerImages(docker, expected)).rejects.toMatchObject({ statusCode: 503 });
  failure = undefined; observed = expected[0]!.imageId;
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([]);
});
