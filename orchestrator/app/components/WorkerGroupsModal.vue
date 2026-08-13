<script setup lang="ts">
import type { ContainerInfo } from "~/types";
import type {
  GroupAdminWorkspace,
  WorkerGroup,
} from "~/composables/useWorkerGroups";
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ containers: ContainerInfo[] }>();
const emit = defineEmits<{ service: [workspaceId: string, service: string] }>();
const { groups, create, update, remove, adminAction } = useWorkerGroups();
const name = ref("");
const error = ref("");
const busy = ref("");
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
  const result = await run("create", () => create(name.value));
  if (result) name.value = "";
}
async function rename(group: WorkerGroup) {
  const value = prompt("Group name", group.name);
  if (value?.trim())
    await run(`rename-${group.id}`, () => update(group.id, { name: value }));
}
async function toggle(group: WorkerGroup, id: string) {
  const ids = group.workerIds.includes(id)
    ? group.workerIds.filter((x) => x !== id)
    : [...group.workerIds, id];
  await run(`member-${group.id}`, () => update(group.id, { workerIds: ids }));
}
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
</script>
<template>
  <UModal v-model:open="open" title="Worker groups" data-testid="worker-groups"
    ><template #body>
      <form class="flex gap-2" @submit.prevent="createGroup">
        <UInput
          v-model="name"
          aria-label="Group name"
          placeholder="Group name"
        /><UButton type="submit" :loading="busy === 'create'"
          >Create group</UButton
        >
      </form>
      <p v-if="error" role="alert" class="text-red-500 text-sm">{{ error }}</p>
      <p v-if="!groups.length" class="text-gray-500 mt-4">
        No worker groups yet.
      </p>
      <section
        v-for="group in groups"
        :key="group.id"
        class="mt-4 rounded border p-3"
        :data-testid="`worker-group-${group.id}`"
      >
        <div class="flex justify-between">
          <strong>{{ group.name }}</strong
          ><span
            ><UButton size="xs" variant="ghost" @click="rename(group)"
              >Rename</UButton
            ><UButton
              size="xs"
              color="error"
              variant="ghost"
              @click="deleteGroup(group)"
              >Delete</UButton
            ></span
          >
        </div>
        <p class="text-xs text-gray-500">
          Deleting a group never deletes its workers. Its trusted group-admin
          workspace is removed.
        </p>
        <label
          v-for="worker in props.containers.filter(
            (c) => c.userId === group.userId && !c.administrativeKind,
          )"
          :key="worker.id"
          class="block mt-2"
          ><input
            type="checkbox"
            :checked="group.workerIds.includes(worker.id)"
            @change="toggle(group, worker.id)"
          />
          {{ worker.displayName }}</label
        >
        <div
          class="mt-3 rounded border border-red-300 p-3"
          data-testid="group-admin-workspace"
        >
          <div class="flex items-center justify-between">
            <strong class="text-sm">Scoped group administrator</strong
            ><span v-if="group.adminWorkspace" class="text-xs uppercase">{{
              group.adminWorkspace.status
            }}</span>
          </div>
          <p class="text-xs text-gray-500 mt-1">
            Trusted MCP access is restricted to this group’s current members.
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <UButton
              v-if="!group.adminWorkspace"
              size="xs"
              color="error"
              :loading="busy === `admin-${group.id}-ensure`"
              @click="admin(group, 'ensure')"
              >Provision group admin</UButton
            >
            <template v-else
              ><UButton
                v-if="group.adminWorkspace.status === 'stopped'"
                size="xs"
                @click="admin(group, 'start')"
                >Start</UButton
              ><UButton v-else size="xs" @click="admin(group, 'stop')"
                >Stop</UButton
              ><UButton
                size="xs"
                variant="outline"
                @click="admin(group, 'rebuild')"
                >Rebuild</UButton
              ><UButton
                v-for="service in group.adminWorkspace.services"
                :key="service"
                size="xs"
                variant="ghost"
                @click="openService(group.adminWorkspace!, service)"
                >Open {{ service }}</UButton
              ></template
            >
          </div>
        </div>
      </section>
    </template></UModal
  >
</template>
