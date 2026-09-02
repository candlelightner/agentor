import type { HostMountGrant, HostMountPath } from "../../shared/types";

export interface HostMountView {
  ownerId: string;
  canManageCatalog: boolean;
  catalog: Array<HostMountPath & { entitled: boolean }>;
  grants: HostMountGrant[];
  effectivePathIds: string[];
  groups: Array<{ id: string; name: string; parentId?: string }>;
  workers: Array<{ id: string; displayName: string; status: string }>;
}

export function useHostMounts() {
  const view = ref<HostMountView | null>(null);
  const loading = ref(false);
  const error = ref("");
  let refreshSequence = 0;

  const effectivePaths = computed(() => {
    const ids = new Set(view.value?.effectivePathIds ?? []);
    return (view.value?.catalog ?? []).filter((path) => ids.has(path.id));
  });

  async function refresh(options: { ownerId?: string; workerId?: string; groupId?: string } = {}) {
    const sequence = ++refreshSequence;
    loading.value = true;
    error.value = "";
    try {
      const result = await $fetch<HostMountView>("/api/host-mounts", {
        query: options,
      });
      if (sequence === refreshSequence) view.value = result;
    } catch (cause: any) {
      if (sequence === refreshSequence) {
        error.value =
          cause?.data?.statusMessage || cause?.data?.message || "Could not load host mount permissions.";
        view.value = null;
      }
    } finally {
      if (sequence === refreshSequence) loading.value = false;
    }
  }

  return { view, loading, error, effectivePaths, refresh };
}
