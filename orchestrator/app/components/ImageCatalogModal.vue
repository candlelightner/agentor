<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: []; testWorker: [workerId: string] }>();
const api = useImageCatalog();
const form = reactive({
  name: "",
  description: "",
  baseImage: "agentor-worker:approved-latest",
  dockerfileFragment: "",
  contextFiles: [] as Array<{ path: string; contentBase64: string }>,
});
const selected = ref(""),
  busy = ref(""),
  actionError = ref(""),
  rebuildBase = ref("agentor-worker:approved-latest");
const git = reactive({ repository: "", visibility: "private" as "public" | "private", authType: "pat" as "none" | "pat" | "github-app", token: "", appId: "", installationId: "", workflow: "pull-request" as "direct" | "branch" | "pull-request", buildMode: "local" as "local" | "github-actions", publishGhcr: false });
watch(open, (shown) => (shown ? api.refresh() : api.stop()));
onBeforeUnmount(api.stop);
const current = computed(
  () =>
    api.definitions.value.find((d) => d.id === selected.value) ||
    api.definitions.value[0],
);
async function run(key: string, fn: () => Promise<any>) {
  busy.value = key;
  actionError.value = "";
  try {
    return await fn();
  } catch (e: any) {
    actionError.value =
      e?.data?.statusMessage || e?.message || "Image operation failed.";
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
    });
  }
}
async function create() {
  const d = await run("create", () => api.create(form));
  if (d) {
    selected.value = d.id;
    Object.assign(form, {
      name: "",
      description: "",
      dockerfileFragment: "",
      contextFiles: [],
    });
    emit("changed");
  }
}
async function testWorker(d: string, v: string) {
  const r: any = await run("test", () => api.testWorker(d, v));
  if (r) emit("testWorker", r.workerId);
}
async function connectGit() {
  await run("git-connect", () => api.connectGit({
    provider: "github",
    repository: git.repository,
    visibility: git.visibility,
    workflow: git.workflow,
    buildMode: git.buildMode,
    publishGhcr: git.publishGhcr,
    auth: git.authType === "github-app" ? { type: "github-app", appId: git.appId, installationId: git.installationId } : git.visibility === "public" && git.authType === "none" ? { type: "none" } : { type: "pat", token: git.token },
  }));
  git.token = "";
}
const fmt = (n: number) => formatBytes(n);
function close() { open.value = false; }
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
          class="text-red-600"
        >
          {{ api.error.value || actionError }}
        </p>
        <section class="border rounded p-4 space-y-3" data-testid="git-image-catalog">
          <div class="flex justify-between gap-3">
            <div><h3 class="font-medium">GitHub catalog and disaster recovery</h3><p class="text-xs text-gray-500">Optional image-definition source of truth. This does not back up workspace data, and repository credentials never enter builds or workers.</p></div>
            <UButton v-if="api.gitConnection.value.repository" size="xs" color="error" variant="outline" :loading="busy === 'git-disconnect'" @click="run('git-disconnect', api.disconnectGit)">Disconnect and erase credential</UButton>
          </div>
          <div v-if="!api.gitConnection.value.repository" class="grid md:grid-cols-6 gap-2">
            <input v-model="git.repository" class="border rounded p-2 md:col-span-2" placeholder="owner/repository" aria-label="GitHub repository" />
            <select v-model="git.visibility" class="border rounded p-2"><option value="private">Private</option><option value="public">Public</option></select>
            <select v-model="git.workflow" class="border rounded p-2"><option value="pull-request">Pull request</option><option value="branch">Branch</option><option value="direct">Direct</option></select>
            <select v-model="git.authType" class="border rounded p-2"><option value="pat">Fine-grained PAT</option><option value="github-app">GitHub App</option><option v-if="git.visibility === 'public'" value="none">Public, no token</option></select>
            <input v-if="git.authType === 'pat'" v-model="git.token" type="password" autocomplete="off" class="border rounded p-2" placeholder="Fine-grained PAT" aria-label="Fine-grained GitHub token" />
            <div v-else-if="git.authType === 'github-app'" class="flex gap-1"><input v-model="git.appId" class="min-w-0 border rounded p-2" placeholder="App ID" /><input v-model="git.installationId" class="min-w-0 border rounded p-2" placeholder="Installation ID" /></div>
            <UButton :disabled="!git.repository || (git.authType === 'pat' && !git.token) || (git.authType === 'github-app' && (!git.appId || !git.installationId))" :loading="busy === 'git-connect'" @click="connectGit">Connect</UButton>
            <label class="text-xs flex gap-2 md:col-span-2"><input v-model="git.publishGhcr" type="checkbox" /> Publish immutable images to GHCR</label>
            <select v-model="git.buildMode" class="border rounded p-2 md:col-span-2"><option value="local">Build locally</option><option value="github-actions">Build with GitHub Actions</option></select>
          </div>
          <div v-else class="flex flex-wrap gap-2 items-center text-sm">
            <b>{{ api.gitConnection.value.repository }}</b><span>{{ api.gitConnection.value.workflow }} · {{ api.gitConnection.value.buildMode }}</span>
            <UButton size="xs" :loading="busy === 'git-push'" @click="run('git-push', () => api.syncGit('push'))">Sync local changes</UButton>
            <UButton size="xs" variant="outline" :loading="busy === 'git-pull'" @click="run('git-pull', () => api.syncGit('pull'))">Recover / pull</UButton>
            <UButton v-if="api.gitSyncResult.value?.conflicts?.length" size="xs" color="warning" @click="run('git-copy', () => api.syncGit('pull', 'remote-copy'))">Keep local and import remote copies</UButton>
          </div>
          <p v-if="api.gitRecovery.value" class="text-xs">Recovery: {{ api.gitRecovery.value.state }} · {{ api.gitRecovery.value.catalogEntries || 0 }} definitions · {{ api.gitRecovery.value.imageDigests || 0 }} immutable digests. {{ api.gitRecovery.value.note }}</p>
          <p v-if="api.gitSyncResult.value?.conflicts?.length" class="text-xs text-amber-700">Conflicts were preserved; no local definition was overwritten.</p>
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
            /><textarea
              v-model="form.dockerfileFragment"
              rows="8"
              class="w-full border rounded p-2 font-mono"
              placeholder="RUN apt-get update…"
            /><label class="block"
              >Build context files<input
                type="file"
                multiple
                class="block"
                @change="files"
            /></label>
            <ul class="text-xs">
              <li v-for="f in form.contextFiles" :key="f.path">{{ f.path }}</li>
            </ul>
            <UButton
              :disabled="!form.name || !form.baseImage"
              :loading="busy === 'create'"
              @click="create"
              >Create definition</UButton
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
                  <b>{{ d.name }}</b>
                  <p class="text-xs">{{ d.description }} · {{ d.baseImage }}</p>
                </div>
                <div>
                  <UButton
                    size="xs"
                    :loading="busy === d.id"
                    @click="run(d.id, () => api.startBuild(d.id))"
                    >Build</UButton
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
                    </td>
                    <td class="text-right">
                      <UButton
                        size="xs"
                        variant="ghost"
                        @click="run('test', () => testWorker(d.id, v.version))"
                        >Create test worker</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
                        @click="
                          run('promote', () => api.promote(d.id, v.version))
                        "
                        >Promote</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
                        @click="
                          run('rollback', () => api.rollback(d.id, v.version))
                        "
                        >Rollback</UButton
                      ><UButton
                        size="xs"
                        variant="ghost"
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
              <div class="flex justify-between">
                <b>{{ b.status }} · {{ b.phase }}</b
                ><span>{{ b.durationMs ? `${b.durationMs} ms` : "" }}</span>
              </div>
              <p v-if="b.error" class="text-red-600">{{ b.error }}</p>
              <pre
                class="bg-gray-950 text-gray-100 p-2 max-h-40 overflow-auto"
                >{{ api.logs.value[b.id] || "Waiting for logs…" }}</pre>
              <UButton
                v-if="b.status === 'queued' || b.status === 'running'"
                size="xs"
                @click="api.cancel(b.id)"
                >Cancel build</UButton
              >
            </section>
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
