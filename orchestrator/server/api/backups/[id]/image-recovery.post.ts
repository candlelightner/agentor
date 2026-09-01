defineRouteMeta({
  openAPI: {
    tags: ["Backups"],
    summary: "Recover an embedded custom image definition",
    operationId: "startBackupImageRecovery",
    requestBody: {
      required: true,
      content: { "application/json": { schema: {
        type: "object", required: ["workspaceId"],
        properties: {
          workspaceId: { type: "string", minLength: 1 } as any,
          requestId: { type: "string", minLength: 1, maxLength: 200 } as any,
          startBuild: { type: "boolean", default: true },
        },
      } } },
    },
    responses: {
      202: { description: "Image recipe recovery queued; poll the returned backup job" },
      401: { description: "Unauthorized" }, 403: { description: "Forbidden" },
      404: { description: "Backup not found" }, 409: { description: "No portable custom image recipe is available" },
    },
  },
});

import { requireAuth } from "../../../utils/auth-helpers";
import { useBackupManager } from "../../../utils/backup-manager";

export default defineEventHandler(async (event) => {
  const user = requireAuth(event).user;
  const manager = useBackupManager();
  const artifact = await manager.getArtifact(getRouterParam(event, "id")!);
  if (!artifact) throw createError({ statusCode: 404, statusMessage: "Backup not found" });
  if (user.role !== "admin" && artifact.userId !== user.id)
    throw createError({ statusCode: 403, statusMessage: "Forbidden" });
  const body = await readBody<{ workspaceId?: unknown; requestId?: unknown; startBuild?: unknown }>(event) ?? {};
  if (typeof body.workspaceId !== "string" || !body.workspaceId || body.workspaceId.length > 200 || /[\0\r\n]/.test(body.workspaceId))
    throw createError({ statusCode: 400, statusMessage: "A valid backup workspace must be selected" });
  if (body.requestId !== undefined && (typeof body.requestId !== "string" || body.requestId.length < 1 || body.requestId.length > 200 || /[\0\r\n]/.test(body.requestId)))
    throw createError({ statusCode: 400, statusMessage: "Invalid request identity" });
  if (body.startBuild !== undefined && typeof body.startBuild !== "boolean")
    throw createError({ statusCode: 400, statusMessage: "startBuild must be boolean" });
  try {
    const job = await manager.createImageRecovery(
      artifact.userId, artifact.id, body.workspaceId, body.requestId,
      body.startBuild !== false,
    );
    setResponseStatus(event, 202);
    return {
      jobId: job.id, status: job.status, phase: job.phase,
      next: {
        status: `/api/backup-jobs/${job.id}`,
        logs: `/api/backups/jobs/${job.id}/logs`,
        cancel: `/api/backup-jobs/${job.id}`,
      },
    };
  } catch (error: any) {
    throw createError({ statusCode: error?.statusCode ?? 400, statusMessage: error?.message ?? "Unable to recover image definition" });
  }
});
