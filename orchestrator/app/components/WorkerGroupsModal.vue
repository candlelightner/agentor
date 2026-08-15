<script setup lang="ts">
import type { ContainerInfo } from "~/types";
import type {
  GroupAdminWorkspace,
  WorkerGroup,
} from "~/composables/useWorkerGroups";
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ containers: ContainerInfo[] }>();
const emit = defineEmits<{ service: [workspaceId: string, service: string] }>();
const { groups, create, update, remove, assignWorker, adminAction } = useWorkerGroups();
const name = ref("");
const createParentId = ref("");
const error = ref("");
const busy = ref("");
const filesWorkspace = ref<GroupAdminWorkspace | null>(null);
const showFiles = ref(false);
async function run(key: string, operation: () => Promise<unknown>) {
  busy.value = key;
  error.value = "";
  try {
    return await operation();
  } catch (e: any) {
    error.value =
      e?.data?.statusMessage || e?.message || "Worker group operation failed";
  } finally {
    busy.value = "";
  }
}
async function createGroup() {
  if (!name.value.trim()) return;
  const result = await run("create", () => create(name.value, createParentId.value || undefined));
  if (result) name.value = "";
}
async function rename(group: WorkerGroup) {
  const value = prompt("Group name", group.name);
  if (value?.trim())
    await run(`rename-${group.id}`, () => update(group.id, { name: value }));
}
async function toggle(group: WorkerGroup, id: string) {
  await run(`member-${group.id}`, () =>
    assignWorker(id, group.workerIds.includes(id) ? null : group.id),
  );
}
function descendants(groupId: string) {
  const result = new Set<string>();
  const visit = (id: string) => groups.value.filter((g) => g.parentId === id).forEach((g) => {
    if (!result.has(g.id)) { result.add(g.id); visit(g.id); }
  });
  visit(groupId);
  return result;
}
function legalParents(group: WorkerGroup) {
  const excluded = descendants(group.id);
  excluded.add(group.id);
  return groups.value.filter((candidate) => candidate.userId === group.userId && !excluded.has(candidate.id));
}
async function moveGroup(group: WorkerGroup, value: string) {
  await run(`parent-${group.id}`, () => update(group.id, { parentId: value || null }));
}
const orderedGroups = computed(() => {
  const result: Array<{ group: WorkerGroup; depth: number }> = [];
  const visit = (parentId: string | undefined, depth: number, seen: Set<string>) => {
    groups.value.filter((group) => group.parentId === parentId).forEach((group) => {
      if (seen.has(group.id)) return;
      seen.add(group.id); result.push({ group, depth }); visit(group.id, depth + 1, seen);
    });
  };
  const seen = new Set<string>(); visit(undefined, 0, seen);
  groups.value.forEach((group) => { if (!seen.has(group.id)) result.push({ group, depth: 0 }); });
  return result;
});
const groupPath = (group: WorkerGroup) => {
  const byId = new Map(groups.value.map((item) => [item.id, item]));
  const path = [group.name]; let parentId = group.parentId; const seen = new Set([group.id]);
  while (parentId && !seen.has(parentId)) { seen.add(parentId); const parent = byId.get(parentId); if (!parent) break; path.unshift(parent.name); parentId = parent.parentId; }
  return path.join(" / ");
};
const { data: validation, refresh: refreshValidation } = useFetch<{ valid: boolean; membershipConflicts: Array<{ workerId: string; groupIds: string[] }>; hierarchyErrors: Array<{ groupId: string; code: "missing-parent" | "cycle" }> }>("/api/worker-groups/validation", { default: () => ({ valid: true, membershipConflicts: [], hierarchyErrors: [] }) });
watch(groups, () => refreshValidation(), { deep: true });
async function deleteGroup(group: WorkerGroup) {
  await run(`delete-${group.id}`, () => remove(group.id));
}
async function admin(
  group: WorkerGroup,
  action: "ensure" | "start" | "stop" | "rebuild",
) {
  await run(`admin-${group.id}-${action}`, () => adminAction(group.id, action));
}
function openService(workspace: GroupAdminWorkspace, service: string) {
  emit("service", workspace.id, service);
  open.value = false;
}
function openFiles(workspace: GroupAdminWorkspace) {
  filesWorkspace.value = workspace;
  showFiles.value = true;
}
function serviceIcon(service: string) {
  return service === 'terminal'
    ? 'i-lucide-terminal'
    : service === 'editor'
      ? 'i-lucide-code'
      : service === 'desktop'
        ? 'i-lucide-monitor'
        : 'i-lucide-layout-grid';
}
</script>
<template>
  <UModal v-model:open="open" title="Worker groups" data-testid="worker-groups"
    ><template #body>
      <form class="flex flex-wrap gap-2" @submit.prevent="createGroup">
        <UInput
          v-model="name"
          aria-label="Group name"
          placeholder="Group name"
        />
        <select v-model="createParentId" aria-label="Parent group" class="rounded border px-2 dark:bg-gray-900">
          <option value="">Root group</option><option v-for="candidate in groups" :key="candidate.id" :value="candidate.id">{{ groupPath(candidate) }}</option>
        </select>
        <UButton type="submit" :loading="busy === 'create'"
          >Create group</UButton
        >
      </form>
      <p v-if="error" role="alert" class="text-red-500 text-sm">{{ error }}</p>
      <div v-if="validation.membershipConflicts.length" role="alert" class="mt-3 rounded border border-amber-400 bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">
        Existing membership conflicts must be resolved before changing the hierarchy.
        <div v-for="conflict in validation.membershipConflicts" :key="conflict.workerId">Worker {{ conflict.workerId }} belongs to {{ conflict.groupIds.length }} groups.</div>
      </div>
      <div v-if="validation.hierarchyErrors.length" role="alert" class="mt-3 rounded border border-red-400 bg-red-50 p-2 text-sm text-red-900 dark:bg-red-950 dark:text-red-100">
        Invalid saved hierarchy detected. Resolve it before moving groups.
        <div v-for="issue in validation.hierarchyErrors" :key="`${issue.groupId}-${issue.code}`">Group {{ issue.groupId }}: {{ issue.code }}</div>
      </div>
      <p v-if="!groups.length" class="text-gray-500 mt-4">
        No worker groups yet.
      </p>
      <section
        v-for="entry in orderedGroups"
        :key="entry.group.id"
        class="mt-4 rounded border p-3"
        :style="{ marginLeft: `${entry.depth * 1.25}rem` }"
        :data-depth="entry.depth"
        :data-testid="`worker-group-${entry.group.id}`"
      >
        <template v-if="true"><!-- retain a concise local alias in the template -->
        <div class="flex justify-between">
          <div><strong>{{ entry.group.name }}</strong><div class="text-xs text-gray-500">{{ groupPath(entry.group) }} · {{ entry.group.workerIds.length }} direct worker{{ entry.group.workerIds.length === 1 ? '' : 's' }}</div></div
          ><span
            ><UButton size="xs" variant="ghost" @click="rename(entry.group)"
              >Rename</UButton
            ><UButton
              size="xs"
              color="error"
              variant="ghost"
              @click="deleteGroup(entry.group)"
              >Delete</UButton
            ></span
          >
        </div>
        <p class="text-xs text-gray-500">
          Deleting a group never deletes its workers. Its trusted group-admin
          workspace is removed.
        </p>
        <label class="mt-2 flex items-center gap-2 text-sm">Parent
          <select :value="entry.group.parentId || ''" :aria-label="`Parent for ${entry.group.name}`" class="rounded border px-2 py-1 dark:bg-gray-900" @change="moveGroup(entry.group, ($event.target as HTMLSelectElement).value)">
            <option value="">Root group</option><option v-for="candidate in legalParents(entry.group)" :key="candidate.id" :value="candidate.id">{{ groupPath(candidate) }}</option>
          </select>
        </label>
        <label
          v-for="worker in props.containers.filter(
            (c) => c.userId === entry.group.userId && !c.administrativeKind,
          )"
          :key="worker.id"
          class="block mt-2"
          ><input
            type="checkbox"
            :checked="entry.group.workerIds.includes(worker.id)"
            @change="toggle(entry.group, worker.id)"
          />
          {{ worker.displayName }}</label
        >
        <div
          class="mt-3 rounded border border-red-300 p-3"
          data-testid="group-admin-workspace"
        >
          <div class="flex items-center justify-between">
            <strong class="text-sm">Scoped group administrator</strong
            ><span v-if="entry.group.adminWorkspace" class="text-xs uppercase">{{
              entry.group.adminWorkspace.status
            }}</span>
          </div>
          <p class="text-xs text-gray-500 mt-1">
            Trusted MCP access covers this group and its live descendant subtree.
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <UButton
              v-if="!entry.group.adminWorkspace"
              size="xs"
              color="error"
              :loading="busy === `admin-${entry.group.id}-ensure`"
              @click="admin(entry.group, 'ensure')"
              >Provision group admin</UButton
            >
            <template v-else
              ><UTooltip v-if="entry.group.adminWorkspace.status === 'stopped'" text="Start"
                ><UButton size="xs" color="success" variant="subtle" icon="i-lucide-refresh-cw" aria-label="Start" @click="admin(entry.group, 'start')" /></UTooltip
              ><UTooltip v-else text="Stop"
                ><UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-square" aria-label="Stop" @click="admin(entry.group, 'stop')" /></UTooltip
              ><UTooltip text="Rebuild"
                ><UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-hammer" aria-label="Rebuild" @click="admin(entry.group, 'rebuild')" /></UTooltip
              ><UTooltip text="Files"
                ><UButton size="xs" color="neutral" variant="subtle" icon="i-lucide-folder-tree" aria-label="Files" :disabled="entry.group.adminWorkspace.status !== 'running'" @click="openFiles(entry.group.adminWorkspace)" /></UTooltip
              ><UTooltip v-for="service in entry.group.adminWorkspace.services" :key="service" :text="`Open ${service}`"
                ><UButton size="xs" color="neutral" variant="subtle" :icon="serviceIcon(service)" :aria-label="`Open ${service}`" @click="openService(entry.group.adminWorkspace!, service)" /></UTooltip
              ></template
            >
          </div>
        </div>
        <WorkerGroupEnvEditor :group-id="entry.group.id" />
        </template>
      </section>
    </template></UModal
  >
  <WorkspaceFilesModal
    v-if="filesWorkspace"
    v-model:open="showFiles"
    :container="{
      id: filesWorkspace.id,
      displayName: 'Group administrator',
      status: filesWorkspace.status,
    }"
  />
</template>
