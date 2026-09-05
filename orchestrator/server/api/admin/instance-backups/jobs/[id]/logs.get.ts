import { requireAdmin } from "../../../../../utils/auth-helpers";
import { useInstanceBackupManager } from "../../../../../utils/instance-backup-manager";

export default defineEventHandler(async (event) => {
  const admin = requireAdmin(event);
  const manager = useInstanceBackupManager();
  const id = getRouterParam(event, "id")!;
  const job = await manager.getJob(id);
  if (!job || job.userId !== admin.user.id)
    throw createError({ statusCode: 404, statusMessage: "Instance backup job not found" });
  const query = getQuery(event);
  const after = integerQuery(query.after, "after", 0, Number.MAX_SAFE_INTEGER, 0);
  const limit = integerQuery(query.limit, "limit", 1, 200, 100);
  return manager.logs(id, after, limit);
});

function integerQuery(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  const parsed = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw createError({
      statusCode: 400,
      statusMessage: `${field} must be an integer between ${minimum} and ${maximum}`,
    });
  return parsed;
}
