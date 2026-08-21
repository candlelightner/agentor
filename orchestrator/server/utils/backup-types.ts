export type BackupProviderKind = 'local' | 'fake' | 'google-drive';
export type BackupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

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
}
export interface BackupArtifact {
  schemaVersion: 1; id: string; userId: string; workspaceId: string; provider: BackupProviderKind;
  providerObjectId: string; createdAt: string; size: number; sha256: string; sourceWorkerId?: string;
  missingSecrets: string[];
  workspaceIds?: string[];
  deletionPending?: boolean;
  deletionErrorAt?: string;
  selectedPathsByWorkspace?: Record<string, string[]>;
}
