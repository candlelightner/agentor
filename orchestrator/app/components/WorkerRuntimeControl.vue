<script setup lang="ts">
import type { WorkerRuntimeProfile } from '../../shared/types';

const props = defineProps<{
  workerId: string;
  runtimeProfile?: WorkerRuntimeProfile;
  approvalRequired?: boolean;
  disabled?: boolean;
  canMigrate?: boolean;
}>();
const { isAdmin } = useAuth();
const profile = computed(() => props.runtimeProfile ?? 'legacy-runc');
const expanded = ref(false);
const acknowledged = ref(false);
const lockPassword = ref('');
const busy = ref(false);
const message = ref('');
const error = ref('');
const migrationPlan = ref<{ targetProfile: WorkerRuntimeProfile; mounts: Array<{ target: string; kind: string }> }>();
const migrationPhase = ref('');
const confirmDowntime = ref(false);
const daemonSettled = ref(false);
const confirmDeleteRollback = ref(false);
const migrationTerminal = computed(() => ['committed', 'rolled-back'].includes(migrationPhase.value));
let statusTimer: ReturnType<typeof setInterval> | undefined;
onBeforeUnmount(() => { if (statusTimer) clearInterval(statusTimer); });
function toggleExpanded() { expanded.value = !expanded.value; }
async function refreshStatus() {
  if (!isAdmin.value || !props.canMigrate) return;
  try {
    const status = await $fetch<{ phase: string } | null>(`/api/admin/workers/${props.workerId}/migration`);
    migrationPhase.value = status?.phase ?? '';
  } catch { /* Explicit operations surface authoritative errors. */ }
}
watch(() => [props.workerId, isAdmin.value, props.canMigrate], () => { void refreshStatus(); }, { immediate: true });

async function recoverMigration() {
  busy.value = true; error.value = ''; message.value = '';
  try {
    await $fetch(`/api/admin/workers/${props.workerId}/migration-recover`, { method: 'POST', body: {
      acknowledgeDaemonOperationsSettled: daemonSettled.value, lockPassword: lockPassword.value || undefined,
    } });
    message.value = 'Rollback completed; the previous worker and its local data were restored. Shared account state was not rewound.';
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'Migration recovery failed'; }
  finally { await refreshStatus(); busy.value = false; daemonSettled.value = false; }
}

async function finalizeMigration() {
  if (!confirmDeleteRollback.value) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    await $fetch(`/api/admin/workers/${props.workerId}/migration-finalize`, { method: 'POST', body: {
      confirmDeleteRollback: true, lockPassword: lockPassword.value || undefined,
    } });
    message.value = 'Retained rollback container and volume copies removed. The active root filesystem image is preserved.';
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'Migration cleanup failed'; }
  finally { await refreshStatus(); busy.value = false; confirmDeleteRollback.value = false; }
}

async function preflightMigration() {
  error.value = ''; migrationPlan.value = undefined; confirmDowntime.value = false; busy.value = true;
  try {
    migrationPlan.value = await $fetch(`/api/admin/workers/${props.workerId}/migration-preflight`, {
      query: { runtimeProfile: profile.value === 'legacy-runc' ? 'kata-qemu' : 'legacy-runc' },
    });
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'Migration preflight failed'; }
  finally { busy.value = false; }
}

async function migrate() {
  if (!migrationPlan.value || !confirmDowntime.value) return;
  busy.value = true; error.value = ''; migrationPhase.value = 'Preparing';
  const poll = async () => {
    try {
      const status = await $fetch<{ phase: string } | null>(`/api/admin/workers/${props.workerId}/migration`);
      if (status) migrationPhase.value = status.phase;
    } catch { /* The migration request remains authoritative. */ }
  };
  statusTimer = setInterval(() => { void poll(); }, 2000);
  try {
    const result = await $fetch<{ phase: string }>(`/api/admin/workers/${props.workerId}/migration`, {
      method: 'POST', body: { runtimeProfile: migrationPlan.value.targetProfile, confirmDowntime: true,
        acknowledgeHostPrivilege: acknowledged.value, lockPassword: lockPassword.value || undefined },
    });
    migrationPhase.value = result.phase;
    message.value = 'Runtime migration completed. The original root filesystem and data snapshots were retained.';
    migrationPlan.value = undefined;
  } catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.message || 'Migration failed; check its recovery status'; await poll(); }
  finally { if (statusTimer) clearInterval(statusTimer); statusTimer = undefined; await refreshStatus(); busy.value = false; }
}

async function authorize() {
  if (!isAdmin.value || (profile.value === 'legacy-runc' && !acknowledged.value)) return;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await $fetch<{ message?: string }>(`/api/admin/workers/${props.workerId}/runtime`, {
      method: 'POST', body: { runtimeProfile: profile.value,
        acknowledgeHostPrivilege: acknowledged.value, lockPassword: lockPassword.value || undefined },
    });
    message.value = result.message || 'Runtime approved. Starting or unarchiving remains a separate action.';
    expanded.value = false; acknowledged.value = false; lockPassword.value = '';
  } catch (cause: any) {
    error.value = cause?.data?.statusMessage || cause?.data?.message || cause?.message || 'Runtime authorization failed';
  } finally { busy.value = false; }
}
</script>

<template>
  <div class="space-y-2 text-xs">
    <p>Runtime: {{ profile === 'kata-qemu' ? 'Kata / QEMU' : 'Legacy runc' }}</p>
    <p v-if="approvalRequired && !message" class="text-amber-600">An administrator must approve this restored worker on this installation.</p>
    <UButton v-if="isAdmin && !disabled && (profile === 'legacy-runc' || approvalRequired)" size="xs" color="neutral" variant="outline" @click="toggleExpanded">
      {{ profile === 'legacy-runc' ? 'Authorize legacy runtime' : 'Approve restored runtime' }}
    </UButton>
    <div v-if="expanded" class="space-y-2">
      <UCheckbox v-if="profile === 'legacy-runc'" v-model="acknowledged" label="I authorize legacy runc. Docker-enabled workers receive privilege on the host." />
      <p v-else>This retains Kata / QEMU and checks this installation's host readiness.</p>
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Runtime authorization protection password" />
      <UButton size="xs" :loading="busy" :disabled="profile === 'legacy-runc' && !acknowledged" @click="authorize">Confirm authorization</UButton>
      <p>Starting, rebuilding or unarchiving remains a separate action.</p>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <UButton v-if="isAdmin && canMigrate && !disabled && !approvalRequired" size="xs" color="neutral" variant="outline" :disabled="busy" @click="preflightMigration">Check runtime migration</UButton>
    <div v-if="migrationPlan" class="space-y-2">
      <p>Target: {{ migrationPlan.targetProfile }}. Migration stops this worker, snapshots its root filesystem, and copies worker data for rollback. Allow temporary disk space for the copies.</p>
      <p class="text-amber-600">Automatic disk-capacity admission is not implemented. An operator must verify space for root filesystem and persistent-data snapshots before migration.</p>
      <p>The captured root filesystem becomes a required local image. Whole-instance backups do not contain image layers: separately encrypt and transfer its Docker image archive before restoring on another host.</p>
      <p>Shared account credentials and Kilo data keep their existing bindings and are not rolled back with this worker.</p>
      <ul class="list-disc pl-4"><li v-for="mount in migrationPlan.mounts" :key="mount.target">{{ mount.target }} — {{ mount.kind }}</li></ul>
      <UCheckbox v-model="confirmDowntime" label="I confirm worker downtime and snapshot creation." />
      <UCheckbox v-if="migrationPlan.targetProfile === 'legacy-runc'" v-model="acknowledged" label="I authorize legacy runc and its host privilege for Docker-enabled workers." />
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Migration protection password" />
      <UButton size="xs" :loading="busy" :disabled="!confirmDowntime || (migrationPlan.targetProfile === 'legacy-runc' && !acknowledged)" @click="migrate">Migrate runtime</UButton>
    </div>
    <p v-if="migrationPhase" role="status">Migration: {{ migrationPhase }}</p>
    <div v-if="isAdmin && canMigrate && migrationPhase && !busy" class="space-y-2">
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Migration recovery protection password" />
      <template v-if="!migrationTerminal">
        <p>Recovery may restore worker-local data. Before proceeding, the host operator must verify no outstanding Docker create, start or copy operation can still mutate this worker. A timeout alone does not prove this.</p>
        <UCheckbox v-model="daemonSettled" label="The operator verified that outstanding Docker operations have settled." />
        <UButton size="xs" :disabled="!daemonSettled || disabled" @click="recoverMigration">Recover interrupted migration</UButton>
      </template>
      <template v-else>
        <p>After validating the worker, remove retained rollback evidence to allow another migration, rebuild or archive. This cleanup cannot be undone.</p>
        <UCheckbox v-model="confirmDeleteRollback" label="I confirm deletion of the retained rollback container and copied volumes." />
        <UButton size="xs" color="error" :disabled="!confirmDeleteRollback || disabled" @click="finalizeMigration">Delete rollback evidence</UButton>
      </template>
    </div>
    <p v-if="error" role="alert" class="text-red-500">{{ error }}</p>
  </div>
</template>
