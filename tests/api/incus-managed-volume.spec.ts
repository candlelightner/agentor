import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncusWorkerRuntime } from '../../orchestrator/server/utils/incus-worker-runtime';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import type { Config } from '../../orchestrator/server/utils/config';

test('real retained compute seeds an Incus filesystem staging disk before any disposable-root replacement', async () => {
  test.skip(process.env.INCUS_MANAGED_VOLUME_TEST !== 'true', 'Explicit disposable managed-storage primitive gate');
  test.setTimeout(600_000);
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-incus-volume-seed-'));
  const config = { dataDir, incusEnabled: true, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusNetwork: 'incusbr0', incusStoragePool: 'default',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase7-bounded', containerPrefix: 'agentor-worker',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', workerImagePrefix: '', workerImage: 'agentor-worker:latest' } as Config;
  const runtime = new IncusWorkerRuntime(config), client = runtime.client;
  const id = randomUUID(), volumeId = randomUUID();
  const owner = { id, userId: 'managed-volume-primitive', containerName: `${config.containerPrefix}-${id}` };
  const options = { ...owner, dockerEnabled: false, userEnv: zeroUserEnvVars(owner.userId),
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '', exposeApis: {} },
    capabilitiesJson: [], instructionsJson: [], workerJson: { id, displayName: 'storage primitive', repos: [], initScript: '', gitName: '', gitEmail: '' } };
  const installation = await backupInstallationId(dataDir);
  const volumeName = `agentor-persist-${volumeId}`;
  const source = '/opt/agentor-volume-seed-fixture', staging = `/run/agentor-volume-seed/${volumeId}`;
  let incarnation: string | undefined, volumeCreationAttempted = false, primaryFailure = false;
  const checked = async (command: string[], ...args: string[]) => {
    const result = await client.exec(owner.containerName, [...command, ...args]);
    expect(result.returnCode, result.stderr + result.stdout).toBe(0);
    return result.stdout;
  };
  const ready = async () => expect.poll(async () => {
    try { return (await client.exec(owner.containerName, ['true'])).returnCode; } catch { return -1; }
  }, { timeout: 120_000, intervals: [500, 1000] }).toBe(0);
  try {
    const instance = await runtime.create(options); incarnation = instance.config['volatile.uuid'];
    expect(incarnation).toBeTruthy();
    await checked(['python3', '-c', [
      'import os, pathlib, sys, struct', 'p=pathlib.Path(sys.argv[1]); p.mkdir()',
      "(p/'bytes').write_bytes(bytes([0,255,10,13,128]))", "os.chown(p/'bytes',1000,1000); os.chmod(p/'bytes',0o640)",
      "os.link(p/'bytes',p/'hardlink'); os.symlink('bytes',p/'symlink')",
      "os.setxattr(p/'bytes','user.agentor-seed',b'metadata-preserved')",
      "acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])",
      "os.setxattr(p/'bytes','system.posix_acl_access',acl)",
      "os.utime(p/'bytes',ns=(1700000000000000000,1700000000123456789))",
    ].join('\n')], source);
    await checked(['bash', '-ec', 'cp /bin/true "$1/capability-exec"; setcap cap_net_bind_service=ep "$1/capability-exec"; getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'source-capability'], source);
    await runtime.stop(owner, incarnation);
    // Boot the retained root with /run empty: no worker/dockerd/plugin processes
    // from the prior boot can write while the guest agent copies its directory.
    volumeCreationAttempted = true;
    await client.createCustomVolume(config.incusStoragePool, { name: volumeName, content_type: 'filesystem', config: {
      'user.agentor.installation': installation, 'user.agentor.owner': owner.userId,
      'user.agentor.id': owner.id, 'user.agentor.volume-id': volumeId, 'user.agentor.target': source,
    } });
    const retained = await client.getInstance(owner.containerName);
    expect(retained.config['volatile.uuid']).toBe(incarnation);
    await client.updateInstanceDevices(owner.containerName, { ...retained.devices,
      seed: { type: 'disk', pool: config.incusStoragePool, source: volumeName, path: staging } });
    await client.startInstance(owner.containerName); await ready();
    await checked(['bash', '-ec', 'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; mountpoint -q "$1"', 'seed-preflight'], staging);
    await checked(['bash', '-ec',
      'set -o pipefail; tar --format=pax --xattrs --xattrs-include="*" --acls --numeric-owner -cpf - -C "$1" . | tar --xattrs --xattrs-include="*" --acls --numeric-owner -xpf - -C "$2"; sync -f "$2"', 'seed-copy'], source, staging);
    const verify = [
      'import os,pathlib,sys,struct', 'p=pathlib.Path(sys.argv[1]); a=p/"bytes"; b=p/"hardlink"',
      'assert a.read_bytes()==bytes([0,255,10,13,128])', 'assert os.stat(a).st_ino==os.stat(b).st_ino',
      'assert os.readlink(p/"symlink")=="bytes"', 'assert os.stat(a).st_uid==1000 and os.stat(a).st_gid==1000',
      'assert os.stat(a).st_mode & 0o777 == 0o640',
      'assert os.getxattr(a,"user.agentor-seed")==b"metadata-preserved"',
      "acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',*entry) for entry in [(1,6,0xffffffff),(2,4,1001),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])",
      'assert os.getxattr(a,"system.posix_acl_access")==acl',
      'assert os.stat(a).st_mtime_ns==1700000000123456789',
    ].join('\n');
    await checked(['python3', '-c', verify], staging);
    await checked(['python3', '-c', verify], source); // Original root/data still intact.
    await checked(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'seeded-capability'], staging);
    await runtime.stop(owner, incarnation);
    const beforeDeclaration = await client.getInstance(owner.containerName);
    expect(beforeDeclaration.config['volatile.uuid']).toBe(incarnation);
    await client.updateInstanceDevices(owner.containerName, { ...beforeDeclaration.devices,
      seed: { type: 'disk', pool: config.incusStoragePool, source: volumeName, path: source } });
    await runtime.start(options, incarnation);
    await checked(['bash', '-ec', 'mountpoint -q "$1"; systemctl is-active --quiet agentor-worker', 'declared-volume'], source);
    await checked(['python3', '-c', verify], source);
    await checked(['bash', '-ec', 'getcap "$1/capability-exec" | grep -q "cap_net_bind_service=ep"', 'declared-capability'], source);
    const found = await client.getCustomVolume(config.incusStoragePool, volumeName);
    expect(found.config['user.agentor.volume-id']).toBe(volumeId);
    expect(found.used_by).toHaveLength(1);
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    const failures: string[] = [];
    try {
      if (incarnation) await runtime.remove(owner, incarnation);
      if (volumeCreationAttempted) {
        let volume;
        try { volume = await client.getCustomVolume(config.incusStoragePool, volumeName); }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error; }
        if (volume) {
          expect(volume).toMatchObject({ name: volumeName, type: 'custom', content_type: 'filesystem', config: {
            'user.agentor.installation': installation, 'user.agentor.owner': owner.userId,
            'user.agentor.id': owner.id, 'user.agentor.volume-id': volumeId, 'user.agentor.target': source } });
          expect(volume.used_by ?? []).toEqual([]);
          await client.deleteCustomVolume(config.incusStoragePool, volumeName);
        }
      }
      await runtime.removeStorage(owner);
    } catch (error) { failures.push(String(error)); }
    if (!failures.length) await rm(dataDir, { recursive: true, force: true });
    else { console.error('Preserving exact failed storage fixture', owner.containerName, volumeName, dataDir, failures);
      if (!primaryFailure) throw new Error('Managed storage primitive cleanup failed'); }
  }
});
