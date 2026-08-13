import { test, expect } from "@playwright/test";
import { ManagementStatusDomain } from "../../orchestrator/server/utils/management-status-domain";

const metric = (workerId: string, error?: string): any => ({ workerId, containerName: `agentor-worker-${workerId}`, displayName: workerId, status: "running", cpuUtilization: 12, memoryUsedBytes: 3, memoryLimitBytes: 4, memoryUtilization: 75, diskUsedBytes: 5, netRxBytesPerSec: 6, netTxBytesPerSec: 7, blkReadBytesPerSec: 8, blkWriteBytesPerSec: 9, lastChecked: "2026-01-01T00:00:00.000Z", ...(error ? { error } : {}) });

function domain() {
  const metrics = [metric("alice-worker", "/run/docker.sock denied"), metric("bob-worker")];
  return new ManagementStatusDomain({
    usage: { getStatus: (userId: string) => ({ agents: [{ agentId: "codex", displayName: "Codex", authType: "oauth", usageAvailable: false, windows: [{ label: "five hour", utilization: 125, resetsAt: null }], error: `token for ${userId}` }] }) } as any,
    metrics: { getWorkerMetricsStatus: () => ({ workers: metrics }), getWorkerMetric: (id: string) => metrics.find((item) => item.workerId === id) } as any,
    containers: { get: (id: string) => id === "alice-worker" ? ({ userId: "alice" } as any) : undefined },
    workers: { findById: (id: string) => id === "bob-worker" ? ({ userId: "bob" } as any) : undefined },
  });
}

test("status domain exposes only read-only usage and metrics tools", () => {
  const tools = domain().tools();
  expect(tools.map((tool) => tool.name)).toEqual(["usage.get", "workers.metrics", "workers.metrics.get"]);
  for (const tool of tools) expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
});

test("status domain owner-filters metrics and redacts provider/docker errors", async () => {
  const adapter = domain();
  const alice = await adapter.execute("workers.metrics", { userId: "alice" });
  expect((alice.result as any).workers).toHaveLength(1);
  expect((alice.result as any).workers[0]).toMatchObject({ workerId: "alice-worker", error: "Metric sampling is currently unavailable" });
  expect(JSON.stringify(alice.result)).not.toContain("docker.sock");
  const usage = await adapter.execute("usage.get", { userId: "alice" });
  expect((usage.result as any).agents[0]).toMatchObject({ error: "Usage data is currently unavailable", windows: [{ utilization: 100 }] });
  expect(JSON.stringify(usage.result)).not.toContain("token for");
});

test("status domain rejects missing owner/worker and does not disclose unknown metrics", async () => {
  const adapter = domain();
  await expect(adapter.execute("usage.get", {})).rejects.toMatchObject({ statusCode: 400 });
  await expect(adapter.execute("workers.metrics.get", { workerId: "gone" })).rejects.toMatchObject({ statusCode: 404 });
  await expect(adapter.execute("workers.metrics.get", {})).rejects.toMatchObject({ statusCode: 400 });
  expect(await adapter.execute("other.tool", {})).toEqual({ handled: false });
});
