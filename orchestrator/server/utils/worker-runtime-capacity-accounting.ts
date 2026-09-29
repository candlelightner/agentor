/** Pure, bounded accounting for a future operator capacity service.
 *
 * This is NOT admission or evidence authentication. Inputs must eventually come
 * from a trusted layout mapper, complete source measurement and durable ledger
 * inside that service. A successful calculation neither reserves space nor
 * establishes a maintenance fence or an enforced write bound. The public
 * migration gate remains closed until that separate protocol is implemented.
 *
 * Quantities are canonical unsigned 64-bit decimal strings in bytes / inodes.
 * Each allocation destination names exactly one filesystem constraint and any
 * additional quota / pool constraints. Aliases share constraint IDs, so free
 * space is never summed across paths. Different copies are distinct demands
 * even when they read the same source. Reservations describe FUTURE allocations
 * only; materialized usage is already reflected in available space. The caller
 * must reconcile that distinction durably, never infer it from ticket expiry.
 * Physical filesystem / pool floors must be positive in both dimensions.
 * Quota-only floors may be zero: a workload can consume its enforced hard
 * limit. Zero available quota means no headroom, never unlimited allocation.
 */

export interface RuntimeCapacityAmount { bytes: string; inodes: string }
export interface RuntimeCapacityAccountingInput {
  version: 1;
  constraints: Array<{
    id: string;
    kind: 'filesystem' | 'quota' | 'pool';
    available: RuntimeCapacityAmount;
    safetyFloor: RuntimeCapacityAmount;
  }>;
  destinations: Array<{ id: string; constraintIds: string[] }>;
  demands: Array<{ id: string; destinationId: string; amount: RuntimeCapacityAmount }>;
  // Every outstanding reservation is counted, including expired tickets and
  // operations whose orchestrator journal is missing or terminal.
  reservations: Array<{
    id: string;
    allocations: Array<{ constraintId: string; amount: RuntimeCapacityAmount }>;
  }>;
}
export interface RuntimeCapacityAccountingResult {
  version: 1;
  constraints: Array<{
    id: string;
    available: RuntimeCapacityAmount;
    safetyFloor: RuntimeCapacityAmount;
    outstanding: RuntimeCapacityAmount;
    requested: RuntimeCapacityAmount;
    remaining: RuntimeCapacityAmount;
  }>;
}

type Amount = { bytes: bigint; inodes: bigint };
const MAX_QUANTITY = (1n << 64n) - 1n;
const LIMITS = { constraints: 64, destinations: 128, demands: 1024, reservations: 1024 } as const;
function invalid(field: string): never {
  throw Object.assign(new Error(`Invalid runtime capacity accounting input: ${field}`), {
    code: 'WORKER_RUNTIME_CAPACITY_ACCOUNTING_INVALID',
  });
}

function object(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(field);
  const result = value as Record<string, unknown>;
  const own = Object.keys(result);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(result, key))) invalid(field);
  return result;
}

function list(value: unknown, maximum: number, field: string, allowEmpty = false): unknown[] {
  if (!Array.isArray(value) || value.length > maximum || (!allowEmpty && value.length === 0)) invalid(field);
  return value;
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalid(field);
  return value;
}

function quantity(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || value.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value)) invalid(field);
  const parsed = BigInt(value);
  if (parsed > MAX_QUANTITY) invalid(field);
  return parsed;
}

function amount(value: unknown, field: string): Amount {
  const item = object(value, ['bytes', 'inodes'], field);
  return { bytes: quantity(item.bytes, `${field}.bytes`), inodes: quantity(item.inodes, `${field}.inodes`) };
}

function add(left: Amount, right: Amount, field: string): Amount {
  const result = { bytes: left.bytes + right.bytes, inodes: left.inodes + right.inodes };
  if (result.bytes > MAX_QUANTITY || result.inodes > MAX_QUANTITY) invalid(`${field}: uint64 overflow`);
  return result;
}

function encode(value: Amount): RuntimeCapacityAmount {
  return { bytes: value.bytes.toString(), inodes: value.inodes.toString() };
}

/** Accepts decoded data rather than relying on TypeScript types at a boundary.
 * Throws on malformed, unmapped, ambiguous or insufficient accounting. It has
 * no I/O and returns no ticket, grant, capacityVerified flag or reservation.
 */
export function calculateRuntimeCapacityHeadroom(input: unknown): RuntimeCapacityAccountingResult {
  const root = object(input, ['version', 'constraints', 'destinations', 'demands', 'reservations'], 'root');
  if (root.version !== 1) invalid('version');
  const constraints = new Map<string, {
    kind: string; available: Amount; safetyFloor: Amount; outstanding: Amount; requested: Amount;
  }>();
  for (const raw of list(root.constraints, LIMITS.constraints, 'constraints')) {
    const row = object(raw, ['id', 'kind', 'available', 'safetyFloor'], 'constraint');
    const id = identifier(row.id, 'constraint.id');
    if (constraints.has(id)) invalid('duplicate constraint.id');
    if (row.kind !== 'filesystem' && row.kind !== 'quota' && row.kind !== 'pool') invalid('constraint.kind');
    const available = amount(row.available, 'constraint.available');
    const safetyFloor = amount(row.safetyFloor, 'constraint.safetyFloor');
    if (row.kind !== 'quota' && (safetyFloor.bytes === 0n || safetyFloor.inodes === 0n))
      invalid('physical constraint.safetyFloor must be nonzero');
    constraints.set(id, { kind: row.kind, available, safetyFloor,
      outstanding: { bytes: 0n, inodes: 0n }, requested: { bytes: 0n, inodes: 0n } });
  }

  const destinations = new Map<string, string[]>();
  const mapped = new Set<string>();
  for (const raw of list(root.destinations, LIMITS.destinations, 'destinations')) {
    const row = object(raw, ['id', 'constraintIds'], 'destination');
    const id = identifier(row.id, 'destination.id');
    if (destinations.has(id)) invalid('duplicate destination.id');
    const ids = list(row.constraintIds, LIMITS.constraints, 'destination.constraintIds')
      .map((value) => identifier(value, 'destination.constraintId'));
    if (new Set(ids).size !== ids.length || ids.some((key) => !constraints.has(key))) invalid('destination.constraintIds');
    if (ids.filter((key) => constraints.get(key)!.kind === 'filesystem').length !== 1)
      invalid('destination must map exactly one filesystem');
    ids.forEach((key) => mapped.add(key));
    destinations.set(id, ids);
  }
  if (mapped.size !== constraints.size) invalid('unmapped constraint');

  const demandIds = new Set<string>();
  for (const raw of list(root.demands, LIMITS.demands, 'demands')) {
    const row = object(raw, ['id', 'destinationId', 'amount'], 'demand');
    const id = identifier(row.id, 'demand.id');
    if (demandIds.has(id)) invalid('duplicate demand.id');
    demandIds.add(id);
    const keys = destinations.get(identifier(row.destinationId, 'demand.destinationId'));
    if (!keys) invalid('unmapped demand.destinationId');
    const demand = amount(row.amount, 'demand.amount');
    if (demand.bytes === 0n && demand.inodes === 0n) invalid('empty demand.amount');
    for (const key of keys) {
      const constraint = constraints.get(key)!;
      constraint.requested = add(constraint.requested, demand, 'requested');
    }
  }

  const reservationIds = new Set<string>();
  for (const raw of list(root.reservations, LIMITS.reservations, 'reservations', true)) {
    const row = object(raw, ['id', 'allocations'], 'reservation');
    const id = identifier(row.id, 'reservation.id');
    if (reservationIds.has(id)) invalid('duplicate reservation.id');
    reservationIds.add(id);
    const seen = new Set<string>();
    for (const rawAllocation of list(row.allocations, LIMITS.constraints, 'reservation.allocations')) {
      const allocation = object(rawAllocation, ['constraintId', 'amount'], 'reservation.allocation');
      const key = identifier(allocation.constraintId, 'reservation.constraintId');
      if (seen.has(key)) invalid('duplicate reservation.constraintId');
      seen.add(key);
      const constraint = constraints.get(key);
      if (!constraint) invalid('unmapped reservation.constraintId');
      const reserved = amount(allocation.amount, 'reservation.amount');
      if (reserved.bytes === 0n && reserved.inodes === 0n) invalid('empty reservation.amount');
      constraint.outstanding = add(constraint.outstanding, reserved, 'outstanding');
    }
  }

  return { version: 1, constraints: [...constraints].map(([id, row]) => {
    const required = add(add(row.safetyFloor, row.outstanding, 'required'), row.requested, 'required');
    for (const resource of ['bytes', 'inodes'] as const) {
      if (required[resource] > row.available[resource]) {
        throw Object.assign(new Error(`Insufficient runtime capacity accounting headroom: ${id} (${resource})`), {
          code: 'WORKER_RUNTIME_CAPACITY_ACCOUNTING_INSUFFICIENT', constraintId: id, resource,
        });
      }
    }
    return { id, available: encode(row.available), safetyFloor: encode(row.safetyFloor),
      outstanding: encode(row.outstanding), requested: encode(row.requested),
      remaining: encode({ bytes: row.available.bytes - required.bytes, inodes: row.available.inodes - required.inodes }) };
  }) };
}
