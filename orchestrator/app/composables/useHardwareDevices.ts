import type { HardwareDevice, HardwareDeviceCandidate, HardwareDeviceGrant } from "../../shared/types";
export interface HardwareDeviceView {
  ownerId: string;
  canManageCatalog: boolean;
  catalog: Array<HardwareDevice & { entitled: boolean; available: boolean }>;
  discovered: HardwareDeviceCandidate[];
  grants: HardwareDeviceGrant[];
  effectiveDeviceIds: string[];
  groups: Array<{ id: string; name: string; parentId?: string }>;
  workers: Array<{ id: string; displayName: string; status: string }>;
}
export function useHardwareDevices() {
  const view = ref<HardwareDeviceView | null>(null); const loading = ref(false); const error = ref(""); let sequence = 0;
  const effectiveDevices = computed(() => { const ids = new Set(view.value?.effectiveDeviceIds ?? []); return (view.value?.catalog ?? []).filter((item) => ids.has(item.id)); });
  async function refresh(options: { ownerId?: string; workerId?: string; groupId?: string } = {}) {
    const current = ++sequence; loading.value = true; error.value = "";
    try { const result = await $fetch<HardwareDeviceView>("/api/hardware-devices", { query: options }); if (current === sequence) view.value = result; }
    catch (cause: any) { if (current === sequence) { error.value = cause?.data?.statusMessage || cause?.data?.message || "Could not load hardware devices."; view.value = null; } }
    finally { if (current === sequence) loading.value = false; }
  }
  return { view, loading, error, effectiveDevices, refresh };
}
