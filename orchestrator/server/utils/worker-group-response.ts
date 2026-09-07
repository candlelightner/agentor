import type { WorkerGroup } from "./worker-group-store";
import type { WorkerRecord } from "./worker-store";
import { effectiveGroupWorkerSelfApiAccess } from "./worker-self-access";

export interface WorkerGroupMemberCounts {
  /** Persisted direct memberships, including archived workers. */
  total: number;
  /** Direct workers whose durable lifecycle state is not archived. */
  active: number;
  /** Direct workers retained in the archive. */
  archived: number;
}

export type WorkerGroupResponse = WorkerGroup & {
  memberCounts: WorkerGroupMemberCounts;
  effectiveWorkerSelfApiAccess: import("../../shared/types").EffectiveWorkerSelfApiAccess;
};

/** Add lifecycle counts without changing the persisted worker-group record.
 * `workerIds` deliberately retains archived members, so API and MCP callers can
 * see the same direct-membership status that the dashboard renders. */
export function workerGroupsWithMemberCounts(
  groups: WorkerGroup[],
  workers: WorkerRecord[],
): WorkerGroupResponse[] {
  const workersById = new Map(workers.map((worker) => [worker.id, worker]));
  return groups.map((group) => {
    let active = 0;
    let archived = 0;
    for (const workerId of group.workerIds) {
      const worker = workersById.get(workerId);
      if (worker?.status === "archived") archived += 1;
      else if (worker?.status === "active") active += 1;
    }
    return {
      ...group,
      memberCounts: {
        total: group.workerIds.length,
        active,
        archived,
      },
      effectiveWorkerSelfApiAccess: effectiveGroupWorkerSelfApiAccess(
        group.userId,
        group.id,
        groups,
      ),
    };
  });
}

export function workerGroupWithMemberCounts(
  group: WorkerGroup,
  workers: WorkerRecord[],
  groups: WorkerGroup[] = [group],
): WorkerGroupResponse {
  return (
    workerGroupsWithMemberCounts(groups, workers).find(
      (candidate) => candidate.id === group.id,
    ) ?? workerGroupsWithMemberCounts([group], workers)[0]!
  );
}
