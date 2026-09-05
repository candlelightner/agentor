import { createError, getRequestURL } from "h3";
import {
  instanceControlPlaneBarrierKind,
  instanceSnapshotActive,
  instanceSnapshotJobId,
} from "../utils/instance-snapshot-gate";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export default defineEventHandler((event) => {
  if (!instanceSnapshotActive() || READ_METHODS.has(event.method)) return;
  const path = getRequestURL(event).pathname;
  // Cancellation is the only mutation that remains useful during the barrier.
  // The manager validates the exact job identity and aborts its streams.
  if (
    event.method === "DELETE" &&
    path ===
      `/api/admin/instance-backups/jobs/${encodeURIComponent(instanceSnapshotJobId()!)}`
  )
    return;
  throw createError({
    statusCode: 423,
    statusMessage:
      instanceControlPlaneBarrierKind() === "restore"
        ? "Agentor control-plane mutations are locked while a verified whole-instance restore is being staged and applied."
        : "Agentor control-plane mutations are temporarily paused while a consistent instance snapshot is being created.",
  });
});
