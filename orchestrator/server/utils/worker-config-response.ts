import type { WorkerRecord } from './worker-store';
import type { ContainerInfo } from '../../shared/types';
import { DEFAULT_ENVIRONMENT_ID } from './environments';
import { WORKER_SYSTEM_ENV_VARS } from './user-env-store';
import { parseDotEnv, useWorkerConfigStore, type EffectiveScopeEntry } from './worker-config-store';
import { useEnvironmentStore, useUserEnvStore } from './services';

const SENSITIVE_NAME_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i;

export async function workerConfigurationResponse(worker: WorkerRecord | ContainerInfo) {
  const store = useWorkerConfigStore();
  const record = await store.get(worker.userId, worker.id);
  const local = { variables: [] as any[], secrets: [] as any[], secretFiles: [] as any[] };
  for (const entry of record?.entries ?? []) {
    if (entry.kind === 'variable') local.variables.push({ key: entry.key, value: entry.value });
    else if (entry.kind === 'secret') local.secrets.push({ key: entry.key, configured: true, masked: true, encryptedAtRest: true });
    else local.secretFiles.push({ name: entry.key, path: entry.fileName, configured: true, encryptedAtRest: true });
  }
  const broader: EffectiveScopeEntry[] = WORKER_SYSTEM_ENV_VARS.map((entry) => ({ key: entry.name, source: 'orchestrator', secret: true }));
  for (const entry of useUserEnvStore().getOrDefault(worker.userId).envVars) {
    const secret = SENSITIVE_NAME_RE.test(entry.key);
    broader.push({ key: entry.key, source: 'user', value: secret ? undefined : entry.value, secret });
  }
  const environment = useEnvironmentStore().getById(worker.environmentId || DEFAULT_ENVIRONMENT_ID);
  if (environment?.envVars) {
    try {
      for (const entry of parseDotEnv(environment.envVars)) {
        const secret = SENSITIVE_NAME_RE.test(entry.key);
        broader.push({ key: entry.key, source: 'environment', value: secret ? undefined : entry.value, secret });
      }
    } catch { /* tolerate invalid legacy environment text */ }
  }
  const effective = (await store.effectivePreview(worker.userId, worker.id, broader))
    .filter((entry) => entry.kind !== 'secretFile')
    .map(({ kind, ...entry }) => ({ ...entry, type: kind }));
  return {
    local,
    effective,
    precedence: ['orchestrator', 'user', 'environment', 'worker'],
    pendingRebuild: !!worker.pendingRebuild || (!!record && record.appliedAt !== record.updatedAt),
    secretsEncryptedAtRest: true,
    storageFormat: 'aes-256-gcm-v1',
  };
}
