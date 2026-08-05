export interface ManagementMcpPolicyGroup {
  enabled: boolean;
  source?: string;
}
export interface ManagementMcpPolicy {
  schemaVersion: number;
  default: "deny";
  groups: Record<string, ManagementMcpPolicyGroup>;
  revision: number;
  updatedAt: string;
  source?: string;
}
export interface ManagementMcpProposal {
  id: string;
  immutable: true;
  status: "pending-dashboard-approval" | "approved" | "applied";
  diff: Record<string, unknown>;
  createdAt: string;
  approvedAt?: string;
  appliedAt?: string;
}
export interface ManagementMcpAuditEntry {
  id: string;
  at: string;
  action: string;
  outcome: string;
  details?: Record<string, unknown>;
}

const mcpMessage = (error: any, fallback: string) =>
  error?.data?.statusMessage ||
  error?.data?.message ||
  error?.message ||
  fallback;

export function useManagementMcp() {
  const policy = ref<ManagementMcpPolicy | null>(null);
  const proposals = ref<ManagementMcpProposal[]>([]);
  const audit = ref<ManagementMcpAuditEntry[]>([]);
  const loading = ref(false);
  const saving = ref(false);
  const approving = ref("");
  const error = ref("");

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      const [nextPolicy, nextProposals, nextAudit] = await Promise.all([
        $fetch<ManagementMcpPolicy>("/api/admin/management-mcp/policy"),
        $fetch<ManagementMcpProposal[]>("/api/admin/management-mcp/proposals"),
        $fetch<ManagementMcpAuditEntry[]>("/api/admin/management-mcp/audit", {
          query: { limit: 200 },
        }),
      ]);
      policy.value = nextPolicy;
      proposals.value = nextProposals;
      audit.value = nextAudit;
    } catch (cause) {
      error.value = mcpMessage(
        cause,
        "Could not load management MCP controls.",
      );
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  async function updatePolicy(groups: Record<string, boolean>) {
    saving.value = true;
    error.value = "";
    try {
      policy.value = await $fetch<ManagementMcpPolicy>(
        "/api/admin/management-mcp/policy",
        {
          method: "PUT",
          body: { groups },
        },
      );
      await refreshAudit();
      return policy.value;
    } catch (cause) {
      error.value = mcpMessage(
        cause,
        "Could not update management MCP policy.",
      );
      throw cause;
    } finally {
      saving.value = false;
    }
  }

  async function refreshAudit() {
    audit.value = await $fetch<ManagementMcpAuditEntry[]>(
      "/api/admin/management-mcp/audit",
      {
        query: { limit: 200 },
      },
    );
  }

  async function approve(id: string) {
    approving.value = id;
    error.value = "";
    try {
      const approved = await $fetch<ManagementMcpProposal>(
        `/api/admin/management-mcp/proposals/${encodeURIComponent(id)}/approve`,
        { method: "POST", body: {} },
      );
      proposals.value = proposals.value.map((proposal) =>
        proposal.id === id ? approved : proposal,
      );
      await refreshAudit();
      return approved;
    } catch (cause) {
      error.value = mcpMessage(
        cause,
        "Could not approve the immutable proposal.",
      );
      throw cause;
    } finally {
      approving.value = "";
    }
  }

  return {
    policy,
    proposals,
    audit,
    loading,
    saving,
    approving,
    error,
    refresh,
    refreshAudit,
    updatePolicy,
    approve,
  };
}
