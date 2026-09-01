defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Start restore",
    operationId: "startRestore",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: {
              target: { type: "string", enum: ["new", "original"] },
              displayName: { type: "string" },
              workspaceIds: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true, description: "Optional non-empty, duplicate-free exact subset of artifact workspaces; omit to restore all members" } as any,
              requestId: { type: "string", maxLength: 200 } as any,
              imageResolutions: {
                type: "object",
                description:
                  "Per-workspace exact, explicit replacement, or acknowledged workspace-only image resolution.",
              },
              confirmOverwrite: { type: "boolean" },
              lockPassword: {
                type: "string",
                writeOnly: true,
                description:
                  "Required for an original-worker restore when that worker is protected",
              },
            },
          },
        },
      },
    },
    responses: {
      202: { description: "Restore queued" },
      400: { description: "Invalid restore target" },
      409: { description: "Unsafe original restore" },
      423: { description: "Correct worker lock password required" },
      401: { description: "Unauthorized" },
      403: { description: "Forbidden" },
      404: { description: "Not found" },
    },
  },
});

import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";
import { useContainerManager } from "../../../utils/services";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const manager = useBackupManager();
  const artifact = await manager.getArtifact(getRouterParam(event, "id")!);
  if (!artifact)
    throw createError({ statusCode: 404, statusMessage: "Backup not found" });
  if (user.role !== "admin" && artifact.userId !== user.id)
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  const body = await readBody<{
    target?: "new" | "original";
    displayName?: string;
    confirmOverwrite?: boolean;
    lockPassword?: unknown;
    workspaceIds?: string[];
    requestId?: string;
    imageResolutions?: Record<
      string,
      | { mode: "exact" }
      | { mode: "workspace-only"; acknowledged: true }
      | {
          mode: "replacement";
          imageDefinitionId: string;
          imageVersion: string;
        }
    >;
  }>(event);
  const target = body?.target ?? "new";
  if (target !== "new" && target !== "original")
    throw createError({ statusCode: 400, statusMessage: "Invalid restore target" });
  if (body?.displayName !== undefined && typeof body.displayName !== "string")
    throw createError({ statusCode: 400, statusMessage: "Invalid display name" });
  if (body?.confirmOverwrite !== undefined && typeof body.confirmOverwrite !== "boolean")
    throw createError({ statusCode: 400, statusMessage: "Invalid overwrite confirmation" });
  if (target === "original") {
    const artifactWorkspaceIds = artifact.workspaceIds ?? [artifact.workspaceId];
    const selected = body?.workspaceIds ?? artifactWorkspaceIds;
    if (!Array.isArray(selected) || selected.length !== 1 || typeof selected[0] !== "string" || !artifactWorkspaceIds.includes(selected[0]))
      throw createError({ statusCode: 400, statusMessage: "Original restore requires selecting exactly one backup workspace" });
    const source = selected[0]!;
    const worker = useContainerManager().get(source);
    if (!worker || worker.userId !== artifact.userId || worker.status !== "stopped" || !body?.confirmOverwrite)
      throw createError({
        statusCode: 409,
        statusMessage: "Stop the original worker and confirm safe overwrite",
      });
  }
  let job;
  try {
    job = await manager.createRestore(
      artifact.userId,
      artifact,
      target,
      body?.displayName,
      body?.lockPassword,
      body?.workspaceIds,
      body?.requestId,
      body?.imageResolutions,
    );
  } catch (error: any) {
    if (typeof error?.statusCode === "number") throw error;
    throw createError({
      statusCode: 400,
      statusMessage:
        error instanceof Error ? error.message : "Invalid restore request",
      data: error?.data,
    });
  }
  setResponseStatus(event, 202);
  return {
    jobId: job.id,
    status: job.status,
    next: {
      status: `/api/backup-jobs/${job.id}`,
      logs: `/api/backups/jobs/${job.id}/logs`,
      cancel: `/api/backup-jobs/${job.id}`,
    },
  };
});
