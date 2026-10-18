import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { IncusVolumeSizeHelper, INCUS_OFFLINE_SCAN_MOUNT, type IncusSizeHelperState } from '../../orchestrator/server/utils/incus-volume-size-helper';
import type { Config } from '../../orchestrator/server/utils/config';
import { IncusRequestRejected } from '../../orchestrator/server/utils/incus-client';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { ManagedVolumeSizingManager } from '../../orchestrator/server/utils/managed-volume-sizing';
import { registerOperationHelper } from '../../orchestrator/server/utils/operation-helper-registry';

async function fixture(run: (f: any) => Promise<void>) {
  const id = randomUUID(), installation = randomUUID(), config = { incusProject: 'agentor', incusStoragePool: 'pool', incusWorkerImage: 'trusted-platform' } as Config;
  let state: IncusSizeHelperState | undefined = { installation, copy: true }, instance: any, copy: any;
  const calls: any[] = [], control = { failure: '', terminal: 'Success', output: 'AGENTOR_VOLUME_SIZE {"ok":true}\n',
    stderr: '', closeCount: 0, holdBoot: false, rejectPersist: false, operationMissing: false };
  const controller = new AbortController();
  const metadata = { 'user.agentor.installation': installation, 'user.agentor.helper': 'volume-size', 'user.agentor.operation': id };
  const missing = () => { throw Object.assign(new Error('missing'), { statusCode: 404 }); };
  const client: any = {
    getInstance: async () => instance ? structuredClone(instance) : missing(),
    getCustomVolume: async () => copy ? structuredClone(copy) : missing(),
    getImageAlias: async (name: string) => { calls.push(['alias', name]); return { target: 'a'.repeat(64) }; },
    getImage: async () => ({ type: 'virtual-machine', fingerprint: 'a'.repeat(64), properties: {
      source_image_id: 'sha256:' + 'b'.repeat(64), recipe_id: 'c'.repeat(64), source_architecture: 'amd64',
      converter_version: 'v0.4.0', bootstrap_generation: '3' } }),
    copyCustomVolume: async (pool: string, source: string, name: string, fields: any, accepted: any) => {
      calls.push(['copy', pool, source, name]);
      if (control.failure === 'reject-copy') throw new IncusRequestRejected('denied', 403, 403);
      copy = { name, project: 'agentor', type: 'custom', content_type: 'block', used_by: [], created_at: '2026-10-04T00:00:00Z', config: fields };
      if (control.failure === 'unknown') throw new Error('lost acknowledgement');
      await accepted('/1.0/operations/' + id);
      if (control.failure === 'pending') throw new Error('wait timeout');
    },
    createInstance: async (spec: any, accepted: any) => {
      calls.push(['create', spec]);
      if (control.failure === 'reject-create') throw new IncusRequestRejected('invalid', 409, 409);
      instance = { ...spec, status: 'Stopped', config: { ...spec.config, 'volatile.uuid': randomUUID() } };
      if (control.failure === 'unknown-create') throw new Error('lost create acknowledgement');
      await accepted('/1.0/operations/' + id);
      if (control.failure === 'pending-create') throw new Error('create wait timeout');
      return instance;
    },
    startInstance: async () => { calls.push(['start']); instance.status = 'Running'; },
    stopInstance: async () => { calls.push(['stop']); instance.status = 'Stopped'; },
    deleteInstance: async () => { calls.push(['delete-helper']); instance = undefined; },
    deleteCustomVolume: async () => { calls.push(['delete-copy']); copy = undefined; },
    exec: async () => { if (control.holdBoot) { controller.abort(); throw new Error('agent unavailable'); } return { returnCode: 0 }; },
    execStream: async (_name: string, command: string[]) => {
      calls.push(['exec', command]); const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      stdin.on('finish', () => { stdout.end(control.output); stderr.end(control.stderr); });
      return { stdin, stdout, stderr, result: Promise.resolve(0), close() { control.closeCount++; } };
    },
    request: async () => control.operationMissing ? missing() :
      ({ status: control.terminal, status_code: control.terminal === 'Running' ? 103 : 200 }),
  };
  const helper = new IncusVolumeSizeHelper(config, client);
  const source: any = { id: randomUUID(), dockerName: 'canonical-source', incarnation: 'd'.repeat(64), live: false,
    runtimeKind: 'incus-vm', incus: { attached: true, contentType: 'block' } };
  const persist = async (value?: IncusSizeHelperState) => { if (control.rejectPersist && value?.pending?.operation) throw new Error('persistence failed'); state = value; };
  const scan = () => helper.scan(id, source, state!, persist, async () => { calls.push(['source-check']); }, controller.signal, 'fixed scanner');
  await run({ id, metadata, source, calls, control, helper, scan, persist, getState: () => state, getCopy: () => copy,
    setInstance: (value: any) => { instance = value; } });
}

test('stopped block sizing copies natively into a networkless readonly helper and cleans helper before copy', async () => {
  await fixture(async ({ scan, calls, getState, getCopy }) => {
    expect(await scan()).toContain('AGENTOR_VOLUME_SIZE');
    expect(calls.find((c: any) => c[0] === 'alias')[1]).toBe('trusted-platform');
    const spec = calls.find((c: any) => c[0] === 'create')[1];
    expect(spec.profiles).toEqual([]); expect(spec.devices.docker.readonly).toBe('true');
    expect(Object.values(spec.devices).some((device: any) => device.type === 'nic')).toBe(false);
    expect(spec.config['user.agentor.id']).toBeUndefined();
    expect(calls.findIndex((c: any) => c[0] === 'delete-helper')).toBeLessThan(calls.findIndex((c: any) => c[0] === 'delete-copy'));
    expect(getState()).toBeUndefined(); expect(getCopy()).toBeUndefined();
    expect(INCUS_OFFLINE_SCAN_MOUNT).toContain('ro,noload,nodev,nosuid,noexec');
    expect(INCUS_OFFLINE_SCAN_MOUNT).toContain('blockdev --getro'); expect(INCUS_OFFLINE_SCAN_MOUNT).toContain('needs_recovery');
    expect(INCUS_OFFLINE_SCAN_MOUNT).not.toMatch(/mkfs|fsck|agentor-docker-storage/);
  });
});

test('definitive copy/create rejection releases helper reservation but lost create acknowledgement does not', async () => {
  for (const failure of ['reject-copy', 'reject-create', 'unknown-create', 'pending-create'])
    await fixture(async ({ scan, control, getState, calls }) => {
      control.failure = failure; control.terminal = 'Running';
      await expect(scan()).rejects.toThrow();
      if (failure.startsWith('reject')) expect(getState()).toBeUndefined();
      else {
        expect(getState()?.pending?.kind).toBe('create');
        expect(calls.some((c: any) => c[0] === 'delete-helper' || c[0] === 'delete-copy')).toBe(false);
      }
    });
});

test('accepted-operation persistence failure retains unknown acknowledgement rather than authorizing cleanup', async () => {
  await fixture(async ({ scan, control, getState, calls }) => {
    control.rejectPersist = true;
    await expect(scan()).rejects.toThrow('ambiguous');
    expect(getState()?.pending).toEqual({ kind: 'copy' });
    expect(calls.some((c: any) => c[0].startsWith('delete'))).toBe(false);
  });
});

test('boot cancellation and excessive helper output clean only helper resources and do not return a measurement', async () => {
  for (const failure of ['boot', 'stdout', 'stderr']) await fixture(async ({ scan, control, getState, calls }) => {
    if (failure === 'boot') control.holdBoot = true;
    if (failure === 'stdout') control.output = 'x'.repeat(32769);
    if (failure === 'stderr') control.stderr = 'x'.repeat(32769);
    await expect(scan()).rejects.toThrow();
    expect(getState()).toBeUndefined();
    expect(calls.some((c: any) => c[0] === 'delete-helper')).toBe(true);
    if (failure !== 'boot') expect(control.closeCount).toBe(1);
  });
});

test('filesystem and detached block sizing do not copy or mutate the original devices', async () => {
  for (const type of ['filesystem', 'block']) await fixture(async ({ source, getState, scan, calls, persist }) => {
    source.incus.contentType = type; source.incus.attached = false; await persist({ ...getState(), copy: false });
    await scan(); expect(calls.some((c: any) => c[0] === 'copy')).toBe(false);
    const disks = calls.find((c: any) => c[0] === 'create')[1].devices;
    expect(disks[type === 'filesystem' ? 'scan' : 'docker']).toMatchObject({ source: 'canonical-source', readonly: 'true' });
  });
});

test('unknown acceptance and nonterminal copy waits retain cleanup authority without deleting data', async () => {
  for (const failure of ['unknown', 'pending']) await fixture(async ({ scan, calls, control, helper, id, persist, getState, getCopy }) => {
    control.failure = failure; control.terminal = 'Running';
    await expect(scan()).rejects.toThrow(/ambiguous|pending/);
    expect(getState()?.pending?.kind).toBe('copy'); expect(getCopy()).toBeTruthy();
    expect(calls.some((c: any) => c[0].startsWith('delete'))).toBe(false);
    control.terminal = 'Success';
    if (failure === 'unknown') await expect(helper.cleanup(id, getState()!, persist)).rejects.toThrow('ambiguous');
    else { await helper.cleanup(id, getState()!, persist); expect(getState()).toBeUndefined(); }
  });
});

test('same-name foreign helper or canonical worker metadata never permits cleanup', async () => {
  await fixture(async ({ helper, id, metadata, getState, persist, setInstance, calls }) => {
    setInstance({ name: `asz-${id}`, type: 'virtual-machine', status: 'Stopped',
      config: { ...metadata, 'volatile.uuid': randomUUID(), 'user.agentor.id': randomUUID() } });
    await expect(helper.cleanup(id, getState()!, persist)).rejects.toThrow('ownership');
    expect(calls.some((c: any) => c[0].startsWith('delete'))).toBe(false);
  });
});

test('expired accepted operation without daemon continuity proof remains quarantined and never permits cleanup', async () => {
  await fixture(async ({ scan, control, helper, id, persist, getState, calls }) => {
    control.failure = 'pending'; control.operationMissing = true;
    await expect(scan()).rejects.toMatchObject({ statusCode: 404 });
    const retained = structuredClone(getState());
    expect(retained?.pending).toEqual({ kind: 'copy', operation: '/1.0/operations/' + id });
    await expect(helper.cleanup(id, retained!, persist)).rejects.toMatchObject({ statusCode: 404 });
    expect(getState()).toEqual(retained);
    expect(calls.some((call: any) => call[0].startsWith('delete'))).toBe(false);
    expect(calls.filter((call: any) => call[0] === 'copy')).toHaveLength(1);
  });
});

test('offline mount preflight rejects dirty ext4, journal recovery and writable block devices before mount or scan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-offline-mount-check-'));
  try {
    const fakeDevice = join(root, 'incus_docker'); await writeFile(fakeDevice, 'fake-device');
    for (const condition of ['dirty', 'journal', 'writable', 'clean']) {
      const state = condition === 'dirty' ? 'not clean' : 'clean';
      const features = condition === 'journal' ? 'has_journal needs_recovery' : 'has_journal';
      const fixture = `systemctl(){ return 1; }; blockdev(){ echo ${condition === 'writable' ? '0' : '1'}; }; blkid(){ echo ext4; };
dumpe2fs(){ printf 'Filesystem state:     ${state}\\nFilesystem features:  ${features}\\n'; };
mkdir(){ :; }; mount(){ echo mounted; }; mountpoint(){ :; }; findmnt(){ echo ro,noload; };\n`;
      // CI does not grant a real test block device. Replace only device-kind
      // checks; execute the production clean/journal/RO gates unchanged.
      const script = fixture + INCUS_OFFLINE_SCAN_MOUNT.replace('/dev/disk/by-id/*incus_docker*', JSON.stringify(fakeDevice)).replaceAll('test -b', 'test -f');
      let code = 0, output = '';
      try { output = execFileSync('bash', ['-ec', script, 'offline-test', 'block', 'console.log("scanned")']).toString(); }
      catch (error: any) { code = error.status; output = error.stdout.toString(); }
      expect(code).toBe(condition === 'clean' ? 0 : 1);
      if (condition === 'clean') expect(output).toContain('mounted\nscanned');
      else expect(output).not.toMatch(/mounted|scanned/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale cleanup reserves ownership before awaiting and concurrent cleanup cannot overwrite pending helper state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-sizing-cleanup-race-'));
  const original = IncusVolumeSizeHelper.prototype.cleanup;
  let releaseScan: (() => void) | undefined;
  try {
    const installation = await backupInstallationId(root);
    const manager = new ManagedVolumeSizingManager(root, { docker: { listContainers: async () => [] } as any,
      scan: async () => ({ allocatedBytes: 1, logicalBytes: 1, entriesScanned: 1 }) });
    const resource: any = { id: randomUUID(), ownerKey: 'owner', workerId: randomUUID(), userId: 'owner',
      incarnation: 'a'.repeat(64), live: false };
    const job = await manager.create('owner', async () => resource, true);
    await expect.poll(async () => (await manager.get(job.id))?.status).toBe('succeeded');
    const pending = { installation, copy: true, pending: { kind: 'copy' as const, operation: '/1.0/operations/' + randomUUID() } };
    releaseScan = registerOperationHelper(job.id);
    await (manager as any).persistIncusHelper(job.id, pending);
    let cleanups = 0, unblock!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { unblock = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    IncusVolumeSizeHelper.prototype.cleanup = async (_id, state, persist) => {
      cleanups++; expect(state).toEqual(pending); entered(); await barrier; await persist(undefined);
    };
    await Promise.all([manager.cleanupStaleHelpers(), manager.cleanupStaleHelpers()]);
    expect(cleanups).toBe(0); expect(manager.getStored(job.id)?.incusHelper).toEqual(pending);
    releaseScan(); releaseScan = undefined;
    const first = manager.cleanupStaleHelpers(); await started;
    const second = manager.cleanupStaleHelpers(); await second;
    expect(cleanups).toBe(1); expect(manager.getStored(job.id)?.incusHelper).toEqual(pending);
    await expect(manager.create('owner', async () => resource, true)).rejects.toThrow('requires cleanup');
    expect((manager as any).cleanupReservations()).toHaveLength(1);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    unblock(); await first; expect(manager.getStored(job.id)?.incusHelper).toBeUndefined();
  } finally {
    releaseScan?.(); IncusVolumeSizeHelper.prototype.cleanup = original;
    await rm(root, { recursive: true, force: true });
  }
});
