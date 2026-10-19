<script setup lang="ts">
import { normalizeWorkerRuntimeKind, type WorkerRuntimeKind } from '../../shared/types';

const props = defineProps<{ runtimeKind?: WorkerRuntimeKind }>();
const isVm = computed(() => normalizeWorkerRuntimeKind(props.runtimeKind) === 'incus-vm');
const label = computed(() => isVm.value ? 'Incus virtual machine' : 'Docker container');
</script>

<template>
  <UTooltip :text="label">
    <span
      tabindex="0"
      role="img"
      :aria-label="label"
      data-testid="worker-runtime-icon"
      class="inline-flex shrink-0 rounded text-gray-500 dark:text-gray-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      <UIcon :name="isVm ? 'i-lucide-server' : 'i-lucide-container'" class="size-3.5" aria-hidden="true" />
    </span>
  </UTooltip>
</template>
