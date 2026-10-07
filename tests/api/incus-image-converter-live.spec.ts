import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { IncusClient, type IncusProject } from '../../orchestrator/server/utils/incus-client';
import { IncusImageConverter, readCanonicalIncusBootstrap, incusConversionRecipeId,
  type IncusImageConverterReceipt } from '../../orchestrator/server/utils/incus-image-converter';
import { normalizeAndImportIncusImage } from '../../orchestrator/server/utils/incus-image-artifact';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';

const run = promisify(execFile);
const ssh = ['-p', '22375', '-i', '/workspace/agentor-kata-vm-access.ZgLVo9uk/id_ed25519',
  '-o', 'UserKnownHostsFile=/workspace/agentor-kata-vm-access.ZgLVo9uk/known_hosts',
  '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', 'kata-test@172.19.0.1'];
const project = 'agentor-image-gate-e983a414';
const seedFingerprint = '37cd37e7ff7343207f14db6197c4ed11fc22e90c987ce8ec71e2fe330c55099b';
const sourceImageId = 'sha256:38b656283e26e5b070b97a49ead034903480ccaf0fd465825f6e985819745b5f';

/** One serial operator-authorized isolated conversion. The SSH Docker bridge
 * is fixture-only and reaches the approved disposable host, never production.
 * Retain failures/unknown receipts for root diagnosis; no name-based adoption. */
test('real isolated SAME d2vm converter produces bounded RAW and parent-only normalized VM import', async () => {
  test.skip(process.env.INCUS_IMAGE_CONVERTER_TEST !== 'true', 'Explicit serial disposable converter gate');
  test.setTimeout(60 * 60_000);
  const credentials = process.env.INCUS_IMAGE_IMPORT_GATE_DIR;
  if (!credentials || !/^\/workspace\/agentor-incus-image-gate\.[A-Za-z0-9]+$/.test(credentials))
    throw new Error('Pinned private disposable project credentials are required');
  // Missing parent tools must fail before an expensive disposable VM build.
  expect((await run('qemu-img', ['--version'], { maxBuffer: 4096 })).stdout).toContain('qemu-img version');
  expect((await run('dd', ['--version'], { maxBuffer: 4096 })).stdout).toContain('coreutils');
  const config = { ...loadConfig(), incusEndpoint: 'https://127.0.0.1:18443', incusProject: project,
    incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusConverterStoragePool: 'agentor-converter-gate-e983a414',
    incusClientCertPath: join(credentials, 'client.crt'), incusClientKeyPath: join(credentials, 'client.key'),
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const client = IncusClient.fromConfig(config);
  try {
    const nativeProject = await client.request<IncusProject>('GET', '/1.0/projects/' + project);
    expect(nativeProject.config).toMatchObject({ restricted: 'true', 'features.images': 'true',
      'user.agentor.image-gate': 'e983a414-4c7f-4fd4-805d-460f2bcbd6f0' });
    expect((await client.getImage(seedFingerprint)).type).toBe('virtual-machine');
    expect(await client.listInstances()).toEqual([]);
    const inspect = async () => {
      const result = await run('ssh', [...ssh, 'sudo docker image inspect ' + sourceImageId], { maxBuffer: 1024 * 1024 });
      return JSON.parse(result.stdout)[0] as { Id: string; Architecture: string };
    };
    expect(await inspect()).toMatchObject({ Id: sourceImageId, Architecture: 'amd64' });
    const pool = await client.request<{ name: string; driver: string; status: string }>('GET',
      '/1.0/storage-pools/' + config.incusConverterStoragePool);
    expect(pool).toMatchObject({ name: config.incusConverterStoragePool, driver: 'dir', status: 'Created' });
    // Restricted native credentials deliberately redact pool configuration.
    // Fixture-only operator SSH validates our exact setup marker/source; never
    // broaden the production credential just to read global pool settings.
    const ownedPool = JSON.parse((await run('ssh', [...ssh,
      'sudo incus query /1.0/storage-pools/agentor-converter-gate-e983a414'], { maxBuffer: 16384 })).stdout);
    expect(ownedPool.config).toMatchObject({
      'user.agentor.image-gate': 'e983a414-4c7f-4fd4-805d-460f2bcbd6f0',
      source: '/mnt/kata-extra/agentor-converter-gate-e983a414',
    });
    const resources = await client.request<{ space: { total: number; used: number } }>('GET',
      '/1.0/storage-pools/' + config.incusConverterStoragePool + '/resources');
    expect(resources.space.total - resources.space.used, 'Converter scratch—not canonical worker pool').toBeGreaterThan(68 * 1024 ** 3);
    const directory = await mkdtemp('/workspace/agentor-isolated-image-gate.');
    config.dataDir = directory;
    const assets = join(directory, 'bootstrap');
    await run('node', ['../orchestrator/build-incus-worker-assets.mjs', assets], { maxBuffer: 4096 });
    const recipeId = incusConversionRecipeId(sourceImageId, await readCanonicalIncusBootstrap(assets));
    const jobId = randomUUID(), installationId = randomUUID();
    const receipts: IncusImageConverterReceipt[] = [];
    const imports: Array<{ pending: boolean; operation?: string; fingerprint?: string }> = [];
    const docker = { getImage: (id: string) => {
      expect(id).toBe(sourceImageId);
      return { inspect, get: async () => {
        const child = spawn('ssh', [...ssh, 'sudo docker image save ' + sourceImageId], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stderr.resume();
        child.on('error', error => child.stdout.destroy(error));
        child.on('exit', code => { if (code !== 0) child.stdout.destroy(new Error('Disposable OCI export failed')); });
        child.stdout.once('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
        return child.stdout;
      } } as unknown as ReturnType<ConstructorParameters<typeof IncusImageConverter>[2]['getImage']>;
    } } satisfies ConstructorParameters<typeof IncusImageConverter>[2];
    const validateAuthority = async () => {
      const current = await client.request<IncusProject>('GET', '/1.0/projects/' + project);
      expect(current.config).toMatchObject({ restricted: 'true', 'features.images': 'true',
        'user.agentor.image-gate': 'e983a414-4c7f-4fd4-805d-460f2bcbd6f0' });
    };
    const execStream = client.execStream.bind(client);
    client.execStream = async (name, command, options) => {
      if (command[0] === '/bin/bash' && command[1] === '-ec') {
        const current = await client.getInstance(name);
        expect(current.config['user.agentor.operation']).toBe(jobId);
        expect(current.config['user.agentor.installation']).toBe(installationId);
        expect(current.config['volatile.uuid']).toBe(receipts.at(-1)?.incarnation);
        const capacity = await client.exec(name, ['/usr/bin/df', '-B1', '--output=source,size,avail,target', '/']);
        expect(capacity.returnCode).toBe(0);
        expect((await client.getInstance(name)).config['volatile.uuid']).toBe(current.config['volatile.uuid']);
        console.info('Converter guest filesystem capacity', capacity.stdout);
      }
      return execStream(name, command, options);
    };
    console.info('Isolated converter fixture', { directory, jobId, installationId, project, sourceImageId, recipeId });
    const raw = await new IncusImageConverter(config, client, docker, assets).convert({ jobId, installationId,
      ownerId: 'image-gate-owner', sourceImageId, seedFingerprint, validateAuthority,
      acknowledge: async receipt => {
        receipts.push(structuredClone(receipt));
        await writeFile(join(directory, 'converter-receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
        console.info('Converter acknowledgement', { pending: receipt.pending?.kind, removed: receipt.removed });
      } });
    expect(receipts.at(-1)).toMatchObject({ removed: true, incarnation: expect.any(String) });
    expect(receipts.at(-1)?.pending).toBeUndefined();
    await expect(client.getInstance('aic-' + jobId)).rejects.toMatchObject({ statusCode: 404 });
    const image = await normalizeAndImportIncusImage(client, raw, join(directory, 'tmp', 'incus-image-' + jobId, 'normalized'), {
      validateAuthority,
      acknowledgeImport: async ack => {
        imports.push(ack); await writeFile(join(directory, 'import-receipt.json'), JSON.stringify(ack), { mode: 0o600 });
      },
    });
    expect(incusImageIdentity(image)).toMatchObject({ sourceImageId, recipeId, bootstrapGeneration: '3', converterVersion: 'v0.4.0' });
    expect(imports.at(-1)).toMatchObject({ pending: false, fingerprint: image.fingerprint });
    expect(await client.listInstances()).toEqual([]);
    expect(JSON.parse(await readFile(join(directory, 'converter-receipt.json'), 'utf8')).removed).toBe(true);
    console.info('Isolated converter accepted; retain exact image for worker boot gate', { directory, fingerprint: image.fingerprint });
  } finally { client.dispose(); }
});
