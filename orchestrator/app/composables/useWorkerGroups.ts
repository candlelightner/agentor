export interface GroupAdminWorkspace {
  id: string;
  groupId: string;
  userId: string;
  status: "running" | "stopped";
  services: string[];
  startupScriptStatus?: {
    configured: boolean;
    revision: number;
    appliedRevision: number;
    pendingRebuild: boolean;
    lastAppliedAt?: string;
  };
}
export interface WorkerGroup {
  id: string;
  userId: string;
  name: string;
  workerIds: string[];
  parentId?: string;
  adminWorkspace?: GroupAdminWorkspace;
  createdAt: string;
  updatedAt: string;
}
export function useWorkerGroups() {
  const { data: groups, refresh } = useFetch<WorkerGroup[]>(
    "/api/worker-groups",
    { default: () => [] },
  );
  const create = async (name: string, parentId?: string) => {
    const group = await $fetch<WorkerGroup>("/api/worker-groups", {
      method: "POST",
      body: { name, ...(parentId ? { parentId } : {}) },
    });
    await refresh();
    return group;
  };
  const update = async (
    id: string,
    patch: Partial<Pick<WorkerGroup, "name" | "workerIds">> & {
      parentId?: string | null;
    },
  ) => {
    const group = await $fetch<WorkerGroup>(`/api/worker-groups/${id}`, {
      method: "PATCH",
      body: patch,
    });
    await refresh();
    return group;
  };
  const remove = async (id: string) => {
    await $fetch(`/api/worker-groups/${id}`, { method: "DELETE" });
    await refresh();
  };
  const assignWorker = async (workerId: string, groupId: string | null) => {
    await $fetch("/api/worker-groups/assignment", {
      method: "PUT",
      body: { workerId, groupId },
    });
    await refresh();
  };
  const adminAction = async (
    id: string,
    action: "ensure" | "start" | "stop" | "rebuild",
  ) => {
    const suffix = action === "ensure" ? "" : `/${action}`;
    const result = await $fetch<GroupAdminWorkspace>(
      `/api/worker-groups/${id}/admin-workspace${suffix}`,
      { method: "POST" },
    );
    await refresh();
    const group = groups.value.find((item) => item.id === id);
    if (group) group.adminWorkspace = result;
    return result;
  };
  return { groups, refresh, create, update, remove, assignWorker, adminAction };
}
