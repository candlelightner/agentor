import { expect, test } from '@playwright/test';
import {
  parseRuntimeCapacityMeasurementRequest, verifyRuntimeCapacityMeasurementEvidence,
  type RuntimeCapacityMeasurementEvidence, type RuntimeCapacityVerificationContext,
} from '../../orchestrator/server/utils/worker-runtime-capacity-protocol';
import { assertRuntimeMigrationCapacityAdmission } from '../../orchestrator/server/utils/worker-runtime-capacity';

function fixture(): { evidence: RuntimeCapacityMeasurementEvidence; context: RuntimeCapacityVerificationContext } {
  const request = {
    version: 1 as const, kind: 'capacity-measurement-request' as const,
    binding: { hostId: 'host-1', serviceId: 'service-1', daemonId: 'daemon-1', layoutGeneration: '7',
      maintenanceEpoch: 'epoch-1', operationId: 'operation-1', ownerId: 'owner-1', workerId: 'worker-1',
      sourceContainerId: 'a'.repeat(64), targetRuntime: 'kata-qemu' as const,
      inventoryDigest: `sha256:${'b'.repeat(64)}`, envelopeDigest: `sha256:${'c'.repeat(64)}`,
      phase: 'stopped-source' as const, expectedSourceState: 'stopped' as const },
    nonce: 'd'.repeat(64), issuedAtMs: 1_000_000, expiresAtMs: 1_010_000,
  };
  return {
    evidence: { version: 1, kind: 'capacity-measurement-evidence', request: structuredClone(request), sequence: '42',
      issuedAtMs: 1_000_500, expiresAtMs: 1_009_000,
      scan: { status: 'complete', sourceState: 'stopped', startedAtMs: 1_000_100, completedAtMs: 1_000_400, entries: '100' } },
    context: { expectedRequest: request, replayState: { hostId: 'host-1', serviceId: 'service-1', daemonId: 'daemon-1', sequence: '41' },
      nowMs: 1_001_000, maxEvidenceAgeMs: 2000, maxLifetimeMs: 10_000, maxScanDurationMs: 1000, maxScanEntries: '1000' },
  };
}

test('exact request and complete stopped scan produce detached evidence and a prospective replay state, not admission', () => {
  const f = fixture(), before = structuredClone(f);
  const result = verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context);
  expect(result).toEqual({ evidence: f.evidence, nextReplayState: { ...f.context.replayState, sequence: '42' } });
  expect(f).toEqual(before);
  result.evidence.request.binding.workerId = 'different';
  expect(f.evidence.request.binding.workerId).toBe('worker-1');
  expect(Object.keys(result)).toEqual(['evidence', 'nextReplayState']);
  expect(() => assertRuntimeMigrationCapacityAdmission()).toThrow(/trusted disk-capacity admission/);
});

test('schema-only request parsing does not invent current-time freshness', () => {
  const f = fixture();
  f.context.nowMs = f.evidence.request.expiresAtMs;
  expect(parseRuntimeCapacityMeasurementRequest(f.evidence.request)).toEqual(f.evidence.request);
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/lifetime/);
});

const bindingChanges = {
  hostId: 'host-2', serviceId: 'service-2', daemonId: 'daemon-2', layoutGeneration: '8', maintenanceEpoch: 'epoch-2',
  operationId: 'operation-2', ownerId: 'owner-2', workerId: 'worker-2', sourceContainerId: 'e'.repeat(64),
  targetRuntime: 'legacy-runc', inventoryDigest: `sha256:${'e'.repeat(64)}`, envelopeDigest: `sha256:${'f'.repeat(64)}`,
  phase: 'recovery', expectedSourceState: 'running-bounded',
};
for (const [field, value] of Object.entries(bindingChanges)) test(`rejects evidence from changed ${field}`, () => {
  const f = fixture(); (f.evidence.request.binding as any)[field] = value;
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(`binding mismatch: ${field}`);
});

for (const [field, value] of Object.entries({ nonce: 'e'.repeat(64), issuedAtMs: 1_000_001, expiresAtMs: 1_010_001 })) {
  test(`rejects changed request ${field}`, () => {
    const f = fixture(); (f.evidence.request as any)[field] = value;
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(`request mismatch: ${field}`);
  });
}

test('replay is rejected after the caller persists the returned high-water', () => {
  const f = fixture();
  const first = verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context);
  f.context.replayState = first.nextReplayState;
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/replayed sequence/);
  f.evidence.sequence = '40';
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/replayed sequence/);
});

test('sequence arithmetic remains exact across JavaScript safe integer and uint64 boundaries', () => {
  const f = fixture();
  f.context.replayState.sequence = '18446744073709551614';
  f.evidence.sequence = '18446744073709551615';
  expect(verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context).nextReplayState.sequence).toBe('18446744073709551615');
  f.context.replayState.sequence = f.evidence.sequence;
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/replayed sequence/);
});

for (const field of ['hostId', 'serviceId', 'daemonId'] as const) test(`replay high-water must belong to expected ${field}`, () => {
  const f = fixture(); f.context.replayState[field] = 'another';
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/replayState identity/);
});

for (const phase of ['pre-stop', 'stopped-source', 'forward', 'recovery', 'finalization'] as const) {
  test(`${phase} evidence is bound to explicit trusted source state, including restarted source finalization`, () => {
    const f = fixture();
    f.context.expectedRequest.binding.phase = phase; f.evidence.request.binding.phase = phase;
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).not.toThrow();
    f.evidence.scan.sourceState = 'running-bounded';
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/source state differs from trusted expectation/);
    f.context.expectedRequest.binding.expectedSourceState = 'running-bounded';
    f.evidence.request.binding.expectedSourceState = 'running-bounded';
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).not.toThrow();
  });
}

test('entry and age/duration policy exact boundaries are accepted', () => {
  const f = fixture();
  f.context.maxScanEntries = f.evidence.scan.entries;
  f.context.maxScanDurationMs = f.evidence.scan.completedAtMs - f.evidence.scan.startedAtMs;
  f.context.maxEvidenceAgeMs = f.context.nowMs - f.evidence.scan.completedAtMs;
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).not.toThrow();
});

const stale: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['expired evidence', (f) => f.context.nowMs = f.evidence.expiresAtMs],
  ['expired request', (f) => f.context.nowMs = f.evidence.request.expiresAtMs],
  ['future request', (f) => f.context.nowMs = f.evidence.request.issuedAtMs - 1],
  ['future evidence', (f) => f.context.nowMs = f.evidence.issuedAtMs - 1],
  ['issue before request', (f) => f.evidence.issuedAtMs = f.evidence.request.issuedAtMs - 1],
  ['expiry beyond request', (f) => f.evidence.expiresAtMs = f.evidence.request.expiresAtMs + 1],
  ['scan before request', (f) => f.evidence.scan.startedAtMs = f.evidence.request.issuedAtMs - 1],
  ['negative scan interval', (f) => f.evidence.scan.completedAtMs = f.evidence.scan.startedAtMs - 1],
  ['scan after evidence issue', (f) => f.evidence.scan.completedAtMs = f.evidence.issuedAtMs + 1],
  ['stale scan hidden by fresh issue', (f) => { f.evidence.issuedAtMs = f.context.nowMs; f.context.maxEvidenceAgeMs = 599; }],
  ['overlong scan', (f) => f.context.maxScanDurationMs = 299],
  ['entry budget exceeded', (f) => f.context.maxScanEntries = '99'],
  ['local lifetime ceiling', (f) => f.context.maxLifetimeMs = 9999],
  ['evidence lifetime reversed', (f) => f.evidence.expiresAtMs = f.evidence.issuedAtMs],
  ['request lifetime reversed', (f) => f.evidence.request.expiresAtMs = f.evidence.request.issuedAtMs],
  ['evidence global lifetime ceiling', (f) => f.evidence.expiresAtMs = f.evidence.issuedAtMs + 300001],
  ['request global lifetime ceiling', (f) => f.evidence.request.expiresAtMs = f.evidence.request.issuedAtMs + 300001],
];
for (const [name, mutate] of stale) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/Runtime capacity protocol rejected/);
});

const malformed: Array<[string, (f: any) => void]> = [
  ['evidence version', (f) => f.evidence.version = 2],
  ['request version', (f) => f.evidence.request.version = '1'],
  ['evidence kind', (f) => f.evidence.kind = 'capacity-ticket'],
  ['request kind', (f) => f.evidence.request.kind = 'admission'],
  ['authority flag', (f) => f.evidence.capacityVerified = true],
  ['source path', (f) => f.evidence.request.binding.path = '/var/lib/docker'],
  ['scan partial counts', (f) => f.evidence.scan.partialBytes = '100'],
  ['unknown context field', (f) => f.context.authenticated = true],
  ['unknown replay field', (f) => f.context.replayState.expired = true],
  ['missing binding', (f) => delete f.evidence.request.binding],
  ['missing context', (f) => f.context = null],
  ['null scan', (f) => f.evidence.scan = null],
  ['array evidence', (f) => f.evidence = []],
  ['inherited request', (f) => f.evidence.request = Object.create(f.evidence.request)],
  ['invalid target', (f) => f.evidence.request.binding.targetRuntime = 'runc'],
  ['invalid phase', (f) => f.evidence.request.binding.phase = 'admit'],
  ['unknown source state', (f) => f.evidence.scan.sourceState = 'running'],
  ['unknown expected source state', (f) => f.evidence.request.binding.expectedSourceState = 'unverified'],
  ['empty identifier', (f) => f.evidence.request.binding.hostId = ''],
  ['oversized identifier', (f) => f.evidence.request.binding.hostId = 'a'.repeat(129)],
  ['path identifier', (f) => f.evidence.request.binding.hostId = '/host'],
  ['short container ID', (f) => f.evidence.request.binding.sourceContainerId = 'a'.repeat(12)],
  ['short nonce', (f) => f.evidence.request.nonce = 'a'.repeat(32)],
  ['uppercase nonce', (f) => f.evidence.request.nonce = 'A'.repeat(64)],
  ['short digest', (f) => f.evidence.request.binding.inventoryDigest = 'sha256:abc'],
  ['wrong digest algorithm', (f) => f.evidence.request.binding.envelopeDigest = `sha512:${'a'.repeat(64)}`],
  ['zero sequence', (f) => f.evidence.sequence = '0'],
  ['overflow sequence', (f) => f.evidence.sequence = '18446744073709551616'],
  ['unsafe numeric sequence', (f) => f.evidence.sequence = Number.MAX_SAFE_INTEGER + 1],
  ['noncanonical sequence', (f) => f.evidence.sequence = '042'],
  ['zero layout generation', (f) => f.evidence.request.binding.layoutGeneration = '0'],
  ['overflow layout generation', (f) => f.evidence.request.binding.layoutGeneration = '18446744073709551616'],
  ['zero entries', (f) => f.evidence.scan.entries = '0'],
  ['overflow entries', (f) => f.evidence.scan.entries = '18446744073709551616'],
  ['oversized integer string', (f) => f.evidence.scan.entries = '9'.repeat(1000)],
  ['zero local scan budget', (f) => f.context.maxScanEntries = '0'],
  ['huge local scan budget', (f) => f.context.maxScanEntries = '100000001'],
  ['overflow replay state', (f) => f.context.replayState.sequence = '18446744073709551616'],
  ['negative scan count', (f) => f.evidence.scan.entries = '-1'],
];
for (const [name, mutate] of malformed) test(`rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/Runtime capacity protocol rejected/);
});

for (const status of ['partial', 'timeout', 'cancelled', 'permission-denied', 'changing-tree', 'limit-hit', true, null]) {
  test(`rejects incomplete scan status ${status}`, () => {
    const f = fixture(); (f.evidence.scan as any).status = status;
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/scan.status must be complete/);
  });
}

for (const value of [-1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1000', null]) {
  test(`rejects unsafe timestamp ${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`, () => {
    const f = fixture(); (f.evidence as any).issuedAtMs = value;
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/evidence.issuedAtMs/);
  });
}

for (const field of ['maxEvidenceAgeMs', 'maxLifetimeMs', 'maxScanDurationMs'] as const) {
  for (const value of [0, 300001]) test(`rejects invalid local ${field} ${value}`, () => {
    const f = fixture(); f.context[field] = value;
    expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(`context.${field}`);
  });
}

test('own accessor and symbol fields are rejected without evaluating getters', () => {
  const f = fixture(); let called = false;
  Object.defineProperty(f.evidence, 'sequence', { get: () => { called = true; return '42'; }, enumerable: true });
  expect(() => verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context)).toThrow(/evidence.sequence/);
  expect(called).toBe(false);
  const other = fixture(); (other.evidence as any)[Symbol('extra')] = 'hidden';
  expect(() => verifyRuntimeCapacityMeasurementEvidence(other.evidence, other.context)).toThrow(/rejected: evidence/);
});

test('diagnostics never echo untrusted path, credential or identity values', () => {
  const f = fixture(); f.evidence.request.binding.hostId = 'sensitive-identity';
  try { verifyRuntimeCapacityMeasurementEvidence(f.evidence, f.context); throw new Error('unexpected success'); }
  catch (error) {
    expect(String(error)).toContain('binding mismatch: hostId');
    expect(String(error)).not.toContain('sensitive-identity');
  }
});
