import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../orchestrator/server/utils/config';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { WorkerStore, type WorkerRecord } from '../../orchestrator/server/utils/worker-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';

test('real stopped restore promotes data without services and archive removes only disposable compute', async () => {
  test.skip(process.env.INCUS_INSTANCE_STOPPED_RESTORE_TEST !== 'true', 'Explicit serial disposable native restore gate');
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-instance-stopped-restore-'));
  const id = randomUUID(), userId = 'instance-stopped-restore', nonce = randomUUID();
  const config = { ...loadConfig(), dataDir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', incusClientCertPath: '/workspace/agentor-incus-tls/client.crt',
    incusClientKeyPath: '/workspace/agentor-incus-tls/client.key', incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' };
  const opts = { id, userId, containerName: config.containerPrefix + '-' + id, start: false, recreationNonce: nonce,
    dockerEnabled: true, cpuLimit: 2, memoryLimit: '2GiB', userEnv: zeroUserEnvVars(userId),
    capabilitiesJson: [], instructionsJson: [],
    environmentJson: { dockerEnabled: true, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '',
      exposeApis: { portMappings: false, domainMappings: false, usage: false } },
    workerJson: { id, displayName: 'Stopped whole-instance restore prerequisite', repos: [], initScript: '', gitName: '', gitEmail: '' },
  } satisfies IncusWorkerOptions;
  const runtime = new IncusWorkerRuntime(config), workers = new WorkerStore(dataDir);
  await workers.init();
  const marker: NonNullable<WorkerRecord['incusRecreation']> = { nonce, initialCreate: true, importIncomplete: true };
  let submitted = false, cleaned = false, nativeSettled = true, incarnation: string | undefined;
  try {
    const installation = await backupInstallationId(dataDir);
    console.info('Exact stopped native restore fixture', { dataDir, installation, id, userId, nonce });
    const raw: Record<'workspace' | 'agents' | 'docker', string> = { workspace: '', agents: '', docker: '' };
    for (const role of ['workspace', 'agents', 'docker'] as const) {
      const wrapper = role === 'agents' ? '.agent-data' : role;
      const stage = join(dataDir, 'input-' + role);
      await mkdir(join(stage, wrapper), { recursive: true });
      await writeFile(join(stage, wrapper, 'marker'), Buffer.from([0, 255, 128, 10, 61, 0]));
      raw[role] = join(dataDir, role + '.tar');
      execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-C', stage, '-cf', raw[role], wrapper]);
    }
    const stamp = new Date().toISOString();
    await workers.upsert({ id, userId, runtimeKind: 'incus-vm', status: 'active', desiredRuntimeStatus: 'stopped',
      displayName: 'Stopped restored worker', createdAt: stamp, updatedAt: stamp, incusRecreation: marker });
    const validate = () => {
      const current = workers.get(userId, id);
      if (!current || current.runtimeKind !== 'incus-vm' || current.status !== 'active' || current.deletionPending ||
          current.desiredRuntimeStatus !== 'stopped' || JSON.stringify(current.incusRecreation) !== JSON.stringify(marker))
        throw new Error('Stopped restore durable authority changed');
    };
    validate(); submitted = true; nativeSettled = false;
    const created = await runtime.createCanonicalRestore(opts, undefined, true);
    incarnation = created.config['volatile.uuid'];
    if (!incarnation) throw new Error('Native creation did not return an exact incarnation');
    nativeSettled = true;
    marker.replacementIncarnation = incarnation;
    await workers.transitionIncusRecreation(userId, id, { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    nativeSettled = false;
    await runtime.restoreCanonicalArchives(opts, incarnation, { workspace: raw.workspace, agents: raw.agents }, validate,
      undefined, [], [{ path: '/var/lib/docker', archivePath: raw.docker }]);
    nativeSettled = true;
    const inactive = await runtime.client.exec(opts.containerName, ['bash', '-ec',
      'test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; cmp /restore/workspace/marker /restore/.agent-data/marker; cmp /restore/workspace/marker /run/agentor-docker-restore/docker/marker']);
    expect(inactive.returnCode, inactive.stdout + inactive.stderr).toBe(0);
    const canonicalNames = ['workspace', 'agents', 'docker'].map(role => opts.containerName + '-' + role);
    const before = await Promise.all(canonicalNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    nativeSettled = false;
    await runtime.finishCanonicalRestore(opts, incarnation, validate, 'stopped');
    nativeSettled = true;
    validate();
    const promoted = await runtime.client.getInstance(opts.containerName);
    expect(promoted.status).toBe('Stopped');
    expect(promoted.config['user.agentor.restore']).toBeUndefined();
    expect(promoted.config['user.agentor.recreation']).toBe(nonce);
    expect(promoted.config['volatile.uuid']).toBe(incarnation);
    expect(promoted.devices.workspace?.path).toBe('/workspace');
    expect(promoted.devices.agents?.path).toBe('/home/agent/.agent-data');
    expect(promoted.devices.eth0?.['security.mac_filtering']).toBe('true');
    expect(promoted.devices.eth0?.['security.ipv4_filtering']).toBe('true');
    // A raw guest boot (no runtime provision call) must still not activate the
    // restored Docker state or worker services. This is independent of stop.
    nativeSettled = false;
    await runtime.client.startInstance(opts.containerName);
    nativeSettled = true;
    let ready = false;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try { ready = (await runtime.client.exec(opts.containerName, ['true'])).returnCode === 0; } catch { /* boot */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(ready).toBe(true);
    const unprovisioned = await runtime.client.exec(opts.containerName, ['bash', '-ec',
      'test ! -e /run/agentor/provisioned; test ! -e /run/agentor/worker.env; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; cmp /workspace/marker /home/agent/.agent-data/marker']);
    expect(unprovisioned.returnCode, unprovisioned.stdout + unprovisioned.stderr).toBe(0);
    nativeSettled = false;
    await runtime.stop(opts, incarnation);
    await runtime.remove(opts, incarnation);
    nativeSettled = true;
    const archived = await runtime.inspectOfflineBackupStorage(opts);
    expect(archived.docker).toBe(true);
    const after = await Promise.all(canonicalNames.map(name => runtime.client.getCustomVolume(config.incusStoragePool, name)));
    for (const [index, volume] of after.entries()) {
      expect(volume.created_at).toBe(before[index]!.created_at);
      expect(volume.config).toEqual(before[index]!.config);
      expect(volume.used_by).toEqual([]);
    }
    console.info('Stopped promotion and unprovisioned boot kept services inactive; archive retained exact canonical storage including initialized Docker');
  } catch (error) {
    console.error('Stopped native restore gate failed', error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    if (submitted && nativeSettled && incarnation) {
      try { await runtime.rollbackRecreation(opts, marker); await runtime.removeStorage(opts); cleaned = true; }
      catch (error) { console.error('Exact stopped native restore fixture retained', { dataDir, id, nonce, incarnation, error: String(error) }); }
    } else if (!submitted) cleaned = true;
    else console.error('Unconfirmed native mutation retained for exact recovery', { dataDir, id, nonce, incarnation });
    if (cleaned) await rm(dataDir, { recursive: true, force: true });
    expect(cleaned, 'Exact fixture cleanup must settle; unknown native authority remains quarantined').toBe(true);
  }
});
