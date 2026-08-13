import type { AgentUsageInfo, AgentUsageStatus, WorkerMetrics } from "../../shared/types";
import {
  useContainerManager,
  useResourceMonitor,
  useUsageChecker,
  useWorkerStore,
} from "./services";

export interface ManagementStatusTool {
  name: string;
  group: "read-only-status";
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
}

interface StatusDependencies {
  usage: Pick<ReturnType<typeof useUsageChecker>, "getStatus">;
  metrics: Pick<ReturnType<typeof useResourceMonitor>, "getWorkerMetricsStatus" | "getWorkerMetric">;
  containers: Pick<ReturnType<typeof useContainerManager>, "get">;
  workers: Pick<ReturnType<typeof useWorkerStore>, "findById">;
}

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/**
 * Read-only MCP adapter for account usage and worker resource snapshots.
 *
 * It deliberately wraps the existing monitor/checker rather than Docker or
 * provider APIs: calls neither refresh usage nor sample metrics.  Owner
 * filtering is resolved from the authoritative worker record/container, and
 * provider/Docker error strings are replaced with safe availability markers.
 */
export class ManagementStatusDomain {
  constructor(private readonly deps: StatusDependencies = {
    usage: useUsageChecker(),
    metrics: useResourceMonitor(),
    containers: useContainerManager(),
    workers: useWorkerStore(),
  }) {}

  tools(): ManagementStatusTool[] {
    return [
      {
        name: "usage.get",
        group: "read-only-status",
        description: "Read sanitized agent usage status for one explicit owner; does not refresh provider data.",
        inputSchema: { type: "object", required: ["userId"], properties: { userId: { type: "string" } } },
        annotations: readOnly,
      },
      {
        name: "workers.metrics",
        group: "read-only-status",
        description: "List sanitized live worker resource metrics; optionally limit to one owner.",
        inputSchema: { type: "object", properties: { userId: { type: "string" } } },
        annotations: readOnly,
      },
      {
        name: "workers.metrics.get",
        group: "read-only-status",
        description: "Read sanitized live metrics for one known worker.",
        inputSchema: { type: "object", required: ["workerId"], properties: { workerId: { type: "string" } } },
        annotations: readOnly,
      },
    ];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<{ handled: boolean; result?: unknown }> {
    if (name === "usage.get") {
      return { handled: true, result: sanitizeUsage(this.deps.usage.getStatus(required(args.userId, "userId"))) };
    }
    if (name === "workers.metrics") {
      const userId = optional(args.userId);
      const workers = this.deps.metrics.getWorkerMetricsStatus().workers
        .filter((metric) => {
          const owner = this.ownerFor(metric.workerId);
          return !!owner && (!userId || owner === userId);
        })
        .map(sanitizeMetric);
      return { handled: true, result: { workers } };
    }
    if (name === "workers.metrics.get") {
      const workerId = required(args.workerId, "workerId");
      if (!this.ownerFor(workerId)) throw status(404, "Worker not found");
      const metric = this.deps.metrics.getWorkerMetric(workerId);
      return { handled: true, result: metric ? sanitizeMetric(metric) : { workerId, available: false } };
    }
    return { handled: false };
  }

  private ownerFor(workerId: string): string | undefined {
    return this.deps.containers.get(workerId)?.userId ?? this.deps.workers.findById(workerId)?.userId;
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw status(400, `${name} is required`);
  return value;
}
function optional(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return required(value, "userId");
}
function status(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
function safeNumber(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function safeString(value: unknown): string { return typeof value === "string" ? value : ""; }

function sanitizeUsage(statusValue: AgentUsageStatus): AgentUsageStatus {
  return {
    agents: (statusValue.agents ?? []).map((agent: AgentUsageInfo) => ({
      agentId: safeString(agent.agentId), displayName: safeString(agent.displayName),
      authType: agent.authType, usageAvailable: agent.usageAvailable === true,
      windows: (agent.windows ?? []).map((window) => ({
        label: safeString(window.label), utilization: Math.max(0, Math.min(100, safeNumber(window.utilization))),
        resetsAt: typeof window.resetsAt === "string" ? window.resetsAt : null,
      })),
      ...(typeof agent.planType === "string" ? { planType: agent.planType } : {}),
      ...(agent.error ? { error: "Usage data is currently unavailable" } : {}),
      ...(typeof agent.lastChecked === "string" ? { lastChecked: agent.lastChecked } : {}),
      ...(typeof agent.lastFetchTime === "string" ? { lastFetchTime: agent.lastFetchTime } : {}),
    })),
  };
}

function sanitizeMetric(metric: WorkerMetrics): WorkerMetrics {
  return {
    workerId: safeString(metric.workerId), containerName: safeString(metric.containerName), displayName: safeString(metric.displayName), status: metric.status,
    cpuUtilization: safeNumber(metric.cpuUtilization), memoryUsedBytes: safeNumber(metric.memoryUsedBytes), memoryLimitBytes: safeNumber(metric.memoryLimitBytes), memoryUtilization: safeNumber(metric.memoryUtilization), diskUsedBytes: safeNumber(metric.diskUsedBytes), netRxBytesPerSec: safeNumber(metric.netRxBytesPerSec), netTxBytesPerSec: safeNumber(metric.netTxBytesPerSec), blkReadBytesPerSec: safeNumber(metric.blkReadBytesPerSec), blkWriteBytesPerSec: safeNumber(metric.blkWriteBytesPerSec), lastChecked: safeString(metric.lastChecked),
    ...(metric.error ? { error: "Metric sampling is currently unavailable" } : {}),
  };
}
