<script setup lang="ts">
import { validateVcpuCount, type VcpuSettings } from '../../shared/vcpu-count';

const props = defineProps<{ endpoint: string; lockPassword?: string }>();
const settings = ref<VcpuSettings | null>(null);
const count = ref<number | string>('');
const password = ref('');
const needsPassword = ref(false);
const busy = ref(false);
const error = ref('');
const saved = ref(false);

async function request(save = false, reconcile = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  saved.value = false;
  try {
    const body = save ? { vcpuCount: validateVcpuCount(reconcile ? settings.value?.pendingVcpuCount : Number(count.value), reconcile ? undefined : settings.value?.maxVcpuCount),
      lockPassword: props.lockPassword ?? password.value } : undefined;
    settings.value = await $fetch<VcpuSettings>(props.endpoint, {
      method: save ? 'PUT' : 'GET', ...(body ? { body } : {}), timeout: 30_000, retry: 0,
    });
    count.value = settings.value.vcpuCount;
    saved.value = save;
    password.value = '';
  } catch (cause: any) {
    if ((cause?.statusCode ?? cause?.status ?? cause?.data?.statusCode) === 423) needsPassword.value = true;
    error.value = cause?.data?.statusMessage || cause?.data?.message || cause?.message || 'Could not load or save vCPU count. Refresh before retrying.';
  } finally { busy.value = false; }
}
onMounted(() => { void request(); });
</script>

<template>
  <section class="space-y-2 rounded border border-current/30 p-3" data-testid="vcpu-editor">
    <h3 class="font-semibold">Virtual CPU cores</h3>
    <p class="text-xs">Stop the VM before changing its vCPU count. Save, then start it normally; storage is retained.</p>
    <p v-if="error" role="alert" class="text-sm text-red-500">{{ error }}</p>
    <template v-if="settings">
      <p class="text-xs">Assigned: {{ settings.vcpuCount }} · Maximum allowed: {{ settings.maxVcpuCount }}</p>
      <p v-if="settings.status === 'running'" role="status" class="text-xs">Stop the VM, then refresh to edit its vCPU count.</p>
      <p v-if="settings.pending" role="status" class="text-xs text-amber-500">A previous CPU change needs reconciliation before another change.</p>
      <UButton v-if="settings.pendingVcpuCount !== undefined" :disabled="busy" color="warning" @click="request(true, true)">Reconcile pending CPU change</UButton>
      <div class="flex flex-wrap items-end gap-2">
        <label class="text-sm">vCPU count
          <UInput v-model="count" type="number" :min="1" :max="settings.maxVcpuCount" :step="1"
            :disabled="busy || settings.status !== 'stopped' || settings.pending" aria-label="VM vCPU count" />
        </label>
        <UButton :disabled="busy || settings.status !== 'stopped' || settings.pending || Number(count) === settings.vcpuCount" @click="request(true)">Save vCPU count</UButton>
      </div>
    </template>
    <label v-if="needsPassword && lockPassword === undefined" class="block text-sm">Current worker lock password
      <UInput v-model="password" type="password" autocomplete="off" aria-label="CPU change lock password" />
    </label>
    <p v-if="saved" role="status" class="text-xs">vCPU count saved. Start the VM normally to use it.</p>
    <UButton :loading="busy" :disabled="busy" color="neutral" variant="outline" @click="request()">Refresh vCPU count</UButton>
  </section>
</template>
