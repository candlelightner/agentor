import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open, lstat, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual, promisify } from 'node:util';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { IncusClient, IncusError, type IncusCustomVolume, type IncusInstance, type IncusProject } from '../../orchestrator/server/utils/incus-client';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { IncusWorkerStorage } from '../../orchestrator/server/utils/incus-worker-storage';
import { incusImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';
import { readCanonicalIncusBootstrap, incusConversionRecipeId } from '../../orchestrator/server/utils/incus-image-converter';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';

const project = 'agentor-image-gate-e983a414', marker = 'e983a414-4c7f-4fd4-805d-460f2bcbd6f0';
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/, hash = /^[a-f0-9]{64}$/;
async function privateJson(path: string): Promise<Record<string, unknown>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > 16_384 || (info.mode & 0o077) || info.uid !== process.getuid?.())
      throw new Error('Acknowledged fixture receipt must be a bounded private regular file');
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid acknowledged fixture receipt');
    return value as Record<string, unknown>;
  } finally { await file.close(); }
}

/** Root-owned serial gate only. This boots the exact parent-imported image;
 * it is not catalog/UI dispatch acceptance. Fresh owned storage plus the
 * existing fixed-fingerprint recreation primitive avoid any mutable alias or
 * image-property adoption. Unknown requests retain their exact fixture. */
test('parent-normalized converted image boots through worker runtime with systemd, provisioning, editor and desktop', async () => {
  test.skip(process.env.INCUS_CONVERTED_IMAGE_BOOT_TEST !== 'true', 'Explicit serial approved converted-image boot gate');
  test.setTimeout(600_000);
  const converted = process.env.INCUS_CONVERTED_IMAGE_GATE_DIR, credentials = process.env.INCUS_IMAGE_IMPORT_GATE_DIR;
  if (!converted || !/^\/workspace\/agentor-isolated-image-gate\.[A-Za-z0-9]+$/.test(converted) ||
      !credentials || !/^\/workspace\/agentor-incus-image-gate\.[A-Za-z0-9]+$/.test(credentials))
    throw new Error('Exact approved converted-image and restricted credential fixture paths are required');
  const directory = await lstat(converted);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || directory.uid !== process.getuid?.())
    throw new Error('Converted image fixture directory is not private');
  const imported = await privateJson(join(converted, 'import-receipt.json'));
  const converter = await privateJson(join(converted, 'converter-receipt.json'));
  if (imported.pending !== false || typeof imported.fingerprint !== 'string' || !hash.test(imported.fingerprint) ||
      converter.version !== 1 || converter.removed !== true || converter.pending !== undefined || converter.project !== project ||
      typeof converter.incarnation !== 'string' || !uuid.test(converter.incarnation) || typeof converter.name !== 'string' ||
      !/^aic-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(converter.name) ||
      typeof converter.installationId !== 'string' || !uuid.test(converter.installationId) ||
      typeof converter.sourceImageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(converter.sourceImageId) ||
      typeof converter.recipeId !== 'string' || !hash.test(converter.recipeId))
    throw new Error('Successful exact converter removal and native import acknowledgements are required');
  const recipe = incusConversionRecipeId(converter.sourceImageId, await readCanonicalIncusBootstrap(join(converted, 'bootstrap')));
  expect(recipe).toBe(converter.recipeId);
  // A retained conversion may predate current canonical source changes. Reuse
  // the real asset packager before any native allocation, rather than trusting
  // the old converter's internally coherent manifest as current evidence.
  const currentAssets = await mkdtemp(join(tmpdir(), 'agentor-converted-current-assets-'));
  try {
    const bootstrap = join(currentAssets, 'bootstrap');
    await promisify(execFile)(process.execPath, ['../orchestrator/build-incus-worker-assets.mjs', bootstrap],
      { maxBuffer: 4096, timeout: 30_000 });
    expect(incusConversionRecipeId(converter.sourceImageId, await readCanonicalIncusBootstrap(bootstrap)),
      'Acknowledged converted image must match current canonical bootstrap assets').toBe(recipe);
  } finally { await rm(currentAssets, { recursive: true, force: true }); }
  const network = process.env.INCUS_NETWORK, gateway = process.env.INCUS_INTERNAL_GATEWAY_URL;
  if (!network || !/^[A-Za-z0-9_.-]+$/.test(network) || !gateway?.startsWith('http://') ||
      process.env.INCUS_STORAGE_POOL && process.env.INCUS_STORAGE_POOL !== 'default')
    throw new Error('Configured disposable worker network/gateway and canonical default pool are required');
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-converted-boot-')), id = randomUUID(), userId = 'converted-boot-' + randomUUID();
  const config = { ...loadConfig(), dataDir, containerPrefix: 'converted-boot', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: project, incusNetwork: network, incusStoragePool: 'default',
    incusInternalGatewayUrl: gateway, incusClientCertPath: join(credentials, 'client.crt'),
    incusClientKeyPath: join(credentials, 'client.key'), incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const client = IncusClient.fromConfig(config), runtime = new IncusWorkerRuntime(config, client);
  const installation = await backupInstallationId(dataDir), storage = new IncusWorkerStorage(client, config, installation);
  const owner = { id, userId, containerName: config.containerPrefix + '-' + id };
  const probe = 'converted-' + id;
  const options = { ...owner, start: false, recreationNonce: randomUUID(), cpuLimit: 2, memoryLimit: '2GiB', dockerEnabled: false,
    userEnv: { ...zeroUserEnvVars(userId), envVars: [{ key: 'CONVERTED_BOOT_PROBE', value: probe }] },
    capabilitiesJson: [], instructionsJson: [], sshAuthorizedKeys: '',
    environmentJson: { dockerEnabled: false, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: 'Converted image boot acceptance', repos: [], initScript: '', gitName: '', gitEmail: '' },
  } satisfies IncusWorkerOptions;
  let attempted = false, completed = false, cleaned = false, settled = true, incarnation: string | undefined;
  let snapshot: IncusInstance | undefined, volumes: IncusCustomVolume[] = [];
  const names = ['workspace', 'agents'].map(role => owner.containerName + '-' + role);
  const absent = async (read: () => Promise<unknown>) => {
    try { await read(); throw new Error('Fresh exact boot fixture destination already exists'); }
    catch (error) { if (!(error instanceof IncusError) || error.statusCode !== 404) throw error; }
  };
  const references = (values: string[]) => values.map(value => {
    const url = new URL(value, client.endpoint);
    if (url.origin !== new URL(client.endpoint).origin || url.username || url.password || url.hash ||
        url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== project ||
        [...url.searchParams.keys()].some(key => key !== 'project')) throw new Error('Fixture storage reference is foreign');
    return url.pathname;
  }).sort();
  const assertCompute = async () => {
    const current = await client.getInstance(owner.containerName);
    // Incus may assign volatile tap/DHCP/power state on start/stop. Stable
    // configuration remains exact; UUID and base-image volatile fields are
    // separately mandatory authority, never inferred from that exception.
    const stable = (value: Record<string, string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('volatile.')));
    if (!incarnation || current.config['volatile.uuid'] !== incarnation || !await runtime.matchesWorkerIdentity(current, id, userId) ||
        current.config['volatile.base_image'] !== imported.fingerprint || current.type !== 'virtual-machine' || current.profiles.length ||
        snapshot && (!isDeepStrictEqual(stable(current.config), stable(snapshot.config)) ||
          !isDeepStrictEqual(stable(current.expanded_config ?? current.config), stable(snapshot.expanded_config ?? snapshot.config)) ||
          !isDeepStrictEqual(current.devices, snapshot.devices) || !isDeepStrictEqual(current.expanded_devices, snapshot.expanded_devices)))
      throw new Error('Exact boot fixture incarnation/image/device authority changed');
    return current;
  };
  const assertVolumes = async (attached: boolean) => {
    for (const before of volumes) {
      const current = await client.getCustomVolume(config.incusStoragePool, before.name);
      if (!isDeepStrictEqual({ ...current, used_by: undefined }, { ...before, used_by: undefined }) ||
          !isDeepStrictEqual(references(current.used_by), attached ? ['/1.0/instances/' + owner.containerName] : []))
        throw new Error('Exact boot fixture storage metadata/reference authority changed');
    }
  };
  try {
    const scoped = await client.request<IncusProject>('GET', '/1.0/projects/' + project);
    expect(scoped.config).toMatchObject({ restricted: 'true', 'features.images': 'true', 'user.agentor.image-gate': marker });
    const image = await client.getImage(imported.fingerprint);
    expect(incusImageIdentity(image)).toMatchObject({ fingerprint: imported.fingerprint, sourceImageId: converter.sourceImageId,
      recipeId: recipe, architecture: 'amd64', bootstrapGeneration: '3', converterVersion: 'v0.4.0' });
    await absent(() => client.getInstance(converter.name as string));
    await absent(() => client.getInstance(owner.containerName));
    for (const name of [...names, owner.containerName + '-docker']) await absent(() => client.getCustomVolume(config.incusStoragePool, name));
    console.info('Exact converted image boot fixture', { dataDir, id, installation, project, fingerprint: imported.fingerprint, recipe });
    attempted = true; settled = false;
    await storage.devices(owner, false); settled = true;
    // The public runtime primitive uses only this acknowledged fingerprint and
    // these independently allocated, owned volumes; no alias is synthesized.
    settled = false;
    const created = await runtime.create(options, { fingerprint: imported.fingerprint, docker: false });
    incarnation = created.config['volatile.uuid'];
    if (!uuid.test(incarnation ?? '') || created.config['user.agentor.recreation'] !== options.recreationNonce ||
        !await runtime.matchesWorkerIdentity(created, id, userId)) throw new Error('Boot creation omitted its exact acknowledgement');
    settled = true; snapshot = await assertCompute(); expect(snapshot.status).toBe('Stopped');
    expect(Object.keys(snapshot.devices).sort()).toEqual(['agents', 'eth0', 'root', 'workspace']);
    expect(snapshot.devices.eth0).toMatchObject({ network, 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' });
    volumes = await Promise.all(names.map(name => client.getCustomVolume(config.incusStoragePool, name)));
    for (const [index, volume] of volumes.entries()) {
      expect(volume).toMatchObject({ project, type: 'custom', content_type: 'filesystem', created_at: expect.any(String),
        config: { 'user.agentor.installation': installation, 'user.agentor.id': id, 'user.agentor.owner': userId,
          'user.agentor.storage-role': index === 0 ? 'workspace' : 'agents' } });
      expect(Number.isFinite(Date.parse(volume.created_at))).toBe(true);
    }
    await assertVolumes(true);
    settled = false; await runtime.start(options, incarnation); settled = true;
    snapshot = await assertCompute(); expect(snapshot.status).toBe('Running');
    const commands = runtime.commands(owner, incarnation!, async () => { await assertCompute(); });
    const handle = 'incus:' + incarnation;
    const sudo = await commands.execCapture(handle, ['sudo', '-n', 'id', '-u']);
    expect(sudo.exitCode, sudo.stderr.toString()).toBe(0); expect(sudo.stdout.toString().trim()).toBe('0');
    const checked = await client.exec(owner.containerName, ['/bin/bash', '-ec', String.raw`
test "$(cat /proc/1/comm)" = systemd
systemctl is-active --quiet incus-agent agentor-worker
test "$(id -u agent)" = 1000
test "$(stat -c '%u:%g:%a' /run/agentor/provisioned)" = '0:0:600'
test "$(cat /run/agentor/provisioned)" = agentor-runtime-v1
test "$(stat -c '%u:%g:%a' /run/agentor/worker.env)" = '0:1000:640'
. /run/agentor/worker.env
test "$CONVERTED_BOOT_PROBE" = "$1"
mountpoint -q /workspace; mountpoint -q /home/agent/.agent-data
test ! -e /tls/client.key; test ! -e /tls/client.crt
! systemctl is-active --quiet docker
pgrep -x Xvfb >/dev/null; pgrep -x fluxbox >/dev/null; pgrep -x x11vnc >/dev/null
curl --fail --silent http://127.0.0.1:8443/ | grep -q code-server
curl --fail --silent http://127.0.0.1:6080/agentor.html | grep -q noVNC
`, 'converted-boot', probe]);
    expect(checked.returnCode, checked.stderr).toBe(0);
    expect((await commands.execListTmuxWindows(handle)).length).toBeGreaterThan(0);
    await assertCompute(); await assertVolumes(true);
    await absent(() => client.getCustomVolume(config.incusStoragePool, owner.containerName + '-docker'));
    settled = false; await runtime.stop(owner, incarnation); settled = true;
    expect((await assertCompute()).status).toBe('Stopped'); await assertVolumes(true); completed = true;
  } finally {
    try {
      if (completed && settled && incarnation && volumes.length === 2) {
        await assertCompute(); await assertVolumes(true);
        settled = false; await runtime.remove(owner, incarnation); settled = true;
        await absent(() => client.getInstance(owner.containerName)); await assertVolumes(false);
        settled = false; await runtime.removeStorage(owner); settled = true;
        for (const name of names) await absent(() => client.getCustomVolume(config.incusStoragePool, name));
        cleaned = true;
      }
    } finally {
      client.dispose();
      if (!attempted || cleaned) await rm(dataDir, { recursive: true, force: true });
      else console.error('Retained exact converted boot fixture for root diagnosis', { dataDir, owner, incarnation, settled, completed });
    }
    if (completed) expect(cleaned, 'Exact acknowledged worker/core cleanup').toBe(true);
  }
});
