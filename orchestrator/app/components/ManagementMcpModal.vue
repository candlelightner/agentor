<script setup lang="ts">
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ changed: [] }>();
const mcp = useManagementMcp();
const draft = reactive<Record<string, boolean>>({});
const confirmProposal = ref<ManagementMcpProposal | null>(null);
const activeTab = ref<"policy" | "proposals" | "audit">("policy");

const groupDescriptions: Record<string, string> = {
  "read-only-status":
    "System status and worker inspection.",
  logs: "Safe log metadata (worker log bodies remain unavailable).",
  "volume-browsing": "Volume metadata and read-only workspace browsing.",
  "configuration-inspection": "Sanitized worker configuration inspection.",
  "worker-lifecycle": "Start and stop workers.",
  console: "Open bounded interactive terminal sessions inside selected workers.",
  exports: "Create, inspect, and cancel export jobs.",
  backups: "Create, inspect, and cancel backup jobs.",
  "image-builds": "Validate image definitions and run controlled builds.",
  "configuration-proposals":
    "Create immutable non-secret configuration proposals.",
  "configuration-application":
    "Apply an immutable proposal. The invoking harness controls confirmation.",
};
const dangerousGroups = new Set([
  "worker-lifecycle",
  "console",
  "exports",
  "backups",
  "image-builds",
  "configuration-application",
]);
const pendingCount = computed(
  () =>
    mcp.proposals.value.filter(
      (proposal) => proposal.status === "pending-dashboard-approval",
    ).length,
);

watch(open, async (shown) => {
  confirmProposal.value = null;
  if (!shown) return;
  await mcp.refresh().catch(() => undefined);
  resetDraft();
});
function resetDraft() {
  for (const key of Object.keys(draft)) delete draft[key];
  for (const [key, value] of Object.entries(mcp.policy.value?.groups || {}))
    draft[key] = value.enabled;
}
function close() {
  open.value = false;
}
function reviewProposal(proposal: ManagementMcpProposal) {
  confirmProposal.value = proposal;
}
function cancelApproval() {
  confirmProposal.value = null;
}
async function savePolicy() {
  const changed = Object.fromEntries(
    Object.entries(draft).filter(
      ([name, enabled]) => mcp.policy.value?.groups[name]?.enabled !== enabled,
    ),
  );
  if (!Object.keys(changed).length) return;
  const result = await mcp.updatePolicy(changed).catch(() => undefined);
  if (result) {
    resetDraft();
    emit("changed");
  }
}
async function approve() {
  if (!confirmProposal.value) return;
  const result = await mcp
    .approve(confirmProposal.value.id)
    .catch(() => undefined);
  if (result) {
    confirmProposal.value = null;
    emit("changed");
  }
}
const date = (value: string) => new Date(value).toLocaleString();
const sourceFor = (name: string) =>
  mcp.policy.value?.groups[name]?.source ||
  mcp.policy.value?.source ||
  `Dashboard policy revision ${mcp.policy.value?.revision ?? "—"}`;
</script>

<template>
  <UModal v-model:open="open" :ui="{ content: 'max-w-6xl' }">
    <template #content>
      <div
        data-testid="management-mcp"
        class="max-h-[90vh] overflow-y-auto p-6"
      >
        <header class="flex items-start justify-between gap-4 border-b pb-4">
          <div>
            <div class="flex items-center gap-2">
              <span
                class="rounded bg-red-700 px-2 py-1 text-xs font-black text-white"
                >ADMIN / ORCHESTRATOR</span
              ><span
                class="text-xs font-semibold uppercase tracking-widest text-gray-500"
                >Internal only</span
              >
            </div>
            <h2 class="mt-2 text-xl font-semibold">Management MCP controls</h2>
            <p class="text-sm text-gray-500">
              Live, fail-closed tool policy, immutable proposals, and security
              audit history.
            </p>
          </div>
          <UButton
            aria-label="Close management MCP"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            @click="close"
          />
        </header>

        <div
          class="my-4 rounded border border-amber-400 bg-amber-50 p-3 text-sm text-amber-950"
          role="alert"
        >
          This MCP is restricted to the administrative workspace. Policy is
          re-checked on every call; disabled or unknown tools are denied.
          Confirmation prompts are controlled by the invoking agent harness;
          dashboard proposal review remains optional.
        </div>
        <p
          v-if="mcp.error.value"
          role="alert"
          class="mb-4 rounded bg-red-50 p-3 text-sm text-red-700"
        >
          {{ mcp.error.value }}
        </p>

        <nav
          class="mb-4 flex gap-2 border-b"
          aria-label="Management MCP sections"
        >
          <button
            v-for="tab in ['policy', 'proposals', 'audit'] as const"
            :key="tab"
            type="button"
            class="border-b-2 px-3 py-2 capitalize"
            :class="
              activeTab === tab
                ? 'border-red-600 font-semibold text-red-700'
                : 'border-transparent'
            "
            @click="activeTab = tab"
          >
            {{ tab
            }}<span
              v-if="tab === 'proposals' && pendingCount"
              class="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white"
              >{{ pendingCount }}</span
            >
          </button>
        </nav>

        <div v-if="mcp.loading.value" class="py-12 text-center text-gray-500">
          Loading management controls…
        </div>
        <section
          v-else-if="activeTab === 'policy'"
          aria-labelledby="mcp-policy-title"
        >
          <div
            class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded bg-gray-50 p-3 dark:bg-gray-900"
          >
            <div>
              <h3 id="mcp-policy-title" class="font-semibold">
                Effective tool-group permissions
              </h3>
              <p class="text-xs text-gray-500">
                Source:
                {{
                  mcp.policy.value?.source || "Dashboard-managed live policy"
                }}
                · revision {{ mcp.policy.value?.revision ?? "—" }}
              </p>
            </div>
            <span
              class="rounded bg-gray-900 px-3 py-1 text-xs font-bold uppercase text-white"
              >Default: {{ mcp.policy.value?.default || "deny" }}</span
            >
          </div>
          <div class="divide-y rounded border">
            <label
              v-for="(group, name) in mcp.policy.value?.groups"
              :key="name"
              class="flex cursor-pointer items-start justify-between gap-4 p-4"
            >
              <span
                ><span class="font-medium">{{ name }}</span
                ><span
                  v-if="dangerousGroups.has(name)"
                  class="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700"
                  >Mutating</span
                ><span class="mt-1 block text-sm text-gray-500">{{
                  groupDescriptions[name] ||
                  "Explicitly allow this management tool group."
                }}</span
                ><span class="mt-1 block text-xs text-gray-400"
                  >Effective source: {{ sourceFor(name) }}</span
                ></span
              >
              <span class="flex shrink-0 items-center gap-2"
                ><span
                  class="text-xs font-semibold"
                  :class="draft[name] ? 'text-green-700' : 'text-gray-500'"
                  >{{ draft[name] ? "Allowed" : "Denied" }}</span
                ><input
                  v-model="draft[name]"
                  type="checkbox"
                  class="h-5 w-5 accent-red-700"
                  :aria-label="`Allow ${name}`"
              /></span>
            </label>
          </div>
          <div class="mt-4 flex justify-end gap-2">
            <UButton color="neutral" variant="ghost" @click="resetDraft"
              >Reset</UButton
            ><UButton
              color="error"
              :loading="mcp.saving.value"
              @click="savePolicy"
              >Save live policy</UButton
            >
          </div>
        </section>

        <section
          v-else-if="activeTab === 'proposals'"
          aria-labelledby="mcp-proposals-title"
        >
          <h3 id="mcp-proposals-title" class="font-semibold">
            Immutable configuration proposals
          </h3>
          <p class="mb-4 text-sm text-gray-500">
            Review the fixed diff carefully. Approval permits the administrative
            AI to apply this exact change ID; it does not apply the change
            itself.
          </p>
          <p
            v-if="!mcp.proposals.value.length"
            class="rounded border border-dashed p-8 text-center text-gray-500"
          >
            No configuration proposals.
          </p>
          <article
            v-for="proposal in mcp.proposals.value"
            :key="proposal.id"
            class="mb-3 rounded border p-4"
            :data-testid="`proposal-${proposal.id}`"
          >
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="flex items-center gap-2">
                  <code class="text-xs">{{ proposal.id }}</code
                  ><span
                    class="rounded px-2 py-0.5 text-xs font-semibold"
                    :class="
                      proposal.status === 'pending-dashboard-approval'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-green-100 text-green-800'
                    "
                    >{{ proposal.status }}</span
                  ><span class="rounded bg-gray-100 px-2 py-0.5 text-xs"
                    >Immutable</span
                  >
                </div>
                <p class="mt-1 text-xs text-gray-500">
                  Proposed {{ date(proposal.createdAt) }}
                </p>
              </div>
              <UButton
                v-if="proposal.status === 'pending-dashboard-approval'"
                color="error"
                size="sm"
                @click="reviewProposal(proposal)"
                >Review and approve</UButton
              >
            </div>
            <pre
              class="mt-3 max-h-56 overflow-auto rounded bg-gray-950 p-3 text-xs text-gray-100"
              >{{ JSON.stringify(proposal.diff, null, 2) }}</pre>
          </article>
        </section>

        <section v-else aria-labelledby="mcp-audit-title">
          <div class="mb-3 flex justify-between">
            <div>
              <h3 id="mcp-audit-title" class="font-semibold">Security audit</h3>
              <p class="text-sm text-gray-500">
                Policy changes, approvals, applications, and authorization
                failures.
              </p>
            </div>
            <UButton
              color="neutral"
              variant="outline"
              size="sm"
              @click="mcp.refreshAudit"
              >Refresh audit</UButton
            >
          </div>
          <p
            v-if="!mcp.audit.value.length"
            class="rounded border border-dashed p-8 text-center text-gray-500"
          >
            No audit events.
          </p>
          <div v-else class="overflow-x-auto rounded border">
            <table class="w-full text-left text-sm">
              <thead class="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th class="p-3">Time</th>
                  <th class="p-3">Action</th>
                  <th class="p-3">Outcome</th>
                  <th class="p-3">Safe details</th>
                </tr>
              </thead>
              <tbody class="divide-y">
                <tr v-for="entry in mcp.audit.value" :key="entry.id">
                  <td class="whitespace-nowrap p-3">{{ date(entry.at) }}</td>
                  <td class="p-3 font-mono text-xs">{{ entry.action }}</td>
                  <td class="p-3">
                    <span
                      :class="
                        entry.outcome === 'success'
                          ? 'text-green-700'
                          : 'text-red-700'
                      "
                      >{{ entry.outcome }}</span
                    >
                  </td>
                  <td class="max-w-md break-all p-3 font-mono text-xs">
                    {{ entry.details ? JSON.stringify(entry.details) : "—" }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <div
          v-if="confirmProposal"
          class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5"
          data-testid="proposal-approval-confirmation"
        >
          <section
            role="alertdialog"
            aria-labelledby="proposal-confirm-title"
            class="max-w-xl rounded bg-white p-5 text-gray-950 shadow-2xl"
          >
            <h3
              id="proposal-confirm-title"
              class="text-lg font-bold text-red-700"
            >
              Approve immutable change ID?
            </h3>
            <p class="my-2 text-sm">
              Only the exact diff below can be applied. Approval cannot be
              edited or delegated back to the AI.
            </p>
            <code class="text-xs">{{ confirmProposal.id }}</code>
            <pre
              class="my-3 max-h-56 overflow-auto rounded bg-gray-950 p-3 text-xs text-white"
              >{{ JSON.stringify(confirmProposal.diff, null, 2) }}</pre>
            <div class="flex justify-end gap-2">
              <UButton
                color="neutral"
                variant="ghost"
                @click="cancelApproval"
                >Cancel</UButton
              ><UButton
                color="error"
                :loading="mcp.approving.value === confirmProposal.id"
                @click="approve"
                >Approve exact change ID</UButton
              >
            </div>
          </section>
        </div>
      </div>
    </template>
  </UModal>
</template>
