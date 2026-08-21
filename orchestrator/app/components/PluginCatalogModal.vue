<script setup lang="ts">
import type { PluginDefinition, PluginManifest } from '~/types';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ containerId: string; containerName: string }>();
const { isAdmin } = useAuth();
const { openPluginTab } = useSplitPanes();
const {
  definitions,
  installations,
  loading,
  error: apiError,
  refresh,
  createDefinition,
  updateDefinition,
  duplicateDefinition,
  deleteDefinition,
  install,
  setEnabled,
  removeInstallation,
  stop,
} = usePlugins(toRef(props, 'containerId'));
const busy = ref('');
const formError = ref('');
const editingId = ref<string | null>(null);
const manifestText = ref('');
const scope = ref<PluginDefinition['scope']>('owner');
const iconFailures = ref(new Set<string>());

watch(open, shown => { if (shown) void refresh(); });
onBeforeUnmount(stop);
const byDefinition = computed(() => new Map(definitions.value.map(d => [d.id, d])));
const installedDefinitionIds = computed(() => new Set(installations.value.map(i => i.definitionId)));
function iconSource(definition: PluginDefinition) { return `/api/plugins/definitions/${encodeURIComponent(definition.id)}/icon`; }
function markIconFailure(id: string) { iconFailures.value = new Set(iconFailures.value).add(id); }
function defaultManifest(): PluginManifest {
  return { schemaVersion: 1, name: '', slug: '', description: '', version: '0.1.0', lifecycle: { start: { argv: [] } } };
}
function edit(definition?: PluginDefinition) {
  editingId.value = definition?.id ?? null;
  scope.value = definition?.scope ?? 'owner';
  manifestText.value = JSON.stringify(definition?.manifest ?? defaultManifest(), null, 2);
  formError.value = '';
}
async function run(key: string, operation: () => Promise<unknown>) {
  if (busy.value) return; busy.value = key; formError.value = '';
  try { await operation(); } catch (cause: any) { formError.value = cause?.data?.statusMessage || cause?.data?.message || 'Plugin operation failed.'; }
  finally { busy.value = ''; }
}
function saveDefinition() {
  return run('save', async () => {
    let manifest: PluginManifest;
    try { manifest = JSON.parse(manifestText.value) as PluginManifest; }
    catch { formError.value = 'Manifest must be valid JSON.'; return; }
    if (editingId.value) await updateDefinition(editingId.value, manifest);
    else await createDefinition({
      scope: scope.value,
      manifest,
      ...(scope.value === 'owner' ? { targetWorkerId: props.containerId } : {}),
      ...(scope.value === 'worker' ? { workerId: props.containerId } : {}),
    });
    editingId.value = null;
  });
}
function actionOpen(installationId: string, action: { id: string; label: string }, definition: PluginDefinition) {
  openPluginTab(props.containerId, props.containerName, installationId, action.id, `${definition.name}: ${action.label}`);
  open.value = false;
}
function close() { open.value = false; }
function cancelEdit() { editingId.value = null; manifestText.value = ''; }
function installDefinition(definitionId: string) { return run(`install-${definitionId}`, () => install(definitionId)); }
function duplicate(definitionId: string) { return run(`duplicate-${definitionId}`, () => duplicateDefinition(definitionId)); }
function removeDefinition(definitionId: string) { return run(`delete-${definitionId}`, () => deleteDefinition(definitionId)); }
function toggleInstallation(installationId: string, desiredEnabled: boolean) { return run(`toggle-${installationId}`, () => setEnabled(installationId, !desiredEnabled)); }
function remove(installationId: string) { return run(`remove-${installationId}`, () => removeInstallation(installationId)); }
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-6xl' }">
    <template #content>
      <div class="max-h-[90vh] overflow-y-auto p-6 space-y-5" data-testid="plugin-catalog">
        <header class="flex items-start justify-between gap-4">
          <div><h2 class="text-lg font-semibold">Plugins</h2><p class="text-xs text-gray-500">Install reusable worker applications and open their private interfaces in a sandboxed pane.</p></div>
          <UButton aria-label="Close" variant="ghost" icon="i-lucide-x" @click="close" />
        </header>
        <p v-if="apiError || formError" role="alert" class="text-sm text-red-600">{{ formError || apiError }}</p>
        <div class="grid gap-5 lg:grid-cols-2">
          <section class="space-y-3">
            <div class="flex items-center justify-between"><h3 class="font-medium">Catalog</h3><UButton size="xs" icon="i-lucide-plus" @click="edit()">New definition</UButton></div>
            <p v-if="!definitions.length && !loading" class="text-sm text-gray-500">No plugin definitions available.</p>
            <article v-for="definition in definitions" :key="definition.id" class="rounded border p-3 space-y-2">
              <div class="flex gap-3"><img v-if="!iconFailures.has(definition.id)" :src="iconSource(definition)" class="size-9 rounded object-contain bg-gray-100 p-1" alt="" @error="markIconFailure(definition.id)" /><UIcon v-else name="i-lucide-puzzle" class="size-9 rounded bg-gray-100 p-2 text-gray-500" aria-label="Default plugin icon" /><div class="min-w-0 flex-1"><div class="flex items-center gap-2"><b>{{ definition.name }}</b><span class="text-xs text-gray-500">v{{ definition.manifest?.version ?? 'unknown' }} · {{ definition.scope }}</span></div><p class="text-xs text-gray-500">{{ definition.manifest?.description ?? '' }}</p></div></div>
              <div class="flex flex-wrap gap-2"><UButton v-if="!installedDefinitionIds.has(definition.id)" size="xs" :loading="busy === `install-${definition.id}`" @click="installDefinition(definition.id)">Install</UButton><span v-else class="text-xs text-emerald-700 dark:text-emerald-400">Installed</span><UButton size="xs" color="neutral" variant="outline" @click="edit(definition)">Edit</UButton><UButton size="xs" color="neutral" variant="outline" @click="duplicate(definition.id)">Duplicate</UButton><UButton v-if="!definition.builtIn" size="xs" color="error" variant="outline" @click="removeDefinition(definition.id)">Delete</UButton></div>
            </article>
          </section>
          <section class="space-y-3"><h3 class="font-medium">Installed on this worker</h3><p v-if="!installations.length" class="text-sm text-gray-500">No plugins installed on this worker.</p>
            <article v-for="installation in installations" :key="installation.id" class="rounded border p-3 space-y-2"><div class="flex justify-between gap-2"><div><b>{{ byDefinition.get(installation.definitionId)?.name || 'Unavailable plugin' }}</b><p class="text-xs text-gray-500">{{ installation.observed.state }}<template v-if="installation.observed.error"> · {{ installation.observed.error.message }}</template></p></div><span :class="installation.observed.ready ? 'text-emerald-600' : 'text-amber-600'" class="text-xs">{{ installation.observed.ready ? 'Ready' : 'Not ready' }}</span></div><div class="flex flex-wrap gap-2"><UButton size="xs" :loading="busy === `toggle-${installation.id}`" @click="toggleInstallation(installation.id, installation.desiredEnabled)">{{ installation.desiredEnabled ? 'Disable' : 'Enable' }}</UButton><UButton size="xs" color="error" variant="outline" @click="remove(installation.id)">Remove</UButton><UButton v-for="action in byDefinition.get(installation.definitionId)?.manifest?.actions || []" :key="action.id" size="xs" color="neutral" variant="outline" :disabled="!installation.observed.ready" @click="actionOpen(installation.id, action, byDefinition.get(installation.definitionId)!)">{{ action.label }}</UButton></div></article>
          </section>
        </div>
        <section v-if="editingId !== null || manifestText" class="space-y-2 border-t pt-4"><div class="flex gap-2 items-center"><h3 class="font-medium">{{ editingId ? 'Edit definition' : 'New definition' }}</h3><select v-if="!editingId" v-model="scope" class="rounded border p-1 text-sm" aria-label="Plugin scope"><option value="owner">Worker owner</option><option value="worker">This worker only</option><option v-if="isAdmin" value="platform">Platform</option></select></div><textarea v-model="manifestText" class="min-h-56 w-full rounded border p-2 font-mono text-xs" aria-label="Plugin manifest JSON" /><div class="flex gap-2"><UButton size="sm" :loading="busy === 'save'" @click="saveDefinition">Save definition</UButton><UButton size="sm" color="neutral" variant="outline" @click="cancelEdit">Cancel</UButton></div></section>
      </div>
    </template>
  </UModal>
</template>
