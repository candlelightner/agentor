<script setup lang="ts">
interface Gpu { id: string; name: string; available: boolean; reason: string; workerId?: string; status: string; pendingRebuild: boolean }
interface Worker { id: string; displayName: string; status: string; pendingRebuild: boolean }
const view = ref<{ devices: Gpu[]; workers: Worker[] }>();
const selected = reactive<Record<string, string>>({});
const saving = ref(false), error = ref('');
const { isAdmin } = useAuth();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh() {
  if (!isAdmin.value || saving.value) return;
  try {
    view.value = await $fetch('/api/hardware-devices/gpu');
    for (const gpu of view.value!.devices) selected[gpu.id] ??= gpu.workerId ?? 'none';
    error.value = '';
  } catch (cause: any) { error.value = cause?.data?.statusMessage || 'Could not load NVIDIA GPU assignments.'; }
}
async function apply(gpu: Gpu) {
  saving.value = true; error.value = '';
  try {
    const workerId = selected[gpu.id] === 'none' ? null : selected[gpu.id];
    const targetId = workerId ?? gpu.workerId;
    const worker = view.value?.workers.find(item => item.id === targetId);
    if (worker?.status !== 'stopped') throw new Error('Stop the selected VM before changing its GPU assignment.');
    let lockPassword: string | undefined;
    const request = () => $fetch('/api/hardware-devices/gpu', { method: 'PUT', body: { deviceId: gpu.id, workerId, lockPassword } });
    try { await request(); }
    catch (cause: any) {
      if (cause?.statusCode !== 423 && cause?.status !== 423) throw cause;
      const supplied = prompt('Worker protection password');
      if (!supplied) return;
      lockPassword = supplied;
      await request();
    }
    delete selected[gpu.id];
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'GPU assignment failed.'; }
  finally { saving.value = false; if (!error.value) await refresh(); }
}
function choices(gpu: Gpu) {
  return [{ label: 'None', value: 'none' }, ...(view.value?.workers ?? []).map(worker => ({
    label: `${worker.displayName} (${worker.status})`, value: worker.id,
    disabled: worker.status !== 'stopped' || worker.pendingRebuild || !!gpu.workerId && worker.id !== gpu.workerId,
  }))];
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section v-if="isAdmin" class="space-y-3 rounded-lg border p-4" data-testid="physical-gpu-assignments">
    <div><h3 class="font-medium">NVIDIA physical GPU assignment</h3><p class="text-xs text-gray-500">Platform administrators assign one GPU to one stopped VM. Stop and release its current VM before choosing another. Start the VM through its existing worker controls.</p></div>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="view && !view.devices.length" class="text-sm text-gray-500">No approved NVIDIA physical GPUs.</p>
    <div v-for="gpu in view?.devices" :key="gpu.id" class="space-y-2 rounded border p-3">
      <div class="flex flex-wrap items-center gap-2 text-sm"><span class="font-medium">{{ gpu.name }}</span><UBadge size="xs" :color="gpu.status === 'recovery-required' ? 'warning' : 'neutral'">{{ gpu.status }}</UBadge><span v-if="gpu.pendingRebuild" class="text-xs">Rebuild or recovery required</span></div>
      <p class="text-xs text-gray-500">{{ gpu.available ? 'Detected' : 'Unavailable' }} · {{ gpu.reason }}</p>
      <div class="flex items-center gap-2"><USelect v-model="selected[gpu.id]" :items="choices(gpu)" :aria-label="`Assigned VM for ${gpu.name}`" class="min-w-64 flex-1" /><UButton :loading="saving" :disabled="!selected[gpu.id] || selected[gpu.id] === (gpu.workerId ?? 'none') && gpu.status !== 'recovery-required'" @click="apply(gpu)">{{ selected[gpu.id] === 'none' ? 'Release' : 'Assign' }}</UButton></div>
    </div>
    <p class="text-xs text-gray-500">CUDA runs directly in the assigned VM using its ordinary image and persistent storage. Intel mediated GPU and USB permissions are managed separately below.</p>
  </section>
</template>
