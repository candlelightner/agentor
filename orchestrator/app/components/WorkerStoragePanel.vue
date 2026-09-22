<script setup lang="ts">
import type { ManagedVolume, PersistencePolicy, VolumeApplyMode } from '../../shared/managed-volumes';
const props = defineProps<{ workerId: string; lockPassword?: string }>();
const volumes = ref<ManagedVolume[]>([]);
const policy = reactive({ selfService: false, allowSelfRecreate: false, allowLiveMount: false });
const target = ref(''), name = ref(''), error = ref(''), notice = ref('');
const mode = ref<VolumeApplyMode>('deferred');
const privilegedAcknowledged = ref(false), busy = ref(false), loaded = ref(false);
const confirmDetach = ref<ManagedVolume | null>(null), detachNow = ref(false);
const modes = [
  { label: 'Save for next rebuild', value: 'deferred' },
  { label: 'Apply now — recreate worker', value: 'recreate' },
  { label: 'Apply live — privileged Agentor helper', value: 'live' },
];
let timer: ReturnType<typeof setInterval> | undefined;
async function refresh(loadPolicy = false) {
  try {
    const result = await $fetch<{ volumes: ManagedVolume[]; policy: PersistencePolicy }>(`/api/containers/${props.workerId}/storage`);
    volumes.value = result.volumes;
    if (loadPolicy || !loaded.value) Object.assign(policy, { selfService: result.policy.selfService, allowSelfRecreate: result.policy.allowSelfRecreate, allowLiveMount: result.policy.allowLiveMount });
    loaded.value = true;
  } catch (e: any) { error.value = e?.data?.statusMessage || 'Could not inspect persistent storage.'; }
}
watch(() => props.workerId, () => { loaded.value = false; volumes.value = []; void refresh(true); }, { immediate: true });
onMounted(() => { timer = setInterval(() => {
  if (volumes.value.some((v) => v.operation && v.operation.mode !== 'deferred' && ['queued', 'copying', 'mounting', 'recreating'].includes(v.operation.stage))) void refresh();
}, 3000); });
onBeforeUnmount(() => { if (timer) clearInterval(timer); });

async function action(body: Record<string, unknown>) {
  busy.value = true; error.value = ''; notice.value = '';
  try {
    await $fetch(`/api/containers/${props.workerId}/storage`, { method: 'POST', body: { ...body, lockPassword: props.lockPassword } });
    notice.value = body.action === 'policy' ? 'Persistence permissions saved.' : 'Storage request saved. Check the path status below; no backup was configured.';
    await refresh(body.action === 'policy');
    if (body.action === 'add') { target.value = ''; name.value = ''; }
    confirmDetach.value = null;
  } catch (e: any) { error.value = e?.data?.statusMessage || e?.message || 'Storage operation failed.'; }
  finally { busy.value = false; }
}
const applyOptions = () => ({ mode: mode.value, acknowledgePrivileged: privilegedAcknowledged.value });
const canApply = computed(() => mode.value !== 'live' || policy.allowLiveMount || privilegedAcknowledged.value);
</script>

<template>
  <section class="space-y-3 rounded border border-gray-200 dark:border-gray-700 p-4" data-testid="worker-persistent-storage">
    <div class="flex justify-between items-center"><h3 class="font-medium">Persistent paths</h3><UButton size="xs" variant="outline" @click="refresh()">Refresh storage</UButton></div>
    <p class="text-xs text-gray-500">Keep application directories on this host across worker recreation. Local persistence is not a backup. Existing workspace, credential and system mounts cannot be replaced.</p>
    <p v-if="error" role="alert" class="text-sm text-red-600">{{ error }}</p>
    <p v-if="notice" role="status" class="text-sm text-green-600">{{ notice }}</p>
    <div class="grid gap-3 sm:grid-cols-2">
      <UFormField label="Directory inside worker"><UInput v-model="target" placeholder="/home/agent/models" aria-label="Persistent directory path" class="w-full" /></UFormField>
      <UFormField label="Volume display name (optional)"><UInput v-model="name" placeholder="Models cache" aria-label="Volume display name" class="w-full" /></UFormField>
    </div>
    <UFormField label="Application method"><USelect v-model="mode" :items="modes" aria-label="Persistence application method" class="w-full" /></UFormField>
    <p v-if="mode === 'recreate'" class="text-xs text-amber-600">The worker will briefly stop. Its current image and privilege level are preserved; pending unrelated settings are not applied.</p>
    <div v-if="mode === 'live'" class="rounded border border-amber-400 p-3 space-y-2">
      <p class="text-sm text-amber-700 dark:text-amber-300">This runs a temporary privileged Agentor helper to mount into the worker. The worker itself does not become privileged. Processes pause during copying. Busy directories or unsupported runtimes require recreation instead.</p>
      <UCheckbox v-model="privilegedAcknowledged" label="I acknowledge this privileged helper operation" />
    </div>
    <UButton :loading="busy" :disabled="!target || !canApply" @click="action({ action: 'add', target, name: name || undefined, ...applyOptions() })">Add persistent path</UButton>
    <div v-for="v in volumes" :key="v.id" class="rounded bg-gray-50 dark:bg-gray-800 p-3 space-y-2">
      <div class="flex flex-wrap gap-2 items-center"><span class="font-medium">{{ v.name }}</span><UBadge :color="v.state === 'failed' ? 'error' : v.state === 'ready' ? 'success' : 'neutral'" variant="subtle">{{ v.state }}</UBadge><span class="text-xs text-gray-500">{{ v.operation?.stage }}</span></div>
      <p class="font-mono text-xs break-all">{{ v.target }}</p>
      <p v-if="v.operation?.error" role="alert" class="text-xs text-red-600">{{ v.operation.error }}</p>
      <div class="flex gap-2">
        <UButton v-if="v.attached" size="xs" variant="outline" :disabled="busy || !canApply || mode === 'deferred'" @click="action({ action: 'apply', volumeId: v.id, ...applyOptions() })">Apply / retry</UButton>
        <UButton v-if="!v.attached" size="xs" variant="outline" :disabled="busy || !canApply" @click="action({ action: 'reattach', volumeId: v.id, ...applyOptions() })">Reattach</UButton>
        <UButton v-if="v.attached" size="xs" color="warning" variant="ghost" :disabled="busy" @click="confirmDetach = v; detachNow = false">Detach — keep data</UButton>
      </div>
    </div>
    <div v-if="confirmDetach" class="rounded border border-amber-400 p-3 space-y-2">
      <p>Detach {{ confirmDetach.name }}? Its volume is retained. After recreation, {{ confirmDetach.target }} will expose the underlying directory, not this volume’s contents.</p>
      <UCheckbox v-model="detachNow" label="Recreate worker now to apply detachment" />
      <div class="flex gap-2"><UButton color="warning" :loading="busy" @click="action({ action: 'detach', volumeId: confirmDetach.id, confirmed: true, applyNow: detachNow })">Confirm detach</UButton><UButton variant="ghost" @click="() => { confirmDetach = null; }">Cancel</UButton></div>
    </div>
    <details class="border-t pt-3">
      <summary class="cursor-pointer text-sm font-medium">Worker self-service permissions</summary>
      <div class="mt-3 space-y-2">
        <UCheckbox v-model="policy.selfService" label="Allow this worker to add persistent paths for itself" />
        <p class="text-xs text-gray-500">Workers can inspect and add only. Detach, deletion and permission changes remain owner/admin operations.</p>
        <UCheckbox v-model="policy.allowSelfRecreate" label="Allow self-service requests to recreate this worker" />
        <UCheckbox v-model="policy.allowLiveMount" label="Authorize privileged Agentor live-mount helpers for this worker" />
        <p v-if="policy.allowLiveMount" class="text-xs text-amber-600">Live requests may run a privileged helper and pause worker processes. This does not grant privilege to the worker. If live mounting fails, recreation requires a separate explicit action.</p>
        <p class="text-xs text-gray-500">Without either application permission, self-service requests remain pending for an owner/admin to apply.</p>
        <UButton size="xs" :loading="busy" @click="action({ action: 'policy', policy: { ...policy } })">Save persistence permissions</UButton>
      </div>
    </details>
  </section>
</template>
