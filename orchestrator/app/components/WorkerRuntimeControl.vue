<script setup lang="ts">
import type { WorkerRuntimeProfile } from '../../shared/types';

const props = defineProps<{
  workerId: string;
  runtimeProfile?: WorkerRuntimeProfile;
  approvalRequired?: boolean;
  disabled?: boolean;
  canMigrate?: boolean;
  recoveryOnly?: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const { isAdmin } = useAuth();
const profile = computed(() => props.runtimeProfile ?? 'legacy-runc');
const expanded = ref(false);
const acknowledged = ref(false);
const lockPassword = ref('');
const busy = ref(false);
const message = ref('');
const error = ref('');
const migrationPlan = ref<{ targetProfile: WorkerRuntimeProfile; capacityAdmission?: string; mounts: Array<{ target: string; kind: string }> }>();
const capacityAdmitted = computed(() => migrationPlan.value?.capacityAdmission === 'admitted');
interface MigrationStatus {
  phase: string;
  reconciliationRequired?: boolean;
  workerRecordTransitionPending?: boolean;
}
const migrationPhase = ref('');
const reconciliationRequired = ref(false);
const workerRecordTransitionPending = ref(false);
const statusKnown = ref(false);
const statusLoading = ref(false);
const statusFailed = ref(false);
const confirmDowntime = ref(false);
const daemonSettled = ref(false);
const confirmDeleteRollback = ref(false);
const migrationTerminal = computed(() => ['committed', 'rolled-back'].includes(migrationPhase.value));
const migrationNeedsRecovery = computed(() => !migrationTerminal.value || reconciliationRequired.value || workerRecordTransitionPending.value);
let statusTimer: ReturnType<typeof setInterval> | undefined;
let contextVersion = 0;
let statusRequest = 0;
let mounted = true;
function contextCurrent(version: number) { return mounted && version === contextVersion; }
onBeforeUnmount(() => { mounted = false; contextVersion++; statusRequest++; if (statusTimer) clearInterval(statusTimer); });
function toggleExpanded() { expanded.value = !expanded.value; }
function applyStatus(status: MigrationStatus | null) {
  migrationPhase.value = status?.phase ?? '';
  // Missing reconciliation state is not permission to delete retained evidence.
  reconciliationRequired.value = !!status && status.reconciliationRequired !== false;
  workerRecordTransitionPending.value = status?.workerRecordTransitionPending === true;
  statusKnown.value = true;
  statusFailed.value = false;
}
async function refreshStatus() {
  if (!isAdmin.value || !props.canMigrate) return;
  const workerId = props.workerId;
  const version = contextVersion;
  const request = ++statusRequest;
  statusLoading.value = true;
  statusKnown.value = false;
  try {
    const status = await $fetch<MigrationStatus | null>(`/api/admin/workers/${workerId}/migration`);
    if (contextCurrent(version) && request === statusRequest) applyStatus(status);
  } catch {
    if (contextCurrent(version) && request === statusRequest) { statusKnown.value = false; statusFailed.value = true; }
  } finally { if (contextCurrent(version) && request === statusRequest) statusLoading.value = false; }
}
watch(() => [props.workerId, isAdmin.value, props.canMigrate, props.recoveryOnly], () => {
  contextVersion++; statusRequest++;
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = undefined; busy.value = false;
  migrationPhase.value = ''; statusKnown.value = false;
  statusLoading.value = false; statusFailed.value = false;
  reconciliationRequired.value = false; workerRecordTransitionPending.value = false;
  daemonSettled.value = false; confirmDeleteRollback.value = false;
  migrationPlan.value = undefined; confirmDowntime.value = false; acknowledged.value = false; expanded.value = false;
  message.value = ''; error.value = ''; lockPassword.value = '';
  void refreshStatus();
}, { immediate: true });

async function recoverMigration() {
  if (!isAdmin.value || !props.canMigrate || props.disabled || busy.value || !statusKnown.value || !migrationNeedsRecovery.value || !daemonSettled.value) return;
  const wasTerminal = migrationTerminal.value;
  const version = contextVersion;
  const workerId = props.workerId;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await $fetch<MigrationStatus>(`/api/admin/workers/${workerId}/migration-recover`, { method: 'POST', body: {
      acknowledgeDaemonOperationsSettled: daemonSettled.value, lockPassword: lockPassword.value || undefined,
    } });
    if (!contextCurrent(version)) return;
    statusRequest++; applyStatus(result);
    if (migrationNeedsRecovery.value) message.value = 'Migration still requires recovery or reconciliation. Retained evidence has not been deleted.';
    else if (result.phase === 'committed') message.value = 'Committed migration reconciled; the migrated worker was retained. No rollback was performed. Rollback evidence is still retained.';
    else if (wasTerminal) message.value = 'Completed rollback reconciled; the previous worker was retained. No new rollback was performed. Rollback evidence is still retained.';
    else message.value = 'Rollback completed; the previous worker and its local data were restored. Shared account state was not rewound. Rollback evidence is still retained.';
    emit('changed');
  } catch (cause: any) { if (contextCurrent(version)) error.value = cause?.data?.statusMessage || cause?.message || 'Migration recovery failed'; }
  finally {
    if (contextCurrent(version)) await refreshStatus();
    if (contextCurrent(version)) { busy.value = false; daemonSettled.value = false; }
  }
}

async function finalizeMigration() {
  if (!isAdmin.value || !props.canMigrate || props.disabled || busy.value || !statusKnown.value || migrationNeedsRecovery.value || !confirmDeleteRollback.value) return;
  const version = contextVersion;
  const workerId = props.workerId;
  busy.value = true; error.value = ''; message.value = '';
  try {
    await $fetch(`/api/admin/workers/${workerId}/migration-finalize`, { method: 'POST', body: {
      confirmDeleteRollback: true, lockPassword: lockPassword.value || undefined,
    } });
    if (!contextCurrent(version)) return;
    message.value = 'Rollback cleanup completed. The current worker and its required root filesystem image were preserved.';
    emit('changed');
  } catch (cause: any) { if (contextCurrent(version)) error.value = cause?.data?.statusMessage || cause?.message || 'Migration cleanup failed'; }
  finally {
    if (contextCurrent(version)) await refreshStatus();
    if (contextCurrent(version)) { busy.value = false; confirmDeleteRollback.value = false; }
  }
}

async function preflightMigration() {
  if (props.recoveryOnly || !isAdmin.value || props.disabled || !props.canMigrate || busy.value) return;
  const version = contextVersion;
  error.value = ''; migrationPlan.value = undefined; confirmDowntime.value = false; busy.value = true;
  try {
    const plan = await $fetch<typeof migrationPlan.value>(`/api/admin/workers/${props.workerId}/migration-preflight`, {
      query: { runtimeProfile: profile.value === 'legacy-runc' ? 'kata-qemu' : 'legacy-runc' },
    });
    if (contextCurrent(version)) migrationPlan.value = plan;
  } catch (cause: any) { if (contextCurrent(version)) error.value = cause?.data?.statusMessage || cause?.message || 'Migration preflight failed'; }
  finally { if (contextCurrent(version)) busy.value = false; }
}

async function migrate() {
  if (props.recoveryOnly || !isAdmin.value || props.disabled || !props.canMigrate || busy.value || !migrationPlan.value || !confirmDowntime.value || !capacityAdmitted.value) return;
  const version = contextVersion;
  busy.value = true; error.value = ''; migrationPhase.value = 'Preparing';
  const poll = async () => { if (contextCurrent(version)) await refreshStatus(); };
  statusTimer = setInterval(() => { void poll(); }, 2000);
  try {
    const result = await $fetch<MigrationStatus>(`/api/admin/workers/${props.workerId}/migration`, {
      method: 'POST', body: { runtimeProfile: migrationPlan.value.targetProfile, confirmDowntime: true,
        acknowledgeHostPrivilege: acknowledged.value, lockPassword: lockPassword.value || undefined },
    });
    if (!contextCurrent(version)) return;
    statusRequest++; applyStatus(result);
    message.value = 'Runtime migration completed. The original root filesystem and data snapshots were retained.';
    migrationPlan.value = undefined;
  } catch (cause: any) { if (contextCurrent(version)) { error.value = cause?.data?.statusMessage || cause?.message || 'Migration failed; check its recovery status'; await poll(); } }
  finally {
    if (contextCurrent(version)) { if (statusTimer) clearInterval(statusTimer); statusTimer = undefined; await refreshStatus(); }
    if (contextCurrent(version)) busy.value = false;
  }
}

async function authorize() {
  if (props.recoveryOnly || !isAdmin.value || props.disabled || busy.value || (profile.value === 'legacy-runc' && !acknowledged.value)) return;
  const version = contextVersion;
  busy.value = true; error.value = ''; message.value = '';
  try {
    const result = await $fetch<{ message?: string }>(`/api/admin/workers/${props.workerId}/runtime`, {
      method: 'POST', body: { runtimeProfile: profile.value,
        acknowledgeHostPrivilege: acknowledged.value, lockPassword: lockPassword.value || undefined },
    });
    if (!contextCurrent(version)) return;
    message.value = result.message || 'Runtime approved. Starting or unarchiving remains a separate action.';
    expanded.value = false; acknowledged.value = false; lockPassword.value = '';
  } catch (cause: any) {
    if (contextCurrent(version)) error.value = cause?.data?.statusMessage || cause?.data?.message || cause?.message || 'Runtime authorization failed';
  } finally { if (contextCurrent(version)) busy.value = false; }
}
</script>

<template>
  <div class="space-y-2 text-xs">
    <p v-if="!recoveryOnly">Runtime: {{ profile === 'kata-qemu' ? 'Kata / QEMU' : 'Legacy runc' }}</p>
    <p v-if="approvalRequired && !message" class="text-amber-600">An administrator must approve this restored worker on this installation.</p>
    <UButton v-if="!recoveryOnly && isAdmin && !disabled && (profile === 'legacy-runc' || approvalRequired)" size="xs" color="neutral" variant="outline" @click="toggleExpanded">
      {{ profile === 'legacy-runc' ? 'Authorize legacy runtime' : 'Approve restored runtime' }}
    </UButton>
    <div v-if="!recoveryOnly && expanded" class="space-y-2">
      <UCheckbox v-if="profile === 'legacy-runc'" v-model="acknowledged" label="I authorize legacy runc. Docker-enabled workers receive privilege on the host." />
      <p v-else>This retains Kata / QEMU and checks this installation's host readiness.</p>
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Runtime authorization protection password" />
      <UButton size="xs" :loading="busy" :disabled="profile === 'legacy-runc' && !acknowledged" @click="authorize">Confirm authorization</UButton>
      <p>Starting, rebuilding or unarchiving remains a separate action.</p>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <UButton v-if="!recoveryOnly && isAdmin && canMigrate && !disabled && !approvalRequired" size="xs" color="neutral" variant="outline" :disabled="busy" @click="preflightMigration">Check runtime migration</UButton>
    <div v-if="!recoveryOnly && migrationPlan" class="space-y-2">
      <p>Target: {{ migrationPlan.targetProfile }}. Migration stops this worker, snapshots its root filesystem, and copies worker data for rollback. Allow temporary disk space for the copies.</p>
      <p v-if="!capacityAdmitted" class="text-amber-600">Migration is unavailable until trusted disk-capacity admission is implemented. Checking space manually or acknowledging downtime does not bypass this gate.</p>
      <p>The captured root filesystem becomes a required local image. Whole-instance backups do not contain image layers: separately encrypt and transfer its Docker image archive before restoring on another host.</p>
      <p>Shared account credentials and Kilo data keep their existing bindings and are not rolled back with this worker.</p>
      <ul class="list-disc pl-4"><li v-for="mount in migrationPlan.mounts" :key="mount.target">{{ mount.target }} — {{ mount.kind }}</li></ul>
      <UCheckbox v-model="confirmDowntime" label="I confirm worker downtime and snapshot creation." />
      <UCheckbox v-if="migrationPlan.targetProfile === 'legacy-runc'" v-model="acknowledged" label="I authorize legacy runc and its host privilege for Docker-enabled workers." />
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Migration protection password" />
      <UButton size="xs" :loading="busy" :disabled="!capacityAdmitted || !confirmDowntime || (migrationPlan.targetProfile === 'legacy-runc' && !acknowledged)" @click="migrate">Migrate runtime</UButton>
    </div>
    <p v-if="migrationPhase" role="status">Migration: {{ migrationPhase }}</p>
    <div v-if="isAdmin && canMigrate && !busy" class="space-y-2">
      <p v-if="statusFailed" role="alert" class="text-amber-600">Migration status could not be verified. Recovery and deletion of rollback evidence are unavailable until status can be read.</p>
      <UButton size="xs" color="neutral" variant="outline" :loading="statusLoading" :disabled="statusLoading" @click="refreshStatus">{{ statusFailed ? 'Retry migration status' : 'Refresh migration status' }}</UButton>
      <p v-if="recoveryOnly && statusKnown && !migrationPhase">No retained migration journal remains for this worker.</p>
    </div>
    <div v-if="isAdmin && canMigrate && migrationPhase && !busy && statusKnown" class="space-y-2">
      <UInput v-model="lockPassword" type="password" placeholder="Protection password, if set" aria-label="Migration recovery protection password" />
      <template v-if="migrationNeedsRecovery">
        <p v-if="migrationTerminal">This completed {{ migrationPhase === 'committed' ? 'migration' : 'rollback' }} requires explicit reconciliation of the journal, worker record and Docker identities. Reconciliation retains the current runtime and rollback evidence; it does not perform a new rollback.</p>
        <p v-else>Recovery may restore worker-local data.</p>
        <p>Before proceeding, the host operator must verify no outstanding Docker create, start or copy operation can still mutate this worker. A timeout alone does not prove this.</p>
        <p v-if="workerRecordTransitionPending">A worker-record transition is pending. Retain all recovery evidence until reconciliation succeeds.</p>
        <UCheckbox v-model="daemonSettled" label="The operator verified that outstanding Docker operations have settled." />
        <UButton size="xs" :disabled="!daemonSettled || disabled" @click="recoverMigration">{{ migrationTerminal ? 'Reconcile migration' : 'Recover interrupted migration' }}</UButton>
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
