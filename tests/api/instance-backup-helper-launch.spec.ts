import { test, expect } from '@playwright/test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InstanceBackupManager } from '../../orchestrator/server/utils/instance-backup-manager';
import { InstanceBackupStore } from '../../orchestrator/server/utils/instance-backup-store';
import type { InstanceBackupJob } from '../../orchestrator/server/utils/instance-backup-types';
import { beginInstanceRestore, instanceSnapshotActive } from '../../orchestrator/server/utils/instance-snapshot-gate';

async function fixture(mode: 'success' | 'running-error' | 'never-started' = 'success') {
  const dataDir = await mkdtemp(join(tmpdir(), 'agentor-helper-launch-')), id = randomUUID();
  const stage = join(dataDir, 'instance-restore-staging', 'restore-' + id);
  await mkdir(stage, { recursive: true }); await writeFile(join(stage, 'keep'), 'private staged bytes');
  const stamp = new Date().toISOString(), image = 'sha256:' + 'a'.repeat(64), helperId = 'b'.repeat(64);
  const job: InstanceBackupJob = { schemaVersion: 1, id, userId: 'platform-admin', operation: 'restore', provider: 'local',
    status: 'running', phase: 'helper-starting', progress: 70, bytesProcessed: 0, createdAt: stamp, updatedAt: stamp, logs: [] };
  const store = new InstanceBackupStore(dataDir); await store.init(); await store.saveJob(job);
  const events: string[] = []; let spec: any, running = false, exited = false, removed = false, exitCode = 0;
  let ledgerStatus: InstanceBackupJob['status'] = 'succeeded';
  const data = { Type: 'bind', Source: '/operator/private-data', Destination: dataDir };
  const current = { Id: 'c'.repeat(64), Image: image, Config: { Image: 'mutable:tag' }, Mounts: [data] };
  const info = () => ({ Id: helperId, Image: image, Config: { Env: spec?.Env, Labels: spec?.Labels }, Mounts: [data],
    State: { Status: exited ? 'exited' : running ? 'running' : 'created', Running: running, Restarting: false, Dead: false,
      StartedAt: running || exited ? stamp : '0001-01-01T00:00:00Z', FinishedAt: exited ? stamp : '0001-01-01T00:00:00Z', ExitCode: exitCode } });
  const helper = { id: helperId, inspect: async () => { if (removed) throw Object.assign(new Error('missing'), { statusCode: 404 }); return info(); },
    start: async () => { events.push('start'); if (mode !== 'never-started') running = true;
      if (mode !== 'success') throw new Error('Lost start response'); },
    remove: async (options: any) => { events.push('remove'); expect(options.force).toBe(false); removed = true; },
    wait: async () => { events.push('wait'); running = false; exited = true;
      await store.saveJob({ ...job, status: ledgerStatus, phase: ledgerStatus === 'succeeded' ? 'complete' : 'failed' }); return { StatusCode: exitCode }; } };
  const docker = { getContainer: (requested: string) => requested === helperId ? helper : { inspect: async () => current },
    createContainer: async (value: any) => { spec = value; events.push('create'); return helper; },
    listContainers: async () => [] };
  const manager = new InstanceBackupManager({ dataDir, store, docker: docker as any, backupManager: {} as any });
  await manager.init(); // initial helper-starting state deliberately remains held.
  const internal = manager as any;
  const launch = () => internal.launchRestoreHelper(job, stage, new AbortController().signal, async () => {
    events.push('handoff'); job.phase = 'applying'; await store.saveJob(job);
  });
  return { dataDir, stage, job, store, manager, internal, events, image, helperId, info, launch,
    spec: () => spec, exit: () => { running = false; exited = true; },
    disagree: (status: InstanceBackupJob['status'], code: number) => { ledgerStatus = status; exitCode = code; },
    cleanup: async () => { manager.stop(); for (const release of internal.restoreBarriers.values()) release();
      internal.restoreBarriers.clear(); await rm(dataDir, { recursive: true, force: true }); } };
}

test('helper image is immutable and acknowledged ownership is persisted before start dispatch', async () => {
  const f = await fixture(); try {
    await f.launch();
    expect(f.spec().Image).toBe(f.image); expect(f.spec().HostConfig.AutoRemove).toBe(false);
    expect(f.events).toEqual(['create', 'handoff', 'start', 'wait', 'remove']);
    expect(f.store.getJob(f.job.id)?.restoreHelper).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('lost start acknowledgement retains possibly active exact helper and private staging', async () => {
  const f = await fixture('running-error'); try {
    await expect(f.launch()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
    expect(f.events).not.toContain('remove'); expect(await readFile(join(f.stage, 'keep'), 'utf8')).toBe('private staged bytes');
    expect(f.store.getJob(f.job.id)?.restoreHelper).toEqual({ containerId: f.helperId, imageId: f.image });
    await f.internal.fail(f.job, new Error('Transport closed'));
    expect(f.store.getJob(f.job.id)?.status).toBe('running'); expect(instanceSnapshotActive()).toBe(true);
    await expect(f.manager.cancel(f.job.id)).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_ALREADY_APPLYING' });
    f.manager.stop(); expect(instanceSnapshotActive()).toBe(true);
  } finally { await f.cleanup(); }
});

test('exact never-started proof permits non-force cleanup without executing or adopting a name', async () => {
  const f = await fixture('never-started'); try {
    await expect(f.launch()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_NOT_STARTED' });
    expect(f.events).toEqual(['create', 'handoff', 'start', 'remove']); expect(f.job.restoreHelper).toBeUndefined();
  } finally { await f.cleanup(); }
});

test('startup retains helper-owned stage and ledger; succeeded alone cannot clear a running helper fence', async () => {
  const f = await fixture('running-error'); try {
    await expect(f.launch()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
    await f.store.saveJob({ ...f.job, status: 'succeeded', phase: 'complete' });
    await f.manager.getJob(f.job.id); expect(instanceSnapshotActive()).toBe(true); expect(f.events).not.toContain('remove');
    f.exit(); const result = await f.manager.getJob(f.job.id);
    expect(result?.status).toBe('succeeded'); expect(result).not.toHaveProperty('restoreHelper');
    expect(instanceSnapshotActive()).toBe(false);
    await expect(readFile(join(f.stage, 'keep'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('restart retention includes legacy in-flight and failed native quarantine but cleans pre-handoff work', async () => {
  for (const mode of ['legacy-applying', 'rollback-incomplete', 'pre-handoff'] as const) {
    const f = await fixture(); try {
      for (const release of f.internal.restoreBarriers.values()) release(); f.internal.restoreBarriers.clear();
      const source = { ...f.job, phase: mode === 'pre-handoff' ? 'verifying' : 'applying',
        ...(mode === 'rollback-incomplete' ? { status: 'failed' as const, errorCode: 'INSTANCE_RESTORE_ROLLBACK_INCOMPLETE' } : {}) };
      await f.store.saveJob(source);
      const reloaded = new InstanceBackupManager({ dataDir: f.dataDir, store: f.store, backupManager: {} as any });
      await reloaded.init();
      if (mode === 'pre-handoff') {
        expect(f.store.getJob(f.job.id)).toMatchObject({ phase: 'interrupted', retryable: true });
        await expect(readFile(join(f.stage, 'keep'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(f.store.getJob(f.job.id)).toEqual(source); expect(await readFile(join(f.stage, 'keep'), 'utf8')).toBe('private staged bytes');
        expect(instanceSnapshotActive()).toBe(true);
      }
      for (const release of (reloaded as any).restoreBarriers.values()) release();
    } finally { await f.cleanup(); }
  }
});

test('pre-migration startup check blocks an executing helper only on the exact DATA mount', async () => {
  const f = await fixture(); try {
    const docker = f.internal.docker;
    docker.listContainers = async () => [{ Id: f.helperId, Mounts: [{ Type: 'bind', Source: '/operator/private-data', Destination: f.dataDir }] }];
    await expect(f.manager.assertStartupSafe()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_ACTIVE' });
    docker.listContainers = async () => [{ Id: f.helperId, Mounts: [{ Type: 'bind', Source: '/foreign/data', Destination: f.dataDir }] }];
    // A rejected process must not begin handling requests after the helper
    // disappears without completing a new safe startup.
    await expect(f.manager.assertStartupSafe()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_ACTIVE' });
    const restarted = new InstanceBackupManager({ dataDir: f.dataDir, docker, backupManager: {} as any });
    await expect(restarted.assertStartupSafe()).resolves.toBeUndefined();
  } finally { await f.cleanup(); }
});

test('startup settles exact terminal handoff before a retained barrier can block sign-in', async () => {
  const f = await fixture('running-error'); try {
    await expect(f.launch()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
    await f.store.saveJob({ ...f.job, status: 'succeeded', phase: 'complete' }); f.exit();
    const restarted = new InstanceBackupManager({ dataDir: f.dataDir, store: f.store,
      docker: f.internal.docker, backupManager: {} as any });
    await restarted.init();
    expect(f.store.getJob(f.job.id)?.restoreHelper).toBeUndefined(); expect(instanceSnapshotActive()).toBe(false);
    expect(f.events).toContain('remove');
    await expect(readFile(join(f.stage, 'keep'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

for (const mismatch of [{ status: 'succeeded' as const, code: 137 }, { status: 'failed' as const, code: 0 }])
  test(`terminal helper ${mismatch.status}/exit${mismatch.code} cannot release staging or its exact acknowledgement`, async () => {
    const f = await fixture(); try {
      f.disagree(mismatch.status, mismatch.code);
      await expect(f.launch()).rejects.toMatchObject({ code: 'INSTANCE_RESTORE_HELPER_UNCERTAIN' });
      expect(f.events).not.toContain('remove');
      await f.manager.getJob(f.job.id); expect(instanceSnapshotActive()).toBe(true);
      expect(f.store.getJob(f.job.id)?.restoreHelper).toEqual({ containerId: f.helperId, imageId: f.image });
      expect(await readFile(join(f.stage, 'keep'), 'utf8')).toBe('private staged bytes');
    } finally { await f.cleanup(); }
  });
