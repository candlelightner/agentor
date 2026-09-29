import { expect, test } from '@playwright/test';
import { calculateRuntimeCapacityHeadroom, type RuntimeCapacityAccountingInput } from '../../orchestrator/server/utils/worker-runtime-capacity-accounting';
import { assertRuntimeMigrationCapacityAdmission } from '../../orchestrator/server/utils/worker-runtime-capacity';

const amount = (bytes: string, inodes = bytes) => ({ bytes, inodes });
function fixture(): RuntimeCapacityAccountingInput {
  return {
    version: 1,
    constraints: [{ id: 'fs-1', kind: 'filesystem', available: amount('1000'), safetyFloor: amount('100') }],
    destinations: [{ id: 'images', constraintIds: ['fs-1'] }, { id: 'volumes', constraintIds: ['fs-1'] }],
    demands: [{ id: 'rootfs-commit', destinationId: 'images', amount: amount('200') },
      { id: 'rollback-copy', destinationId: 'volumes', amount: amount('300') }],
    reservations: [{ id: 'other-operation', allocations: [{ constraintId: 'fs-1', amount: amount('150') }] }],
  };
}

test('aliased image and volume paths share one budget, including reservations and safety floor', () => {
  const input = fixture(), before = structuredClone(input);
  expect(calculateRuntimeCapacityHeadroom(input)).toEqual({ version: 1, constraints: [{
    id: 'fs-1', available: amount('1000'), safetyFloor: amount('100'),
    requested: amount('500'), outstanding: amount('150'), remaining: amount('250'),
  }] });
  expect(input).toEqual(before);
});

test('distinct copies on an aliased destination are additive; aliases cannot manufacture free space', () => {
  const input = fixture();
  input.demands.push({ id: 'second-copy', destinationId: 'volumes', amount: amount('251') });
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/Insufficient.*fs-1/);
});

test('separate filesystems and shared quota/pool limits each constrain the full demand mapped to them', () => {
  const input = fixture();
  input.constraints.push({ id: 'fs-2', kind: 'filesystem', available: amount('900'), safetyFloor: amount('50') },
    { id: 'quota', kind: 'quota', available: amount('800'), safetyFloor: amount('100') },
    { id: 'pool', kind: 'pool', available: amount('1000'), safetyFloor: amount('100') });
  input.destinations[0]!.constraintIds.push('quota', 'pool');
  input.destinations[1]!.constraintIds = ['fs-2', 'quota', 'pool'];
  input.reservations[0]!.allocations.push({ constraintId: 'quota', amount: amount('150') },
    { constraintId: 'pool', amount: amount('150') });
  const result = calculateRuntimeCapacityHeadroom(input).constraints;
  expect(result.map((row) => [row.id, row.requested.bytes, row.remaining.bytes])).toEqual([
    ['fs-1', '200', '550'], ['fs-2', '300', '550'], ['quota', '500', '50'], ['pool', '500', '250'],
  ]);
  input.constraints[2]!.available.bytes = '749';
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/quota \(bytes\)/);
});

for (const resource of ['bytes', 'inodes'] as const) test(`${resource} exhaustion rejects independently`, () => {
  const input = fixture();
  input.constraints[0]!.available[resource] = '749';
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(`fs-1 (${resource})`);
});

test('exact floor boundary succeeds with zero remaining allocation headroom', () => {
  const input = fixture();
  input.constraints[0]!.available = amount('750');
  expect(calculateRuntimeCapacityHeadroom(input).constraints[0]!.remaining).toEqual(amount('0'));
});

function quotaFixture(): RuntimeCapacityAccountingInput {
  const input = fixture();
  input.constraints.push({ id: 'quota', kind: 'quota', available: amount('650'), safetyFloor: amount('0') });
  input.destinations.forEach((destination) => destination.constraintIds.push('quota'));
  input.reservations[0]!.allocations.push({ constraintId: 'quota', amount: amount('150') });
  return input;
}

test('quota-only zero floors admit the exact enforced boundary without weakening physical floors', () => {
  const result = calculateRuntimeCapacityHeadroom(quotaFixture()).constraints;
  expect(result[0]).toMatchObject({ id: 'fs-1', safetyFloor: amount('100'), remaining: amount('250') });
  expect(result[1]).toEqual({ id: 'quota', available: amount('650'), safetyFloor: amount('0'),
    outstanding: amount('150'), requested: amount('500'), remaining: amount('0') });
});

for (const resource of ['bytes', 'inodes'] as const) {
  test(`zero quota ${resource} headroom rejects positive demand rather than representing unlimited quota`, () => {
    const input = quotaFixture();
    input.constraints[1]!.available[resource] = '0';
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(`quota (${resource})`);
  });

  test(`quota-only ${resource} floor may be positive and is still charged`, () => {
    const input = quotaFixture();
    input.constraints[1]!.safetyFloor[resource] = '1';
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(`quota (${resource})`);
    input.constraints[1]!.available[resource] = '651';
    expect(calculateRuntimeCapacityHeadroom(input).constraints[1]!.remaining).toEqual(amount('0'));
  });

  test(`pool ${resource} safety floor must remain positive even with a valid filesystem mapping`, () => {
    const input = fixture();
    input.constraints.push({ id: 'pool', kind: 'pool', available: amount('1000'), safetyFloor: amount('100') });
    input.constraints[1]!.safetyFloor[resource] = '0';
    input.destinations.forEach((destination) => destination.constraintIds.push('pool'));
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/physical constraint.safetyFloor must be nonzero/);
  });

  test(`quota allowance cannot cover filesystem ${resource} exhaustion`, () => {
    const input = quotaFixture();
    input.constraints[0]!.available[resource] = '749';
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(`fs-1 (${resource})`);
  });
}

test('changing the only filesystem to a zero-floor quota cannot bypass physical domain mapping', () => {
  const input = fixture();
  input.constraints[0]!.kind = 'quota';
  input.constraints[0]!.safetyFloor = amount('0');
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/exactly one filesystem/);
});

test('all outstanding reservations accumulate; no terminal or expired ticket can be silently excluded', () => {
  const input = fixture();
  input.reservations.push({ id: 'expired-or-orphan-operation', allocations: [{ constraintId: 'fs-1', amount: amount('250') }] });
  expect(calculateRuntimeCapacityHeadroom(input).constraints[0]!.remaining).toEqual(amount('0'));
  (input.reservations[1] as any).expired = true;
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/Invalid/);
});

test('decimal quantities above the JavaScript exact integer range remain exact', () => {
  const input = fixture();
  input.constraints[0]!.available = amount('18446744073709551615');
  input.demands = [{ id: 'large', destinationId: 'images', amount: amount('9007199254740993') }];
  expect(calculateRuntimeCapacityHeadroom(input).constraints[0]!.remaining).toEqual(amount('18437736874454810372'));
});

test('zero in one demand dimension is valid, including metadata-only allocation', () => {
  const input = fixture();
  input.demands = [{ id: 'metadata', destinationId: 'images', amount: amount('0', '1') }];
  input.reservations = [];
  expect(calculateRuntimeCapacityHeadroom(input).constraints[0]!.remaining).toEqual(amount('900', '899'));
});

const malformed: Array<[string, (input: any) => void]> = [
  ['schema version', (x) => x.version = 2],
  ['client authority flag', (x) => x.capacityVerified = true],
  ['unknown source path', (x) => x.destinations[0].path = '/var/lib/docker'],
  ['unknown measurement field', (x) => x.constraints[0].available.free = '1000'],
  ['unknown constraint kind', (x) => x.constraints[0].kind = 'unknown'],
  ['duplicate constraint', (x) => x.constraints.push(structuredClone(x.constraints[0]))],
  ['duplicate destination', (x) => x.destinations.push(structuredClone(x.destinations[0]))],
  ['duplicate alias constraint', (x) => x.destinations[0].constraintIds.push('fs-1')],
  ['unknown destination constraint', (x) => x.destinations[0].constraintIds.push('missing')],
  ['no filesystem', (x) => x.constraints[0].kind = 'quota'],
  ['two filesystems', (x) => { x.constraints.push({ ...x.constraints[0], id: 'fs-2' }); x.destinations[0].constraintIds.push('fs-2'); }],
  ['unmapped constraint', (x) => x.constraints.push({ ...x.constraints[0], id: 'unused' })],
  ['unmapped demand', (x) => x.demands[0].destinationId = 'missing'],
  ['duplicate demand', (x) => x.demands.push(structuredClone(x.demands[0]))],
  ['empty demand', (x) => x.demands[0].amount = amount('0')],
  ['duplicate reservation', (x) => x.reservations.push(structuredClone(x.reservations[0]))],
  ['duplicate reservation constraint', (x) => x.reservations[0].allocations.push(structuredClone(x.reservations[0].allocations[0]))],
  ['unknown reservation constraint', (x) => x.reservations[0].allocations[0].constraintId = 'missing'],
  ['empty reservation', (x) => x.reservations[0].allocations[0].amount = amount('0')],
  ['zero byte floor', (x) => x.constraints[0].safetyFloor.bytes = '0'],
  ['zero inode floor', (x) => x.constraints[0].safetyFloor.inodes = '0'],
  ['path identifier', (x) => x.constraints[0].id = '/var/lib/docker'],
  ['oversized identifier', (x) => x.constraints[0].id = 'a'.repeat(129)],
  ...['constraints', 'destinations', 'demands'].map((key): [string, (x: any) => void] => [`empty ${key}`, (x) => x[key] = []]),
  ['missing reservations', (x) => delete x.reservations],
  ['null amount', (x) => x.demands[0].amount = null],
  ['array instead of amount', (x) => x.demands[0].amount = []],
  ['inherited field', (x) => x.demands[0].amount = Object.create(amount('1'))],
  ['empty allocations', (x) => x.reservations[0].allocations = []],
  ['empty mappings', (x) => x.destinations[0].constraintIds = []],
  ['too many constraints', (x) => x.constraints = Array.from({ length: 65 }, (_, i) => ({ ...x.constraints[0], id: `fs-${i}` }))],
  ['too many destinations', (x) => x.destinations = Array.from({ length: 129 }, (_, i) => ({ ...x.destinations[0], id: `dst-${i}` }))],
  ['too many demands', (x) => x.demands = Array.from({ length: 1025 }, (_, i) => ({ ...x.demands[0], id: `demand-${i}` }))],
  ['too many reservations', (x) => x.reservations = Array.from({ length: 1025 }, (_, i) => ({ ...x.reservations[0], id: `reserved-${i}` }))],
];
for (const [name, mutate] of malformed) test(`rejects ${name}`, () => {
  const input = fixture(); mutate(input);
  expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/Invalid runtime capacity accounting input/);
});

for (const value of [-1, 1, 1.5, NaN, Infinity, null, true, '', '01', '-1', '+1', ' 1', '1 ', '1e3', '1.0', '18446744073709551616', '9'.repeat(1000)]) {
  test(`rejects noncanonical or out-of-range quantity ${typeof value}:${String(value).slice(0, 30)}`, () => {
    const input = fixture(); (input.demands[0]!.amount as any).bytes = value;
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/Invalid/);
  });
}

for (const dimension of ['bytes', 'inodes'] as const) {
  for (const phase of ['requested', 'outstanding', 'required'] as const) test(`rejects uint64 overflow in ${phase} ${dimension}`, () => {
    const input = fixture(), maximum = '18446744073709551615';
    input.constraints[0]!.available = amount(maximum);
    if (phase === 'requested') input.demands[0]!.amount[dimension] = maximum;
    if (phase === 'outstanding') {
      input.reservations[0]!.allocations[0]!.amount[dimension] = maximum;
      input.reservations.push({ id: 'another', allocations: [{ constraintId: 'fs-1', amount: amount('1') }] });
    }
    if (phase === 'required') input.constraints[0]!.safetyFloor[dimension] = maximum;
    expect(() => calculateRuntimeCapacityHeadroom(input)).toThrow(/uint64 overflow/);
  });
}

test('successful arithmetic supplies no admission grant and cannot open the public migration gate', () => {
  const result = calculateRuntimeCapacityHeadroom(fixture());
  expect(Object.keys(result)).toEqual(['version', 'constraints']);
  expect(() => assertRuntimeMigrationCapacityAdmission()).toThrow(/trusted disk-capacity admission/);
});
