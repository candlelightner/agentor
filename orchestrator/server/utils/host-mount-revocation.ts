import { createError } from "h3";
import { useContainerManager } from "./services";

/** Grants are already durably revoked when this runs. Failure is therefore
 * reported as a committed security transition needing operator attention,
 * never as though the old grant were still valid. */
export async function enforceHostMountRevocation(userId?: string) {
  const result = await useContainerManager().reconcileHostMountAccess(userId);
  if (result.failures.length)
    throw createError({
      statusCode: 409,
      statusMessage:
        "Host mount access was revoked, but one or more affected workers could not be stopped. The desired mounts were removed and restart is blocked; stop or rebuild those workers immediately.",
      data: { revocationCommitted: true, ...result },
    });
  return result;
}
