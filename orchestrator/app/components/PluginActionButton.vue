<script setup lang="ts">
import type { PluginInstallation, PluginManifest } from '~/types';
const props = defineProps<{ workerId: string; installation: PluginInstallation; action: NonNullable<PluginManifest['actions']>[number]; name: string }>();
defineEmits<{ open: [] }>();
const status = computed(() => !props.installation.desiredEnabled ? 'Disabled' : props.installation.observed.state === 'error' ? 'Failed' : props.installation.observed.ready ? 'Ready' : 'Starting');
const source = computed(() => `${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}/plugin-ui/${encodeURIComponent(props.workerId)}/${encodeURIComponent(props.installation.id)}/${encodeURIComponent(props.action.id)}/`);
</script>

<template>
  <span class="inline-flex items-center gap-1" :title="installation.observed.error?.message || status">
    <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-puzzle" :disabled="!installation.desiredEnabled || !installation.observed.ready" @click="$emit('open')">{{ name }} · {{ action.label }}</UButton>
    <a v-if="installation.desiredEnabled && installation.observed.ready" :href="source" target="_blank" rel="noopener noreferrer" class="text-xs px-1" :aria-label="`Open ${name} in tab`">Open in tab</a>
    <span v-if="status !== 'Ready'" class="text-xs text-gray-500">{{ status }}<span v-if="installation.observed.error"> · {{ installation.observed.error.message }}</span></span>
  </span>
</template>
