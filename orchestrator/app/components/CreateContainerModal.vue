<script setup lang="ts">
import type { GitProviderInfo, MountConfig, RepoConfig, CreateContainerRequest, GitHubBranchInfo, GitHubRepoInfo } from '~/types';
import type { WorkerGroup } from '~/composables/useWorkerGroups';

const props = defineProps<{
  gitProviders: GitProviderInfo[];
  workerGroups: WorkerGroup[];
}>();

const emit = defineEmits<{
  create: [request: CreateContainerRequest];
  manageEnvironments: [];
  manageInitScripts: [];
  'after:leave': [];
}>();

const open = defineModel<boolean>('open', { default: false });

const { environments, defaultEnvironmentId } = useEnvironments();
const hostMounts = useHostMounts();

const {
  repos: githubRepos,
  reposLoading: githubReposLoading,
  username: githubUser,
  orgs: githubOrgs,
  error: githubReposError,
  fetchRepos,
  addRepoToList,
} = useGitHubRepos();

// Per-repo-row branch state keyed by stable row ID
const branchData = reactive(new Map<number, { branches: GitHubBranchInfo[]; loading: boolean; defaultBranch: string }>());
const creatingRepo = reactive(new Map<number, boolean>());
let rowCounter = 0;
const repoRowIds = reactive(new Map<number, number>());

const generatedName = ref('');

// Pre-select the built-in default environment once the list resolves — its id
// is a derived UUID, not known until the environments load.
watch(defaultEnvironmentId, (id) => {
  if (id && !form.environmentId) form.environmentId = id;
}, { immediate: true });

watch(open, async (isOpen) => {
  if (isOpen) {
    fetchRepos();
    await refreshEffectiveHostMounts();
    const { displayName } = await $fetch<{ displayName: string }>('/api/containers/generate-name');
    generatedName.value = displayName;
  }
});

const form = reactive({
  displayName: '',
  environmentId: '',
  workerGroupId: '',
  repos: [] as RepoConfig[],
  mounts: [] as MountConfig[],
  initScript: '',
});
const workerConfiguration = ref<CreateContainerRequest['workerConfiguration']>({ variables: [], secrets: [], secretFiles: [] });
const excludedGlobalEnvVarKeys = ref<string[]>([]);

const { initScripts } = useInitScripts();

const { selectedPreset, presetOptions } = useInitScriptSync(
  initScripts,
  toRef(form, 'initScript'),
);

const environmentOptions = computed(() =>
  environments.value.map((e) => ({ label: e.name, value: e.id })),
);

const workerGroupOptions = computed(() => {
  const byId = new Map(props.workerGroups.map((group) => [group.id, group]));
  const labelFor = (group: WorkerGroup) => {
    const names = [group.name];
    const seen = new Set([group.id]);
    let parentId = group.parentId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      names.unshift(parent.name);
      parentId = parent.parentId;
    }
    return names.join(' / ');
  };
  return [
    { label: 'Ungrouped', value: '' },
    ...props.workerGroups
      .map((group) => ({ label: labelFor(group), value: group.id }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
});

async function refreshEffectiveHostMounts() {
  await hostMounts.refresh({
    ...(form.workerGroupId ? { groupId: form.workerGroupId } : {}),
  });
  const available = new Set(hostMounts.effectivePaths.value.map((path) => path.id));
  form.mounts = form.mounts.filter((mount) => mount.pathId && available.has(mount.pathId));
}

watch(() => form.workerGroupId, () => {
  if (open.value) void refreshEffectiveHostMounts();
});

const defaultProvider = computed(() => props.gitProviders[0]?.id || 'github');

function addRepo() {
  const idx = form.repos.length;
  form.repos.push({ provider: defaultProvider.value, url: '', branch: '' });
  repoRowIds.set(idx, ++rowCounter);
}

function removeRepo(idx: number) {
  const rowId = repoRowIds.get(idx);
  if (rowId !== undefined) {
    branchData.delete(rowId);
    creatingRepo.delete(rowId);
  }
  form.repos.splice(idx, 1);
  // Re-index row IDs after splice
  const newMap = new Map<number, number>();
  for (const [k, v] of repoRowIds) {
    if (k < idx) newMap.set(k, v);
    else if (k > idx) newMap.set(k - 1, v);
  }
  repoRowIds.clear();
  for (const [k, v] of newMap) repoRowIds.set(k, v);
}

async function onRepoSelected(idx: number, fullName: string) {
  const rowId = repoRowIds.get(idx);
  if (rowId === undefined) return;

  branchData.set(rowId, { branches: [], loading: true, defaultBranch: '' });

  try {
    const [owner, repo] = fullName.split('/');
    const data = await $fetch<{ branches: GitHubBranchInfo[]; defaultBranch: string }>(
      `/api/github/repos/${owner}/${repo}/branches`,
    );
    branchData.set(rowId, { branches: data.branches, loading: false, defaultBranch: data.defaultBranch });
  } catch {
    branchData.set(rowId, { branches: [], loading: false, defaultBranch: '' });
  }
}

async function onCreateRepo(idx: number, payload: { owner: string; name: string; isPrivate: boolean }) {
  const rowId = repoRowIds.get(idx);
  if (rowId === undefined) return;

  creatingRepo.set(rowId, true);
  try {
    const data = await $fetch<{ repo: GitHubRepoInfo }>('/api/github/repos', {
      method: 'POST',
      body: { owner: payload.owner, name: payload.name, private: payload.isPrivate },
    });

    addRepoToList(data.repo);
    // The await above may have outlived this row — the user can remove a repo
    // mid-flight, which re-indexes `repoRowIds`. Resolve the live index from the
    // stable rowId before writing so we never mutate the wrong (or a gone) row.
    const liveIdx = [...repoRowIds].find(([, id]) => id === rowId)?.[0];
    if (liveIdx === undefined || !form.repos[liveIdx]) return;
    form.repos[liveIdx] = { ...form.repos[liveIdx]!, url: data.repo.fullName };
    await onRepoSelected(liveIdx, data.repo.fullName);
  } catch {
    // API error — leave the URL as-is so the user can retry
  } finally {
    creatingRepo.set(rowId, false);
  }
}

function getBranchData(idx: number) {
  const rowId = repoRowIds.get(idx);
  return rowId !== undefined ? branchData.get(rowId) : undefined;
}

function getCreatingRepo(idx: number) {
  const rowId = repoRowIds.get(idx);
  return rowId !== undefined ? creatingRepo.get(rowId) ?? false : false;
}

function addMount() {
  form.mounts.push({ pathId: '', source: '', target: '', readOnly: true });
}

function removeMount(idx: number) {
  form.mounts.splice(idx, 1);
}

function submit() {
  // The internal worker identity is a UUID v4 minted server-side; the form only
  // collects the editable, free-form display name. Send the suggested name when
  // the user leaves the field blank so the worker keeps the friendly label they
  // saw in the placeholder.
  const customName = form.displayName.trim();
  const request: CreateContainerRequest = {
    displayName: customName || generatedName.value,
  };
  if (form.environmentId) request.environmentId = form.environmentId;
  if (form.workerGroupId) request.workerGroupId = form.workerGroupId;
  request.excludedGlobalEnvVarKeys = [...excludedGlobalEnvVarKeys.value];
  const validRepos = form.repos.filter((r) => r.url);
  if (validRepos.length > 0) {
    request.repos = validRepos.map((r) => ({
      provider: r.provider,
      url: r.url,
      ...(r.branch ? { branch: r.branch } : {}),
    }));
  }
  if (form.mounts.length > 0) {
    request.mounts = form.mounts.filter((m) => m.pathId && m.target);
  }
  if (form.initScript.trim()) {
    request.initScript = form.initScript;
  }
  request.workerConfiguration = workerConfiguration.value;
  emit('create', request);
  reset();
  open.value = false;
}

function reset() {
  form.displayName = '';
  form.environmentId = defaultEnvironmentId.value;
  form.workerGroupId = '';
  form.repos = [];
  form.mounts = [];
  form.initScript = '';
  generatedName.value = '';
  branchData.clear();
  creatingRepo.clear();
  repoRowIds.clear();
  rowCounter = 0;
  workerConfiguration.value = { variables: [], secrets: [], secretFiles: [] };
  excludedGlobalEnvVarKeys.value = [];
}
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'sm:max-w-3xl' }" @after:leave="emit('after:leave')">
    <template #content>
      <div class="p-6 space-y-5 max-h-[90vh] overflow-y-auto">
        <h2 class="text-lg font-semibold text-gray-900 dark:text-white">New Worker</h2>

        <UFormField label="Display name">
          <UInput
            v-model="form.displayName"
            :placeholder="generatedName"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Environment">
          <div class="flex gap-2">
            <USelect v-model="form.environmentId" :items="environmentOptions" class="flex-1" />
            <UButton
              size="sm"
              color="neutral"
              variant="outline"
              @click="emit('manageEnvironments')"
            >
              Manage
            </UButton>
          </div>
        </UFormField>

        <UFormField label="Worker group" hint="Optional direct membership; group permissions apply during creation">
          <USelect
            v-model="form.workerGroupId"
            :items="workerGroupOptions"
            class="w-full"
          />
        </UFormField>

        <AccountEnvInheritancePicker v-model:excluded-keys="excludedGlobalEnvVarKeys" />

        <details class="rounded-md border border-gray-200 dark:border-gray-700 p-3">
          <summary class="cursor-pointer text-sm font-medium">Worker-local variables and secrets</summary>
          <div class="mt-3"><WorkerConfigurationEditor v-model="workerConfiguration" /></div>
        </details>

        <UFormField label="Repositories">
          <div class="space-y-2">
            <RepoInput
              v-for="(repo, idx) in form.repos"
              :key="repoRowIds.get(idx) ?? idx"
              :model-value="repo"
              @update:model-value="form.repos[idx] = $event"
              :providers="gitProviders"
              :github-repos="githubRepos"
              :github-repos-loading="githubReposLoading"
              :github-repos-error="githubReposError"
              :github-branches="getBranchData(idx)?.branches"
              :github-branches-loading="getBranchData(idx)?.loading"
              :github-default-branch="getBranchData(idx)?.defaultBranch"
              :github-user="githubUser"
              :github-orgs="githubOrgs"
              :creating-repo="getCreatingRepo(idx)"
              @remove="removeRepo(idx)"
              @repo-selected="onRepoSelected(idx, $event)"
              @create-repo="onCreateRepo(idx, $event)"
            />
          </div>
          <UButton
            size="xs"
            variant="link"
            class="mt-2"
            @click="addRepo"
          >
            + Add repository
          </UButton>
        </UFormField>

        <UFormField label="Volume Mounts">
          <div class="space-y-2">
            <MountInput
              v-for="(mount, idx) in form.mounts"
              :key="idx"
              :model-value="mount"
              :paths="hostMounts.effectivePaths.value"
              @update:model-value="form.mounts[idx] = $event"
              @remove="removeMount(idx)"
            />
          </div>
          <UButton
            size="xs"
            variant="link"
            class="mt-2"
            :disabled="hostMounts.effectivePaths.value.length === 0"
            @click="addMount"
          >
            + Add mount
          </UButton>
          <p v-if="hostMounts.effectivePaths.value.length === 0" class="mt-1 text-xs text-gray-500">
            No host path is assigned to {{ form.workerGroupId ? 'the selected group' : 'all new workers' }}. Configure host mount permissions first.
          </p>
        </UFormField>

        <UFormField label="Init Script" hint="Script to run in tmux on startup">
          <div class="space-y-2">
            <div class="flex gap-2">
              <USelect v-model="selectedPreset" :items="presetOptions" class="flex-1" />
              <UButton
                size="sm"
                color="neutral"
                variant="outline"
                @click="emit('manageInitScripts')"
              >
                Manage
              </UButton>
            </div>
            <UTextarea
              v-model="form.initScript"
              :rows="3"
              placeholder="#!/bin/bash&#10;# Script to run in tmux on startup"
              class="w-full font-mono text-xs"
            />
          </div>
        </UFormField>

        <div class="flex gap-3 pt-2">
          <UButton class="flex-1" @click="submit">
            Create
          </UButton>
          <UButton
            color="neutral"
            variant="outline"
            @click="open = false; reset()"
          >
            Cancel
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
