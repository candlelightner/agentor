import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { IncusClient, type IncusProject } from '../../orchestrator/server/utils/incus-client';
import { loadConfig } from '../../orchestrator/server/utils/config';

// Operator-created disposable project/credential, never the existing agentor
// project or a broader certificate. Input is an exported, already live-accepted
// trusted image, NOT converter-guest QCOW/metadata.
test('real restricted project streams split VM image import without global alias mutation', async () => {
  test.skip(process.env.INCUS_IMAGE_IMPORT_TEST !== 'true', 'Explicit serial disposable image-import gate');
  test.setTimeout(600_000);
  const directory = process.env.INCUS_IMAGE_IMPORT_GATE_DIR;
  if (!directory || !/^\/workspace\/agentor-incus-image-gate\.[A-Za-z0-9]+$/.test(directory))
    throw new Error('Private operator image gate directory is required');
  const project = 'agentor-image-gate-e983a414';
  const config = { ...loadConfig(), incusEndpoint: 'https://127.0.0.1:18443', incusProject: project,
    incusClientCertPath: join(directory, 'client.crt'), incusClientKeyPath: join(directory, 'client.key'),
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const client = IncusClient.fromConfig(config);
  const current = await client.request<IncusProject>('GET', '/1.0/projects/' + project);
  expect(current.config).toMatchObject({ restricted: 'true', 'features.images': 'true',
    'user.agentor.image-gate': 'e983a414-4c7f-4fd4-805d-460f2bcbd6f0' });
  await expect(client.request('GET', '/1.0/projects/default')).rejects.toMatchObject({ statusCode: 403 });
  expect(await client.listImages()).toEqual([]);
  const fingerprint = '37cd37e7ff7343207f14db6197c4ed11fc22e90c987ce8ec71e2fe330c55099b';
  await expect(client.getImage(fingerprint)).rejects.toMatchObject({ statusCode: 404 });
  let accepted = false;
  const imported = await client.importImage(join(directory, 'source-image'), join(directory, 'source-image.root'), async operation => {
    // Existing accepted-operation receipts store the canonical path; this
    // client's pinned project is added by every subsequent API request.
    expect(operation).toMatch(/^\/1\.0\/operations\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    accepted = true;
  });
  expect(accepted).toBe(true);
  expect(imported).toMatchObject({ fingerprint, type: 'virtual-machine', aliases: [],
    properties: { bootstrap_generation: '3', source_image_id: 'sha256:38b656283e26e5b070b97a49ead034903480ccaf0fd465825f6e985819745b5f' } });
  expect((await client.listImages()).map(image => image.fingerprint)).toEqual([fingerprint]);
  expect(await client.getImage(fingerprint)).toEqual(imported);
  // Retain this exact project/image as the converter seed; root owns subsequent
  // guest testing and identity-pinned cleanup. Never remove the global image.
  console.info('Restricted split import accepted', { project, fingerprint });
});
