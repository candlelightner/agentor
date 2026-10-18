import { test, expect } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const { parse } = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('yaml');

test('production Incus override preserves legacy control plane and grants only individual readonly TLS files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-compose-'));
  try {
    for (const file of ['docker-compose.prod.yml', 'docker-compose.incus.yml']) await cp('../' + file, join(dir, file));
    await writeFile(join(dir, '.env'), '# isolated synthetic deployment fixture\n');
    const env = { ...process.env, AGENTOR_INCUS_ORCHESTRATOR_IMAGE: 'agentor-orchestrator:incus-test',
      WORKER_IMAGE_PREFIX: '', WORKER_IMAGE: 'operator-worker:approved',
      INCUS_WORKER_GATEWAY: '10.45.0.1', INCUS_INTERNAL_PORT: '3079', INCUS_TLS_NAME: 'incus.internal',
      INCUS_API_HOST_ADDRESS: '172.30.0.1', INCUS_CLIENT_CERT_SOURCE: dir + '/client.crt', INCUS_CLIENT_KEY_SOURCE: dir + '/client.key',
      INCUS_SERVER_CERT_SOURCE: dir + '/server.crt', INCUS_POLICY_CERT_SOURCE: dir + '/policy.crt',
      INCUS_ENDPOINT: 'https://incus.internal:8443', INCUS_PROJECT: 'agentor-private', INCUS_NETWORK: 'owned-workers',
      INCUS_STORAGE_POOL: 'owned-data', INCUS_CONVERTER_STORAGE_POOL: 'owned-scratch', INCUS_WORKER_IMAGE: 'owned-derived',
      INCUS_CONVERTER_SEED_FINGERPRINT: 'a'.repeat(64), INCUS_NETWORK_HOST_ENDPOINT: 'https://incus.internal:8444',
      INCUS_INTERNAL_GATEWAY_URL: 'http://10.45.0.1:3079' };
    const result = spawnSync('docker', ['compose', '-f', 'docker-compose.prod.yml', '-f', 'docker-compose.incus.yml', 'config', '--format', 'json'],
      { cwd: dir, env, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const app = JSON.parse(result.stdout).services.orchestrator;
    const raw = parse(await readFile(join(dir, 'docker-compose.incus.yml'), 'utf8')).services.orchestrator;
    expect(app.image).toBe(env.AGENTOR_INCUS_ORCHESTRATOR_IMAGE);
    expect(app.environment).toMatchObject({ INCUS_ENABLED: 'true', WORKER_IMAGE_PREFIX: '', WORKER_IMAGE: env.WORKER_IMAGE,
      INCUS_PROJECT: env.INCUS_PROJECT, INCUS_CONVERTER_SEED_FINGERPRINT: env.INCUS_CONVERTER_SEED_FINGERPRINT });
    expect(app.ports).toEqual(expect.arrayContaining([
      expect.objectContaining({ host_ip: '127.0.0.1', published: '3000', target: 3000 }),
      expect.objectContaining({ host_ip: env.INCUS_WORKER_GATEWAY, published: '3079', target: 3000 }),
    ]));
    expect(app.ports.every((port: { host_ip: string }) => port.host_ip && !['0.0.0.0', '::'].includes(port.host_ip))).toBe(true);
    expect(app.volumes).toEqual(expect.arrayContaining([expect.objectContaining({ source: '/var/run/docker.sock', target: '/var/run/docker.sock' })]));
    for (const file of ['client.crt', 'client.key', 'server.crt', 'policy.crt']) {
      const target = '/run/agentor-incus/' + file;
      expect(raw.volumes.find((volume: { target: string }) => volume.target === target))
        .toMatchObject({ type: 'bind', read_only: true, bind: { create_host_path: false } });
      const volume = app.volumes.find((volume: { target: string }) => volume.target === target);
      expect(volume).toMatchObject({ type: 'bind', source: dir + '/' + file, read_only: true });
      // Compose versions may omit false boolean fields from normalized JSON.
      expect([undefined, false]).toContain(volume.bind?.create_host_path);
    }
    expect(app.volumes.some((volume: { source: string; target: string }) =>
      volume.source.startsWith('/var/lib/incus') || volume.target.startsWith('/var/lib/incus'))).toBe(false);
    const hosts = app.extra_hosts;
    const mapped = Array.isArray(hosts)
      ? hosts.includes('incus.internal=' + env.INCUS_API_HOST_ADDRESS) || hosts.includes('incus.internal:' + env.INCUS_API_HOST_ADDRESS)
      : hosts?.['incus.internal'] === env.INCUS_API_HOST_ADDRESS || hosts?.['incus.internal']?.includes(env.INCUS_API_HOST_ADDRESS);
    expect(mapped).toBe(true);
    expect(app.networks).toHaveProperty('agentor-net');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Incus override fails configuration before deployment without required operator image authority', async () => {
  const env: NodeJS.ProcessEnv = { ...process.env,
    INCUS_WORKER_GATEWAY: '10.45.0.1', INCUS_TLS_NAME: 'incus.internal', INCUS_API_HOST_ADDRESS: '172.30.0.1',
    INCUS_CLIENT_CERT_SOURCE: '/tmp/client.crt', INCUS_CLIENT_KEY_SOURCE: '/tmp/client.key',
    INCUS_SERVER_CERT_SOURCE: '/tmp/server.crt', INCUS_POLICY_CERT_SOURCE: '/tmp/policy.crt',
    INCUS_ENDPOINT: 'https://incus.internal:8443', INCUS_PROJECT: 'agentor-private', INCUS_NETWORK: 'owned-workers',
    INCUS_STORAGE_POOL: 'owned-data', INCUS_CONVERTER_STORAGE_POOL: 'owned-scratch', INCUS_WORKER_IMAGE: 'owned-derived',
    INCUS_CONVERTER_SEED_FINGERPRINT: 'a'.repeat(64), INCUS_NETWORK_HOST_ENDPOINT: 'https://incus.internal:8444',
    INCUS_INTERNAL_GATEWAY_URL: 'http://10.45.0.1:3079' };
  delete env.AGENTOR_INCUS_ORCHESTRATOR_IMAGE;
  const result = spawnSync('docker', ['compose', '-f', '../docker-compose.incus.yml', 'config', '--quiet'], { env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('AGENTOR_INCUS_ORCHESTRATOR_IMAGE');
});
