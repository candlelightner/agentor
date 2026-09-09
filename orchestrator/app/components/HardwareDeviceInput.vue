<script setup lang="ts">
import type { HardwareDevice } from '../../shared/types';
const props = defineProps<{ modelValue: string; devices: Array<HardwareDevice & { available?: boolean }> }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; remove: [] }>();
const items = computed(() => props.devices.map((item) => ({ label: `${item.name} · ${item.kind.toUpperCase()}${item.available === false ? ' (unavailable)' : ''}`, value: item.id, disabled: item.available === false })));
</script>
<template>
  <div class="flex items-center gap-2">
    <USelect :model-value="modelValue" :items="items" placeholder="Assigned hardware device" aria-label="Assigned hardware device" size="xs" class="flex-1" @update:model-value="emit('update:modelValue', $event)" />
    <UButton icon="i-lucide-x" size="xs" color="neutral" variant="ghost" @click="emit('remove')" />
  </div>
</template>
