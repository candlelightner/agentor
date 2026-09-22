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
  backupCoverage: "selected" | "not-configured" | "unknown";
  createdAt?: string;
  managed: boolean;
  canDelete: boolean;
  error?: string;
}
