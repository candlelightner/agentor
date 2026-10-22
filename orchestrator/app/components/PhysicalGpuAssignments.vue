<script setup lang="ts">
interface Profile { id: string; name: string; framebufferMiB?: number; total?: number; available: number; hostAvailable: number; active: number; reserved: number; compatible: boolean }
interface Allocation { workerId: string; displayName: string; profile?: string; status: string; pendingRebuild: boolean }
interface Gpu { id: string; name: string; available: boolean; reason: string; workerId?: string; status: string; pendingRebuild: boolean; mode?: string; physicalSupported?: boolean; physicalReason?: string; profiles?: Profile[]; allocations?: Allocation[]; unknownInstances?: number; foreignAssignments?: number }
interface Worker { id: string; displayName: string; status: string; pendingRebuild: boolean }
const view = ref<{ devices: Gpu[]; workers: Worker[] }>();
const selected = reactive<Record<string, string>>({}), profiles = reactive<Record<string, string>>({});
const saving = ref(false), error = ref('');
const { isAdmin } = useAuth();
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh() {
  if (!isAdmin.value || saving.value) return;
  try {
    view.value = await $fetch('/api/hardware-devices/gpu');
    for (const gpu of view.value!.devices) {
      selected[gpu.id] ??= gpu.workerId ?? gpu.allocations?.[0]?.workerId ?? 'none';
      profiles[gpu.id] ??= gpu.allocations?.[0]?.profile ?? gpu.profiles?.[0]?.id ?? 'physical';
    }
    error.value = '';
  } catch (cause: any) { error.value = cause?.data?.statusMessage || 'Could not load GPU assignments.'; }
}
async function apply(gpu: Gpu, releaseWorkerId?: string) {
  saving.value = true; error.value = '';
  try {
    const workerId = releaseWorkerId || selected[gpu.id] === 'none' ? null : selected[gpu.id];
    const targetId = releaseWorkerId ?? workerId ?? gpu.workerId ?? gpu.allocations?.[0]?.workerId;
    const worker = view.value?.workers.find(item => item.id === targetId);
    if (worker?.status !== 'stopped') throw new Error('Stop the selected VM before changing its GPU assignment.');
    let lockPassword: string | undefined;
    const request = () => $fetch('/api/hardware-devices/gpu', { method: 'PUT', body: { deviceId: gpu.id, workerId, lockPassword,
      ...(workerId && profiles[gpu.id] !== 'physical' ? { profile: profiles[gpu.id] } : {}), ...(releaseWorkerId ? { releaseWorkerId } : {}) } });
    try { await request(); }
    catch (cause: any) {
      if (cause?.statusCode !== 423 && cause?.status !== 423) throw cause;
      const supplied = prompt('Worker protection password');
      if (!supplied) return;
      lockPassword = supplied; await request();
    }
    delete selected[gpu.id]; delete profiles[gpu.id];
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'GPU assignment failed.'; }
  finally { saving.value = false; if (!error.value) await refresh(); }
}
function choices(gpu: Gpu) {
  return [{ label: 'None', value: 'none' }, ...(view.value?.workers ?? []).map(worker => ({
    label: `${worker.displayName} (${worker.status})`, value: worker.id,
    disabled: worker.status !== 'stopped' || worker.pendingRebuild || !!gpu.workerId && worker.id !== gpu.workerId,
  }))];
}
function profileChoices(gpu: Gpu) {
  return [{ label: 'Full physical passthrough', value: 'physical', disabled: gpu.physicalSupported === false },
    ...(gpu.profiles ?? []).map(profile => ({ label: profile.name, value: profile.id,
      disabled: profile.available === 0 && !(gpu.allocations?.length === 1 && gpu.allocations[0]!.workerId === selected[gpu.id]) }))];
}
onMounted(() => { void refresh(); timer = setInterval(() => void refresh(), 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section v-if="isAdmin" class="space-y-3 rounded-lg border p-4" data-testid="physical-gpu-assignments">
    <div><h3 class="font-medium">GPU assignment</h3><p class="text-xs text-gray-500">Platform administrators assign GPUs to stopped worker VMs. Stop before changing or releasing an allocation; start through the existing worker controls. Agentor never switches host drivers.</p></div>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="view && !view.devices.length" class="text-sm text-gray-500">No approved PCI GPUs. Approve a discovered GPU below.</p>
    <div v-for="gpu in view?.devices" :key="gpu.id" class="space-y-2 rounded border p-3">
      <div class="flex flex-wrap items-center gap-2 text-sm"><span class="font-medium">{{ gpu.name }}</span><UBadge size="xs" :color="gpu.status === 'recovery-required' ? 'warning' : 'neutral'">{{ gpu.status }}</UBadge><span v-if="gpu.pendingRebuild" class="text-xs">Rebuild or recovery required</span></div>
      <p class="text-xs text-gray-500">{{ gpu.available ? 'Detected' : 'Unavailable' }} · {{ gpu.mode === 'gpu-mdev' ? 'vGPU/mdev' : gpu.mode === 'gpu-physical' ? 'Physical passthrough' : 'Unavailable/unsupported' }} · {{ gpu.reason }}</p>
      <p v-if="gpu.physicalSupported === false" class="text-xs text-gray-500">Full physical passthrough: {{ gpu.physicalReason }}</p>
      <div v-if="gpu.profiles?.length" class="overflow-auto"><table class="w-full text-left text-xs"><caption class="text-left font-medium">Native vGPU profiles (stopped assignments reserve capacity)</caption><thead><tr><th>Profile</th><th>Framebuffer</th><th>Available / total</th><th>Active / reserved</th></tr></thead><tbody><tr v-for="profile in gpu.profiles" :key="profile.id"><td>{{ profile.name }} ({{ profile.id }})</td><td>{{ profile.framebufferMiB === undefined ? 'Not reported' : `${profile.framebufferMiB} MiB` }}</td><td>{{ profile.available }} / {{ profile.total ?? 'Not reported' }}</td><td>{{ profile.active }} / {{ profile.reserved }}</td></tr></tbody></table></div>
      <div v-for="allocation in gpu.allocations" :key="allocation.workerId" class="flex items-center gap-2 text-xs"><span class="flex-1">{{ allocation.displayName }} · {{ allocation.profile || 'Full physical passthrough' }} · {{ allocation.status }}</span><UButton size="xs" :loading="saving" :disabled="allocation.status !== 'stopped' && allocation.status !== 'recovery-required'" @click="apply(gpu, allocation.workerId)">Release {{ allocation.displayName }}</UButton></div>
      <p v-if="gpu.unknownInstances || gpu.foreignAssignments" class="text-xs text-amber-600">Unmanaged or ambiguous GPU allocations are present; resolve their ownership before assigning.</p>
      <div class="flex flex-wrap items-center gap-2"><USelect v-model="selected[gpu.id]" :items="choices(gpu)" :aria-label="`Assigned VM for ${gpu.name}`" class="min-w-64 flex-1" /><USelect v-if="gpu.profiles?.length" v-model="profiles[gpu.id]" :items="profileChoices(gpu)" :aria-label="`GPU profile for ${gpu.name}`" class="min-w-48" /><UButton :loading="saving" :disabled="!selected[gpu.id] || !gpu.profiles?.length && selected[gpu.id] === (gpu.workerId ?? 'none') && gpu.status !== 'recovery-required'" @click="apply(gpu)">{{ selected[gpu.id] === 'none' ? 'Release' : 'Assign' }}</UButton></div>
    </div>
    <p class="text-xs text-gray-500">Guest GPU drivers and licensing are the worker's responsibility. Existing Intel mediated GPU and USB permissions are managed below.</p>
  </section>
</template>
