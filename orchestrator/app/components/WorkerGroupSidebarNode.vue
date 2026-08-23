<script setup lang="ts">
import type { ContainerInfo, Tab, UpdateContainerSettingsRequest } from "~/types";
import type { WorkerGroup } from "~/composables/useWorkerGroups";

export interface WorkerGroupSidebarTreeNode {
  group: WorkerGroup;
  workers: ContainerInfo[];
  children: WorkerGroupSidebarTreeNode[];
}

const props = defineProps<{
  node: WorkerGroupSidebarTreeNode;
  tabs: Tab[];
  activeTabId: string | null;
  metricFor: (id: string) => any;
}>();
const emit = defineEmits<{
  openTerminal: [id: string]; openDesktop: [id: string]; openApps: [id: string]; openEditor: [id: string];
  stopContainer: [id: string]; restartContainer: [id: string]; rebuildContainer: [id: string]; removeContainer: [id: string]; archiveContainer: [id: string]; downloadWorkspace: [id: string];
  updateContainer: [id: string, patch: UpdateContainerSettingsRequest, rebuild: boolean, complete: (error?: string) => void];
  groupLifecycle: [groupId: string, action: "stop" | "rebuild" | "archive", complete: (error?: string) => void];
}>();

const loadingAction = ref<"stop" | "rebuild" | "archive" | null>(null);
const actionError = ref("");
function runGroupAction(action: "stop" | "rebuild" | "archive") {
  actionError.value = "";
  loadingAction.value = action;
  emit("groupLifecycle", props.node.group.id, action, (error?: string) => {
    loadingAction.value = null;
    actionError.value = error || "";
  });
}

function active(id: string) {
  return props.tabs.find((tab) => tab.id === props.activeTabId)?.containerId === id;
}
</script>

<template>
  <section
    class="rounded-xl border-2 border-primary-300/70 bg-primary-50/40 p-2 dark:border-primary-700/70 dark:bg-primary-950/20"
    :aria-label="`Worker group: ${node.group.name}`"
    :data-testid="`worker-group-cards-${node.group.id}`"
  >
    <div class="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-primary-700 dark:text-primary-300">
      <UIcon name="i-lucide-folder-kanban" class="size-3.5" />
      <span>{{ node.group.name }}</span>
      <span class="text-primary-600/70 dark:text-primary-400/70">
        {{ node.workers.filter((worker) => worker.administrativeKind !== 'group').length }} direct
      </span>
      <span class="flex-1" />
      <UTooltip :text="`Stop all in ${node.group.name}`">
        <UButton
          size="xs" color="neutral" variant="ghost" icon="i-lucide-square"
          :aria-label="`Stop all in ${node.group.name}`"
          :loading="loadingAction === 'stop'" :disabled="loadingAction !== null"
          @click="runGroupAction('stop')"
        />
      </UTooltip>
      <UTooltip :text="`Rebuild all in ${node.group.name}`">
        <UButton
          size="xs" color="warning" variant="ghost" icon="i-lucide-hammer"
          :aria-label="`Rebuild all in ${node.group.name}`"
          :loading="loadingAction === 'rebuild'" :disabled="loadingAction !== null"
          @click="runGroupAction('rebuild')"
        />
      </UTooltip>
      <UTooltip :text="`Archive all in ${node.group.name}`">
        <UButton
          size="xs" color="neutral" variant="ghost" icon="i-lucide-archive"
          :aria-label="`Archive all in ${node.group.name}`"
          :loading="loadingAction === 'archive'" :disabled="loadingAction !== null"
          @click="runGroupAction('archive')"
        />
      </UTooltip>
    </div>
    <p v-if="actionError" class="mb-2 px-1 text-[10px] text-red-600 dark:text-red-400" role="alert">
      {{ actionError }}
    </p>
    <div class="space-y-2">
      <ContainerCard
        v-for="worker in node.workers" :key="worker.id" :container="worker"
        :is-active="active(worker.id)" :metric="metricFor(worker.id)"
        @open-terminal="(id) => emit('openTerminal', id)" @open-desktop="(id) => emit('openDesktop', id)"
        @open-apps="(id) => emit('openApps', id)" @open-editor="(id) => emit('openEditor', id)"
        @stop="(id) => emit('stopContainer', id)" @restart="(id) => emit('restartContainer', id)"
        @rebuild="(id) => emit('rebuildContainer', id)" @remove="(id) => emit('removeContainer', id)"
        @archive="(id) => emit('archiveContainer', id)"
        @update="(id, patch, rebuild, complete) => emit('updateContainer', id, patch, rebuild, complete)"
        @download-workspace="(id) => emit('downloadWorkspace', id)"
      />
      <WorkerGroupSidebarNode
        v-for="child in node.children" :key="child.group.id" :node="child" :tabs="tabs"
        :active-tab-id="activeTabId" :metric-for="metricFor"
        @open-terminal="(id) => emit('openTerminal', id)" @open-desktop="(id) => emit('openDesktop', id)"
        @open-apps="(id) => emit('openApps', id)" @open-editor="(id) => emit('openEditor', id)"
        @stop-container="(id) => emit('stopContainer', id)" @restart-container="(id) => emit('restartContainer', id)"
        @rebuild-container="(id) => emit('rebuildContainer', id)" @remove-container="(id) => emit('removeContainer', id)"
        @archive-container="(id) => emit('archiveContainer', id)"
        @update-container="(id, patch, rebuild, complete) => emit('updateContainer', id, patch, rebuild, complete)"
        @download-workspace="(id) => emit('downloadWorkspace', id)"
        @group-lifecycle="(groupId, action, complete) => emit('groupLifecycle', groupId, action, complete)"
      />
    </div>
  </section>
</template>
