import type { BackupProviderKind, RemoteBackupDescriptor } from "./backup-types";

export type InstanceBackupJobStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type InstanceBackupOperation =
  | "create"
  | "discovery"
  | "adoption"
  | "verify"
  | "restore";

export interface InstanceBackupOptions {
  includeWorkers: boolean;
  includeAgentData: boolean;
  includeDockerVolumes: boolean;
  includeLocalBackups: boolean;
  includeLogs: boolean;
}

export interface InstanceRestoreOptions {
  restoreDockerVolumes: boolean;
  restoreHostMountPolicies: boolean;
  confirmReplaceControlPlane: boolean;
  confirmExternalDependencies: boolean;
}

export interface InstanceRestorePreflight {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  sourceInstallationId: string;
  sourceStorageMode: "directory" | "volume";
  destinationStorageMode: "directory" | "volume";
  sourceContainerPrefix: string;
  destinationContainerPrefix: string;
  volumeConflicts: string[];
  hostMountPaths: string[];
  imageDigestsNotEmbedded: string[];
}

export interface InstanceBackupVolumeManifest {
  name: string;
  kind:
    | "worker-workspace"
    | "worker-agent-data"
    | "worker-dind"
    | "admin-workspace"
    | "admin-agent-data"
    | "persistent-path"
    | "traefik-certificates";
  ownerId?: string;
  workerId?: string;
  groupId?: string;
  archive: string;
  sha256: string;
  size: number;
}

export interface InstanceBackupHostMountInventory {
  configuredPaths: string[];
  /** Host contents are deliberately not copied through this control-plane
   * inventory. They must be migrated and approved on the destination host. */
  contentsIncluded: false;
}

export interface InstanceBackupImageInventory {
  definitions: number;
  immutableDigests: string[];
  /** Docker image layers are not silently copied with DATA_DIR. */
  layersIncluded: false;
}

export interface InstanceBackupManifest {
  kind: "agentor-instance-backup";
  formatVersion: 1;
  backupId: string;
  sourceInstallationId: string;
  /** Platform administrator who created the encrypted instance artifact. This
   * is inside the authenticated encrypted manifest and lets the restore helper
   * retain terminal recovery-job visibility after auth.db is replaced. */
  createdByUserId: string;
  createdAt: string;
  agentorVersion: string;
  storage: {
    mode: "directory" | "volume";
    containerPrefix: string;
  };
  options: InstanceBackupOptions;
  dataArchive: { archive: "data.tar.gz"; sha256: string; size: number };
  volumes: InstanceBackupVolumeManifest[];
  plugins: {
    platformDefinitionCount: number;
    ownerDefinitionCount: number;
    installationCount: number;
  };
  hostMounts: InstanceBackupHostMountInventory;
  images: InstanceBackupImageInventory;
  excludedDataPaths: string[];
}

export interface InstanceBackupJob {
  schemaVersion: 1;
  id: string;
  userId: string;
  operation: InstanceBackupOperation;
  provider: BackupProviderKind;
  status: InstanceBackupJobStatus;
  phase: string;
  progress: number;
  bytesProcessed: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  requestId?: string;
  requestFingerprint?: string;
  artifactId?: string;
  remoteBackupId?: string;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  logs: string[];
  pendingProviderObjectId?: string;
  pendingProviderUploadId?: string;
}

/** Safe job shape returned through GUI/API/MCP status surfaces. Detailed log
 * lines are available only from the bounded incremental log operation. */
export type PublicInstanceBackupJob = Omit<
  InstanceBackupJob,
  "logs" | "pendingProviderObjectId" | "pendingProviderUploadId"
> & {
  logLineCount: number;
};

export interface InstanceBackupArtifact {
  schemaVersion: 1;
  id: string;
  userId: string;
  provider: BackupProviderKind;
  providerObjectId: string;
  createdAt: string;
  size: number;
  sha256: string;
  keyFingerprint: string;
  sourceInstallationId: string;
  formatVersion: 1;
  integrityStatus: "verified" | "failed" | "unavailable";
  provenance: "local" | "remote-adopted";
  manifest?: InstanceBackupManifest;
}

export interface RemoteInstanceBackupRecord {
  schemaVersion: 1;
  id: string;
  userId: string;
  provider: BackupProviderKind;
  providerObjectId: string;
  discoveredAt: string;
  lastSeenAt: string;
  remote: RemoteBackupDescriptor;
  state:
    | "discovered"
    | "missing-key"
    | "unsupported-format"
    | "too-large"
    | "incomplete"
    | "inaccessible"
    | "damaged"
    | "ready-to-adopt"
    | "adopted";
  keyFingerprint?: string;
  sourceInstallationId?: string;
  formatVersion?: number;
  blockedReason?: string;
  adoptedArtifactId?: string;
}

export interface InstanceBackupState {
  schemaVersion: 1;
  jobs: InstanceBackupJob[];
  artifacts: InstanceBackupArtifact[];
  remoteBackups: RemoteInstanceBackupRecord[];
}

export const DEFAULT_INSTANCE_BACKUP_OPTIONS: InstanceBackupOptions = {
  includeWorkers: true,
  includeAgentData: true,
  includeDockerVolumes: true,
  includeLocalBackups: false,
  includeLogs: false,
};
