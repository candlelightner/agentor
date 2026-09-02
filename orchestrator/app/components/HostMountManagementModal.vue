<script setup lang="ts">
import type { HostMountGrantTarget } from "../../shared/types";

const open = defineModel<boolean>("open", { default: false });
const { client, user, isAdmin } = useAuth();
const { view, loading, error, refresh } = useHostMounts();

interface UserRow { id: string; name: string; email: string }
const users = ref<UserRow[]>([]);
const selectedOwnerId = ref("");
const actionError = ref("");
const saving = ref(false);
const newPath = reactive({ name: "", sourcePath: "", allowWrite: false });
const assignment = reactive({
  pathId: "",
  targetType: "all" as Exclude<HostMountGrantTarget, "entitlement">,
  targetId: "",
});

const selectedOwnerLabel = computed(() =>
  users.value.find((item) => item.id === selectedOwnerId.value)?.email || "your account",
);
const entitledPaths = computed(() => view.value?.catalog.filter((path) => path.entitled) ?? []);
const groupOptions = computed(() => (view.value?.groups ?? []).map((group) => ({ label: group.name, value: group.id })));
const workerOptions = computed(() => (view.value?.workers ?? []).map((worker) => ({ label: `${worker.displayName} (${worker.status})`, value: worker.id })));
const targetOptions = computed(() => assignment.targetType === "group" ? groupOptions.value : workerOptions.value);
const pathById = computed(() => new Map((view.value?.catalog ?? []).map((path) => [path.id, path])));
const groupById = computed(() => new Map((view.value?.groups ?? []).map((group) => [group.id, group])));
const workerById = computed(() => new Map((view.value?.workers ?? []).map((worker) => [worker.id, worker])));

function message(cause: any) {
  return cause?.data?.statusMessage || cause?.data?.message || cause?.message || "Host mount operation failed.";
}

async function loadUsers() {
  if (!isAdmin.value) {
    selectedOwnerId.value = (user.value as any)?.id || "";
    users.value = selectedOwnerId.value ? [{ id: selectedOwnerId.value, name: (user.value as any)?.name || "", email: (user.value as any)?.email || "" }] : [];
    return;
  }
  const result = await client.admin.listUsers({ query: { limit: 500, sortBy: "email", sortDirection: "asc" } });
  if ((result as any)?.error)
    throw new Error((result as any).error.message || "Could not load accounts");
  const data = (result as any)?.data;
  users.value = (data?.users ?? data ?? []) as UserRow[];
  if (!selectedOwnerId.value) selectedOwnerId.value = (user.value as any)?.id || users.value[0]?.id || "";
}

async function reload() {
  if (!selectedOwnerId.value) return;
  await refresh({ ownerId: selectedOwnerId.value });
  if (!assignment.pathId || !entitledPaths.value.some((path) => path.id === assignment.pathId))
    assignment.pathId = entitledPaths.value[0]?.id || "";
}

watch(open, async (shown) => {
  if (!shown) return;
  actionError.value = "";
  try {
    await loadUsers();
    await reload();
  } catch (cause) {
    actionError.value = message(cause);
  }
});
watch(selectedOwnerId, () => { if (open.value) void reload(); });
watch(() => assignment.targetType, () => { assignment.targetId = ""; });

async function run(operation: () => Promise<unknown>) {
  saving.value = true;
  actionError.value = "";
  try {
    await operation();
    await reload();
  } catch (cause) {
    actionError.value = message(cause);
  } finally {
    saving.value = false;
  }
}

async function createPath() {
  await run(async () => {
    await $fetch("/api/host-mounts", { method: "POST", body: newPath });
    newPath.name = "";
    newPath.sourcePath = "";
    newPath.allowWrite = false;
  });
}

function setEntitlement(pathId: string, enabled: boolean) {
  return run(() => $fetch("/api/host-mounts/entitlements", {
    method: "PUT",
    body: { ownerId: selectedOwnerId.value, pathId, enabled },
  }));
}

function deletePath(pathId: string) {
  if (!confirm("Delete this approved host path? All dependent assignments will be revoked and affected running workers will be stopped.")) return;
  return run(() => $fetch(`/api/host-mounts/${pathId}`, { method: "DELETE" }));
}

function setPathWrite(pathId: string, allowWrite: boolean) {
  if (!allowWrite && !confirm("Disable writable mounts for this path? Workers currently using it writable will be stopped and must be rebuilt.")) return;
  return run(() => $fetch(`/api/host-mounts/${pathId}`, {
    method: "PATCH",
    body: { allowWrite },
  }));
}

async function createGrant() {
  if (!assignment.pathId || (assignment.targetType !== "all" && !assignment.targetId)) return;
  await run(() => $fetch("/api/host-mounts/grants", {
    method: "POST",
    body: {
      ownerId: selectedOwnerId.value,
      pathId: assignment.pathId,
      targetType: assignment.targetType,
      ...(assignment.targetType !== "all" ? { targetId: assignment.targetId } : {}),
    },
  }));
}

function deleteGrant(grantId: string) {
  if (!confirm("Revoke this assignment and every delegation derived from it? Affected running workers will be stopped until rebuilt.")) return;
  return run(() => $fetch(`/api/host-mounts/grants/${grantId}`, {
    method: "DELETE",
    query: { ownerId: selectedOwnerId.value },
  }));
}

function grantTarget(grant: any) {
  if (grant.targetType === "all") return "All workers";
  if (grant.targetType === "group") return `Group: ${groupById.value.get(grant.targetId)?.name || grant.targetId}`;
  return `Worker: ${workerById.value.get(grant.targetId)?.displayName || grant.targetId}`;
}

function closeModal() {
  open.value = false;
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-5xl' }">
    <template #content>
      <div class="max-h-[90vh] space-y-5 overflow-y-auto p-6" data-testid="host-mount-management">
        <div class="flex items-center justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Host mount permissions</h2>
            <p class="mt-1 text-sm text-gray-500">Approved paths start unavailable. Platform approval, account entitlement, and a worker/group assignment are all required.</p>
          </div>
          <UButton color="neutral" variant="ghost" @click="closeModal">Close</UButton>
        </div>

        <UAlert color="warning" variant="soft" icon="i-lucide-shield-alert" title="Host access is security-sensitive" description="Workers run user-controlled code. Grant only dedicated data directories, prefer read-only, and never approve system, Docker, credential, or Agentor storage paths." />
        <p v-if="actionError || error" class="text-sm text-red-600 dark:text-red-400">{{ actionError || error }}</p>

        <section v-if="isAdmin" class="space-y-3 rounded-lg border border-red-300 p-4 dark:border-red-900">
          <div>
            <h3 class="font-medium text-red-800 dark:text-red-200">Platform path catalog</h3>
            <p class="text-xs text-gray-500">Only platform administrators can enter raw host paths. Sources are immutable after approval.</p>
          </div>
          <div class="grid gap-2 md:grid-cols-[1fr_2fr_auto_auto]">
            <UInput v-model="newPath.name" placeholder="Display name" />
            <UInput v-model="newPath.sourcePath" placeholder="/dedicated/host/data" />
            <UCheckbox v-model="newPath.allowWrite" label="Allow write" />
            <UButton :disabled="!newPath.name.trim() || !newPath.sourcePath.trim()" :loading="saving" @click="createPath">Approve</UButton>
          </div>
          <div v-if="view?.catalog.length" class="divide-y divide-gray-200 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            <div v-for="path in view.catalog" :key="path.id" class="flex items-center gap-3 p-3 text-sm">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ path.name }}</div>
                <code class="break-all text-xs text-gray-500">{{ path.sourcePath }}</code>
              </div>
              <UCheckbox :model-value="path.allowWrite" label="Allow write" @update:model-value="setPathWrite(path.id, $event === true)" />
              <UButton size="xs" color="error" variant="ghost" @click="deletePath(path.id)">Delete</UButton>
            </div>
          </div>
          <p v-else class="text-sm text-gray-500">No host paths are approved. This is the secure default.</p>
        </section>

        <section class="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex-1">
              <h3 class="font-medium">Account entitlements</h3>
              <p class="text-xs text-gray-500">Platform admins choose which catalog paths the account owner may assign.</p>
            </div>
            <UFormField v-if="isAdmin" label="Account">
              <USelect v-model="selectedOwnerId" :items="users.map((item) => ({ label: `${item.name} (${item.email})`, value: item.id }))" class="min-w-72" />
            </UFormField>
          </div>
          <div v-if="view?.catalog.length" class="grid gap-2 md:grid-cols-2">
            <label v-for="path in view.catalog" :key="path.id" class="flex items-center gap-2 rounded border border-gray-200 p-2 text-sm dark:border-gray-800">
              <UCheckbox :model-value="path.entitled" :disabled="!isAdmin || saving" @update:model-value="setEntitlement(path.id, $event === true)" />
              <span class="min-w-0"><span class="font-medium">{{ path.name }}</span><br><code class="break-all text-xs text-gray-500">{{ path.sourcePath }}</code></span>
            </label>
          </div>
          <p v-else class="text-sm text-gray-500">No approved path is visible for {{ selectedOwnerLabel }}.</p>
        </section>

        <section class="space-y-3 rounded-lg border border-gray-200 p-4 dark:border-gray-800">
          <div>
            <h3 class="font-medium">Assignments for {{ selectedOwnerLabel }}</h3>
            <p class="text-xs text-gray-500">Account owners may assign only entitled paths. A group assignment covers direct members and lets that group's admin delegate it only to descendants.</p>
          </div>
          <div v-if="entitledPaths.length" class="grid gap-2 md:grid-cols-[2fr_1fr_2fr_auto]">
            <USelect v-model="assignment.pathId" :items="entitledPaths.map((path) => ({ label: path.name, value: path.id }))" placeholder="Path" />
            <USelect v-model="assignment.targetType" :items="[{ label: 'All workers', value: 'all' }, { label: 'Group', value: 'group' }, { label: 'Worker', value: 'worker' }]" />
            <USelect v-if="assignment.targetType !== 'all'" v-model="assignment.targetId" :items="targetOptions" placeholder="Select target" />
            <div v-else />
            <UButton :loading="saving" @click="createGrant">Assign</UButton>
          </div>
          <UAlert v-else color="neutral" variant="soft" title="No entitled paths" description="A platform administrator must entitle at least one approved path before it can be assigned." />
          <div v-if="view?.grants.length" class="divide-y divide-gray-200 rounded border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
            <div v-for="grant in view.grants" :key="grant.id" class="flex items-center gap-3 p-3 text-sm">
              <div class="flex-1">
                <span class="font-medium">{{ pathById.get(grant.pathId)?.name || grant.pathId }}</span>
                <span class="text-gray-500"> · {{ grantTarget(grant) }}</span>
                <UBadge v-if="grant.grantorType === 'group'" size="xs" color="info" class="ml-2">delegated</UBadge>
              </div>
              <UButton v-if="grant.grantorType !== 'group'" size="xs" color="error" variant="ghost" @click="deleteGrant(grant.id)">Revoke</UButton>
            </div>
          </div>
        </section>

        <UAlert color="info" variant="soft" title="Group administrative workspaces" description="Group admins cannot enter host paths or widen account permissions. Through their management MCP they can inspect paths granted to their group and delegate those paths only to descendant groups or workers in that subtree. If a path is missing, they are instructed to contact the account owner or platform administrator." />
      </div>
    </template>
  </UModal>
</template>
