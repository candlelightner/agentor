import { expect, test } from '@playwright/test';
import { ManagedVolumeRuntime } from '../../orchestrator/server/utils/managed-volume-runtime';
import { ManagedVolumeManager } from '../../orchestrator/server/utils/managed-volume-manager';

test('Kata live mounting rejects before volume or privileged helper creation, including recovery probes', async () => {
  let creations = 0;
  const runtime = new ManagedVolumeRuntime({
    getContainer: () => ({ inspect: async () => ({
      Config: { Labels: {} }, HostConfig: { Runtime: 'agentor-kata-qemu' },
      State: { Running: true, Paused: true },
    }) }),
    createContainer: async () => { creations++; throw new Error('helper must not run'); },
    getVolume: () => { creations++; throw new Error('volume must not be inspected'); },
  } as any, '/unused');
  for (const probe of [false, true])
    await expect(runtime.mountLive('kata-worker', {} as any, probe)).rejects.toThrow(/verified legacy runc/);
  expect(creations).toBe(0);
});

test('Kata live application rejects before inspecting, journaling or pausing the worker', async () => {
  const manager = new ManagedVolumeManager('/unused', {} as any);
  manager.runtime.validateTarget = async () => { throw new Error('must reject before inspection'); };
  await expect((manager as any).live({ runtimeProfile: 'kata-qemu' }, {}))
    .rejects.toThrow(/Live mounting is not supported for Kata/);
});
