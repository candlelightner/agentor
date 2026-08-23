<script setup lang="ts">
import type { ArchivedWorker } from "~/types";
import type { WorkerGroup } from "~/composables/useWorkerGroups";

export interface ArchivedWorkerGroupSidebarTreeNode {
  group: WorkerGroup;
  workers: ArchivedWorker[];
  children: ArchivedWorkerGroupSidebarTreeNode[];
}

defineProps<{ node: ArchivedWorkerGroupSidebarTreeNode }>();
const emit = defineEmits<{
  unarchive: [id: string];
  delete: [id: string];
}>();
</script>

<template>
  <section
    class="rounded-xl border-2 border-slate-300/70 bg-slate-100/40 p-2 dark:border-slate-700/70 dark:bg-slate-900/25"
    :aria-label="`Archived worker group: ${node.group.name}`"
    :data-testid="`archived-worker-group-cards-${node.group.id}`"
  >
    <div class="mb-2 flex items-center gap-1.5 px-1 text-xs font-semibold text-slate-600 dark:text-slate-300">
      <UIcon name="i-lucide-folder-archive" class="size-3.5" />
      <span>{{ node.group.name }}</span>
      <span class="text-slate-500/80 dark:text-slate-400/80">{{ node.workers.length }} direct</span>
    </div>
    <div class="space-y-2">
      <ArchivedWorkerCard
        v-for="worker in node.workers"
        :key="worker.id"
        :worker="worker"
        @unarchive="(id) => emit('unarchive', id)"
        @delete="(id) => emit('delete', id)"
      />
      <ArchivedWorkerGroupSidebarNode
        v-for="child in node.children"
        :key="child.group.id"
        :node="child"
        @unarchive="(id) => emit('unarchive', id)"
        @delete="(id) => emit('delete', id)"
      />
    </div>
  </section>
</template>
