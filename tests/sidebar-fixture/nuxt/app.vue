<script setup lang="ts">
const query = new URLSearchParams(window.location.search);
const role = query.get('role') === 'ordinary' ? 'ordinary' : 'admin';
const width = query.get('width') === 'narrow' ? 200 : 420;
const containers = [
  { id: 'ordinary-fixture', displayName: 'Research worker', status: 'running', imageId: 'sha256:1234567890abcdef' },
  { id: 'nested-fixture', displayName: 'Nested worker', status: 'running', imageId: 'sha256:67890abcdef12345' },
  ...(role === 'admin' ? [{ id: 'platform-fixture', displayName: 'Platform admin', status: 'running', administrativeKind: 'platform', imageId: 'sha256:abcdef1234567890' }] : []),
];
const archivedWorkers = [
  { id: 'archived-fixture', displayName: 'Archived worker', archivedAt: '2026-09-01T00:00:00Z', createdAt: '2026-08-01T00:00:00Z' },
];
const tabs = [
  { id: 'ordinary-tab', containerId: 'ordinary-fixture', containerName: 'Research worker', type: 'terminal' },
  ...(role === 'admin' ? [{ id: 'platform-tab', containerId: 'platform-fixture', containerName: 'Platform admin', type: 'terminal' }] : []),
];
const activeTabId = query.get('active') === 'admin' && role === 'admin' ? 'platform-tab' : 'ordinary-tab';
const colorMode = useColorMode();
onMounted(() => { colorMode.preference = query.get('theme') === 'light' ? 'light' : 'dark'; });
function record(action: string) { (window as any).__lastAction = action; }
useHead({ title: 'Sidebar QA fixture' });
</script>

<template>
  <UApp>
    <main class="flex h-screen overflow-hidden">
      <AppSidebar
        :style="{ width: `${width}px`, height: '100vh' }"
        :containers="containers as any"
        :tabs="tabs as any"
        :active-tab-id="activeTabId"
        :archived-workers="archivedWorkers as any"
        @new-worker="record('newWorker')"
        @open-admin-workspace="record('openAdminWorkspace')"
      />
      <section class="flex-1 p-8 bg-gray-100 dark:bg-gray-950 text-gray-500">Sidebar style QA fixture</section>
    </main>
  </UApp>
</template>
