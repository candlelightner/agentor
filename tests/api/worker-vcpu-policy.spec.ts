import { test, expect } from '@playwright/test';
import type { WorkerGroup } from '../../orchestrator/server/utils/worker-group-store';
import { effectiveGroupVcpuLimit, effectiveWorkerVcpuLimit, assertGroupVcpuLimitChange,
  assertGroupVcpuReparent, assertWorkerVcpuMembershipChange, assertGroupVcpuLimit, workerVcpuAllocation } from '../../orchestrator/server/utils/worker-vcpu-policy';

const group = (id: string, parentId?: string, maxVcpuCount?: number | null, workerIds: string[] = []): WorkerGroup =>
  ({ id, parentId, maxVcpuCount, workerIds, userId: 'owner', name: id, createdAt: '', updatedAt: '' });

test('ceilings inherit the tightest ancestor per worker without summing sibling allocation', () => {
  const groups = [group('root', undefined, 8), group('child', 'root', 4, ['one', 'two']), group('leaf', 'child', null)];
  expect(effectiveGroupVcpuLimit('owner', 'leaf', groups)).toBe(4);
  expect(effectiveWorkerVcpuLimit('owner', 'one', groups)).toBe(4);
  expect(effectiveWorkerVcpuLimit('owner', 'two', groups)).toBe(4);
  expect(assertGroupVcpuLimit('owner', 'child', 4, true, groups)).toBe(4);
  expect(assertGroupVcpuLimit('owner', 'child', 4, true, groups)).toBe(4);
  expect(effectiveGroupVcpuLimit('owner', 'child', [group('root', undefined, 2), groups[1]!])).toBe(2);
  expect(effectiveGroupVcpuLimit('owner', 'root', [group('root')])).toBeNull();
});

test('delegation cannot raise its own ceiling, escape its subtree, or create unlimited CPU authority', () => {
  const groups = [group('root', undefined, 8), group('child', 'root', 4), group('leaf', 'child')];
  const delegated = { globalAdmin: false, authorityGroupId: 'child' };
  expect(() => assertGroupVcpuLimitChange('owner', 'child', 2, delegated, groups)).toThrow('descendant');
  expect(() => assertGroupVcpuLimitChange('owner', 'root', 2, delegated, groups)).toThrow('descendant');
  expect(() => assertGroupVcpuLimitChange('owner', 'leaf', 5, delegated, groups)).toThrow('ceiling');
  expect(assertGroupVcpuLimitChange('owner', 'leaf', 4, delegated, groups)).toBe(4);
  expect(assertGroupVcpuLimitChange('owner', 'leaf', null, delegated, groups)).toBeNull();
  expect(() => assertGroupVcpuLimitChange('owner', 'root', 8, { globalAdmin: false }, groups)).toThrow('configure');
  expect(() => assertGroupVcpuLimit('owner', 'root', 2, true, [group('root')])).toThrow('configure');
  expect(assertGroupVcpuLimitChange('owner', 'root', 16, { globalAdmin: true }, groups)).toBe(16);
  for (const value of [0, -1, 1.5, '4', NaN, undefined])
    expect(() => assertGroupVcpuLimitChange('owner', 'leaf', value, delegated, groups)).toThrow('positive integer');
});

test('owner moves and membership removal cannot discard a worker ceiling', () => {
  const groups = [group('root', undefined, 8), group('child', 'root', undefined, ['one']), group('other')];
  expect(() => assertGroupVcpuReparent('owner', 'child', null, false, groups)).toThrow('inherited');
  expect(() => assertWorkerVcpuMembershipChange('owner', groups, groups.map(item => ({ ...item, workerIds: [] })))).toThrow('source group');
  expect(() => assertWorkerVcpuMembershipChange('owner', groups, [groups[0]!, group('child', 'root'), group('other', undefined, 16, ['one'])])).toThrow('source group');
  expect(() => assertWorkerVcpuMembershipChange('owner', groups, [groups[0]!, group('child', 'root'), group('other', undefined, 4, ['one'])])).not.toThrow();
});

test('malformed hierarchy and cross-owner parents fail closed', () => {
  expect(() => effectiveGroupVcpuLimit('owner', 'child', [group('child', 'missing')])).toThrow('parent');
  expect(() => effectiveGroupVcpuLimit('owner', 'child', [group('child', 'root'), { ...group('root'), userId: 'other' }])).toThrow('parent');
  expect(() => effectiveGroupVcpuLimit('owner', 'child', [group('child', 'child')])).toThrow('cycle');
});


test('combined reparent and clearing a tighter child ceiling cannot expand delegated authority', () => {
  const groups = [group('root', undefined, 8), group('child', 'root', 2), group('other', undefined, 16)];
  expect(() => assertGroupVcpuReparent('owner', 'child', 'other', false, groups, null)).toThrow('inherited');
  expect(() => assertGroupVcpuReparent('owner', 'child', 'other', false, groups, 2)).toThrow('inherited');
  expect(() => assertGroupVcpuReparent('owner', 'child', 'root', false, groups, 2)).not.toThrow();
  const bounded = [...groups, group('tight', undefined, 2)];
  expect(() => assertGroupVcpuReparent('owner', 'child', 'tight', false, bounded, null)).not.toThrow();
});


test('native allocation checks target groups before initial membership and rounds environment CPU counts', () => {
  const groups = [group('root', undefined, 2, ['existing'])];
  expect(workerVcpuAllocation('owner', 'new', undefined, 'root', groups)).toBe(1);
  expect(workerVcpuAllocation('owner', 'new', 1.5, 'root', groups)).toBe(2);
  expect(() => workerVcpuAllocation('owner', 'new', 2.1, 'root', groups)).toThrow('ceiling');
  expect(() => workerVcpuAllocation('owner', 'existing', 3, undefined, groups)).toThrow('ceiling');
  expect(workerVcpuAllocation('owner', 'unassigned', undefined, undefined, groups)).toBeUndefined();
});
