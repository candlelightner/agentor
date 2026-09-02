<script setup lang="ts">
import type { HostMountPath, MountConfig } from '../../shared/types';

const props = defineProps<{
  modelValue: MountConfig;
  paths: HostMountPath[];
}>();

const emit = defineEmits<{
  'update:modelValue': [value: MountConfig];
  remove: [];
}>();

function update(field: keyof MountConfig, value: string | boolean) {
  emit('update:modelValue', { ...props.modelValue, [field]: value });
}

const selected = computed(() => props.paths.find((path) => path.id === props.modelValue.pathId));
const pathItems = computed(() => props.paths.map((path) => ({
  label: `${path.name} (${path.sourcePath})`,
  value: path.id,
})));
const legacyUnapproved = computed(() =>
  !!props.modelValue.source && !selected.value,
);
const accessItems = computed(() => [
  { label: 'Read only', value: 'ro' },
  {
    label: 'Read and write',
    value: 'rw',
    disabled: !selected.value?.allowWrite,
  },
]);

function selectPath(pathId: string) {
  const path = props.paths.find((item) => item.id === pathId);
  emit('update:modelValue', {
    ...props.modelValue,
    pathId,
    source: path?.sourcePath || '',
    readOnly: path?.allowWrite ? props.modelValue.readOnly !== false : true,
  });
}
</script>

<template>
  <div class="flex gap-2 items-center">
    <USelect
      :model-value="modelValue.pathId"
      :items="pathItems"
      placeholder="Approved host path"
      aria-label="Approved host path"
      size="xs"
      class="flex-1"
      @update:model-value="selectPath($event)"
    />
    <span class="text-gray-400 dark:text-gray-500 text-xs">:</span>
    <UInput
      :model-value="modelValue.target"
      placeholder="Container path"
      size="xs"
      class="flex-1"
      @update:model-value="update('target', $event)"
    />
    <USelect
      :model-value="modelValue.readOnly === false ? 'rw' : 'ro'"
      :items="accessItems"
      aria-label="Mount access"
      size="xs"
      class="w-36 shrink-0"
      @update:model-value="update('readOnly', $event !== 'rw')"
    />
    <UButton
      icon="i-lucide-x"
      size="xs"
      color="neutral"
      variant="ghost"
      @click="emit('remove')"
    />
  </div>
  <p v-if="legacyUnapproved" class="mt-1 text-xs text-amber-600 dark:text-amber-400">
    This legacy mount is not currently approved. Remove it or ask the platform administrator to approve and assign the exact path before rebuilding.
  </p>
</template>
