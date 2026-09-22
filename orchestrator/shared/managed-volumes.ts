/** Public volume metadata deliberately excludes Docker/host storage paths. */
export type VolumeApplyMode = "deferred" | "recreate" | "live";
export type ManagedVolumeState = "pending" | "preparing" | "ready" | "failed" | "detached";

export interface PersistencePolicy {
  workerId: string;
  userId: string;
  selfService: boolean;
  allowSelfRecreate: boolean;
  allowLiveMount: boolean;
}

export interface ManagedVolume {
  id: string;
  userId: string;
  name: string;
  purpose: "persistent-path" | "legacy-backup-path";
  workerId: string;
  target: string;
  attached: boolean;
  state: ManagedVolumeState;
  createdAt: string;
  updatedAt: string;
  retainedAfterAccountDeletion?: boolean;
  operation?: {
    id: string;
    mode: VolumeApplyMode;
    stage: "queued" | "copying" | "mounting" | "recreating" | "complete" | "failed";
    error?: string;
  };
}

export type VolumeSizeState = "known" | "stale" | "unknown";
export type VolumeSizeJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface VolumeSizeMeasurement {
  state: VolumeSizeState;
  /** Allocated filesystem blocks. This is the disk-usage figure shown first. */
  allocatedBytes: number | null;
  /** Sum of regular-file lengths, with hard links counted once. */
  logicalBytes: number | null;
  measuredAt?: string;
  source?: "bounded-read-only-scan";
  consistency?: "offline-read-only" | "live-approximate";
  reason?: "not-measured" | "stale" | "volume-unavailable" | "incarnation-changed" | "scan-failed";
}

export interface PublicVolumeSizeJob {
  id: string;
  volumeId: string;
  status: VolumeSizeJobStatus;
  phase: "queued" | "validating" | "scanning" | "complete" | "failed" | "cancelled";
  progress: number;
  entriesScanned: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  measurement?: VolumeSizeMeasurement;
}

export interface VolumeInventoryItem {
  id: string;
  name: string;
  userId?: string;
  purpose: string;
  workerId?: string;
  workerName?: string;
  target?: string;
  desired: boolean;
  observed: "mounted" | "unmounted" | "missing" | "unknown";
  state: string;
  sizeBytes: number | null;
  logicalSizeBytes?: number | null;
  size: VolumeSizeMeasurement;
  sizeJob?: PublicVolumeSizeJob;
  canMeasureSize: boolean;
  backupCoverage: "selected" | "not-configured" | "unknown";
  createdAt?: string;
  managed: boolean;
  canDelete: boolean;
  error?: string;
}
