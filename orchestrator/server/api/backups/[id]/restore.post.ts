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
  }>(event);
  const target = body?.target ?? "new";
  if (target !== "new" && target !== "original")
    throw createError({ statusCode: 400, statusMessage: "Invalid restore target" });
  if (target === "original") {
    const worker = useContainerManager().get(
      artifact.sourceWorkerId ?? artifact.workspaceId,
    );
    if (worker?.status === "running" || !body?.confirmOverwrite)
      throw createError({
        statusCode: 409,
        statusMessage: "Stop the original worker and confirm safe overwrite",
      });
  }
  const job = await manager.createRestore(
    artifact.userId,
    artifact,
    target,
    body?.displayName,
    body?.lockPassword,
  );
  setResponseStatus(event, 202);
  return { jobId: job.id };
});
