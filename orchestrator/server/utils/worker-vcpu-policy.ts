import type { WorkerGroup } from './worker-group-store';
import { WorkerGroupHierarchy } from './worker-group-hierarchy';
import { useLogger, useWorkerGroupStore } from './services';
import { validateVcpuCount } from '../../shared/vcpu-count';

export function validateGroupVcpuLimit(value: unknown): number | null {
  return value === null ? null : validateVcpuCount(value);
}

/** Each VM has its own ceiling; siblings never consume a shared CPU pool. */
export function effectiveGroupVcpuLimit(userId: string, groupId: string,
  groups: WorkerGroup[] = useWorkerGroupStore().listForUser(userId)): number | null {
  const store = { listForUser: () => groups.filter(group => group.userId === userId),
    get: (ownerId: string, id: string) => groups.find(group => group.userId === ownerId && group.id === id) };
  const limits = new WorkerGroupHierarchy(store).ancestors(userId, groupId, true)
    .flatMap(group => group.maxVcpuCount == null ? [] : [validateVcpuCount(group.maxVcpuCount)]);
  return limits.length ? Math.min(...limits) : null;
}

export function effectiveWorkerVcpuLimit(userId: string, workerId: string,
  groups: WorkerGroup[] = useWorkerGroupStore().listForUser(userId)): number | null {
  const limits = groups.filter(group => group.userId === userId && group.workerIds.includes(workerId))
    .flatMap(group => { const limit = effectiveGroupVcpuLimit(userId, group.id, groups); return limit === null ? [] : [limit]; });
  return limits.length ? Math.min(...limits) : null;
}

export function assertVcpuPolicyLimit(count: number, maximum: number | null, requireDelegatedLimit = false): number | null {
  const message = maximum === null && requireDelegatedLimit
    ? 'A global administrator must configure a group vCPU ceiling before delegated resizing.'
    : maximum !== null && count > maximum ? `vCPU count exceeds the per-worker group ceiling of ${maximum}.` : undefined;
  if (message) {
    useLogger().warn(`[vcpu-policy] ${message} Operation stopped before allocating CPUs; existing VM retained.`);
    throw Object.assign(new Error(message), { statusCode: 403 });
  }
  return maximum;
}

export function assertGroupVcpuLimit(userId: string, groupId: string, count: number,
  requireDelegatedLimit = false, groups?: WorkerGroup[]): number | null {
  return assertVcpuPolicyLimit(count, effectiveGroupVcpuLimit(userId, groupId, groups), requireDelegatedLimit);
}

export function assertWorkerVcpuLimit(userId: string, workerId: string, count: number): number | null {
  return assertVcpuPolicyLimit(count, effectiveWorkerVcpuLimit(userId, workerId));
}

/** Delegation may tighten descendants, but cannot expand its own authority. */
export function assertGroupVcpuLimitChange(userId: string, groupId: string, value: unknown,
  principal: { globalAdmin: boolean; authorityGroupId?: string },
  groups: WorkerGroup[] = useWorkerGroupStore().listForUser(userId)): number | null {
  const limit = validateGroupVcpuLimit(value);
  const group = groups.find(item => item.userId === userId && item.id === groupId);
  if (!group) throw Object.assign(new Error('Worker group not found'), { statusCode: 404 });
  const parentLimit = group.parentId ? effectiveGroupVcpuLimit(userId, group.parentId, groups) : null;
  if (limit !== null && parentLimit !== null) assertVcpuPolicyLimit(limit, parentLimit);
  if (principal.globalAdmin) return limit;
  const store = { listForUser: () => groups, get: (owner: string, id: string) => groups.find(item => item.userId === owner && item.id === id) };
  if (principal.authorityGroupId && (principal.authorityGroupId === groupId ||
      !new WorkerGroupHierarchy(store).canAdminister(userId, principal.authorityGroupId, groupId))) {
    useLogger().warn('[vcpu-policy] Group administrator ceiling change targets its own group or another scope; change stopped, existing ceiling retained.');
    throw Object.assign(new Error('Group administrators may configure ceilings only for descendant groups'), { statusCode: 403 });
  }
  assertVcpuPolicyLimit(limit ?? parentLimit ?? 1, parentLimit, true);
  return limit;
}

/** Unspecified CPU allocation becomes explicit when a policy applies. */
export function workerVcpuAllocation(userId: string, workerId: string, cpuLimit?: number, targetGroupId?: string,
  groups: WorkerGroup[] = useWorkerGroupStore().listForUser(userId)): number | undefined {
  const workerLimit = effectiveWorkerVcpuLimit(userId, workerId, groups);
  const groupLimit = targetGroupId ? effectiveGroupVcpuLimit(userId, targetGroupId, groups) : null;
  const limits = [workerLimit, groupLimit].filter((limit): limit is number => limit !== null);
  const maximum = limits.length ? Math.min(...limits) : null;
  const count = cpuLimit ? Math.max(1, Math.ceil(cpuLimit)) : maximum === null ? undefined : 1;
  if (count !== undefined) assertVcpuPolicyLimit(count, maximum);
  return count;
}

export function assertGroupVcpuReparent(userId: string, groupId: string, parentId: string | null,
  globalAdmin: boolean, groups: WorkerGroup[] = useWorkerGroupStore().listForUser(userId), maxVcpuCount?: number | null) {
  if (globalAdmin) return;
  const before = effectiveGroupVcpuLimit(userId, groupId, groups);
  const prospective = groups.map(group => group.id === groupId ? { ...group, parentId: parentId ?? undefined,
    ...(maxVcpuCount === undefined ? {} : { maxVcpuCount }) } : group);
  const after = effectiveGroupVcpuLimit(userId, groupId, prospective);
  const source = groups.find(group => group.userId === userId && group.id === groupId);
  const destination = parentId ? effectiveGroupVcpuLimit(userId, parentId, groups) : null;
  const moved = (source?.parentId ?? null) !== parentId;
  if (before !== null && (after === null || after > before || moved && (destination === null || destination > before))) {
    useLogger().warn('[vcpu-policy] Group move would loosen inherited CPU authority; move stopped, existing group retained.');
    throw Object.assign(new Error('Only a global administrator may move a group outside its inherited vCPU ceiling'), { statusCode: 403 });
  }
}

export function assertWorkerVcpuMembershipChange(userId: string, previous: WorkerGroup[], prospective: WorkerGroup[]) {
  const workerIds = new Set(previous.flatMap(group => group.workerIds));
  for (const id of workerIds) {
    const before = effectiveWorkerVcpuLimit(userId, id, previous);
    const after = effectiveWorkerVcpuLimit(userId, id, prospective);
    if (before !== null && (after === null || after > before)) {
      useLogger().warn('[vcpu-policy] Membership change would remove or loosen a worker CPU ceiling; change stopped, existing membership retained.');
      throw Object.assign(new Error('Change the source group vCPU ceiling before moving a worker outside that ceiling'), { statusCode: 403 });
    }
  }
}
