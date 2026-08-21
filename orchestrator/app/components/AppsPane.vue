<script setup lang="ts">
import type { AppTypeInfo } from '~/types';
import AppInstanceRow from './AppInstanceRow.vue';
import VsCodeAppRow from './VsCodeAppRow.vue';
import SshAppRow from './SshAppRow.vue';

const props = defineProps<{
  containerId: string;
}>();

const containerIdRef = toRef(props, 'containerId');
const { appTypes, instances, createInstance, stopInstance } = useApps(containerIdRef as Ref<string>);
const { openTab, openPluginTab } = useSplitPanes();
const plugins = usePlugins(containerIdRef as Ref<string>);
const toast = useToast();
const startingTypes = ref<Set<string>>(new Set());
const showPluginCatalog = ref(false);
const pluginDefinitions = computed(() => new Map(plugins.definitions.value.map(item => [item.id, item])));
const pluginActions = computed(() => plugins.installations.value.flatMap((installation) => {
  const definition = pluginDefinitions.value.get(installation.definitionId);
  if (!definition || !installation.desiredEnabled || !installation.observed.ready) return [];
  return (definition.manifest.actions || []).map(action => ({ installation, definition, action }));
}));
onBeforeUnmount(plugins.stop);

// Resolve the real Docker container name (`agentor-worker-<id>`) for the
// app-row network hostname tooltip. `containerId` is the worker UUID, not the
// on-network DNS name, so a raw slice would advertise a host that does not resolve.
const { containers } = useContainers();
const containerName = computed(
  () => containers.value.find((c) => c.id === props.containerId)?.containerName ?? '',
);
const containerDisplayName = computed(() => {
  const container = containers.value.find((c) => c.id === props.containerId);
  return container?.displayName || shortName(container?.id || props.containerId.slice(0, 12));
});

function instancesForType(appTypeId: string) {
  return instances.value.filter((i) => i.appType === appTypeId);
}

// Pass the component reference, not its name. Nuxt auto-imports handle
// statically-referenced components; dynamic `:is="'VsCodeAppRow'"` by string
// does not resolve in SPA builds, so the row silently rendered empty.
function rowComponentFor(appType: AppTypeInfo) {
  if (appType.id === 'vscode') return VsCodeAppRow;
  if (appType.id === 'ssh') return SshAppRow;
  return AppInstanceRow;
}

async function handleStart(appTypeId: string) {
  if (startingTypes.value.has(appTypeId)) return;
  startingTypes.value = new Set(startingTypes.value).add(appTypeId);
  try {
    await createInstance(appTypeId);
    if (appTypeId === 'vscode-desktop') {
      openTab(props.containerId, containerDisplayName.value, 'desktop');
    }
  } catch (err: any) {
    // Best-effort: ignore 409 (already running) — the poll will pick it up.
    if (err?.statusCode !== 409 && err?.response?.status !== 409) {
      console.error(`[apps] start ${appTypeId} failed`, err);
      toast.add({
        title: 'Failed to start app',
        description: err?.data?.statusMessage || err?.data?.message || err?.message || `Could not start ${appTypeId}`,
        color: 'error',
      });
    }
  } finally {
    const next = new Set(startingTypes.value);
    next.delete(appTypeId);
    startingTypes.value = next;
  }
}
function openInstalledPlugin(item: (typeof pluginActions.value)[number]) {
  openPluginTab(
    props.containerId,
    containerDisplayName.value,
    item.installation.id,
    item.action.id,
    `${item.definition.name}: ${item.action.label}`,
  );
}
function openPluginCatalog() {
  showPluginCatalog.value = true;
}
</script>

<template>
  <div class="h-full overflow-y-auto p-6 bg-white dark:bg-gray-950">
    <div class="mb-4 flex items-center justify-between gap-3">
      <h2 class="text-lg font-semibold text-gray-900 dark:text-white">Apps</h2>
      <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-puzzle" data-testid="manage-plugins" @click="openPluginCatalog">Plugins</UButton>
    </div>

    <div v-if="appTypes.length === 0" class="text-gray-400 dark:text-gray-500 text-sm text-center py-12">
      No app types available
    </div>

    <div class="space-y-4">
      <div
        v-for="at in appTypes"
        :key="at.id"
        class="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 overflow-hidden"
      >
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
          <div>
            <h3 class="text-sm font-medium text-gray-900 dark:text-white">{{ at.displayName }}</h3>
            <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{{ at.description }}</p>
          </div>
          <!-- Singleton apps: show "Start" only when no running instance. -->
          <UButton
            v-if="at.singleton && instancesForType(at.id).length === 0"
            size="xs"
            color="primary"
            variant="solid"
            :data-testid="`start-${at.id}`"
            :loading="startingTypes.has(at.id)"
            :disabled="startingTypes.has(at.id)"
            @click="handleStart(at.id)"
          >
            Start
          </UButton>
          <UButton
            v-else-if="!at.singleton"
            size="xs"
            color="primary"
            variant="solid"
            @click="handleStart(at.id)"
          >
            + New Instance
          </UButton>
        </div>

        <div v-if="instancesForType(at.id).length === 0" class="text-gray-400 dark:text-gray-500 text-xs text-center py-4">
          {{ at.singleton ? 'Not running' : 'No running instances' }}
        </div>

        <component
          :is="rowComponentFor(at)"
          v-for="inst in instancesForType(at.id)"
          :key="inst.id"
          :instance="inst"
          :app-type="at"
          :container-name="containerName"
          @stop="stopInstance"
        />
      </div>
      <section v-if="pluginActions.length" class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900" data-testid="installed-plugin-actions">
        <h3 class="mb-3 text-sm font-medium text-gray-900 dark:text-white">Installed plugin applications</h3>
        <div class="flex flex-wrap gap-2">
          <UButton v-for="item in pluginActions" :key="`${item.installation.id}-${item.action.id}`" size="sm" color="neutral" variant="outline" icon="i-lucide-puzzle" @click="openInstalledPlugin(item)">{{ item.definition.name }} · {{ item.action.label }}</UButton>
        </div>
      </section>
    </div>
    <PluginCatalogModal v-model:open="showPluginCatalog" :container-id="containerId" :container-name="containerDisplayName" />
  </div>
</template>
