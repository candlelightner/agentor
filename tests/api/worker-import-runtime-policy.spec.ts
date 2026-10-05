import { expect, test } from '@playwright/test';
import { selectWorkerImportRuntime, type WorkerImportRuntimePolicyInput } from '../../orchestrator/server/utils/worker-import-runtime-policy';
import { parseWorkerBackupRuntime, type WorkerBackupRuntime } from '../../orchestrator/server/utils/worker-backup-runtime';

const legacy: WorkerBackupRuntime = { version: 1, kind: 'legacy-docker' };
const native = parseWorkerBackupRuntime({ version: 1, kind: 'incus-vm', source: {
  sourceImageId: 'sha256:' + 'a'.repeat(64), recipeId: 'b'.repeat(64), architecture: 'amd64',
  converterVersion: 'd2vm-v0.4.0', bootstrapGeneration: '3',
} })!;

test('portable missing or legacy descriptions follow current new-worker policy rather than requesting legacy', () => {
  for (const runtime of [undefined, legacy]) for (const incusEnabled of [false, true]) {
    expect(selectWorkerImportRuntime({ origin: { kind: 'portable' }, runtime, incusEnabled }))
      .toBe(incusEnabled ? 'incus-vm' : 'legacy-docker');
    // Even an extra manifest-like flag cannot override portable policy.
    expect(selectWorkerImportRuntime({ origin: { kind: 'portable', adminLegacyAuthorized: true } as any,
      runtime, incusEnabled })).toBe(incusEnabled ? 'incus-vm' : 'legacy-docker');
  }
});

test('local historical backups without provenance or runtime metadata remain legacy even when Incus is enabled', () => {
  for (const provenance of [undefined, 'local'] as const) for (const runtime of [undefined, legacy])
    for (const incusEnabled of [false, true])
      expect(selectWorkerImportRuntime({ origin: { kind: 'backup', provenance }, runtime, incusEnabled })).toBe('legacy-docker');
});

test('remote-adopted historical or legacy backups require exact current admin authorization under enabled Incus', () => {
  for (const runtime of [undefined, legacy]) {
    const input: WorkerImportRuntimePolicyInput = { origin: { kind: 'backup', provenance: 'remote-adopted' }, runtime, incusEnabled: true };
    for (const authorization of [undefined, false, 'true', 1]) {
      try {
        selectWorkerImportRuntime({ ...input, origin: { ...input.origin, adminLegacyAuthorized: authorization } as any });
        throw new Error('Expected authorization denial');
      } catch (error) { expect(error).toMatchObject({ statusCode: 409, code: 'REMOTE_LEGACY_RESTORE_AUTH_REQUIRED' }); }
    }
    expect(selectWorkerImportRuntime({ ...input, origin: { kind: 'backup', provenance: 'remote-adopted', adminLegacyAuthorized: true } })).toBe('legacy-docker');
    expect(selectWorkerImportRuntime({ ...input, incusEnabled: false })).toBe('legacy-docker');
  }
});

test('encryption or descriptive bundle authorization never confers remote legacy authority', () => {
  for (const encrypted of [false, true]) {
    const input = { origin: { kind: 'backup', provenance: 'remote-adopted', encrypted }, incusEnabled: true,
      runtime: { ...legacy, adminLegacyAuthorized: true }, encrypted, adminLegacyAuthorized: true };
    expect(() => selectWorkerImportRuntime(input as any)).toThrow(/platform-admin authorization/i);
  }
});

test('an Incus description stays Incus for every origin and cannot fall back when disabled', () => {
  for (const origin of [{ kind: 'portable' }, { kind: 'backup' }, { kind: 'backup', provenance: 'local' },
    { kind: 'backup', provenance: 'remote-adopted' }, { kind: 'backup', provenance: 'remote-adopted', adminLegacyAuthorized: true }] as const) {
    expect(selectWorkerImportRuntime({ runtime: native, origin, incusEnabled: true })).toBe('incus-vm');
    expect(() => selectWorkerImportRuntime({ runtime: native, origin, incusEnabled: false })).toThrow(/legacy fallback is not allowed/i);
  }
});

test('native selection rejects captured rootfs unless a trusted explicit import mode ignores it', () => {
  for (const runtime of [undefined, legacy, native]) {
    const input: WorkerImportRuntimePolicyInput = { runtime, origin: { kind: 'portable' }, incusEnabled: true, capturedRootfs: true };
    expect(() => selectWorkerImportRuntime(input)).toThrow(/captured root filesystem/i);
    for (const ignoreCapturedRootfs of ['replacement-image', 'workspace-only'] as const)
      expect(selectWorkerImportRuntime({ ...input, ignoreCapturedRootfs })).toBe('incus-vm');
    for (const ignoreCapturedRootfs of [true, 'true', 'captured-rootfs'])
      expect(() => selectWorkerImportRuntime({ ...input, ignoreCapturedRootfs } as any)).toThrow(/captured root filesystem/i);
    expect(selectWorkerImportRuntime({ ...input, capturedRootfs: false })).toBe('incus-vm');
  }
  expect(selectWorkerImportRuntime({ origin: { kind: 'backup' }, runtime: legacy, incusEnabled: true, capturedRootfs: true })).toBe('legacy-docker');
  expect(selectWorkerImportRuntime({ origin: { kind: 'portable' }, runtime: legacy, incusEnabled: false, capturedRootfs: true })).toBe('legacy-docker');
});

test('invalid internal origin, provenance, kind or enabled state fails closed without changing input', () => {
  const original = { runtime: native, origin: { kind: 'backup', provenance: 'local' }, incusEnabled: true };
  const before = structuredClone(original);
  expect(selectWorkerImportRuntime(original as WorkerImportRuntimePolicyInput)).toBe('incus-vm');
  expect(original).toEqual(before);
  for (const input of [{ ...original, origin: { kind: 'external' } }, { ...original, origin: null },
    { ...original, origin: { kind: 'backup', provenance: 'encrypted' } }, { ...original, incusEnabled: 'true' },
    { ...original, runtime: { version: 1, kind: 'privileged-docker' } }, { ...original, runtime: null }])
    expect(() => selectWorkerImportRuntime(input as any)).toThrow(/invalid trusted inputs/i);
});
