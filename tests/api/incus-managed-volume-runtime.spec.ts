import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IncusManagedVolumeRuntime, INCUS_PERSISTENCE_TARGET_CHECK, INCUS_SELECTION_DIRECTORY_CHECK, INCUS_LIVE_PROOF, INCUS_LIVE_SIGNAL } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { ManagedVolumeStore, assertIncusLiveResolved } from '../../orchestrator/server/utils/managed-volume-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { ManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';
import { useWorkerStore } from '../../orchestrator/server/utils/services';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { beginInstanceSnapshot } from '../../orchestrator/server/utils/instance-snapshot-gate';
import type { Config } from '../../orchestrator/server/utils/config';

async function fixture(run: (runtime: IncusManagedVolumeRuntime, v: any, calls: string[], state: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'incus-managed-adapter-'));
  const config = { dataDir: root, containerPrefix: 'agentor-worker', incusProject: 'agentor', incusStoragePool: 'default' } as Config;
  const store = new ManagedVolumeStore(root); await store.init();
  const v = await store.create('owner', 'worker', '/opt/models', undefined, 'incus-vm');
  const installation = await backupInstallationId(root), calls: string[] = [];
  const state: any = { volume: undefined, instance: { name: 'agentor-worker-worker', status: 'Running',
    config: { 'volatile.uuid': 'original' }, devices: {} } };
  const runtime = new IncusManagedVolumeRuntime(config, {
    matchesWorkerIdentity: async () => true,
    stop: async (_owner: any, uuid: string) => { calls.push('stop:' + uuid); state.instance.status = 'Stopped'; },
    client: {
      endpoint: 'https://incus.test',
      getInstance: async () => state.instance,
      getCustomVolume: async () => {
        if (state.lookupFailure) throw Object.assign(new Error('unavailable'), { statusCode: 503 });
        if (!state.volume) throw Object.assign(new Error('missing'), { statusCode: 404 }); return state.volume;
      },
      createCustomVolume: async (_pool: string, spec: any) => { calls.push('create-volume'); state.volume = { ...spec, type: 'custom', used_by: [] }; },
      deleteCustomVolume: async () => { calls.push('delete-volume'); state.volume = undefined; },
      updateInstanceDevices: async (_name: string, devices: any) => {
        calls.push('devices');
        if (!(state.ignoreDetach && !Object.keys(devices).length)) state.instance.devices = devices;
        if (state.lostAttach && Object.keys(devices).length) { state.lostAttach = false; throw new Error('lost attach response'); }
      },
      startInstance: async () => { calls.push('start'); state.instance.status = 'Running'; if (state.startFailure) throw new Error('lost start response'); },
      exec: async (_name: string, command: string[], options: any) => {
        if (command[4]?.includes("print('directory'")) {
          expect(options).toMatchObject({ user: 1000, group: 1000 });
          if (state.changedProbe) state.instance.config['volatile.uuid'] = 'foreign';
          return state.probeResponse ?? { returnCode: 0, stdout: 'directory\n', stderr: '' };
        }
        const copying = command[0] === 'timeout' && command[1] === '150';
        calls.push(copying ? 'copy' : 'exec');
        if (copying && state.copyFailure) return { returnCode: 1, stderr: 'ENOSPC', stdout: '' };
        if (copying && state.foreignAfterCopy) state.instance.devices[runtime.deviceKey(v)].path = '/foreign';
        return { returnCode: 0, stderr: '', stdout: '' };
      },
    },
  } as any);
  state.ownedVolume = { name: v.dockerName, type: 'custom', content_type: 'filesystem', used_by: [], config: {
    'user.agentor.installation': installation, 'user.agentor.owner': v.userId, 'user.agentor.id': v.workerId,
    'user.agentor.volume-id': v.id, 'user.agentor.target': v.target } };
  try { await run(runtime, v, calls, state); }
  finally { await rm(root, { recursive: true, force: true }); }
}

/** Fresh import tests require the extra project/creation/reference authority
 * of that seam. Do not weaken it to match older adapter fixtures. */
async function freshRestoreFixture(run: (runtime: IncusManagedVolumeRuntime, v: any, calls: string[], state: any) => Promise<void>) {
  await fixture(async (runtime, v, calls, state) => {
    state.ownedVolume = { ...state.ownedVolume, project: 'agentor', created_at: '2026-10-05T12:00:00Z' };
    runtime.worker.client.getCustomVolume = async (_pool: string, name: string) => {
      calls.push('lookup'); expect(name).toBe(v.dockerName);
      if (state.lookupError) throw state.lookupError;
      if (!state.volume || state.created && state.missingAfterCreate)
        throw Object.assign(new Error('missing'), { statusCode: 404 });
      return structuredClone(state.volume);
    };
    runtime.worker.client.createCustomVolume = async (pool: string, spec: any) => {
      calls.push('create'); expect(pool).toBe('default'); state.spec = structuredClone(spec);
      if (!state.createError || state.createBeforeError) {
        state.volume = { ...state.ownedVolume, ...structuredClone(spec), ...state.createdChanges };
        state.created = true;
      }
      if (state.createError) throw state.createError;
      return {} as any;
    };
    runtime.worker.client.getInstance = async () => { calls.push('compute'); throw new Error('Fresh storage allocation must not touch compute'); };
    await run(runtime, v, calls, state);
  });
}

test('fresh restore allocates exactly one pending attached unseeded UUID volume with strict native authority', async () => {
  await freshRestoreFixture(async (runtime, v, calls, state) => {
    const before = structuredClone(v), found = await runtime.freshRestoreVolume(v);
    expect(found).toEqual(state.volume); expect(v).toEqual(before);
    expect(found).toMatchObject({ project: 'agentor', created_at: '2026-10-05T12:00:00Z', used_by: [] });
    expect(state.spec).toEqual({ name: v.dockerName, content_type: 'filesystem', config: state.ownedVolume.config });
    expect(calls).toEqual(['lookup', 'create', 'lookup']);
  });
});

test('fresh restore refuses seeded/detached/nonpending/operation/live-intent records before native mutation', async () => {
  const changes = [{ seeded: true }, { attached: false },
    ...['ready', 'preparing', 'failed', 'detached'].map(state => ({ state })),
    { operation: { stage: 'complete' } },
    ...['not-submitted', 'unknown', 'accepted', 'settled'].map(attachment => ({ incusLive: {
      id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment,
    } })),
    { liveContainerId: 'legacy-source' }, { previousRestartPolicy: 'unless-stopped' },
    { storageRuntimeKind: 'legacy-docker' },
  ];
  for (const change of changes) await freshRestoreFixture(async (runtime, v, calls, state) => {
    await expect(runtime.freshRestoreVolume({ ...v, ...change } as any)).rejects.toThrow();
    expect(calls).toEqual([]); expect(state.volume).toBeUndefined();
  });
  for (const id of ['-'.repeat(36), 'a'.repeat(36), 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA'])
    await freshRestoreFixture(async (runtime, v, calls) => {
      await expect(runtime.freshRestoreVolume({ ...v, id, dockerName: `agentor-persist-${id}` })).rejects.toThrow();
      expect(calls).toEqual([]);
    });
});

test('fresh restore refuses all preexisting owned or foreign native data instead of adopting it', async () => {
  for (const foreign of [false, true]) await freshRestoreFixture(async (runtime, v, calls, state) => {
    state.volume = structuredClone(state.ownedVolume);
    if (foreign) state.volume.config['user.agentor.owner'] = 'another-owner';
    const before = structuredClone(state.volume);
    await expect(runtime.freshRestoreVolume(v)).rejects.toThrow(foreign ? /ownership/ : /fresh pending/);
    expect(calls).toEqual(['lookup']); expect(state.volume).toEqual(before);
  });
});

test('fresh restore create conflict or lost acknowledgement never retries or adopts read-back data', async () => {
  for (const lostAcknowledgement of [false, true]) await freshRestoreFixture(async (runtime, v, calls, state) => {
    state.createError = Object.assign(new Error(lostAcknowledgement ? 'lost creation acknowledgement' : 'native create conflict'),
      { statusCode: lostAcknowledgement ? 503 : 409 });
    state.createBeforeError = lostAcknowledgement;
    await expect(runtime.freshRestoreVolume(v)).rejects.toBe(state.createError);
    expect(calls).toEqual(['lookup', 'create']);
    // Even an exact owned volume found after an unknown acknowledgement is
    // not fresh authority for a subsequent call; it must not be adopted.
    if (lostAcknowledgement) {
      const before = structuredClone(state.volume);
      await expect(runtime.freshRestoreVolume(v)).rejects.toThrow(/fresh pending/);
      expect(calls).toEqual(['lookup', 'create', 'lookup']); expect(state.volume).toEqual(before);
    }
    expect(calls.filter(call => call === 'create')).toHaveLength(1);
  });
});

test('fresh restore requires project, creation time and unused reference authority after acknowledged allocation', async () => {
  const changes = [{ project: undefined }, { project: 'foreign' },
    { created_at: undefined }, { created_at: '' }, { created_at: 'not-a-timestamp' },
    { used_by: undefined }, { used_by: null },
    { used_by: ['/1.0/instances/agentor-worker-worker?project=agentor'] },
    { used_by: ['/1.0/instances/foreign?project=agentor'] },
    { used_by: ['/1.0/instances/agentor-worker-worker?project=foreign'] },
  ];
  for (const createdChanges of changes) await freshRestoreFixture(async (runtime, v, calls, state) => {
    state.createdChanges = createdChanges;
    await expect(runtime.freshRestoreVolume(v)).rejects.toThrow();
    expect(calls).toEqual(['lookup', 'create', 'lookup']);
    expect(state.volume).toBeTruthy(); expect(v.seeded).toBe(false); expect(v.state).toBe('pending');
  });
  await freshRestoreFixture(async (runtime, v, calls, state) => {
    state.missingAfterCreate = true;
    await expect(runtime.freshRestoreVolume(v)).rejects.toThrow(/authority is unavailable/);
    expect(calls).toEqual(['lookup', 'create', 'lookup']);
  });
  await freshRestoreFixture(async (runtime, v, calls, state) => {
    state.lookupError = Object.assign(new Error('API unavailable'), { statusCode: 503 });
    await expect(runtime.freshRestoreVolume(v)).rejects.toBe(state.lookupError);
    expect(calls).toEqual(['lookup']); expect(state.volume).toBeUndefined();
  });
});

async function liveFixture(run: (runtime: IncusManagedVolumeRuntime, v: any, calls: string[], state: any,
  persist: (next: any) => Promise<void>) => Promise<void>) {
  await fixture(async (runtime, v, calls, state) => {
    const store = new ManagedVolumeStore((runtime as any).config.dataDir); await store.init();
    state.instance.config['volatile.uuid'] = randomUUID(); state.boot = randomUUID();
    const baseExec = runtime.worker.client.exec.bind(runtime.worker.client);
    runtime.worker.client.exec = async (name: string, command: string[], options: any) => {
      if (command[0] === 'cat') return { returnCode: 0, stdout: state.boot, stderr: '' };
      if (command[0] === 'systemctl') return { returnCode: 0, stdout: '4242', stderr: '' };
      const proof = command.indexOf(INCUS_LIVE_PROOF), signal = command.indexOf(INCUS_LIVE_SIGNAL);
      if (proof >= 0) {
        const marker = command[proof + 3]!; calls.push('proof:' + marker);
        if (marker === 'attach-armed') state.armed = true;
        if (state.failProof === marker || (marker === 'safe-original' && state.armed) ||
            (marker === 'frozen-source' && !state.armed))
          return { returnCode: 1, stdout: '', stderr: '' };
        return { returnCode: 0, stdout: JSON.stringify({ bootId: state.boot, sourceSynced: !state.noSourceSync, safe: true }), stderr: '' };
      }
      if (signal >= 0) { calls.push('signal:' + command[signal + 3]); return { returnCode: 0, stdout: '', stderr: '' }; }
      return baseExec(name, command, options);
    };
    runtime.worker.client.pushFile = async () => { calls.push('push-helper'); };
    runtime.worker.client.stopInstance = async (_name: string, options: any) => {
      expect(options).toEqual({ force: true }); calls.push('force-stop'); state.instance.status = 'Stopped';
    };
    runtime.worker.client.waitForOperation = async (operation: string) => {
      calls.push('wait:' + operation); if (state.unsettled) throw new Error('wait timeout'); return {} as any;
    };
    runtime.worker.client.request = async () => ({ status: state.unsettled ? 'Running' : 'Success' }) as any;
    runtime.worker.client.updateInstanceDevices = async (_name: string, devices: any, accepted: any) => {
      const attach = !!devices[runtime.deviceKey(v)]; calls.push(attach ? 'attach' : 'detach');
      state.instance.devices = devices;
      state.volume.used_by = attach ? [`/1.0/instances/${state.instance.name}?project=agentor`] : [];
      if (state.lostAttach && attach || state.lostDetach && !attach) throw new Error('lost submission acknowledgement');
      await accepted?.(`/1.0/operations/${randomUUID()}`);
      if (state.unsettled) throw new Error('operation wait timeout');
    };
    const persist = async (next: any) => {
      calls.push(`save:${next.incusLive?.attachment ?? 'clear'}:${next.seeded}:${!!next.incusLive?.rollback}`);
      if (state.failSave?.(next)) throw new Error('injected store write failure');
      await store.save(next); state.saved = store.get(v.userId, v.id);
    };
    state.saved = v;
    await run(runtime, v, calls, state, persist);
  });
}

test('live adapter persists intent/acknowledgement/seeded authority before release, without stop/start on success', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    await runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist);
    expect(state.saved).toMatchObject({ seeded: true, incusLive: undefined });
    const before = (a: string, b: string) => expect(calls.indexOf(a)).toBeLessThan(calls.indexOf(b));
    before('save:not-submitted:false:false', 'push-helper');
    before('save:unknown:false:false', 'attach');
    before('save:accepted:false:false', 'save:settled:false:false');
    before('save:settled:false:false', 'signal:mount-settled');
    before('save:settled:true:false', 'signal:release');
    before('proof:restored', 'save:clear:true:false');
    expect(calls).not.toContain('force-stop'); expect(calls).not.toContain('start'); expect(calls).not.toContain('stop:original');
  });
});

test('live adapter never submits canonical mutation if initial/unknown intent cannot be persisted', async () => {
  for (const stage of ['not-submitted', 'unknown']) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.failSave = (next: any) => next.incusLive?.attachment === stage;
    await expect(runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist)).rejects.toThrow();
    expect(calls).not.toContain('attach'); expect(calls).not.toContain('signal:release');
    if (stage === 'not-submitted') expect(calls).not.toContain('push-helper');
  });
});

test('lost canonical acknowledgement or accepted-store failure retains unknown intent and never resends or thaws', async () => {
  for (const failure of ['ack', 'store']) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.lostAttach = failure === 'ack';
    state.failSave = (next: any) => failure === 'store' && next.incusLive?.attachment === 'accepted';
    await expect(runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist)).rejects.toThrow('Live persistence failed');
    expect(state.saved).toMatchObject({ seeded: false, incusLive: { attachment: 'unknown' } });
    const before = [...calls]; await expect(runtime.recoverLive(state.saved, persist)).rejects.toThrow('unknown authority');
    expect(calls).toEqual(before); expect(calls.filter(c => c === 'attach')).toHaveLength(1);
    expect(calls).not.toContain('signal:release'); expect(calls).not.toContain('detach'); expect(calls).not.toContain('force-stop');
  });
});

test('failed seeded-store write rolls back only synced frozen source with terminal detach, retaining both data sources', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.failSave = (next: any) => next.seeded;
    await expect(runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist)).rejects.toThrow('Live persistence failed');
    expect(state.saved).toMatchObject({ seeded: false, incusLive: undefined });
    expect(state.instance.status).toBe('Stopped'); expect(state.instance.devices).toEqual({}); expect(state.volume).toBeTruthy();
    expect(calls).not.toContain('signal:release');
    expect(calls.indexOf('proof:frozen-source')).toBeLessThan(calls.indexOf('force-stop'));
    expect(calls.indexOf('save:settled:false:true')).toBeLessThan(calls.indexOf('detach'));
    expect(calls.at(-1)).toBe('save:clear:false:false');
  });
});

test('lost rollback-detach response retains stopped compute and unknown rollback intent despite absent read-back', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.failSave = (next: any) => next.seeded; state.lostDetach = true;
    await expect(runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist)).rejects.toThrow('Live persistence failed');
    expect(state.saved).toMatchObject({ seeded: false, incusLive: { attachment: 'unknown', rollback: true } });
    expect(state.instance.status).toBe('Stopped'); expect(state.instance.devices).toEqual({});
    const before = [...calls]; await expect(runtime.recoverLive(state.saved, persist)).rejects.toThrow('unknown authority');
    expect(calls).toEqual(before); expect(calls.filter(c => c === 'detach')).toHaveLength(1);
    expect(calls).not.toContain('signal:release');
  });
});

test('missing sync, lost boot proof and nonterminal operations quarantine uncommitted sources without force-stop or clear', async () => {
  for (const failure of ['sync', 'boot', 'operation']) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume;
    const record = { ...v, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'], bootId: state.boot,
      attachment: failure === 'operation' ? 'accepted' : 'settled', operation: `/1.0/operations/${randomUUID()}` } };
    if (failure === 'boot') state.instance.status = 'Stopped';
    if (failure === 'sync') state.failProof = 'frozen-source';
    if (failure === 'operation') state.unsettled = true;
    await persist(record); const before = calls.length;
    await expect(runtime.recoverLive(record as any, persist)).rejects.toThrow();
    expect(calls.slice(before)).not.toContain('force-stop'); expect(calls.slice(before)).not.toContain('detach');
    expect(state.saved.incusLive).toBeTruthy(); expect(state.saved.seeded).toBe(false);
  });
});

test('durably committed volume recovers after boot-proof loss without recopying or detaching canonical data', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.instance.status = 'Stopped';
    state.instance.devices[runtime.deviceKey(v)] = runtime.device(v);
    const record = { ...v, seeded: true, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'settled' as const } };
    await runtime.recoverLive(record, persist);
    expect(state.saved).toMatchObject({ seeded: true, incusLive: undefined });
    expect(calls).not.toContain('detach'); expect(calls).not.toContain('copy');
    expect(calls).not.toContain('force-stop'); expect(state.volume).toBeTruthy();
  });
});

test('failed final intent clear retries restored committed authority without power-cutting released writers', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    let failed = false;
    state.failSave = (next: any) => {
      if (!next.incusLive && !failed) { failed = true; return true; }
      return false;
    };
    await expect(runtime.mountLive(`incus:${state.instance.config['volatile.uuid']}`, v, persist)).rejects.toThrow('Live persistence failed');
    expect(failed).toBe(true);
    expect(state.saved).toMatchObject({ seeded: true, incusLive: undefined });
    expect(state.instance.status).toBe('Running');
    expect(calls).toContain('signal:release');
    expect(calls.filter(call => call === 'proof:restored')).toHaveLength(2);
    expect(calls).not.toContain('force-stop'); expect(calls).not.toContain('detach');
  });
});

test('running committed recovery without restored same-boot proof never cuts power or clears authority', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.failProof = 'restored';
    state.instance.devices[runtime.deviceKey(v)] = runtime.device(v);
    const record = { ...v, seeded: true, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'settled' as const } };
    await persist(record);
    await expect(runtime.recoverLive(record, persist)).rejects.toThrow();
    expect(state.saved).toMatchObject({ seeded: true, incusLive: record.incusLive });
    expect(state.instance.status).toBe('Running');
    expect(calls).not.toContain('force-stop'); expect(calls).not.toContain('detach');
  });
});

test('pre-attachment synced freeze cannot authorize cold containment when watchdog may still thaw', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.failProof = 'safe-original';
    const record = { ...v, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'not-submitted' as const } };
    await persist(record);
    await expect(runtime.recoverLive(record, persist)).rejects.toThrow();
    expect(INCUS_LIVE_PROOF).toContain("read('attach-armed')");
    expect(state.saved.incusLive).toEqual(record.incusLive);
    expect(calls).not.toContain('force-stop'); expect(calls).not.toContain('detach');
    expect(state.instance.status).toBe('Running');
  });
});

test('pre-submission recovery retains seeded reattachment data and clears only restored or cold detached authority', async () => {
  for (const running of [true, false]) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.instance.status = running ? 'Running' : 'Stopped';
    const record = { ...v, seeded: true, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'not-submitted' as const } };
    await runtime.recoverLive(record, persist);
    expect(state.saved).toMatchObject({ seeded: true, incusLive: undefined });
    expect(calls).not.toContain('force-stop'); expect(calls).not.toContain('detach');
    expect(state.instance.devices).toEqual({}); expect(state.volume).toBeTruthy();
    expect(state.instance.status).toBe(running ? 'Running' : 'Stopped');
  });
});

test('seeded reattachment without safe-original proof never authorizes a power cut even when attachment is armed', async () => {
  await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.armed = true;
    const record = { ...v, seeded: true, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'not-submitted' as const } };
    await persist(record);
    await expect(runtime.recoverLive(record, persist)).rejects.toThrow('restoration is unresolved');
    expect(state.saved.incusLive).toEqual(record.incusLive); expect(state.saved.seeded).toBe(true);
    expect(calls).not.toContain('proof:frozen-source'); expect(calls).not.toContain('force-stop');
    expect(calls).not.toContain('detach'); expect(calls).not.toContain('copy'); expect(calls).not.toContain('delete-volume');
    expect(state.instance.status).toBe('Running');
  });
});

test('interrupted acknowledged detach waits for terminal proof and retries failed settlement persistence without resubmission', async () => {
  for (const failure of ['operation', 'store']) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.instance.status = 'Stopped';
    const operation = `/1.0/operations/${randomUUID()}`;
    const record = { ...v, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'accepted' as const, operation, rollback: true as const } };
    await persist(record);
    state.unsettled = failure === 'operation';
    state.failSave = (next: any) => failure === 'store' && next.incusLive?.attachment === 'settled';
    await expect(runtime.recoverLive(record, persist)).rejects.toThrow();
    expect(state.saved.incusLive).toEqual(record.incusLive);
    expect(calls).not.toContain('detach'); expect(calls).not.toContain('force-stop');
    state.unsettled = false; state.failSave = undefined;
    await runtime.recoverLive(state.saved, persist);
    expect(calls.filter(call => call === 'wait:' + operation)).toHaveLength(2);
    expect(state.saved.incusLive).toBeUndefined(); expect(state.saved.seeded).toBe(false);
    expect(calls).not.toContain('detach'); expect(calls).not.toContain('start'); expect(state.volume).toBeTruthy();
  });
});

test('live recovery refuses changed instance incarnation or installation identity without mutation', async () => {
  for (const failure of ['incarnation', 'identity']) await liveFixture(async (runtime, v, calls, state, persist) => {
    state.volume = state.ownedVolume; state.instance.status = 'Stopped';
    const record = { ...v, incusLive: { id: randomUUID(), incarnation: state.instance.config['volatile.uuid'],
      bootId: state.boot, attachment: 'settled' as const, rollback: true as const } };
    await persist(record); const before = [...calls];
    if (failure === 'incarnation') state.instance.config['volatile.uuid'] = randomUUID();
    else runtime.worker.matchesWorkerIdentity = async () => false;
    await expect(runtime.recoverLive(record, persist)).rejects.toThrow('incarnation changed');
    expect(calls).toEqual(before); expect(state.saved.incusLive).toEqual(record.incusLive);
  });
});

test('Incus storage refuses missing seeded data, wrong backend and unavailable or foreign identity without allocating', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await expect(runtime.ensureVolume({ ...v, seeded: true })).rejects.toThrow('no empty replacement');
    await expect(runtime.ensureVolume({ ...v, storageRuntimeKind: undefined })).rejects.toThrow('backend');
    for (const key of ['user.agentor.installation', 'user.agentor.owner', 'user.agentor.id', 'user.agentor.volume-id', 'user.agentor.target']) {
      state.volume = { ...state.ownedVolume, config: { ...state.ownedVolume.config, [key]: 'foreign' } };
      await expect(runtime.ensureVolume(v)).rejects.toThrow('ownership');
    }
    for (const field of [{ type: 'image' }, { content_type: 'block' }, { name: 'foreign' },
      { used_by: undefined }, { used_by: null },
      { used_by: ['/1.0/instances/foreign?project=agentor'] }, { used_by: ['/1.0/instances/agentor-worker-worker?project=foreign'] }]) {
      state.volume = { ...state.ownedVolume, ...field };
      await expect(runtime.ensureVolume(v)).rejects.toThrow();
    }
    expect(calls).toEqual([]);
    state.lookupFailure = true;
    await expect(runtime.ensureVolume(v)).rejects.toThrow('unavailable');
    expect(calls).toEqual([]); state.lookupFailure = false;
    state.volume = state.ownedVolume;
    await expect(runtime.inspect(v.userId, v.workerId, 'incus:wrong')).rejects.toThrow('incarnation');
    state.instance.config['volatile.uuid'] = '';
    await expect(runtime.inspect(v.userId, v.workerId, 'worker-name')).rejects.toThrow('incarnation');
  });
});

test('selection staging does not stop/start compute, keeps data unseeded and refreshes provisional copies', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.volume = state.ownedVolume;
    await runtime.stageSelection('incus:original', v);
    expect(v.seeded).toBe(false); expect(state.instance.devices).toEqual({});
    expect(state.instance.status).toBe('Running');
    expect(calls.filter(c => c === 'copy')).toHaveLength(1);
    expect(calls).not.toContain('start'); expect(calls).not.toContain('stop:original');
    expect(calls.indexOf('delete-volume')).toBeLessThan(calls.indexOf('create-volume'));
    await runtime.seed('incus:original', v, async () => { v.seeded = true; });
    expect(calls.filter(c => c === 'copy')).toHaveLength(2);
    expect(v.seeded).toBe(true);
  });
});

test('unresolved live intent never allocates missing data, deletes staging or starts a recopy', async () => {
  await fixture(async (runtime, v, calls, state) => {
    v.incusLive = { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' };
    await expect(runtime.ensureVolume(v)).rejects.toThrow('no empty replacement');
    state.volume = state.ownedVolume;
    for (const operation of [() => runtime.removeStaging(v), () => runtime.delete(v),
      () => runtime.stageSelection('incus:original', v), () => runtime.seed('incus:original', v, async () => { throw new Error('must not commit'); })])
      await expect(operation()).rejects.toThrow('unresolved');
    expect(calls).toEqual([]);
    expect(state.volume).toBeTruthy(); expect(state.instance.status).toBe('Running');
  });
});

test('failed selection copy and lost attach response detach only exact staging without changing source lifecycle', async () => {
  for (const fault of ['copyFailure', 'lostAttach']) await fixture(async (runtime, v, calls, state) => {
    state[fault] = true;
    await expect(runtime.stageSelection('incus:original', v)).rejects.toThrow();
    expect(state.instance.devices).toEqual({}); expect(v.seeded).toBe(false);
    expect(state.instance.status).toBe('Running');
    expect(calls).not.toContain('stop:original'); expect(calls).not.toContain('start');
    await runtime.removeStaging(v); expect(state.volume).toBeUndefined();
  });
});

test('selection cleanup retains changed staging devices rather than overwriting foreign identity', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.foreignAfterCopy = true;
    await expect(runtime.stageSelection('incus:original', v)).rejects.toMatchObject({ incusStagingAmbiguous: true });
    expect(state.instance.devices[runtime.deviceKey(v)].path).toBe('/foreign');
    expect(calls.filter(c => c === 'devices')).toHaveLength(1);
    expect(calls).not.toContain('delete-volume'); expect(v.seeded).toBe(false);
  });
});

test('selection attachment rechecks incarnation after storage allocation and never applies a stale device map', async () => {
  await fixture(async (runtime, v, calls, state) => {
    const create = runtime.worker.client.createCustomVolume.bind(runtime.worker.client);
    runtime.worker.client.createCustomVolume = async (...args) => {
      await create(...args); state.instance.config['volatile.uuid'] = 'replaced-during-allocation';
    };
    await expect(runtime.stageSelection('incus:original', v)).rejects.toMatchObject({ incusStagingAmbiguous: true });
    expect(calls).not.toContain('devices'); expect(state.volume).toBeTruthy();
    expect(v.seeded).toBe(false);
  });
});

test('successful detach responses still require the captured device to disappear and references to be empty', async () => {
  await fixture(async (runtime, v, _calls, state) => {
    state.ignoreDetach = true;
    await expect(runtime.stageSelection('incus:original', v)).rejects.toMatchObject({ incusStagingAmbiguous: true });
    expect(state.instance.devices[runtime.deviceKey(v)]).toBeTruthy();
  });
  await fixture(async (runtime, v, _calls, state) => {
    const create = runtime.worker.client.createCustomVolume.bind(runtime.worker.client);
    runtime.worker.client.createCustomVolume = async (...args) => {
      await create(...args); state.volume.used_by = ['/1.0/instances/agentor-worker-worker?project=agentor'];
    };
    await expect(runtime.stageSelection('incus:original', v)).rejects.toMatchObject({ incusStagingAmbiguous: true });
    expect(state.volume).toBeTruthy(); expect(v.seeded).toBe(false);
  });
});

test('captured selection probe uses guest UID1000 without queue reentry and refuses changed/missing/unreadable facts', async () => {
  await fixture(async (runtime, v, _calls, state) => {
    expect(await runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target)).toBe(true);
    state.probeResponse = { returnCode: 0, stdout: 'backup-only\n' };
    expect(await runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target)).toBe(false);
    state.probeResponse = { returnCode: 0, stdout: 'missing\n' };
    await expect(runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target)).rejects.toThrow('missing or unreadable');
    expect(await runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target, true)).toBe(false);
    for (const response of [{ returnCode: 1, stdout: '' }, { returnCode: 0, stdout: 'invalid' }]) {
      state.probeResponse = response;
      await expect(runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target)).rejects.toThrow('missing or unreadable');
    }
    state.probeResponse = { returnCode: 0, stdout: 'directory' }; state.changedProbe = true;
    await expect(runtime.isSelectionDirectory(v.userId, v.workerId, 'incus:original', v.target)).rejects.toThrow('incarnation changed');
  });
});

async function selectionFixture(run: (manager: ManagedVolumeManager, worker: any, calls: string[], state: any) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'incus-selected-paths-'));
  const manager = new ManagedVolumeManager(root, new Proxy({}, { get: () => () => { throw new Error('Docker must not be called'); } }) as any);
  await manager.init();
  const worker = { id: 'selection-worker', userId: 'selection-owner', containerId: 'incus:original' };
  const workers = useWorkerStore(), originalGet = workers.get;
  const calls: string[] = [], state: any = { devices: {}, files: new Set(), declared: { runtimeKind: 'incus-vm', status: 'active' } };
  workers.get = () => state.declared;
  (manager as any).incus = {
    inspect: async () => ({ devices: state.devices }),
    isSelectionDirectory: async (_owner: string, _worker: string, handle: string, target: string, allowMissing: boolean) => {
      if (state.missing) { if (allowMissing) return false; throw new Error('missing selection'); }
      expect(handle).toBe('incus:original'); calls.push('probe:' + target); return !state.files.has(target);
    },
    validateTarget: async () => { if (state.invalidTarget) throw new Error('invalid guest path'); },
    stageSelection: async (_handle: string, v: any) => {
      calls.push('stage:' + v.target);
      if (state.ambiguous) throw Object.assign(new Error('late attachment'), { incusStagingAmbiguous: true });
      if (state.copyFailure) throw new Error('ENOSPC');
    },
    removeStaging: async () => { calls.push('cleanup'); if (state.cleanupFailure) throw new Error('ambiguous attachment'); },
  };
  try { await run(manager, worker, calls, state); }
  finally { workers.get = originalGet; await rm(root, { recursive: true, force: true }); }
}

test('Incus selection classification keeps files, root, protected and already-backed paths backup-only', async () => {
  await selectionFixture(async (manager, worker, calls, state) => {
    state.files.add('/opt/file'); state.files.add('/opt/symlink');
    state.devices.workspace = { type: 'disk', path: '/workspace' };
    await manager.adoptIncusSelections(worker, ['/']);
    await manager.adoptIncusSelections(worker, ['/etc', '/home/agent/.agent-data', '/workspace/project', '/opt/file', '/opt/symlink'], true);
    expect(manager.store.forWorker(worker.userId, worker.id)).toEqual([]);
    expect(calls).toEqual(['probe:/workspace/project', 'probe:/opt/file', 'probe:/opt/symlink']);
    await manager.adoptIncusSelections(worker, ['/opt/project'], true);
    expect(manager.store.forWorker(worker.userId, worker.id)[0]).toMatchObject({
      target: '/opt/project', seeded: false, attached: true, state: 'pending', storageRuntimeKind: 'incus-vm', operation: { stage: 'complete' } });
  });
});

test('durable live intent quarantines provisioning, recreation, snapshots and deletion even before startup recovery', async () => {
  await selectionFixture(async (manager, worker, calls) => {
    (manager.incusRuntime as any).recoverLive = async (v: any) => { assertIncusLiveResolved(v); };
    const v = await manager.store.create(worker.userId, worker.id, '/opt/live', undefined, 'incus-vm');
    await manager.store.save({ ...v, attached: false, seeded: true,
      incusLive: { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'settled' } });
    expect(manager.isRecoveryBlocked(worker.id)).toBe(true);
    expect(manager.isRecoveryBlocked('other-worker')).toBe(false);
    expect(manager.hasActiveOperationsForInstanceSnapshot()).toBe(true);
    expect(await manager.requiresRecreation(worker.userId, worker.id, worker.containerId)).toBe(true);
    for (const operation of [() => manager.prepare(worker), () => manager.mounts(worker.userId, worker.id),
      () => manager.currentIncusVolumes(worker.userId, worker.id, worker.containerId),
      () => manager.markDeclared(worker.userId, worker.id, worker.containerId),
      () => manager.workerDeleted(worker.userId, worker.id), () => manager.recoverWorker(worker.userId, worker.id)])
      await expect(operation()).rejects.toThrow('unresolved');
    expect(() => manager.assertLiveRecoveryResolved(worker.userId, worker.id)).toThrow('unresolved');
    await manager.recoverStartup();
    expect(manager.store.get(worker.userId, v.id)?.incusLive).toBeTruthy();
    expect(manager.isRecoveryBlocked(worker.id)).toBe(true);
    expect(calls).toEqual([]);
  });
});

test('queued second live volume never starts its helper after first cutover becomes quarantined', async () => {
  await selectionFixture(async (manager, worker) => {
    (manager as any).worker = () => ({ live: worker });
    const first = await manager.store.create(worker.userId, worker.id, '/opt/queued-first', undefined, 'incus-vm');
    const second = await manager.store.create(worker.userId, worker.id, '/opt/queued-second', undefined, 'incus-vm');
    for (const v of [first, second]) await manager.store.save({ ...v,
      operation: { id: randomUUID(), mode: 'live', stage: 'queued' } });
    const launched: string[] = [];
    (manager.incusRuntime as any).mountLive = async (_handle: string, v: any, persist: any) => {
      launched.push(v.id);
      await persist({ ...v, incusLive: { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' } });
      throw new Error('lost first acknowledgement');
    };
    const actor = { userId: worker.userId, workerId: worker.id, platformAdmin: true };
    for (const v of [first, second]) (manager as any).enqueue(actor, v.id, 'live', true);
    await expect.poll(() => manager.store.get(worker.userId, second.id)?.operation?.stage).toBe('failed');
    expect(launched).toEqual([first.id]);
    expect(manager.store.get(worker.userId, first.id)?.incusLive?.attachment).toBe('unknown');
    expect(manager.store.get(worker.userId, second.id)?.incusLive).toBeUndefined();
    expect(manager.isRecoveryBlocked(worker.id)).toBe(true);
  });
});

test('live recovery requires current non-deleting non-recreating Incus WorkerRecord authority', async () => {
  await selectionFixture(async (manager, worker, _calls, state) => {
    let recoveries = 0;
    (manager.incusRuntime as any).recoverLive = async () => { recoveries++; };
    const v = await manager.store.create(worker.userId, worker.id, '/opt/authority', undefined, 'incus-vm');
    await manager.store.save({ ...v, incusLive: { id: randomUUID(), incarnation: randomUUID(), bootId: randomUUID(), attachment: 'unknown' } });
    for (const declared of [undefined, { runtimeKind: 'legacy-docker' }, { runtimeKind: 'incus-vm', deletionPending: true },
      { runtimeKind: 'incus-vm', incusRecreation: {} }, { runtimeKind: 'incus-vm', status: 'archived' }]) {
      state.declared = declared;
      await expect(manager.recoverWorker(worker.userId, worker.id)).rejects.toThrow();
    }
    expect(recoveries).toBe(0); expect(manager.store.get(worker.userId, v.id)?.incusLive).toBeTruthy();
  });
});

test('ambiguous staging retains its durable candidate even when an early inspection would report detached', async () => {
  await selectionFixture(async (manager, worker, calls, state) => {
    state.ambiguous = true;
    await expect(manager.adoptIncusSelections(worker, ['/opt/project'], true)).rejects.toThrow('late attachment');
    expect(calls).not.toContain('cleanup');
    expect(manager.store.forWorker(worker.userId, worker.id)[0]).toMatchObject({ state: 'failed', seeded: false });
  });
});

test('selection adoption honors the instance snapshot barrier before any probe, record or hotplug', async () => {
  await selectionFixture(async (manager, worker, calls) => {
    const release = beginInstanceSnapshot('selection-barrier');
    try { await expect(manager.adoptIncusSelections(worker, ['/opt/project'], true)).rejects.toThrow('instance backup or restore'); }
    finally { release(); }
    expect(calls).toEqual([]); expect(manager.store.forWorker(worker.userId, worker.id)).toEqual([]);
  });
});

test('removed backup-only selections do not block lifecycle preparation but cannot be newly committed as persistent', async () => {
  await selectionFixture(async (manager, worker, calls, state) => {
    state.missing = true;
    await manager.adoptIncusSelections(worker, ['/opt/removed-file']);
    await expect(manager.adoptIncusSelections(worker, ['/opt/removed-file'], true)).rejects.toThrow('missing selection');
    expect(manager.store.forWorker(worker.userId, worker.id)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

test('selection errors retain previous backup config; ambiguous cleanup cannot bypass validation on retry', async () => {
  await selectionFixture(async (manager, worker, calls, state) => {
    const root = await mkdtemp(join(tmpdir(), 'incus-selection-backup-'));
    try {
      const backup = new BackupManager({ dataDir: root });
      backup.setPathPersistenceAdapter({ reconcileSelections: async (_owner, selected) => {
        await manager.adoptIncusSelections(worker, selected?.[worker.id], true);
      } });
      await backup.setConfig(worker.userId, { enabled: false, selectedPathsByWorkspace: {} });
      const previous = await backup.getConfig(worker.userId);
      state.copyFailure = true;
      const input = { selectedPathsByWorkspace: { [worker.id]: ['/opt/project'] } };
      await expect(backup.setConfig(worker.userId, input)).rejects.toThrow('ENOSPC');
      expect(await backup.getConfig(worker.userId)).toEqual(previous);
      expect(manager.store.forWorker(worker.userId, worker.id)).toEqual([]);
      state.cleanupFailure = true;
      await expect(backup.setConfig(worker.userId, input)).rejects.toThrow('ENOSPC');
      expect(manager.store.forWorker(worker.userId, worker.id)[0]).toMatchObject({ state: 'failed', seeded: false });
      const copied = calls.filter(c => c.startsWith('stage:')).length;
      await expect(backup.setConfig(worker.userId, input)).rejects.toThrow('needs recovery');
      expect(calls.filter(c => c.startsWith('stage:'))).toHaveLength(copied);
      expect(await backup.getConfig(worker.userId)).toEqual(previous);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

test('repeated selection refreshes unseeded staging but never reattaches explicitly detached data', async () => {
  await selectionFixture(async (manager, worker, calls) => {
    await manager.adoptIncusSelections(worker, ['/opt/project'], true);
    await manager.adoptIncusSelections(worker, ['/opt/project'], true);
    expect(calls.filter(c => c === 'stage:/opt/project')).toHaveLength(2);
    const v = manager.store.forWorker(worker.userId, worker.id)[0]!;
    await manager.store.save({ ...v, seeded: true, attached: false, state: 'detached' });
    await manager.adoptIncusSelections(worker, ['/opt/project'], true);
    expect(calls.filter(c => c === 'stage:/opt/project')).toHaveLength(2);
    expect(manager.store.get(worker.userId, v.id)?.attached).toBe(false);
    await manager.adoptIncusSelections(worker, []);
    expect(manager.store.get(worker.userId, v.id)).toBeTruthy();
  });
});

test('interrupted selection staging, invalid target and changed worker authority fail before configuration adoption', async () => {
  await selectionFixture(async (manager, worker, calls, state) => {
    state.invalidTarget = true;
    await expect(manager.adoptIncusSelections(worker, ['/opt/project'], true)).rejects.toThrow('invalid guest path');
    expect(manager.store.forWorker(worker.userId, worker.id)).toEqual([]);
    state.invalidTarget = false;
    const v = await manager.store.create(worker.userId, worker.id, '/opt/project', undefined, 'incus-vm');
    await manager.store.save({ ...v, state: 'preparing', operation: { id: 'interrupted', mode: 'deferred', stage: 'copying' } });
    await expect(manager.adoptIncusSelections(worker, [v.target], true)).rejects.toThrow('needs recovery');
    expect(calls.filter(c => c.startsWith('stage:'))).toEqual([]);
    state.declared = undefined;
    await expect(manager.adoptIncusSelections(worker, [v.target], true)).rejects.toThrow('active Incus worker authority');
  });
});

test('enabling directory persistence reconciles effective existing selections before config commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-selection-reenable-'));
  try {
    const backup = new BackupManager({ dataDir: root }), calls: any[] = [];
    let fail = false;
    backup.setPathPersistenceAdapter({ reconcileSelections: async (_owner, paths) => {
      calls.push(paths); if (fail) throw new Error('copy failed');
    } });
    await backup.setConfig('owner', { persistSelectedDirectories: false, selectedPathsByWorkspace: { worker: ['/opt/project'] } });
    expect(calls).toEqual([]); fail = true;
    await expect(backup.setConfig('owner', { persistSelectedDirectories: true })).rejects.toThrow('copy failed');
    expect((await backup.getConfig('owner'))?.persistSelectedDirectories).toBe(false);
    fail = false; await backup.setConfig('owner', { persistSelectedDirectories: true });
    expect(calls).toEqual([{ worker: ['/opt/project'] }, { worker: ['/opt/project'] }]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an in-process explicit storage retry may prepare its own selected record without authorizing settings-save bypass', async () => {
  await selectionFixture(async (manager, worker, calls) => {
    const v = await manager.store.create(worker.userId, worker.id, '/opt/project', undefined, 'incus-vm');
    await manager.store.save({ ...v, state: 'preparing', operation: { id: 'own-retry', mode: 'recreate', stage: 'recreating' } });
    await expect(manager.adoptIncusSelections(worker, [v.target])).rejects.toThrow('needs recovery');
    (manager as any).operations.add(v.id);
    await manager.adoptIncusSelections(worker, [v.target]);
    await expect(manager.adoptIncusSelections(worker, [v.target], true)).rejects.toThrow('needs recovery');
    expect(calls).toEqual([]);
  });
});

test('a failed seeded-store write can retry only exact-owned detached staging, preserving the original source', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await expect(runtime.seed('incus:original', v, async () => { throw new Error('persistence failure'); })).rejects.toThrow('persistence failure');
    expect(v.seeded).toBe(false);
    await runtime.seed('incus:original', v, async () => { calls.push('commit'); v.seeded = true; });
    expect(v.seeded).toBe(true); expect(state.instance.config['volatile.uuid']).toBe('original');
    expect(calls.filter(call => call === 'copy')).toHaveLength(2);
    expect(calls.filter(call => call === 'delete-volume')).toHaveLength(1);
    expect(calls.at(-1)).toBe('stop:original');
  });
});

test('manager storage backend survives missing WorkerRecord and never probes Docker for retained Incus data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-manager-backend-'));
  try {
    const manager = new ManagedVolumeManager(root, new Proxy({}, { get: () => () => { throw new Error('Docker must not be called'); } }) as any);
    await manager.init();
    const v = await manager.store.create('retained-incus-owner', 'retained-incus-worker', '/opt/retained', undefined, 'incus-vm');
    const calls: string[] = [];
    (manager as any).incus = {
      ensureVolume: async () => { calls.push('ensure'); },
      seed: async (_handle: string, record: any, commit: () => Promise<void>) => {
        expect(record.seeded).toBe(false); calls.push('seed'); await commit();
      },
      deviceKey: () => 'm123456',
      inspectVolume: async () => ({ used_by: [] }),
    };
    await manager.prepare({ id: v.workerId, userId: v.userId, containerId: 'incus:captured' });
    expect(manager.store.get(v.userId, v.id)?.seeded).toBe(true);
    await manager.recoverWorker(v.userId, v.workerId);
    await manager.workerDeleted(v.userId, v.workerId);
    await manager.retainDeletedOwner(v.userId);
    expect(manager.store.get(v.userId, v.id)).toMatchObject({ seeded: true, attached: false, storageRuntimeKind: 'incus-vm', retainedAfterAccountDeletion: true });
    expect(calls).toContain('seed'); expect(calls).toContain('ensure');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('current compute boot repair ignores unseeded deferred paths but verifies mounted deferred detachments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-manager-current-layout-'));
  try {
    const manager = new ManagedVolumeManager(root, {} as any); await manager.init();
    const v = await manager.store.create('layout-owner', 'layout-worker', '/opt/deferred', undefined, 'incus-vm');
    const actual: any = { devices: {} }, calls: string[] = [];
    (manager as any).incus = {
      inspect: async () => actual, deviceKey: () => 'm123456',
      matchesDevice: (device: any) => device?.source === v.dockerName && device?.path === v.target,
      ensureVolume: async () => { calls.push('ensure'); },
    };
    expect(await manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).toEqual([]);
    expect(calls).toEqual([]);
    v.seeded = true; v.attached = false; await manager.store.save(v);
    actual.devices.m123456 = { source: v.dockerName, path: v.target };
    expect(await manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).toEqual([expect.objectContaining({ id: v.id, attached: true, seeded: true })]);
    expect(manager.store.get(v.userId, v.id)?.attached).toBe(false);
    actual.devices.m123456.path = '/run/staging';
    await expect(manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).rejects.toThrow('interrupted');
    delete actual.devices.m123456; v.attached = true; await manager.store.save(v);
    await expect(manager.currentIncusVolumes(v.userId, v.workerId, 'incus:current')).rejects.toThrow('not declared');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Incus deletion and staging cleanup require exact ownership and authoritative empty references', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.volume = { ...state.ownedVolume, used_by: ['/1.0/instances/agentor-worker-worker?project=agentor'] };
    await expect(runtime.delete(v)).rejects.toThrow('referenced');
    await expect(runtime.removeStaging(v)).rejects.toThrow('attached');
    await expect(runtime.removeStaging({ ...v, seeded: true })).rejects.toThrow('Populated');
    expect(calls).toEqual([]);
    state.volume.used_by = [];
    await runtime.delete(v); expect(calls).toEqual(['delete-volume']);
  });
});

test('Incus seeding saves authority after copy and stops only the captured retained incarnation', async () => {
  await fixture(async (runtime, v, calls, state) => {
    await runtime.seed('incus:original', v, async () => { calls.push('commit'); v.seeded = true; });
    expect(calls.indexOf('commit')).toBeGreaterThan(calls.indexOf('copy'));
    expect(calls.at(-1)).toBe('stop:original');
    expect(v.seeded).toBe(true); expect(state.volume).toBeTruthy();
    expect(state.instance.config['volatile.uuid']).toBe('original');
  });
});

test('lost VM start, ENOSPC copy and seeded-store failure preserve original root and non-authoritative staging', async () => {
  for (const failure of ['start', 'copy', 'commit']) await fixture(async (runtime, v, calls, state) => {
    state.startFailure = failure === 'start'; state.copyFailure = failure === 'copy';
    await expect(runtime.seed('incus:original', v, async () => { throw new Error('seeded store unavailable'); })).rejects.toThrow();
    expect(v.seeded).toBe(false); expect(state.volume).toBeTruthy();
    expect(state.instance.config['volatile.uuid']).toBe('original');
    expect(state.instance.status).toBe('Stopped'); expect(calls.at(-1)).toBe('stop:original');
    expect(calls).not.toContain('delete-volume');
  });
});

test('staging key collision and declared overlap fail before stopping or changing storage', async () => {
  await fixture(async (runtime, v, calls, state) => {
    state.instance.devices[runtime.deviceKey(v)] = { type: 'disk', path: '/foreign', source: 'foreign' };
    await expect(runtime.seed('incus:original', v, async () => {})).rejects.toThrow('conflicts');
    state.instance.devices = { existing: { type: 'disk', path: '/opt/models/nested', source: 'other' } };
    await expect(runtime.validateTarget(v.userId, v.workerId, 'incus:original', v.target)).rejects.toThrow('overlaps');
    expect(calls).toEqual([]);
  });
});

test('actual guest path validator rejects symlink components and decodes mountinfo spaces and octal escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-path-proof-'));
  try {
    const target = join(root, 'directory with spaces'); await mkdir(target);
    const mountinfo = join(root, 'mountinfo');
    const script = INCUS_PERSISTENCE_TARGET_CHECK.replace("'/proc/self/mountinfo'", JSON.stringify(mountinfo));
    const run = (path = target) => execFileSync('python3', ['-c', script, path, '']);
    await writeFile(mountinfo, `1 0 0:1 / / rw - ext4 /dev/root rw\n`);
    expect(() => run()).not.toThrow();
    await symlink(target, join(root, 'alias'));
    expect(() => run(join(root, 'alias/child'))).toThrow();
    for (const path of [target, join(target, 'nested'), root]) {
      await writeFile(mountinfo, `1 0 0:1 / ${path.replaceAll(' ', '\\040')} rw - ext4 /dev/disk rw\n`);
      expect(() => run()).toThrow();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual selection classifier rejects symlink ancestors before treating lexical mount coverage as persistent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'incus-selection-path-proof-'));
  try {
    const target = join(root, 'directory with spaces'); await mkdir(target);
    await mkdir(join(target, 'child')); await writeFile(join(root, 'file'), 'backup-only');
    await symlink(target, join(root, 'escape'));
    const run = (path: string) => execFileSync('python3', ['-c', INCUS_SELECTION_DIRECTORY_CHECK, path], { encoding: 'utf8' }).trim();
    expect(run(target)).toBe('directory');
    expect(run(join(root, 'file'))).toBe('backup-only');
    expect(run(join(root, 'escape'))).toBe('backup-only');
    expect(() => run(join(root, 'escape/child'))).toThrow();
    expect(run(join(root, 'missing'))).toBe('missing');
  } finally { await rm(root, { recursive: true, force: true }); }
});
