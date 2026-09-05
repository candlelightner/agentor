export type BackupProviderKind = 'local' | 'fake' | 'google-drive';
export type BackupArtifactKind = 'worker' | 'instance';
export type BackupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** A bounded, provider-supplied description. It is deliberately free of a
 * provider account owner, archive paths, and any credential material. */
export interface RemoteBackupDescriptor {
  objectId: string;
  size: number;
  /** Provider-side selector only. The downloaded authenticated envelope stays
   * authoritative; this prevents instance DR objects entering worker restore. */
  artifactKind?: BackupArtifactKind;
  createdAt?: string;
  artifactId?: string;
  formatVersion?: number;
  keyFingerprint?: string;
  integritySha256?: string;
  incomplete?: boolean;
}

/** Persisted discovery state is owner-scoped even when a provider account is
 * deliberately linked by more than one Agentor installation. */
export interface RemoteBackupRecord {
  schemaVersion: 1;
  id: string;
  userId: string;
  provider: BackupProviderKind;
  providerObjectId: string;
  discoveredAt: string;
  lastSeenAt: string;
  remote: RemoteBackupDescriptor;
  adoptedArtifactId?: string;
  state?: 'discovered'|'missing-key'|'unsupported-format'|'too-large'|'incomplete'|'inaccessible'|'damaged'|'ready-to-adopt'|'adopted';
  integrityStatus?: 'unverified'|'verified'|'failed';
  blockedReason?: string;
  sourceInstallationId?: string;
  keyFingerprint?: string;
  formatVersion?: number;
  workspaceIds?: string[];
  workspaceMembers?: Array<{id:string;displayName?:string}>;
  lastErrorAt?: string;
}

export type BackupImageResolution =
  | { mode: 'exact' }
  | { mode: 'workspace-only'; acknowledged: true }
  | { mode: 'replacement'; imageDefinitionId: string; imageVersion: string };

export interface BackupDependency {
  kind: 'image'|'plugin'|'secret'|'template';
  id: string;
  workspaceId?: string;
  status: 'resolved'|'missing'|'replacement-required'|'warning';
  required?: boolean;
  reason?: string;
}

export interface BackupWorkspaceReconstructionSummary {
  workspaceId: string;
  displayName?: string;
  image: {kind:'legacy'|'platform-default'|'unmanaged'|'custom';definitionId?:string;version?:string;digest?:string;runtimeImageAvailable?:boolean;/** A validated recipe remains encrypted in the artifact and can be recovered asynchronously. */ recoveryAvailable?:boolean;catalogSource?:{kind:'git';connectionId:string;remoteId:string;hash:string}};
  pluginDefinitions: Array<{sourceId:string;name:string;version:string}>;
  desiredPluginCount: number;
  requiredSecretNames: string[];
}

export interface BackupConfig {
  schemaVersion: 1; userId: string; provider: BackupProviderKind; enabled: boolean;
  /** Exact schedule interval. `intervalHours` remains readable for v1 data. */
  intervalMinutes: number; intervalHours?: number; retentionCount: number; selectedWorkspaceIds: string[] | null;
  createdAt: string; updatedAt: string; nextRunAt?: string | null;
  /** Optional, explicit absolute paths per worker. Omission preserves the
   * legacy portable payload (/workspace plus filtered agent data). */
  selectedPathsByWorkspace?: Record<string, string[]>;
  lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; consecutiveFailures?: number;
  google?: { clientId?: string; redirectUri?: string; token?: unknown; oauthPending?: { stateHash: string; expiresAt: number } };
}
export interface BackupJob {
  schemaVersion: 1; id: string; userId: string; workspaceId: string; provider: BackupProviderKind;
  status: BackupJobStatus; phase: string; progress: number; bytesProcessed: number;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string; error?: string;
  /** Sanitized stable failure diagnostics; provider bodies, tokens, and
   * resumable-session URLs are never persisted or returned. */
  errorCode?: string; providerStatus?: number; retryable?: boolean;
  artifactId?: string; size?: number; durationMs?: number; sha256?: string; attempt: number;
  ownerId?: string; workspaceIds?: string[]; backupId?: string; sizeBytes?: number;
  /** Restore-only provenance and the exact selected artifact subset. */
  artifactWorkspaceIds?: string[]; selectedWorkspaceIds?: string[];
  encrypted?: boolean; integrityVerified?: boolean; providerUploadId?: string; resumedFromChunk?: number;
  /** Durable cleanup marker set before a provider upload begins and replaced
   * with the provider's authoritative object id after commit. */
  pendingProviderObjectId?: string;
  /** Stable Agentor artifact id used to reconcile providers that assign an
   * opaque object id after committing an upload. */
  pendingProviderArtifactId?: string;
  /** Durable resumable-upload abort marker retained until the provider
   * confirms cancellation. */
  pendingProviderUploadId?: string;
  consistency?: {workerState:string;strategy:string;warning:string}; target?:'new'|'original';workerId?:string;workerIds?:string[];
  /** Restore display name is retained so an interrupted restore can retry safely. */
  displayName?: string;
  missingSecrets?: Array<{name:string;type:string}>;
  selectedPathsByWorkspace?: Record<string, string[]>;
  /** Additive operation identity for persisted discovery/adoption/dependency
   * jobs. Existing backup and restore jobs intentionally remain valid. */
  operation?: 'backup'|'restore'|'discovery'|'adoption'|'dependency-resolution';
  requestId?: string;
  requestFingerprint?: string;
  remoteBackupId?: string;
  dependencies?: BackupDependency[];
  imageResolutions?: Record<string, BackupImageResolution>;
  /** Result of an asynchronous portable image-definition recovery. The
   * recipe itself stays in the authenticated backup bundle, never here. */
  recoveredImageDefinitionId?: string;
  recoveredImageBuildId?: string;
  recoverImageStartBuild?: boolean;
  restoreMappings?: Array<{sourceWorkspaceId:string;workerId:string}>;
  logs?: string[];
}
export interface BackupArtifact {
  schemaVersion: 1; id: string; userId: string; workspaceId: string; provider: BackupProviderKind;
  providerObjectId: string; createdAt: string; size: number; sha256: string; sourceWorkerId?: string;
  missingSecrets: string[];
  workspaceIds?: string[];
  deletionPending?: boolean;
  deletionErrorAt?: string;
  selectedPathsByWorkspace?: Record<string, string[]>;
  formatVersion?: number;
  keyFingerprint?: string;
  sourceInstallationId?: string;
  integrityStatus?: 'verified'|'failed'|'unavailable';
  provenance?: 'local'|'remote-adopted';
  workspaceMembers?: Array<{id:string;displayName?:string}>;
  reconstruction?: BackupWorkspaceReconstructionSummary[];
  /** Last persisted dependency assessment from authenticated archive
   * inspection. Restore admission rechecks image selections against the
   * current catalog before starting any worker mutation. */
  dependencies?: BackupDependency[];
}
