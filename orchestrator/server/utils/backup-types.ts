export type BackupProviderKind = 'local' | 'fake' | 'google-drive';
export type BackupJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface BackupConfig {
  schemaVersion: 1; userId: string; provider: BackupProviderKind; enabled: boolean;
  /** Exact schedule interval. `intervalHours` remains readable for v1 data. */
  intervalMinutes: number; intervalHours?: number; retentionCount: number; selectedWorkspaceIds: string[] | null;
  createdAt: string; updatedAt: string; nextRunAt?: string | null;
  lastAttemptAt?: string; lastSuccessAt?: string; lastError?: string; consecutiveFailures?: number;
  google?: { clientId?: string; redirectUri?: string; token?: unknown; oauthPending?: { stateHash: string; expiresAt: number } };
}
export interface BackupJob {
  schemaVersion: 1; id: string; userId: string; workspaceId: string; provider: BackupProviderKind;
  status: BackupJobStatus; phase: string; progress: number; bytesProcessed: number;
  createdAt: string; updatedAt: string; startedAt?: string; completedAt?: string; error?: string;
  artifactId?: string; size?: number; durationMs?: number; sha256?: string; attempt: number;
  ownerId?: string; workspaceIds?: string[]; backupId?: string; sizeBytes?: number;
  encrypted?: boolean; integrityVerified?: boolean; providerUploadId?: string; resumedFromChunk?: number;
  consistency?: {workerState:string;strategy:string;warning:string}; target?:'new'|'original';workerId?:string;
  missingSecrets?: Array<{name:string;type:string}>;
}
export interface BackupArtifact {
  schemaVersion: 1; id: string; userId: string; workspaceId: string; provider: BackupProviderKind;
  providerObjectId: string; createdAt: string; size: number; sha256: string; sourceWorkerId?: string;
  missingSecrets: string[];
  workspaceIds?: string[];
  deletionPending?: boolean;
  deletionErrorAt?: string;
}
