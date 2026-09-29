import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { PassThrough, Readable } from 'node:stream';
import { capturedWorkerImageInventory, isRuntimeSnapshotImage, missingCapturedWorkerImages, runtimeSnapshotEnvironment } from '../../orchestrator/server/utils/worker-runtime-snapshot';
import { ContainerManager } from '../../orchestrator/server/utils/container';

const tar = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('tar-stream') as { pack(): any };
const sha = (bytes: Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function savedImage(architecture = 'amd64', oci = false, marker?: string) {
  const config = Buffer.from(JSON.stringify({ os: 'linux', architecture, rootfs: { type: 'layers', diff_ids: [] }, ...(marker ? { marker } : {}) }));
  const configDigest = sha(config);
  const configPath = `blobs/sha256/${configDigest.slice(7)}`;
  const entries: Array<{ name: string; body: Buffer }> = [
    { name: 'manifest.json', body: Buffer.from(JSON.stringify([{ Config: configPath, Layers: [] }])) },
    { name: configPath, body: config },
  ];
  let imageId = configDigest;
  if (oci) {
    const manifest = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: config.length },
      layers: [],
    }));
    const manifestDigest = sha(manifest);
    const index = Buffer.from(JSON.stringify({
      schemaVersion: 2,
      manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: manifestDigest, size: manifest.length,
        platform: { os: 'linux', architecture } }],
    }));
    imageId = sha(index);
    entries.push(
      { name: `blobs/sha256/${manifestDigest.slice(7)}`, body: manifest },
      { name: 'index.json', body: index },
      { name: 'oci-layout', body: Buffer.from('{"imageLayoutVersion":"1.0.0"}') },
    );
  }
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolve, reject) => { pack.on('end', resolve); pack.on('error', reject); });
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: entry.name, type: 'file', size: entry.body.length }, entry.body,
        (error?: Error | null) => error ? reject(error) : resolve());
    });
  }
  pack.finalize();
  await finished;
  return { imageId, configDigest, architecture, archive: Buffer.concat(chunks) };
}

function imageDocker(tags: Map<string, string>, images: Map<string, Awaited<ReturnType<typeof savedImage>>>,
  onExport?: (id: string) => void, failure?: () => number | undefined) {
  const requests: string[] = [];
  return {
    requests,
    getImage: () => ({ modem: { dial: (options: { path: string; abortSignal: AbortSignal }, callback: (error: Error | null, data?: any) => void) => {
      requests.push(options.path);
      const match = /^\/images\/(.+)\/(json|get)$/.exec(options.path);
      if (!match) throw new Error('Unexpected image request');
      const [, name, operation] = match;
      const id = tags.get(name!) ?? name!;
      const image = images.get(id);
      const status = failure?.();
      if (status) return callback(Object.assign(new Error('Docker unavailable'), { statusCode: status }));
      if (!image) return callback(Object.assign(new Error('No image'), { statusCode: 404 }));
      if (operation === 'json') return callback(null, { Id: id, Os: 'linux', Architecture: image.architecture });
      onExport?.(id);
      callback(null, Readable.from([image.archive]));
    } } }),
  } as any;
}

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

test('instance inventory proves a pinned image export and detects a moving tag', async () => {
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const image = await savedImage();
  const movedImage = await savedImage('arm64');
  const tags = new Map([[reference, image.imageId]]);
  const docker = imageDocker(tags, new Map([[image.imageId, image]]));
  const inventory = await capturedWorkerImageInventory(docker, [
    { id: 'worker-1', importedImage: reference }, { id: 'worker-2' }, { id: 'worker-3', importedImage: 'agentor-import-worker-3' },
  ] as any);
  expect(inventory).toEqual([{ workerId: 'worker-1', reference, imageId: image.imageId,
    portableIdentity: { version: 1, configDigest: image.configDigest, platform: { os: 'linux', architecture: 'amd64' } } }]);
  expect(docker.requests).toEqual([`/images/${reference}/json`, `/images/${image.imageId}/get`, `/images/${reference}/json`]);
  const moved = imageDocker(tags, new Map([[image.imageId, image], [movedImage.imageId, movedImage]]), () => tags.set(reference, movedImage.imageId));
  await expect(capturedWorkerImageInventory(moved, [{ id: 'worker-1', importedImage: reference }] as any))
    .rejects.toThrow('Runtime snapshot image reference changed during inventory');
  expect(isRuntimeSnapshotImage('agentor-import-worker-3')).toBe(false);
  expect(isRuntimeSnapshotImage('registry/image:runtime-x')).toBe(false);
});

test('two captured workers sharing one immutable image export it only once', async () => {
  const image = await savedImage();
  const first = 'agentor-import-worker-1:runtime-operation-1';
  const second = 'agentor-import-worker-2:runtime-operation-2';
  const docker = imageDocker(new Map([[first, image.imageId], [second, image.imageId]]), new Map([[image.imageId, image]]));
  const inventory = await capturedWorkerImageInventory(docker, [
    { id: 'worker-1', importedImage: first }, { id: 'worker-2', importedImage: second },
  ] as any);
  expect(inventory).toHaveLength(2);
  expect(inventory[0]!.portableIdentity).toEqual(inventory[1]!.portableIdentity);
  expect(docker.requests.filter((request: string) => request.endsWith('/get'))).toHaveLength(1);
});

test('destination accepts a proven config identity across classic and OCI stores and rejects wrong config or platform', async () => {
  const classic = await savedImage();
  const oci = await savedImage('amd64', true);
  const wrongPlatform = await savedImage('arm64');
  const wrongConfig = await savedImage('amd64', false, 'changed-rootfs-config');
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const expected = [{ workerId: 'worker-1', reference, imageId: classic.imageId,
    portableIdentity: { version: 1 as const, configDigest: classic.configDigest, platform: { os: 'linux', architecture: 'amd64' } } }];
  const tags = new Map([[reference, oci.imageId]]);
  const images = new Map([[oci.imageId, oci], [wrongPlatform.imageId, wrongPlatform], [wrongConfig.imageId, wrongConfig]]);
  const docker = imageDocker(tags, images);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([]);
  tags.set(reference, wrongPlatform.imageId);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([reference]);
  tags.set(reference, wrongConfig.imageId);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([reference]);
  tags.set(reference, oci.imageId);
  expect(await missingCapturedWorkerImages(docker, [{ ...expected[0]!, portableIdentity: { ...expected[0]!.portableIdentity!, configDigest: `sha256:${'e'.repeat(64)}` } }])).toEqual([reference]);
  expect(await missingCapturedWorkerImages(docker, [{ ...expected[0]!, imageId: oci.imageId,
    portableIdentity: { ...expected[0]!.portableIdentity!, configDigest: `sha256:${'e'.repeat(64)}` } }])).toEqual([reference]);
});

test('destination rejects a tag repointed after its immutable export', async () => {
  const image = await savedImage();
  const changed = await savedImage('amd64', false, 'replacement');
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const tags = new Map([[reference, image.imageId]]);
  const docker = imageDocker(tags, new Map([[image.imageId, image], [changed.imageId, changed]]),
    () => tags.set(reference, changed.imageId));
  expect(await missingCapturedWorkerImages(docker, [{ workerId: 'worker-1', reference, imageId: image.imageId,
    portableIdentity: { version: 1, configDigest: image.configDigest, platform: { os: 'linux', architecture: 'amd64' } } }])).toEqual([reference]);
});

test('legacy manifests retain equal-ID fast path and reject unproven mismatches', async () => {
  const image = await savedImage();
  const oci = await savedImage('amd64', true);
  const changed = await savedImage('amd64', false, 'changed-rootfs-config');
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const expected = [{ workerId: 'worker-1', reference, imageId: image.imageId }];
  const tags = new Map([[reference, image.imageId]]);
  let failure: number | undefined;
  const docker = imageDocker(tags, new Map([[image.imageId, image], [oci.imageId, oci], [changed.imageId, changed]]), undefined, () => failure);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([]);
  expect(docker.requests).toEqual([`/images/${reference}/json`]);
  tags.set(reference, oci.imageId);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([]);
  tags.set(reference, changed.imageId);
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([reference]);
  failure = 404;
  expect(await missingCapturedWorkerImages(docker, expected)).toEqual([reference]);
  failure = 503;
  await expect(missingCapturedWorkerImages(docker, expected)).rejects.toMatchObject({ statusCode: 503 });
});

test('cancelling a pending image export closes its late stream and stops inventory', async () => {
  const image = await savedImage();
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const controller = new AbortController();
  const late = new PassThrough();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  const docker = { getImage: () => ({ modem: { dial: (options: { path: string; abortSignal: AbortSignal },
    callback: (error: Error | null, data?: any) => void) => {
    if (options.path.endsWith('/json')) callback(null, { Id: image.imageId, Os: 'linux', Architecture: 'amd64' });
    else {
      start();
      options.abortSignal.addEventListener('abort', () => queueMicrotask(() => callback(null, late)), { once: true });
    }
  } } }) } as any;
  const pending = capturedWorkerImageInventory(docker, [{ id: 'worker-1', importedImage: reference }] as any, controller.signal);
  await started;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  await expect.poll(() => late.destroyed).toBe(true);
});

test('cancelling a stalled image proof destroys the active export stream', async () => {
  const image = await savedImage();
  const reference = 'agentor-import-worker-1:runtime-operation-1';
  const controller = new AbortController();
  const stream = new PassThrough();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  const docker = { getImage: () => ({ modem: { dial: (options: { path: string },
    callback: (error: Error | null, data?: any) => void) => {
    if (options.path.endsWith('/json')) callback(null, { Id: image.imageId, Os: 'linux', Architecture: 'amd64' });
    else { callback(null, stream); started(); }
  } } }) } as any;
  const pending = capturedWorkerImageInventory(docker, [{ id: 'worker-1', importedImage: reference }] as any, controller.signal);
  await reading;
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: 'OPERATION_ABORTED' });
  expect(stream.destroyed).toBe(true);
});
