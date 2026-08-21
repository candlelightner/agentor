import type { PluginDefinition, PluginInstallation } from '~/types';

/**
 * Dashboard contract (intentionally a small, credential-free view):
 *
 * GET    /api/plugins/definitions                         -> PluginDefinition[]
 * POST   /api/plugins/definitions { scope, groupId?, workerId?, manifest } -> PluginDefinition
 * PUT    /api/plugins/definitions/:id { manifest }        -> PluginDefinition
 * DELETE /api/plugins/definitions/:id                     -> { ok: true }
 *
 * GET    /api/containers/:id/plugins                      -> PluginInstallation[]
 * POST   /api/containers/:id/plugins { definitionId, desiredEnabled?, envKeys?, secretKeys? }
 *                                                        -> PluginInstallation
 * PUT    /api/containers/:id/plugins/:installationId/enabled { enabled } -> PluginInstallation
 * DELETE /api/containers/:id/plugins/:installationId      -> { ok: true }
 *
 * Icons are deliberately not embedded from a manifest. The server must serve
 * GET /api/plugins/definitions/:id/icon as image/svg+xml only after its SVG
 * sanitizer has accepted it; a missing icon returns 404 and the UI falls back.
 */
export function usePlugins(containerId?: Ref<string | undefined>) {
  const definitions = ref<PluginDefinition[]>([]);
  const installations = ref<PluginInstallation[]>([]);
  const loading = ref(false);
  const error = ref('');

  async function request<T>(url: string, options?: Parameters<typeof $fetch<T>>[1]) {
    return $fetch<T>(url, options);
  }
  async function refreshDefinitions() {
    const response = await request<unknown>('/api/plugins/definitions', {
      query: containerId?.value ? { workerId: containerId.value } : undefined,
    });
    definitions.value = Array.isArray(response)
      ? response.filter(isPluginDefinition)
      : [];
  }
  async function refreshInstallations() {
    if (!containerId?.value) { installations.value = []; return; }
    installations.value = await request<PluginInstallation[]>(`/api/containers/${containerId.value}/plugins`);
  }
  async function refresh() {
    loading.value = true; error.value = '';
    try { await Promise.all([refreshDefinitions(), refreshInstallations()]); }
    catch (cause: any) { error.value = cause?.data?.statusMessage || cause?.data?.message || 'Could not load plugins.'; }
    finally { loading.value = false; }
  }
  async function createDefinition(input: Pick<PluginDefinition, 'scope'> & { targetWorkerId?: string; groupId?: string; workerId?: string; manifest: PluginDefinition['manifest'] }) {
    const result = await request<PluginDefinition>('/api/plugins/definitions', { method: 'POST', body: input });
    await refreshDefinitions(); return result;
  }
  async function updateDefinition(id: string, manifest: PluginDefinition['manifest']) {
    const result = await request<PluginDefinition>(`/api/plugins/definitions/${encodeURIComponent(id)}`, { method: 'PUT', body: { manifest } });
    await refreshDefinitions(); return result;
  }
  async function duplicateDefinition(id: string) {
    const source = definitions.value.find(item => item.id === id);
    if (!source) throw new Error('Plugin definition not found');
    const manifest = structuredClone(source.manifest);
    manifest.name = `${manifest.name} copy`;
    manifest.slug = `${manifest.slug.replace(/-copy(?:-\d+)?$/, '')}-copy-${Date.now().toString(36)}`.slice(0, 64);
    const result = await request<PluginDefinition>('/api/plugins/definitions', {
      method: 'POST', body: { scope: 'owner', targetWorkerId: containerId?.value, manifest },
    });
    await refreshDefinitions(); return result;
  }
  async function deleteDefinition(id: string) {
    await request(`/api/plugins/definitions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await refreshDefinitions();
  }
  async function install(definitionId: string) {
    if (!containerId?.value) return;
    const definition = definitions.value.find(item => item.id === definitionId);
    await request<PluginInstallation>(`/api/containers/${containerId.value}/plugins`, {
      method: 'POST',
      body: {
        definitionId,
        desiredEnabled: true,
        envKeys: definition?.manifest.environment?.envKeys ?? [],
        secretKeys: definition?.manifest.environment?.secretKeys ?? [],
      },
    });
    await refreshInstallations();
  }
  async function setEnabled(installationId: string, desiredEnabled: boolean) {
    if (!containerId?.value) return;
    await request<PluginInstallation>(`/api/containers/${containerId.value}/plugins/${encodeURIComponent(installationId)}/enabled`, { method: 'PUT', body: { enabled: desiredEnabled } });
    await refreshInstallations();
  }
  async function removeInstallation(installationId: string) {
    if (!containerId?.value) return;
    await request(`/api/containers/${containerId.value}/plugins/${encodeURIComponent(installationId)}`, { method: 'DELETE' });
    await refreshInstallations();
  }
  const { start, stop } = usePolling(() => void refreshInstallations().catch(() => {}), 5_000);
  watch(containerId ?? ref(undefined), () => { void refresh(); start(); }, { immediate: true });
  if (!containerId) void refreshDefinitions().catch(() => {});
  return { definitions, installations, loading, error, refresh, createDefinition, updateDefinition, duplicateDefinition, deleteDefinition, install, setEnabled, removeInstallation, stop };
}

/** Keep an invalid/stale API record from breaking the catalog render. */
function isPluginDefinition(value: unknown): value is PluginDefinition {
  if (!value || typeof value !== 'object') return false;
  const definition = value as Partial<PluginDefinition>;
  return typeof definition.id === 'string'
    && typeof definition.name === 'string'
    && typeof definition.scope === 'string'
    && !!definition.manifest
    && typeof definition.manifest === 'object'
    && typeof definition.manifest.version === 'string'
    && typeof definition.manifest.description === 'string';
}
