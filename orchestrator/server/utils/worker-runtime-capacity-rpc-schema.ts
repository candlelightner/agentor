/** Canonical, bounded wire format for the isolated read-only capacity RPC.
 * No path, quota, ledger review or admission operation exists in this schema.
 * Canonical encoding rejects duplicate keys/ambiguous JSON before dispatch.
 */
import { parseRuntimeCapacityMeasurementRequest, type RuntimeCapacityMeasurementRequest } from './worker-runtime-capacity-protocol';

export const CAPACITY_RPC_MAX_FRAME_BYTES = 64 * 1024;
export type CapacityRpcIdentity = { hostId: string; serviceId: string; daemonId: string };
export type CapacityRpcRequest = { version: 1; kind: 'capacity-rpc-request'; generation: string;
  requestId: string; method: 'measure'; request: RuntimeCapacityMeasurementRequest };
export type CapacityRpcResponse = { version: 1; kind: 'capacity-rpc-response'; generation: string;
  requestId: string } & ({ status: 'ok'; measurement: unknown } | { status: 'error'; error: 'REJECTED' | 'UNAVAILABLE' | 'BUSY' });

export function capacityRpcError(): Error {
  return Object.assign(new Error('Capacity RPC unavailable or rejected; no phase permission or cancellation is established'),
    { code: 'WORKER_RUNTIME_CAPACITY_RPC_UNAVAILABLE' });
}
function invalid(): never { throw capacityRpcError(); }
export function capacityRpcRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    out[key] = descriptor.value;
  }
  return out;
}
export function capacityRpcGeneration(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value) || BigInt(value) > (1n << 64n) - 1n) invalid();
  return value;
}
export function capacityRpcIdentity(value: unknown): CapacityRpcIdentity {
  const row = capacityRpcRecord(value, ['hostId', 'serviceId', 'daemonId']);
  for (const item of Object.values(row))
    if (typeof item !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(item)) invalid();
  return row as CapacityRpcIdentity;
}
export function assertCapacityRpcIdentity(request: RuntimeCapacityMeasurementRequest, identity: CapacityRpcIdentity): void {
  if (Object.keys(identity).some(key => request.binding[key as keyof CapacityRpcIdentity] !== identity[key as keyof CapacityRpcIdentity])) invalid();
}
function requestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) invalid();
  return value;
}

/** The same depth/node/byte limits apply to local output and hostile input.
 * Reject accessors, exotic objects, sparse arrays and toJSON hooks. */
function canonical(value: unknown, depth = 0, budget = { nodes: 2048, bytes: CAPACITY_RPC_MAX_FRAME_BYTES }): string {
  if (depth > 12 || --budget.nodes < 0) invalid();
  const charge = (text: string) => { budget.bytes -= Buffer.byteLength(text); if (budget.bytes < 0) invalid(); return text; };
  if (value === null || typeof value === 'boolean') return charge(JSON.stringify(value));
  if (typeof value === 'string') {
    if (value.length > CAPACITY_RPC_MAX_FRAME_BYTES) invalid();
    return charge(JSON.stringify(value));
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0)) return charge(String(value));
  if (Array.isArray(value)) {
    if (value.length > 64 || Reflect.ownKeys(value).length !== value.length + 1) invalid();
    charge('[' + ','.repeat(value.length) + ']');
    return '[' + Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
      return canonical(descriptor.value, depth + 1, budget);
    }).join(',') + ']';
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length > 64 || keys.some(key => typeof key !== 'string')) invalid();
  charge('{' + ','.repeat(keys.length) + '}');
  return '{' + (keys as string[]).sort().map(key => {
    if (key.length > 128) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) invalid();
    return charge(JSON.stringify(key) + ':') + canonical(descriptor.value, depth + 1, budget);
  }).join(',') + '}';
}
export function encodeCapacityRpcFrame(value: unknown): Buffer {
  const payload = Buffer.from(canonical(value), 'utf8');
  if (!payload.length || payload.length > CAPACITY_RPC_MAX_FRAME_BYTES) invalid();
  const header = Buffer.alloc(4); header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}
export function decodeCapacityRpcPayload(payload: Buffer): unknown {
  if (!payload.length || payload.length > CAPACITY_RPC_MAX_FRAME_BYTES) invalid();
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    const value: unknown = JSON.parse(text);
    if (canonical(value) !== text) invalid();
    return value;
  } catch { invalid(); }
}
export function parseCapacityRpcRequest(value: unknown): CapacityRpcRequest {
  const row = capacityRpcRecord(value, ['version', 'kind', 'generation', 'requestId', 'method', 'request']);
  if (row.version !== 1 || row.kind !== 'capacity-rpc-request' || row.method !== 'measure') invalid();
  return { version: 1, kind: 'capacity-rpc-request', generation: capacityRpcGeneration(row.generation),
    requestId: requestId(row.requestId), method: 'measure', request: parseRuntimeCapacityMeasurementRequest(row.request) };
}
export function parseCapacityRpcResponse(value: unknown): CapacityRpcResponse {
  if (!value || typeof value !== 'object') invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, 'status');
  if (!descriptor || !('value' in descriptor)) invalid();
  const status: unknown = descriptor.value;
  if (status !== 'ok' && status !== 'error') invalid();
  const row = capacityRpcRecord(value, ['version', 'kind', 'generation', 'requestId', 'status', status === 'ok' ? 'measurement' : 'error']);
  if (row.version !== 1 || row.kind !== 'capacity-rpc-response') invalid();
  const common = { version: 1 as const, kind: 'capacity-rpc-response' as const,
    generation: capacityRpcGeneration(row.generation), requestId: requestId(row.requestId) };
  if (status === 'ok') return { ...common, status, measurement: row.measurement };
  if (row.error !== 'REJECTED' && row.error !== 'UNAVAILABLE' && row.error !== 'BUSY') invalid();
  return { ...common, status, error: row.error };
}
