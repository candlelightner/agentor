import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { requireAdmin } from "../../../../utils/auth-helpers";

const statuses = new Set(["pending-dashboard-approval", "approved", "applied"]);

function publicProposal(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const proposal = value as Record<string, unknown>;
  if (
    typeof proposal.id !== "string" ||
    proposal.immutable !== true ||
    typeof proposal.status !== "string" ||
    !statuses.has(proposal.status) ||
    !proposal.diff ||
    typeof proposal.diff !== "object" ||
    Array.isArray(proposal.diff) ||
    typeof proposal.createdAt !== "string"
  )
    return;
  return {
    id: proposal.id,
    immutable: true as const,
    status: proposal.status,
    diff: proposal.diff,
    createdAt: proposal.createdAt,
    ...(typeof proposal.approvedAt === "string"
      ? { approvedAt: proposal.approvedAt }
      : {}),
    ...(typeof proposal.appliedAt === "string"
      ? { appliedAt: proposal.appliedAt }
      : {}),
  };
}

export default defineEventHandler(async (event) => {
  requireAdmin(event);
  try {
    const state = JSON.parse(
      await readFile(
        join(
          process.env.DATA_DIR || "/data",
          "admin",
          "management-mcp.v1.json",
        ),
        "utf8",
      ),
    );
    if (state?.schemaVersion !== 1 || !Array.isArray(state.proposals))
      return [];
    return state.proposals.map(publicProposal).filter(Boolean).reverse();
  } catch (error: any) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
});
defineRouteMeta({
  openAPI: {
    tags: ["Management MCP"],
    summary: "List sanitized management change proposals",
    responses: {
      200: { description: "Proposals" },
      403: { description: "Administrator required" },
    },
  },
});
