<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
  service: [workspaceId: string, service: string];
  changed: [workspace: AdminWorkspace];
}>();
const admin = useAdminWorkspace();
const acknowledged = ref(false);
const pendingAction = ref<"start" | "stop" | "rebuild" | "">("");
const showFiles = ref(false);

watch(open, async (shown) => {
  acknowledged.value = false;
  pendingAction.value = "";
  if (shown) await admin.refresh().catch(() => undefined);
});

const statusTone = computed(() =>
  admin.workspace.value?.status === "running" ? "bg-red-600" : "bg-gray-600",
);
const shortDigest = computed(() => {
  const digest = admin.workspace.value?.image.digest || "";
  return digest.length > 28
    ? `${digest.slice(0, 20)}…${digest.slice(-8)}`
    : digest;
});

function requestAction(action: "start" | "stop" | "rebuild") {
  acknowledged.value = false;
  pendingAction.value = action;
}
function cancelAction() {
  pendingAction.value = "";
}
function close() {
  open.value = false;
}
async function confirmAction() {
  if (!acknowledged.value || !pendingAction.value) return;
  const result = await admin[pendingAction.value]().catch(() => undefined);
  if (result) {
    emit("changed", result);
    pendingAction.value = "";
    acknowledged.value = false;
  }
}
async function ensureWorkspace() {
  const result = await admin.ensure().catch(() => undefined);
  if (result) emit("changed", result);
}
function openService(service: string) {
  if (admin.workspace.value) emit("service", admin.workspace.value.id, service);
}
</script>

<template>
  <UModal
    v-model:open="open"
    :ui="{ content: 'max-w-5xl ring-2 ring-red-600' }"
  >
    <template #content>
      <div
        data-testid="admin-workspace"
        class="max-h-[90vh] overflow-y-auto bg-red-950 text-red-50"
      >
        <header
          class="sticky top-0 z-10 flex items-center justify-between gap-4 border-b-4 border-red-400 bg-red-700 px-6 py-4"
        >
          <div class="flex items-center gap-3">
            <span aria-hidden="true" class="text-3xl">⚠</span>
            <div>
              <p class="text-xs font-black uppercase tracking-[0.28em]">
                Privileged administrative workspace
              </p>
              <h2 class="text-2xl font-black tracking-wide">
                ADMIN / ORCHESTRATOR
              </h2>
            </div>
          </div>
          <UButton
            aria-label="Close administrative workspace"
            color="neutral"
            variant="solid"
            icon="i-lucide-x"
            @click="close"
          />
        </header>

        <div class="space-y-5 p-6">
          <div
            role="alert"
            class="rounded border-2 border-red-300 bg-red-900 p-4 font-semibold"
          >
            Actions here can affect every worker and stored workspace. Verify
            the target and impact before continuing. This authority is never
            granted to ordinary or user-supplied worker images.
          </div>
          <p
            v-if="admin.error.value"
            role="alert"
            class="rounded bg-red-100 p-3 text-sm font-medium text-red-900"
          >
            {{ admin.error.value }}
          </p>
          <div v-if="admin.loading.value" class="py-12 text-center">
            Loading administrative workspace…
          </div>
          <div
            v-else-if="!admin.workspace.value"
            class="rounded border border-red-400 p-5 text-center"
          >
            <p class="mb-3">
              The administrative workspace has not been provisioned.
            </p>
            <UButton
              color="error"
              :loading="admin.action.value === 'ensure'"
              @click="ensureWorkspace"
              >Provision trusted workspace</UButton
            >
          </div>

          <template v-else>
            <section class="grid gap-4 md:grid-cols-2">
              <div class="rounded border border-red-400 bg-red-900/70 p-4">
                <h3 class="mb-3 font-bold uppercase tracking-wider">
                  Lifecycle
                </h3>
                <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt>Status</dt>
                  <dd>
                    <span
                      class="inline-flex items-center gap-2 rounded-full bg-black/30 px-2 py-1 font-bold uppercase"
                      ><span
                        class="h-2 w-2 rounded-full"
                        :class="statusTone"
                      />{{ admin.workspace.value.status }}</span
                    >
                  </dd>
                  <dt>Workspace ID</dt>
                  <dd class="break-all font-mono">
                    {{ admin.workspace.value.id }}
                  </dd>
                  <dt>Persistent since</dt>
                  <dd>
                    {{
                      new Date(admin.workspace.value.createdAt).toLocaleString()
                    }}
                  </dd>
                  <dt>Last change</dt>
                  <dd>
                    {{
                      new Date(admin.workspace.value.updatedAt).toLocaleString()
                    }}
                  </dd>
                </dl>
                <div class="mt-4 flex flex-wrap gap-2">
                  <UButton
                    v-if="admin.workspace.value.status === 'stopped'"
                    color="error"
                    @click="requestAction('start')"
                    >Start admin workspace</UButton
                  >
                  <UButton v-else color="error" @click="requestAction('stop')"
                    >Stop admin workspace</UButton
                  >
                  <UButton
                    color="neutral"
                    variant="outline"
                    @click="requestAction('rebuild')"
                    >Rebuild trusted image</UButton
                  >
                </div>
              </div>

              <div class="rounded border border-red-400 bg-red-900/70 p-4">
                <h3 class="mb-3 font-bold uppercase tracking-wider">
                  Trusted image identity
                </h3>
                <dl class="space-y-2 text-sm">
                  <div>
                    <dt class="text-red-200">Image</dt>
                    <dd class="break-all font-mono">
                      {{ admin.workspace.value.image.name }}
                    </dd>
                  </div>
                  <div>
                    <dt class="text-red-200">Immutable digest</dt>
                    <dd
                      class="break-all font-mono"
                      :title="admin.workspace.value.image.digest"
                    >
                      {{ shortDigest }}
                    </dd>
                  </div>
                  <div class="flex items-center gap-2">
                    <dt>Trust state</dt>
                    <dd
                      class="rounded bg-red-600 px-2 py-1 font-black uppercase"
                    >
                      Explicitly promoted
                    </dd>
                  </div>
                  <div>
                    <dt class="text-red-200">Environment marker</dt>
                    <dd class="font-mono">
                      {{
                        admin.workspace.value.presentation.environmentMarker
                      }}=1
                    </dd>
                  </div>
                </dl>
              </div>
            </section>

            <section class="rounded border border-red-400 bg-black/30 p-4">
              <h3 class="mb-1 font-bold uppercase tracking-wider">
                Administrative services
              </h3>
              <p class="mb-4 text-sm text-red-200">
                Every service opens with the red ADMIN / ORCHESTRATOR identity
                and persistent workspace storage.
              </p>
              <div class="grid gap-3 sm:grid-cols-3">
                <button
                  type="button"
                  class="rounded border-2 border-red-400 bg-red-800 p-4 text-left font-bold hover:bg-red-700 disabled:opacity-50"
                  :disabled="admin.workspace.value.status !== 'running'"
                  @click="showFiles = true"
                >
                  <span class="block text-lg">Files</span>
                  <span class="text-xs font-normal text-red-200"
                    >Manage privileged /workspace files</span
                  >
                </button>
                <button
                  v-for="service in admin.workspace.value.services"
                  :key="service"
                  type="button"
                  class="rounded border-2 border-red-400 bg-red-800 p-4 text-left font-bold capitalize hover:bg-red-700 disabled:opacity-50"
                  :disabled="admin.workspace.value.status !== 'running'"
                  @click="openService(service)"
                >
                  <span class="block text-lg">{{
                    service === "editor" ? "VS Code" : service
                  }}</span>
                  <span class="text-xs font-normal text-red-200"
                    >Open privileged {{ service }}</span
                  >
                </button>
              </div>
            </section>
          </template>
        </div>

        <div
          v-if="pendingAction"
          class="absolute inset-0 z-20 grid place-items-center bg-black/75 p-5"
          data-testid="admin-action-confirmation"
        >
          <section
            class="max-w-lg rounded border-4 border-red-500 bg-white p-5 text-gray-950 shadow-2xl"
            role="alertdialog"
            aria-labelledby="admin-confirm-title"
          >
            <h3
              id="admin-confirm-title"
              class="text-xl font-black text-red-700"
            >
              Confirm privileged {{ pendingAction }} action
            </h3>
            <p class="my-3">
              This operates on the trusted administrative workspace and may
              interrupt management activity.
            </p>
            <label
              class="flex items-start gap-2 rounded bg-red-50 p-3 font-semibold"
              ><input v-model="acknowledged" type="checkbox" class="mt-1" /> I
              understand this is an ADMIN / ORCHESTRATOR action.</label
            >
            <div class="mt-4 flex justify-end gap-2">
              <UButton color="neutral" variant="ghost" @click="cancelAction"
                >Cancel</UButton
              >
              <UButton
                color="error"
                :disabled="!acknowledged"
                :loading="admin.action.value === pendingAction"
                @click="confirmAction"
                >Confirm {{ pendingAction }}</UButton
              >
            </div>
          </section>
        </div>
      </div>
    </template>
  </UModal>
  <WorkspaceFilesModal
    v-if="admin.workspace.value"
    v-model:open="showFiles"
    :container="{
      id: admin.workspace.value.id,
      displayName: 'ADMIN / ORCHESTRATOR',
      status: admin.workspace.value.status,
    }"
  />
</template>
