import type { WorkerSelfContext } from "./worker-auth";
import type { WorkerSelfMcpDomain, WorkerSelfMcpTool } from "./worker-self-mcp";
import { useManagedVolumeManager } from "./managed-volume-manager";
import { strictVolumeInput } from "./managed-volume-api";
import { volumeError } from "./managed-volume-store";

export class WorkerSelfStorageDomain implements WorkerSelfMcpDomain {
  async tools(context: WorkerSelfContext): Promise<WorkerSelfMcpTool[]> {
    const manager = useManagedVolumeManager(); await manager.init();
    if (context.authority && context.authority.kind !== "ordinary" ||
        !manager.policies.policy(context.userId, context.workerId).selfService) return [];
    return [
      { name: "storage.inspect", description: "Inspect this worker's persistent directories and operation status. Local persistence is not a backup.",
        inputSchema: { type: "object", additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false } },
      { name: "storage.add", description: "Request local persistence for an application directory on this worker only. Repeating a target is idempotent. Application mode follows owner policy; pending requests await owner/admin application. No removal or privilege changes are allowed.",
        inputSchema: { type: "object", additionalProperties: false, required: ["target"], properties: { target: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1, maxLength: 100 } } },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
    ];
  }
  async invoke(context: WorkerSelfContext, name: string, args: Record<string, unknown>) {
    if (context.authority && context.authority.kind !== "ordinary") throw volumeError(403, "Use administrative storage tools for this workspace.");
    const actor = { userId: context.userId, workerId: context.workerId, selfService: true };
    if (name === "storage.inspect") { strictVolumeInput(args, []); return useManagedVolumeManager().inspect(actor); }
    if (name === "storage.add") return useManagedVolumeManager().add(actor, strictVolumeInput(args, ["target", "name"]));
    throw volumeError(404, "Unknown worker storage tool.");
  }
}
