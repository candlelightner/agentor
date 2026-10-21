<script setup lang="ts">
import type { HardwareDevice } from '../../shared/types';
const props = defineProps<{ modelValue: string; devices: Array<HardwareDevice & { available?: boolean }> }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; remove: [] }>();
const physical = computed(() => props.devices.find(item => item.id === props.modelValue)?.selector.startsWith('pci-gpu:') === true);
const items = computed(() => props.devices.map((item) => ({ label: `${item.name} · ${item.kind.toUpperCase()}${item.available === false ? ' (unavailable)' : ''}`, value: item.id, disabled: item.available === false || item.selector.startsWith('pci-gpu:') })));
</script>
<template>
  <div class="flex items-center gap-2">
    <USelect :model-value="modelValue" :items="items" :disabled="physical" placeholder="Assigned hardware device" aria-label="Assigned hardware device" size="xs" class="flex-1" @update:model-value="emit('update:modelValue', $event)" />
    <span v-if="physical" class="text-xs text-gray-500">Platform-managed</span>
    <UButton v-else icon="i-lucide-x" size="xs" color="neutral" variant="ghost" aria-label="Remove hardware device" @click="emit('remove')" />
  </div>
</template>
