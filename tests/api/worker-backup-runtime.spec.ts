import { test, expect } from '@playwright/test';
import { parseWorkerBackupRuntime, snapshotIncusWorkerBackupRuntime } from '../../orchestrator/server/utils/worker-backup-runtime';
import type { IncusWorkerImageIdentity } from '../../orchestrator/server/utils/incus-worker-image';

const identity: IncusWorkerImageIdentity = {
  version: 1, sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64),
  architecture: 'amd64', converterVersion: 'd2vm@v0.2.0+agentor.1', bootstrapGeneration: '3',
  fingerprint: 'c'.repeat(64),
};
const portable = {
  version: 1, kind: 'incus-vm', source: {
    sourceImageId: identity.sourceImageId, recipeId: identity.recipeId, architecture: identity.architecture,
    converterVersion: identity.converterVersion, bootstrapGeneration: identity.bootstrapGeneration,
  },
};

test('absent historical runtime stays absent and valid legacy description is not inferred from platform policy', () => {
  expect(parseWorkerBackupRuntime(undefined)).toBeUndefined();
  expect(parseWorkerBackupRuntime({ version: 1, kind: 'legacy-docker' })).toEqual({ version: 1, kind: 'legacy-docker' });
});

test('runtime parser rejects invalid types, versions and unknown authority kinds', () => {
  for (const input of [null, false, 0, 'incus-vm', [], {}, { version: '1', kind: 'legacy-docker' },
    { version: 2, kind: 'incus-vm', source: portable.source }, { version: 1 },
    { version: 1, kind: 'docker' }, { version: 1, kind: 'privileged-docker' },
    { version: 1, kind: 'incus-vm' }])
    expect(() => parseWorkerBackupRuntime(input)).toThrow('Invalid worker backup');
});

test('snapshot validates actual full identity and roundtrips only immutable source fields', () => {
  const captured = snapshotIncusWorkerBackupRuntime(identity);
  expect(captured).toEqual(portable);
  expect(parseWorkerBackupRuntime(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
  expect(JSON.stringify(captured)).not.toContain('fingerprint');
  expect(JSON.stringify(captured)).not.toContain(identity.fingerprint);
  expect(captured.source).not.toBe(identity);
});

test('parser strips native, network, device and credential fields at every descriptive boundary', () => {
  const prohibited = { fingerprint: identity.fingerprint, ipv4Address: '10.0.0.44', instanceUuid: 'native-uuid',
    physicalDevice: '/dev/sdb', clientKey: 'must-not-survive', runtimeAuthorized: true };
  expect(parseWorkerBackupRuntime({ ...portable, ...prohibited,
    source: { ...portable.source, ...prohibited, version: 1 } })).toEqual(portable);
  expect(parseWorkerBackupRuntime({ version: 1, kind: 'legacy-docker', ...prohibited,
    source: { ...portable.source, ...prohibited }, privileged: true })).toEqual({ version: 1, kind: 'legacy-docker' });
});

test('portable immutable source rejects mutable references, unsupported platforms and unsafe conversion inputs', () => {
  const invalid: Array<Record<string, unknown>> = [
    { sourceImageId: undefined }, { sourceImageId: 'agentor-worker:latest' }, { sourceImageId: 'sha256:' + 'A'.repeat(64) },
    { sourceImageId: 'sha256:' + 'a'.repeat(63) }, { recipeId: undefined }, { recipeId: 'latest' },
    { recipeId: 'b'.repeat(65) }, { architecture: 'arm64' }, { bootstrapGeneration: 3 },
    { bootstrapGeneration: '2' }, { converterVersion: '' }, { converterVersion: 'v'.repeat(129) },
    { converterVersion: 'd2vm\ninjected' }, { converterVersion: 'd2vm;cmd' },
  ];
  for (const patch of invalid) {
    expect(() => parseWorkerBackupRuntime({ ...portable, source: { ...portable.source, ...patch } }))
      .toThrow('immutable runtime source');
    expect(() => snapshotIncusWorkerBackupRuntime({ ...identity, ...patch } as IncusWorkerImageIdentity))
      .toThrow('immutable worker image metadata');
  }
  for (const input of [null, [], false, 'source'])
    expect(() => parseWorkerBackupRuntime({ ...portable, source: input })).toThrow('immutable runtime source');
});

test('snapshot never fabricates a missing cache fingerprint to make an incomplete identity valid', () => {
  for (const fingerprint of [undefined, '', 'invalid', 'c'.repeat(63)])
    expect(() => snapshotIncusWorkerBackupRuntime({ ...identity, fingerprint } as IncusWorkerImageIdentity))
      .toThrow('immutable worker image metadata');
});
