<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: []; testWorker: [workerId: string] }>();
const api = useImageCatalog();
const { groups: workerGroups } = useWorkerGroups();
const form = reactive({
  name: "",
  description: "",
  baseImage: "agentor-worker:approved-latest",
  provisioning: [] as Array<any>,
  // Existing definitions intentionally omit this field; omission remains Safe.
  provisioningMode: "safe" as "safe" | "advanced",
  pluginComposition: [] as Array<{
    definitionId: string;
    validation: "required" | "optional";
  }>,
  dockerfileFragment: "",
  contextFiles: [] as Array<{
    path: string;
    contentBase64: string;
    role: "asset" | "script";
    destination: string;
  }>,
});
const selected = ref(""),
  busy = ref(""),
  actionError = ref(""),
  rebuildBase = ref("agentor-worker:approved-latest");
const editingId = ref("");
const expandedLogs = reactive<Record<string, boolean>>({});
const testJobs = reactive<
  Record<string, { status?: string; workerId?: string; message?: string }>
>({});
const git = reactive({
  repository: "",
  visibility: "private" as "public" | "private",
  authType: "pat" as "none" | "pat" | "github-app",
  token: "",
  appId: "",
  installationId: "",
  workflow: "pull-request" as "direct" | "branch" | "pull-request",
  buildMode: "local" as "local" | "github-actions",
  publishGhcr: false,
});
watch(open, (shown) => (shown ? api.start() : api.stop()));
onBeforeUnmount(api.stop);
const current = computed(
  () =>
    api.definitions.value.find((d) => d.id === selected.value) ||
    api.definitions.value[0],
);
async function run(key: string, fn: () => Promise<any>) {
  // Vue updates the loading state on the next render. Guard synchronously as
  // well so a double-click cannot enqueue two builds before the button disables.
  if (busy.value) return;
  busy.value = key;
  actionError.value = "";
  try {
    return await fn();
  } catch (e: any) {
    const structured = diagnosticText(
      e?.data?.data?.diagnostic || e?.data?.diagnostic,
    );
    actionError.value = [
      e?.data?.statusMessage || e?.message || "Image operation failed.",
      structured,
    ]
      .filter(
        (value, index, values) => value && values.indexOf(value) === index,
      )
      .join(" ");
  } finally {
    busy.value = "";
  }
}
async function files(e: Event) {
  for (const f of Array.from((e.target as HTMLInputElement).files || [])) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    form.contextFiles.push({
      path: f.webkitRelativePath || f.name,
      contentBase64: btoa(binary),
      role: "asset",
      destination: `/opt/agentor-context/${f.webkitRelativePath || f.name}`,
    });
  }
}
async function create() {
  // The package-manager selector is rendered even when no packages were
  // entered. Do not persist that UI-only placeholder as an invalid empty
  // provisioning step.
  const definition = {
    ...form,
    // Advanced is structured-only. When an operator explicitly upgrades a
    // legacy Safe definition in the GUI, do not carry its hidden raw fragment
    // across the boundary; the visible structured recipe becomes authoritative.
    dockerfileFragment:
      form.provisioningMode === "advanced" ? "" : form.dockerfileFragment,
    provisioning: form.provisioning.filter(
      (step) => step.type !== "packages" || step.packages?.length,
    ),
  };
  const d = await run(editingId.value ? "update" : "create", () =>
    editingId.value
      ? api.update(editingId.value, definition as any)
      : api.create(definition as any),
  );
  if (d) {
    selected.value = d.id;
    Object.assign(form, {
      name: "",
      description: "",
      dockerfileFragment: "",
      contextFiles: [],
      provisioning: [],
      provisioningMode: "safe",
      pluginComposition: [],
    });
    editingId.value = "";
    emit("changed");
  }
}
function edit(d: any) {
  editingId.value = d.id;
  Object.assign(form, {
    name: d.name,
    description: d.description || "",
    baseImage: d.baseImage,
    dockerfileFragment: d.dockerfileFragment || "",
    contextFiles: (d.contextFiles || []).map((file: any) => ({
      ...file,
      role: file.role || "asset",
      destination: file.destination || `/opt/agentor-context/${file.path}`,
    })),
    provisioning: (d.provisioning || []).map((step: any) => ({ ...step })),
    provisioningMode: d.provisioningMode || "safe",
    pluginComposition: (d.pluginComposition || []).map((item: any) => ({
      definitionId: item.definitionId,
      validation:
        item.validation || (item.required === false ? "optional" : "required"),
    })),
  });
}
function cancelEdit() {
  editingId.value = "";
  Object.assign(form, {
    name: "",
    description: "",
    baseImage: "agentor-worker:approved-latest",
    dockerfileFragment: "",
    contextFiles: [],
    provisioning: [],
    provisioningMode: "safe",
    pluginComposition: [],
  });
}
function packageStep() {
  let step = form.provisioning.find((value) => value.type === "packages");
  if (!step) {
    step = { type: "packages", manager: "apt", packages: [] };
    form.provisioning.unshift(step);
  }
  return step;
}
function setPackages(event: Event) {
  const step = packageStep();
  step.packages = (event.target as HTMLInputElement).value
    .split(/\s+/)
    .filter(Boolean);
}
function setCommand(event: Event) {
  const value = (event.target as HTMLTextAreaElement).value.trim();
  form.provisioning = form.provisioning.filter(
    (step) => step.type !== "command",
  );
  if (value) form.provisioning.push({ type: "command", command: value });
}
function syncContextScript(file: { path: string; role: "asset" | "script" }) {
  form.provisioning = form.provisioning.filter(
    (step) => step.type !== "script" || step.path !== file.path,
  );
  if (file.role === "script")
    form.provisioning.push({
      type: "script",
      path: file.path,
      interpreter: "bash",
    });
}
async function testWorker(d: string, v: string) {
  const r: any = await run(`test-${d}-${v}`, () =>
    api.testWorker(d, v, crypto.randomUUID()),
  );
  // Older servers return an ordinary worker immediately. Newer servers return
  // an accepted job: do not open a worker card until its creation succeeded.
  if (r?.workerId) return emit("testWorker", r.workerId);
  if (r?.id || r?.jobId) {
    const jobId = r.jobId || r.id;
    testJobs[jobId] = {
      status: r.status || "queued",
      message: "Test worker requested",
    };
    void pollTestWorker(jobId);
  }
}
async function pollTestWorker(jobId: string) {
  try {
    const job = await api.testWorkerStatus(jobId);
    testJobs[jobId] = job;
    if (job?.status === "succeeded" && job?.workerId)
      emit("testWorker", job.workerId);
    else if (["queued", "running"].includes(job?.status))
      setTimeout(() => void pollTestWorker(jobId), 1_000);
  } catch (e: any) {
    testJobs[jobId] = {
      status: "failed",
      message: e?.data?.statusMessage || "Could not create test worker.",
    };
  }
}
function pluginName(plugin: any) {
  return (
    plugin?.manifest?.name ||
    plugin?.name ||
    plugin?.manifest?.slug ||
    plugin?.id
  );
}
const imageBuildPlugins = computed(() =>
  api.plugins.value.filter((plugin: any) =>
    Boolean(plugin?.imageBuild || plugin?.manifest?.imageBuild),
  ),
);
function pluginRequiresAdvanced(plugin: any) {
  return Boolean(
    plugin?.imageBuild?.requiresAdvancedProvisioning ||
    plugin?.manifest?.imageBuild?.requiresAdvancedProvisioning ||
    plugin?.manifest?.image?.requiresAdvancedProvisioning,
  );
}
function pluginDefaultValidation(plugin: any): "required" | "optional" {
  const required =
    plugin?.imageBuild?.validation?.defaultRequired ??
    plugin?.manifest?.imageBuild?.validation?.defaultRequired;
  return required === false ? "optional" : "required";
}
function selectedPlugin(id: string) {
  return form.pluginComposition.find((entry) => entry.definitionId === id);
}
function newRequestId(prefix: string) {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}
function setPluginRequired(id: string, event: Event) {
  const item = selectedPlugin(id);
  if (item)
    item.validation = (event.target as HTMLSelectElement).value as
      "required" | "optional";
}
function requiresAdvancedComposition() {
  return form.pluginComposition.some((item) =>
    pluginRequiresAdvanced(
      api.plugins.value.find((plugin) => plugin.id === item.definitionId),
    ),
  );
}
function togglePlugin(plugin: any, event: Event) {
  const checked = (event.target as HTMLInputElement).checked;
  form.pluginComposition = form.pluginComposition.filter(
    (entry) => entry.definitionId !== plugin.id,
  );
  if (checked)
    form.pluginComposition.push({
      definitionId: plugin.id,
      validation: pluginDefaultValidation(plugin),
    });
}
function versionState(v: any) {
  const raw = String(
    v?.readiness ||
      v?.compatibility?.state ||
      v?.compatibility?.status ||
      "ready",
  ).toLowerCase();
  if (raw.includes("warning"))
    return { key: "warnings", label: "Ready with warnings", icon: "⚠" };
  if (raw.includes("incompat"))
    return { key: "incompatible", label: "Built but incompatible", icon: "⚠" };
  if (raw.includes("unavailable") || raw.includes("unknown"))
    return { key: "unavailable", label: "Validation unavailable", icon: "?" };
  if (raw.includes("validat") || raw.includes("pending"))
    return { key: "validating", label: "Built — validating", icon: "◌" };
  if (raw.includes("cancel"))
    return { key: "cancelled", label: "Cancelled", icon: "×" };
  return { key: "ready", label: "Ready", icon: "✓" };
}
function buildState(b: any) {
  const phase = String(b?.phase || "").toLowerCase(),
    status = String(b?.status || "").toLowerCase(),
    outcome = String(b?.outcome || b?.compatibility?.state || "").toLowerCase();
  if (
    b?.diagnostic ||
    status.includes("blocked") ||
    status.includes("invalid")
  ) {
    const code = b?.diagnostic?.code || b?.diagnostic?.kind;
    return {
      key: "blocked",
      label:
        code === "invalid-build-context"
          ? "Invalid build context"
          : code === "invalid-definition"
            ? "Invalid definition"
            : "Blocked by Safe mode",
      icon: "⊘",
    };
  }
  if (status.includes("cancel"))
    return { key: "cancelled", label: "Cancelled", icon: "×" };
  if (outcome.includes("incompat"))
    return { key: "incompatible", label: "Built but incompatible", icon: "⚠" };
  if (outcome.includes("unavailable"))
    return { key: "unavailable", label: "Validation unavailable", icon: "?" };
  if (outcome.includes("warning"))
    return { key: "warnings", label: "Ready with warnings", icon: "⚠" };
  if (phase.includes("validat") && !status.includes("failed"))
    return { key: "validating", label: "Built — validating", icon: "◌" };
  if (status.includes("fail"))
    return { key: "failed", label: "Build failed", icon: "×" };
  if (status.includes("queue"))
    return { key: "queued", label: "Queued", icon: "◌" };
  if (status.includes("run") || phase.includes("build"))
    return { key: "building", label: "Building", icon: "◌" };
  return { key: "ready", label: "Ready", icon: "✓" };
}
function usable(v: any) {
  return ["ready", "warnings"].includes(versionState(v).key);
}
function diagnosticText(diagnostic: any) {
  if (!diagnostic) return "";
  const safeMode =
    diagnostic.code === "safe-mode-blocked" ||
    diagnostic.kind === "safe-mode-blocked";
  return [
    diagnostic.blockedStep &&
      `Blocked: ${typeof diagnostic.blockedStep === "object" ? `${diagnostic.blockedStep.type} step ${diagnostic.blockedStep.index}` : diagnostic.blockedStep}.`,
    diagnostic.blockedField && `Blocked: ${diagnostic.blockedField}.`,
    diagnostic.constraint &&
      `${safeMode ? "Safe-mode constraint" : "Constraint"}: ${diagnostic.constraint}.`,
    diagnostic.reason,
    diagnostic.remediation && `Try: ${diagnostic.remediation}.`,
    (diagnostic.advancedAvailable || diagnostic.advancedModeAvailable) &&
      "Advanced provisioning is available for deliberate unrestricted build-time shell behavior. It can make the derived worker image unusable, but does not grant host access.",
  ]
    .filter(Boolean)
    .join(" ");
}
async function connectGit() {
  await run("git-connect", () =>
    api.connectGit({
      provider: "github",
      repository: git.repository,
      visibility: git.visibility,
      workflow: git.workflow,
      buildMode: git.buildMode,
      publishGhcr: git.publishGhcr,
      auth:
        git.authType === "github-app"
          ? {
              type: "github-app",
              appId: git.appId,
              installationId: git.installationId,
            }
          : git.visibility === "public" && git.authType === "none"
            ? { type: "none" }
            : { type: "pat", token: git.token },
    }),
  );
  git.token = "";
}
const fmt = (n: number) => formatBytes(n);
function catalogScope(groupId?: string) {
  if (!groupId) return "Global catalog";
  const byId = new Map(workerGroups.value.map((item) => [item.id, item]));
  const group = byId.get(groupId);
  if (!group) return `Worker group: ${groupId}`;
  const path = [group.name];
  const seen = new Set([group.id]);
  let parentId = group.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    path.unshift(parent.name);
    parentId = parent.parentId;
  }
  return `Worker group: ${path.join(" / ")}`;
}
function close() {
  open.value = false;
}
</script>
<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-7xl' }"
    ><template #content
      ><div
        class="p-6 space-y-5 max-h-[90vh] overflow-y-auto"
        data-testid="image-catalog"
      >
        <header class="flex justify-between">
          <div>
            <h2 class="text-lg font-semibold">Custom image catalog</h2>
            <p class="text-xs text-gray-500">
              Build only from approved Agentor bases. Variables and secrets are
              never included in contexts or image layers.
            </p>
          </div>
          <UButton
            aria-label="Close"
            variant="ghost"
            icon="i-lucide-x"
            @click="close"
          />
        </header>
        <p
          v-if="api.error.value || actionError"
          role="alert"
          aria-live="assertive"
          class="text-red-600"
        >
          {{ api.error.value || actionError }}
        </p>
        <section
          class="border rounded p-4 space-y-3"
          data-testid="git-image-catalog"
        >
          <div class="flex justify-between gap-3">
            <div>
              <h3 class="font-medium">GitHub catalog and disaster recovery</h3>
              <p class="text-xs text-gray-500">
                Optional image-definition source of truth. This does not back up
                workspace data, and repository credentials never enter builds or
                workers.
              </p>
            </div>
            <UButton
              v-if="api.gitConnection.value.repository"
              size="xs"
              color="error"
              variant="outline"
              :loading="busy === 'git-disconnect'"
              @click="run('git-disconnect', api.disconnectGit)"
              >Disconnect and erase credential</UButton
            >
          </div>
          <div
            v-if="!api.gitConnection.value.repository"
            class="grid md:grid-cols-6 gap-2"
          >
            <input
              v-model="git.repository"
              class="border rounded p-2 md:col-span-2"
              placeholder="owner/repository"
              aria-label="GitHub repository"
            />
            <select v-model="git.visibility" class="border rounded p-2">
              <option value="private">Private</option>
              <option value="public">Public</option>
            </select>
            <select v-model="git.workflow" class="border rounded p-2">
              <option value="pull-request">Pull request</option>
              <option value="branch">Branch</option>
              <option value="direct">Direct</option>
            </select>
            <select v-model="git.authType" class="border rounded p-2">
              <option value="pat">Fine-grained PAT</option>
              <option value="github-app">GitHub App</option>
              <option v-if="git.visibility === 'public'" value="none">
                Public, no token
              </option>
            </select>
            <input
              v-if="git.authType === 'pat'"
              v-model="git.token"
              type="password"
              autocomplete="off"
              class="border rounded p-2"
              placeholder="Fine-grained PAT"
              aria-label="Fine-grained GitHub token"
            />
            <div v-else-if="git.authType === 'github-app'" class="flex gap-1">
              <input
                v-model="git.appId"
                class="min-w-0 border rounded p-2"
                placeholder="App ID"
              /><input
                v-model="git.installationId"
                class="min-w-0 border rounded p-2"
                placeholder="Installation ID"
              />
            </div>
            <UButton
              :disabled="
                !git.repository ||
                (git.authType === 'pat' && !git.token) ||
                (git.authType === 'github-app' &&
                  (!git.appId || !git.installationId))
              "
              :loading="busy === 'git-connect'"
              @click="connectGit"
              >Connect</UButton
            >
            <label class="text-xs flex gap-2 md:col-span-2"
              ><input v-model="git.publishGhcr" type="checkbox" /> Publish
              immutable images to GHCR</label
            >
            <select
              v-model="git.buildMode"
              class="border rounded p-2 md:col-span-2"
            >
              <option value="local">Build locally</option>
              <option value="github-actions">Build with GitHub Actions</option>
            </select>
          </div>
          <div v-else class="flex flex-wrap gap-2 items-center text-sm">
            <b>{{ api.gitConnection.value.repository }}</b
            ><span
              >{{ api.gitConnection.value.workflow }} ·
              {{ api.gitConnection.value.buildMode }}</span
            >
            <UButton
              size="xs"
              :loading="busy === 'git-push'"
              @click="run('git-push', () => api.syncGit('push'))"
              >Sync local changes</UButton
            >
            <UButton
              size="xs"
              variant="outline"
              :loading="busy === 'git-pull'"
              @click="run('git-pull', () => api.syncGit('pull'))"
              >Recover / pull</UButton
            >
            <UButton
              v-if="api.gitSyncResult.value?.conflicts?.length"
              size="xs"
              color="warning"
              @click="run('git-copy', () => api.syncGit('pull', 'remote-copy'))"
              >Keep local and import remote copies</UButton
            >
          </div>
          <p v-if="api.gitRecovery.value" class="text-xs">
            Recovery: {{ api.gitRecovery.value.state }} ·
            {{ api.gitRecovery.value.catalogEntries || 0 }} definitions ·
            {{ api.gitRecovery.value.imageDigests || 0 }} immutable digests.
            {{ api.gitRecovery.value.note }}
          </p>
          <p
            v-if="api.gitSyncResult.value?.conflicts?.length"
            class="text-xs text-amber-700"
          >
            Conflicts were preserved; no local definition was overwritten.
          </p>
        </section>
        <div class="grid lg:grid-cols-3 gap-5">
          <section class="space-y-2">
            <h3 class="font-medium">New image definition</h3>
            <input
              v-model="form.name"
              class="w-full border rounded p-2"
              placeholder="Definition name"
            /><textarea
              v-model="form.description"
              class="w-full border rounded p-2"
              placeholder="Description"
            /><input
              v-model="form.baseImage"
              class="w-full border rounded p-2"
              aria-label="Approved base image"
            />
            <div
              class="space-y-2 border rounded p-2"
              data-testid="image-provisioning"
            >
              <label class="block text-sm font-medium"
                >Provisioning mode
                <select
                  v-model="form.provisioningMode"
                  class="w-full border rounded p-1"
                  aria-label="Provisioning mode"
                  data-testid="image-provisioning-mode"
                >
                  <option value="safe">Safe mode (recommended)</option>
                  <option value="advanced">Advanced provisioning</option>
                </select>
              </label>
              <p
                v-if="form.provisioningMode === 'safe'"
                class="text-xs text-gray-600"
              >
                Safe mode preserves the Agentor worker-image contract and
                rejects risky build steps with a safe rewrite where possible.
                Existing definitions stay in Safe mode unless you explicitly
                change them.
              </p>
              <p
                v-else
                class="text-xs text-amber-800"
                data-testid="advanced-provisioning-warning"
              >
                Advanced provisioning permits arbitrary shell commands only
                inside Agentor's controlled Docker/BuildKit build. Agentor still
                fixes the approved base image and generated Dockerfile boundary:
                this is not host access, a Docker socket, arbitrary bases, or a
                full Dockerfile. A command may make the derived worker image
                unusable and it will be checked after build.
              </p>
              <div class="flex gap-2">
                <select
                  v-model="packageStep().manager"
                  class="border rounded p-1"
                >
                  <option value="apt">apt</option>
                  <option value="npm">npm</option>
                  <option value="pip">pip</option></select
                ><input
                  class="flex-1 border rounded p-1"
                  placeholder="Pinned packages (space separated)"
                  @change="setPackages"
                />
              </div>
              <textarea
                rows="3"
                class="w-full border rounded p-1 font-mono"
                placeholder="Optional shell setup command"
                @change="setCommand"
              />
              <p class="text-xs text-gray-500">
                Provisioning is server-rendered from pinned package installs,
                explicit commands, and uploaded context scripts. Secrets are
                rejected.
              </p>
            </div>
            <label class="block"
              >Build context files<input
                type="file"
                multiple
                class="block"
                @change="files"
            /></label>
            <ul class="text-xs">
              <li
                v-for="f in form.contextFiles"
                :key="f.path"
                class="flex gap-2"
              >
                <span>{{ f.path }}</span
                ><select
                  v-model="f.role"
                  aria-label="Context file role"
                  @change="syncContextScript(f)"
                >
                  <option value="asset">asset</option>
                  <option value="script">script (run)</option></select
                ><input
                  v-model="f.destination"
                  aria-label="Context file destination"
                  class="border rounded px-1"
                />
              </li>
            </ul>
            <fieldset
              v-if="imageBuildPlugins.length"
              class="border rounded p-2 space-y-2"
              data-testid="image-plugin-composition"
            >
              <legend class="px-1 text-sm font-medium">
                Bake reusable plugin installation into this image
              </legend>
              <p class="text-xs text-gray-500">
                Only the selected plugin's build/install contribution is baked.
                Worker secrets, ports, displays, GUI sessions, and instance
                state remain runtime allocations.
              </p>
              <label
                v-for="plugin in imageBuildPlugins"
                :key="plugin.id"
                class="flex items-start gap-2 text-sm"
              >
                <input
                  type="checkbox"
                  :checked="Boolean(selectedPlugin(plugin.id))"
                  :aria-label="`Bake plugin ${pluginName(plugin)}`"
                  @change="togglePlugin(plugin, $event)"
                />
                <span class="flex-1"
                  ><b>{{ pluginName(plugin) }}</b
                  ><span
                    v-if="pluginRequiresAdvanced(plugin)"
                    class="ml-1 text-amber-800"
                    >Requires Advanced provisioning</span
                  ><br /><small>{{
                    plugin.manifest?.description || plugin.description
                  }}</small></span
                >
                <select
                  v-if="selectedPlugin(plugin.id)"
                  :value="selectedPlugin(plugin.id)?.validation || 'required'"
                  :aria-label="`Plugin requirement for ${pluginName(plugin)}`"
                  @change="setPluginRequired(plugin.id, $event)"
                >
                  <option value="required">Required</option>
                  <option value="optional">Optional</option>
                </select>
              </label>
              <p
                v-if="
                  requiresAdvancedComposition() &&
                  form.provisioningMode !== 'advanced'
                "
                class="text-xs text-amber-800"
                role="status"
              >
                A selected plugin requires Advanced provisioning. Select it
                explicitly before building; Agentor will never switch modes
                silently.
              </p>
            </fieldset>
            <UButton
              :disabled="
                !form.name ||
                !form.baseImage ||
                (requiresAdvancedComposition() &&
                  form.provisioningMode !== 'advanced')
              "
              :loading="busy === 'create' || busy === 'update'"
              @click="create"
              :aria-label="
                editingId ? 'Save image definition' : 'Create image definition'
              "
              >{{
                editingId ? "Save definition" : "Create definition"
              }}</UButton
            >
            <UButton v-if="editingId" variant="ghost" @click="cancelEdit"
              >Cancel edit</UButton
            >
          </section>
          <section class="lg:col-span-2">
            <div class="flex justify-between mb-2">
              <h3 class="font-medium">Definitions and versions</h3>
              <span
                >Storage: {{ fmt(api.usage.value.totalBytes) }} (partials
                {{ fmt(api.usage.value.partialBuildBytes) }})</span
              >
            </div>
            <div v-if="!api.definitions.value.length" class="text-gray-500">
              No custom images.
            </div>
            <article
              v-for="d in api.definitions.value"
              :key="d.id"
              class="border rounded p-3 mb-3"
            >
              <div class="flex justify-between">
                <div>
                  <div class="flex flex-wrap items-center gap-2">
                    <b>{{ d.name }}</b>
                    <span
                      class="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                      data-testid="image-catalog-scope"
                      >{{ catalogScope(d.groupId) }}</span
                    >
                  </div>
                  <p class="text-xs">{{ d.description }} · {{ d.baseImage }}</p>
                </div>
                <div>
                  <UButton
                    type="button"
                    size="xs"
                    :loading="busy === d.id"
                    @click="run(d.id, () => api.startBuild(d.id))"
                    >Build</UButton
                  >
                  <UButton
                    size="xs"
                    variant="ghost"
                    :aria-label="`Edit ${d.name}`"
                    @click="edit(d)"
                    >Edit</UButton
                  >
                  <UButton
                    size="xs"
                    color="error"
                    variant="ghost"
                    @click="run(d.id, () => api.removeDefinition(d.id))"
                    >Delete</UButton
                  >
                </div>
              </div>
              <div class="flex gap-2 mt-2">
                <input
                  v-model="rebuildBase"
                  class="border rounded p-1 text-xs"
                  aria-label="New approved base"
                /><UButton
                  size="xs"
                  variant="outline"
                  @click="
                    run('rebuild', () => api.startBuild(d.id, rebuildBase))
                  "
                  >Rebuild newer base</UButton
                >
              </div>
              <table v-if="d.versions.length" class="w-full text-xs mt-3">
                <tbody>
                  <tr v-for="v in d.versions" :key="v.version" class="border-t">
                    <td class="py-2">
                      <b>{{ v.version }}</b>
                      <span v-if="v.promoted">promoted</span><br /><code>{{
                        v.digest
                      }}</code>
                      <p
                        class="mt-1"
                        :class="
                          versionState(v).key === 'incompatible' ||
                          versionState(v).key === 'unavailable'
                            ? 'text-amber-800'
                            : ''
                        "
                        :data-testid="`image-version-status-${v.version}`"
                      >
                        <span aria-hidden="true">{{
                          versionState(v).icon
                        }}</span>
                        {{ versionState(v).label }}
                      </p>
                      <p
                        v-if="
                          v.compatibility?.warnings?.length ||
                          v.warnings?.length
                        "
                        class="text-amber-800"
                      >
                        Warnings:
                        {{
                          (v.compatibility?.warnings || v.warnings || []).join(
                            "; ",
                          )
                        }}
                      </p>
                      <details v-if="v.compatibility">
                        <summary>Compatibility details</summary>
                        <ul class="list-disc pl-4">
                          <li
                            v-for="check in [
                              ...(Array.isArray(v.compatibility.checks)
                                ? v.compatibility.checks
                                : []),
                              ...(Array.isArray(v.compatibility.requiredChecks)
                                ? v.compatibility.requiredChecks
                                : []),
                              ...(Array.isArray(v.compatibility.optionalChecks)
                                ? v.compatibility.optionalChecks
                                : []),
                              ...(Array.isArray(v.compatibility.pluginChecks)
                                ? v.compatibility.pluginChecks
                                : []),
                            ]"
                            :key="check.id || check.name"
                          >
                            {{
                              check.kind === "plugin"
                                ? "Plugin"
                                : "Core Agentor"
                            }}
                            ·
                            {{
                              check.required === false ? "Optional" : "Required"
                            }}
                            · {{ check.name || check.id }}:
                            {{ check.status || check.state }}
                            {{ check.message }}
                          </li>
                        </ul>
                      </details>
                    </td>
                    <td class="text-right">
                      <UButton
                        size="xs"
                        variant="ghost"
                        :disabled="!usable(v)"
                        :title="
                          usable(v)
                            ? undefined
                            : 'A test worker can be created only after Agentor compatibility validation is ready.'
                        "
                        @click="testWorker(d.id, v.version)"
                        >Create test worker</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
                        :disabled="!usable(v)"
                        :title="
                          usable(v)
                            ? undefined
                            : 'Only Ready images may be promoted.'
                        "
                        @click="
                          run('promote', () => api.promote(d.id, v.version))
                        "
                        >Promote</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
                        :disabled="!usable(v)"
                        :title="
                          usable(v)
                            ? undefined
                            : 'Only Ready images may be selected for rollback.'
                        "
                        @click="
                          run('rollback', () => api.rollback(d.id, v.version))
                        "
                        >Rollback</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
                        :disabled="!usable(v)"
                        :title="
                          usable(v)
                            ? undefined
                            : 'Only Ready images may become a default.'
                        "
                        @click="
                          run('default', () => api.setDefault(d.id, v.version))
                        "
                        >Set my default</UButton
                      ><UButton
                        size="xs"
                        color="error"
                        variant="ghost"
                        @click="
                          run('delete-version', () =>
                            api.removeVersion(d.id, v.version),
                          )
                        "
                        >Delete version</UButton
                      >
                      <UButton
                        v-if="
                          versionState(v).key === 'unavailable' ||
                          versionState(v).key === 'incompatible'
                        "
                        size="xs"
                        variant="ghost"
                        :loading="busy === `retry-${d.id}-${v.version}`"
                        :aria-label="`Retry compatibility validation for ${v.version}`"
                        @click="
                          run(`retry-${d.id}-${v.version}`, () =>
                            api.retryValidation(
                              d.id,
                              v.version,
                              newRequestId('validation'),
                            ),
                          )
                        "
                        >Retry validation</UButton
                      >
                    </td>
                  </tr>
                </tbody>
              </table>
            </article>
            <section
              v-for="b in Object.values(api.builds.value)"
              :key="b.id"
              class="border rounded p-3 mb-2"
              data-testid="image-build"
            >
              <div class="flex justify-between" aria-live="polite">
                <b :data-testid="`image-build-status-${b.id}`"
                  ><span aria-hidden="true">{{ buildState(b).icon }}</span>
                  {{ buildState(b).label }} · {{ b.phase }}</b
                ><span>{{ b.durationMs ? `${b.durationMs} ms` : "" }}</span>
              </div>
              <p v-if="b.error" class="text-red-600">{{ b.error }}</p>
              <p
                v-if="b.diagnostic"
                class="text-amber-800"
                data-testid="image-build-diagnostic"
              >
                {{ diagnosticText(b.diagnostic) }}
              </p>
              <p v-if="b.digest" class="text-xs">
                Image digest: <code>{{ b.digest }}</code>
              </p>
              <p
                v-if="b.compatibility?.warnings?.length || b.warnings?.length"
                class="text-amber-800 text-xs"
              >
                Warnings:
                {{ (b.compatibility?.warnings || b.warnings || []).join("; ") }}
              </p>
              <UButton
                size="xs"
                variant="ghost"
                :aria-expanded="Boolean(expandedLogs[b.id])"
                :aria-label="`${expandedLogs[b.id] ? 'Hide' : 'Show'} logs for ${b.id}`"
                @click="
                  expandedLogs[b.id] = !expandedLogs[b.id];
                  if (expandedLogs[b.id])
                    api.loadLogs(b.id, !api.logs.value[b.id]);
                "
                >{{ expandedLogs[b.id] ? "Hide logs" : "Show logs" }}</UButton
              >
              <pre
                v-if="expandedLogs[b.id]"
                class="bg-gray-950 text-gray-100 p-2 max-h-40 overflow-auto"
                >{{ api.logs.value[b.id] || "No logs received yet." }}</pre>
              <UButton
                v-if="['queued', 'running'].includes(b.status)"
                size="xs"
                :aria-label="`Cancel build ${b.id}`"
                @click="
                  run(`cancel-${b.id}`, async () => {
                    await api.cancel(b.id);
                  })
                "
                >Cancel build</UButton
              >
            </section>
            <p
              v-for="(job, id) in testJobs"
              :key="id"
              class="text-xs"
              role="status"
            >
              Test worker {{ id }}: {{ job.status
              }}{{ job.message ? ` · ${job.message}` : "" }}
            </p>
            <p class="text-xs">
              Effective default:
              {{ api.effectiveDefault.value?.source || "platform" }} ·
              {{
                api.effectiveDefault.value?.version || "built-in worker image"
              }}
            </p>
          </section>
        </div>
      </div></template
    ></UModal
  >
</template>
