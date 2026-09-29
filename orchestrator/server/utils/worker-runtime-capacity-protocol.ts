/** Versioned capacity measurement schema and local consistency checks only.
 *
 * This module does NOT authenticate a service, establish a storage layout,
 * enforce a quota/fence, reserve capacity or authorize migration. Its inputs
 * must eventually come from a size-bounded authenticated transport; the expected
 * request, clock/policy and replay high-water must come from trusted local state,
 * never an API client, backup or the evidence being checked. Digest production
 * must bind the exact versioned inventory/envelope bytes; digest equality here
 * is not validation of their contents or measurement completeness.
 * Expected source state comes from the caller's trusted phase context. Matching
 * a reported state does not prove quiescence or make a restart/rollback safe.
 *
 * After verification, the caller must atomically compare-and-persist replay
 * state and consume the outstanding request nonce BEFORE using the result.
 * Reusing stale local state can replay any pure verifier. Service/host/daemon
 * identity changes need separate trusted enrollment; they cannot reset a ledger.
 * No transport, ledger or migration integration exists in this module.
 */

export type RuntimeCapacityPhase = 'pre-stop' | 'stopped-source' | 'forward' | 'recovery' | 'finalization';
export interface RuntimeCapacityBinding {
  hostId: string;
  serviceId: string;
  daemonId: string;
  layoutGeneration: string;
  maintenanceEpoch: string;
  operationId: string;
  ownerId: string;
  workerId: string;
  sourceContainerId: string;
  targetRuntime: 'kata-qemu' | 'legacy-runc';
  inventoryDigest: string;
  envelopeDigest: string;
  phase: RuntimeCapacityPhase;
  expectedSourceState: 'running-bounded' | 'stopped';
}
export interface RuntimeCapacityMeasurementRequest {
  version: 1;
  kind: 'capacity-measurement-request';
  binding: RuntimeCapacityBinding;
  nonce: string;
  issuedAtMs: number;
  expiresAtMs: number;
}
export interface RuntimeCapacityMeasurementEvidence {
  version: 1;
  kind: 'capacity-measurement-evidence';
  request: RuntimeCapacityMeasurementRequest;
  sequence: string;
  issuedAtMs: number;
  expiresAtMs: number;
  scan: {
    status: 'complete';
    sourceState: 'running-bounded' | 'stopped';
    startedAtMs: number;
    completedAtMs: number;
    entries: string;
  };
}
export interface RuntimeCapacityReplayState {
  hostId: string;
  serviceId: string;
  daemonId: string;
  sequence: string;
}
export interface RuntimeCapacityVerificationContext {
  expectedRequest: RuntimeCapacityMeasurementRequest;
  replayState: RuntimeCapacityReplayState;
  nowMs: number;
  maxEvidenceAgeMs: number;
  maxLifetimeMs: number;
  maxScanDurationMs: number;
  maxScanEntries: string;
}

const MAX_UINT64 = (1n << 64n) - 1n;
// Protocol ceilings, not evidence that this timing/scan policy fits a layout.
const MAX_WINDOW_MS = 300_000;
const MAX_SCAN_ENTRIES = 100_000_000n;
const BINDING_KEYS = ['hostId', 'serviceId', 'daemonId', 'layoutGeneration', 'maintenanceEpoch',
  'operationId', 'ownerId', 'workerId', 'sourceContainerId', 'targetRuntime', 'inventoryDigest',
  'envelopeDigest', 'phase', 'expectedSourceState'] as const;

function reject(reason: string, code = 'WORKER_RUNTIME_CAPACITY_PROTOCOL_INVALID'): never {
  // Reasons name schema fields, never supplied values, credentials or paths.
  throw Object.assign(new Error(`Runtime capacity protocol rejected: ${reason}`), { code });
}

function record(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(name);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) reject(name);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) reject(`${name}.${field}`);
    result[field] = descriptor.value;
  }
  return result;
}

function token(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) reject(name);
  return value;
}

function hex(value: unknown, name: string, digest = false): string {
  if (typeof value !== 'string' || !(digest ? /^sha256:[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/).test(value)) reject(name);
  return value;
}

function uint(value: unknown, name: string, nonzero = false): string {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) reject(name);
  const integer = BigInt(value);
  if (integer > MAX_UINT64 || (nonzero && integer === 0n)) reject(name);
  return value;
}

function time(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) reject(name);
  return value;
}

function window(value: unknown, name: string): number {
  const parsed = time(value, name);
  if (parsed === 0 || parsed > MAX_WINDOW_MS) reject(name);
  return parsed;
}

function lifetime(issued: number, expires: number, maximum = MAX_WINDOW_MS): void {
  if (expires <= issued || expires - issued > maximum) reject('lifetime');
}

function binding(value: unknown): RuntimeCapacityBinding {
  const row = record(value, BINDING_KEYS, 'binding');
  if (row.targetRuntime !== 'kata-qemu' && row.targetRuntime !== 'legacy-runc') reject('binding.targetRuntime');
  if (row.phase !== 'pre-stop' && row.phase !== 'stopped-source' && row.phase !== 'forward' &&
      row.phase !== 'recovery' && row.phase !== 'finalization') reject('binding.phase');
  if (row.expectedSourceState !== 'running-bounded' && row.expectedSourceState !== 'stopped') reject('binding.expectedSourceState');
  return {
    hostId: token(row.hostId, 'binding.hostId'), serviceId: token(row.serviceId, 'binding.serviceId'),
    daemonId: token(row.daemonId, 'binding.daemonId'), layoutGeneration: uint(row.layoutGeneration, 'binding.layoutGeneration', true),
    maintenanceEpoch: token(row.maintenanceEpoch, 'binding.maintenanceEpoch'), operationId: token(row.operationId, 'binding.operationId'),
    ownerId: token(row.ownerId, 'binding.ownerId'), workerId: token(row.workerId, 'binding.workerId'),
    sourceContainerId: hex(row.sourceContainerId, 'binding.sourceContainerId'), targetRuntime: row.targetRuntime,
    inventoryDigest: hex(row.inventoryDigest, 'binding.inventoryDigest', true),
    envelopeDigest: hex(row.envelopeDigest, 'binding.envelopeDigest', true), phase: row.phase,
    expectedSourceState: row.expectedSourceState,
  };
}

/** Strict schema parsing only; does not establish freshness or authority. */
export function parseRuntimeCapacityMeasurementRequest(value: unknown): RuntimeCapacityMeasurementRequest {
  const row = record(value, ['version', 'kind', 'binding', 'nonce', 'issuedAtMs', 'expiresAtMs'], 'request');
  if (row.version !== 1 || row.kind !== 'capacity-measurement-request') reject('request.version/kind');
  const result: RuntimeCapacityMeasurementRequest = {
    version: 1, kind: 'capacity-measurement-request', binding: binding(row.binding), nonce: hex(row.nonce, 'request.nonce'),
    issuedAtMs: time(row.issuedAtMs, 'request.issuedAtMs'), expiresAtMs: time(row.expiresAtMs, 'request.expiresAtMs'),
  };
  lifetime(result.issuedAtMs, result.expiresAtMs);
  return result;
}

function evidence(value: unknown): RuntimeCapacityMeasurementEvidence {
  const row = record(value, ['version', 'kind', 'request', 'sequence', 'issuedAtMs', 'expiresAtMs', 'scan'], 'evidence');
  if (row.version !== 1 || row.kind !== 'capacity-measurement-evidence') reject('evidence.version/kind');
  const scan = record(row.scan, ['status', 'sourceState', 'startedAtMs', 'completedAtMs', 'entries'], 'scan');
  if (scan.status !== 'complete') reject('scan.status must be complete');
  if (scan.sourceState !== 'running-bounded' && scan.sourceState !== 'stopped') reject('scan.sourceState');
  const result: RuntimeCapacityMeasurementEvidence = {
    version: 1, kind: 'capacity-measurement-evidence', request: parseRuntimeCapacityMeasurementRequest(row.request),
    sequence: uint(row.sequence, 'evidence.sequence', true), issuedAtMs: time(row.issuedAtMs, 'evidence.issuedAtMs'),
    expiresAtMs: time(row.expiresAtMs, 'evidence.expiresAtMs'),
    scan: { status: 'complete', sourceState: scan.sourceState, startedAtMs: time(scan.startedAtMs, 'scan.startedAtMs'),
      completedAtMs: time(scan.completedAtMs, 'scan.completedAtMs'), entries: uint(scan.entries, 'scan.entries', true) },
  };
  lifetime(result.issuedAtMs, result.expiresAtMs);
  return result;
}

/** Pure comparison against caller-owned trusted context. Returned data is not a
 * ticket/grant. Persistence and nonce consumption MUST be a separate atomic
 * operation; no mutation, authentication or reservation is performed here. */
export function verifyRuntimeCapacityMeasurementEvidence(value: unknown, trustedContext: unknown): {
  evidence: RuntimeCapacityMeasurementEvidence; nextReplayState: RuntimeCapacityReplayState;
} {
  const context = record(trustedContext, ['expectedRequest', 'replayState', 'nowMs', 'maxEvidenceAgeMs',
    'maxLifetimeMs', 'maxScanDurationMs', 'maxScanEntries'], 'context');
  const expected = parseRuntimeCapacityMeasurementRequest(context.expectedRequest);
  const replay = record(context.replayState, ['hostId', 'serviceId', 'daemonId', 'sequence'], 'replayState');
  const lastSequence = uint(replay.sequence, 'replayState.sequence');
  for (const key of ['hostId', 'serviceId', 'daemonId'] as const) {
    if (token(replay[key], `replayState.${key}`) !== expected.binding[key]) reject('replayState identity');
  }
  const now = time(context.nowMs, 'context.nowMs');
  const maxAge = window(context.maxEvidenceAgeMs, 'context.maxEvidenceAgeMs');
  const maxLifetime = window(context.maxLifetimeMs, 'context.maxLifetimeMs');
  const maxScanDuration = window(context.maxScanDurationMs, 'context.maxScanDurationMs');
  const maxScanEntries = BigInt(uint(context.maxScanEntries, 'context.maxScanEntries', true));
  if (maxScanEntries > MAX_SCAN_ENTRIES) reject('context.maxScanEntries');
  const result = evidence(value);
  for (const key of BINDING_KEYS) {
    if (result.request.binding[key] !== expected.binding[key]) reject(`binding mismatch: ${key}`, 'WORKER_RUNTIME_CAPACITY_PROTOCOL_MISMATCH');
  }
  for (const key of ['nonce', 'issuedAtMs', 'expiresAtMs'] as const) {
    if (result.request[key] !== expected[key]) reject(`request mismatch: ${key}`, 'WORKER_RUNTIME_CAPACITY_PROTOCOL_MISMATCH');
  }
  if (BigInt(result.sequence) <= BigInt(lastSequence)) reject('replayed sequence', 'WORKER_RUNTIME_CAPACITY_PROTOCOL_REPLAY');
  lifetime(expected.issuedAtMs, expected.expiresAtMs, maxLifetime);
  lifetime(result.issuedAtMs, result.expiresAtMs, maxLifetime);
  if (expected.issuedAtMs > now || expected.expiresAtMs <= now || result.issuedAtMs > now || result.expiresAtMs <= now ||
      result.issuedAtMs < expected.issuedAtMs || result.expiresAtMs > expected.expiresAtMs)
    reject('stale/future/out-of-request lifetime', 'WORKER_RUNTIME_CAPACITY_PROTOCOL_STALE');
  if (result.scan.startedAtMs < expected.issuedAtMs || result.scan.completedAtMs < result.scan.startedAtMs ||
      result.scan.completedAtMs > result.issuedAtMs || now - result.scan.completedAtMs > maxAge ||
      result.scan.completedAtMs - result.scan.startedAtMs > maxScanDuration)
    reject('stale/inconsistent scan time', 'WORKER_RUNTIME_CAPACITY_PROTOCOL_STALE');
  if (BigInt(result.scan.entries) > maxScanEntries) reject('scan entry limit');
  if (result.scan.sourceState !== expected.binding.expectedSourceState) reject('scan source state differs from trusted expectation');
  return { evidence: result, nextReplayState: { hostId: expected.binding.hostId,
    serviceId: expected.binding.serviceId, daemonId: expected.binding.daemonId, sequence: result.sequence } };
}
