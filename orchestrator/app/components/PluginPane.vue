<script setup lang="ts">
const props = defineProps<{
  containerId: string;
  installationId: string;
  actionId: string;
  label: string;
}>();

const source = computed(() =>
  `/plugin-ui/${encodeURIComponent(props.containerId)}/${encodeURIComponent(props.installationId)}/${encodeURIComponent(props.actionId)}/`,
);
</script>

<template>
  <div class="h-full w-full bg-white dark:bg-gray-950">
    <!-- The proxy authenticates every request and strips dashboard credentials
         before forwarding. Omission of allow-same-origin keeps arbitrary
         worker-supplied application code in an opaque browser origin. -->
    <iframe
      :src="source"
      :title="label"
      sandbox="allow-forms allow-scripts"
      referrerpolicy="no-referrer"
      class="h-full w-full border-0"
      data-testid="plugin-application-frame"
    />
  </div>
</template>
