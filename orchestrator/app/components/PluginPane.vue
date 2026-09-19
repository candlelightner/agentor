<script setup lang="ts">
const props = defineProps<{
  containerId: string;
  installationId: string;
  actionId: string;
  label: string;
  openMode: 'sandboxed-pane' | 'desktop';
}>();

const source = computed(() =>
  `${useRuntimeConfig().app.baseURL.replace(/\/$/, '')}/plugin-ui/${encodeURIComponent(props.containerId)}/${encodeURIComponent(props.installationId)}/${encodeURIComponent(props.actionId)}/`,
);
</script>

<template>
  <div class="h-full w-full flex flex-col bg-white dark:bg-gray-950">
    <div class="px-3 py-1 text-xs border-b"><a :href="source" target="_blank" rel="noopener noreferrer">Open in tab</a></div>
    <!-- The proxy authenticates every request and strips dashboard credentials
         before forwarding. Omission of allow-same-origin keeps arbitrary
         worker-supplied application code in an opaque browser origin. -->
    <iframe
      :src="source"
      :title="label"
      :sandbox="props.openMode === 'desktop' ? undefined : 'allow-forms allow-scripts'"
      referrerpolicy="no-referrer"
      class="flex-1 min-h-0 w-full border-0"
      data-testid="plugin-application-frame"
    />
  </div>
</template>
