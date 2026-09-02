import Docker from "dockerode";
import { loadConfig } from "./config";
import { DockerService } from "./docker";
import { ContainerManager } from "./container";
import { PortMappingStore } from "./port-mapping-store";
import { DomainMappingStore } from "./domain-mapping-store";
import { TraefikManager } from "./traefik-manager";
import { EnvironmentStore } from "./environments";
import { WorkerStore } from "./worker-store";
import { UpdateChecker } from "./update-checker";
import { UsageChecker } from "./usage-checker";
import { ResourceMonitor } from "./resource-monitor";
import { UserCredentialManager } from "./user-credentials";
import { UserEnvVarStore } from "./user-env-store";
import { OrphanSweeper } from "./orphan-sweeper";
import { CapabilityStore } from "./capability-store";
import { InstructionStore } from "./instruction-store";
import { InitScriptStore } from "./init-script-store";
import { StorageManager } from "./storage";
import { SelfSignedCertManager } from "./selfsigned-certs";
import { LogStore } from "./log-store";
import { LogBroadcaster } from "./log-broadcaster";
import { Logger } from "./logger";
import { LogCollector } from "./log-collector";
import { ExportJobManager } from "./export-jobs";
import { WorkerGroupStore } from "./worker-group-store";
import { ManagedNetworkStore } from "./managed-network-store";
import { WorkerGroupEnvStore } from "./worker-group-env-store";
import { PluginDefinitionStore } from "./plugin-definition-store";
import { PluginInstallationStore } from "./plugin-installation-store";
import {
  DockerPluginWorkerExecutor,
  PluginRuntimeManager,
} from "./plugin-runtime-manager";
import { definitionVisibleToWorker, definitionVisibleToPluginSelf } from "./plugin-scope";
import type { WorkerSelfAuthority } from "./worker-auth";
import { useGroupAdminWorkspaceStore } from "./group-admin-workspace-store";
import { PersistentBackupPathManager } from "./persistent-backup-paths";
import { HostMountStore } from "./host-mount-store";

function singleton<T>(factory: () => T): () => T {
  let instance: T | undefined;
  return () => {
    if (!instance) instance = factory();
    return instance;
  };
}

export const useConfig = singleton(() => loadConfig());
export const useDockerService = singleton(() => new DockerService(useConfig()));
export const useStorageManager = singleton(
  () =>
    new StorageManager(
      new Docker({ socketPath: "/var/run/docker.sock" }),
      useConfig(),
    ),
);
export const useContainerManager = singleton(
  () => new ContainerManager(useDockerService(), useConfig()),
);
export const usePersistentBackupPathManager = singleton(
  () =>
    new PersistentBackupPathManager(
      useConfig(),
      (id) => useContainerManager().get(id),
      async (id, path) => {
        try {
          await useContainerManager().listBackupPaths(id, path);
          return true;
        } catch (error: any) {
          if (error?.statusCode === 409) return false;
          throw error;
        }
      },
    ),
);
export const usePortMappingStore = singleton(
  () => new PortMappingStore(useConfig().dataDir),
);
export const useDomainMappingStore = singleton(
  () => new DomainMappingStore(useConfig().dataDir),
);
export const useSelfSignedCertManager = singleton(
  () => new SelfSignedCertManager(useConfig().dataDir),
);
export const useTraefikManager = singleton(
  () =>
    new TraefikManager(
      useConfig(),
      useDomainMappingStore(),
      usePortMappingStore(),
      useStorageManager(),
      useSelfSignedCertManager(),
    ),
);
export const useEnvironmentStore = singleton(
  () => new EnvironmentStore(useConfig().dataDir),
);
export const useWorkerStore = singleton(
  () => new WorkerStore(useConfig().dataDir),
);
export const useWorkerGroupStore = singleton(
  () => new WorkerGroupStore(useConfig().dataDir),
);
export const useHostMountStore = singleton(
  () =>
    new HostMountStore(
      useConfig().dataDir,
      () => useStorageManager().dataHostPath,
      useWorkerGroupStore(),
      useWorkerStore(),
    ),
);
export const useWorkerGroupEnvStore = singleton(
  () => new WorkerGroupEnvStore(useConfig()),
);
export const useManagedNetworkStore = singleton(
  () => new ManagedNetworkStore(useConfig().dataDir),
);
export const usePluginDefinitionStore = singleton(
  () => new PluginDefinitionStore(useConfig().dataDir),
);
export const usePluginInstallationStore = singleton(
  () => new PluginInstallationStore(useConfig().dataDir),
);
export const usePluginRuntimeManager = singleton(
  () =>
    new PluginRuntimeManager(
      usePluginDefinitionStore(),
      usePluginInstallationStore(),
      new DockerPluginWorkerExecutor(
        new Docker({ socketPath: "/var/run/docker.sock" }),
        (workerId) => {
          const worker = useContainerManager().get(workerId);
          return worker && worker.status === "running"
            ? worker.containerId
            : undefined;
        },
      ),
      {
        authorizeDefinition: (definition, installation) => {
          const worker = useContainerManager().get(installation.workerId);
          if (worker?.administrativeKind) {
            const authority: WorkerSelfAuthority | undefined = worker.administrativeKind === "group"
              ? (() => { const record = useGroupAdminWorkspaceStore().findByWorkspaceId(worker.id); return record ? { kind: "group-admin" as const, workspaceId: worker.id, groupId: record.groupId, ownerId: record.ownerId } : undefined; })()
              : { kind: "platform-admin", workspaceId: worker.id };
            return Boolean(worker.status === "running" && authority && definitionVisibleToPluginSelf(definition, authority, useWorkerGroupStore()));
          }
          return Boolean(
            worker &&
            worker.status === "running" &&
            worker.userId === installation.userId &&
            definitionVisibleToWorker(
              definition,
              { id: worker.id, userId: worker.userId },
              useWorkerGroupStore(),
            ),
          );
        },
      },
    ),
);
export const useUpdateChecker = singleton(() => new UpdateChecker(useConfig()));
export const useUsageChecker = singleton(() => new UsageChecker(useConfig()));
export const useResourceMonitor = singleton(
  () => new ResourceMonitor(useDockerService(), useContainerManager()),
);
export const useUserCredentialManager = singleton(
  () => new UserCredentialManager(useStorageManager()),
);
export const useUserEnvStore = singleton(
  () => new UserEnvVarStore(useConfig().dataDir),
);
export const useOrphanSweeper = singleton(
  () =>
    new OrphanSweeper(
      useUserEnvStore(),
      useUserCredentialManager(),
      useUsageChecker(),
      useWorkerStore(),
      usePortMappingStore(),
      useDomainMappingStore(),
      useEnvironmentStore(),
      useCapabilityStore(),
      useInstructionStore(),
      useInitScriptStore(),
      useExportJobManager(),
    ),
);
export const useCapabilityStore = singleton(
  () => new CapabilityStore(useConfig().dataDir),
);
export const useInstructionStore = singleton(
  () => new InstructionStore(useConfig().dataDir),
);
export const useInitScriptStore = singleton(
  () => new InitScriptStore(useConfig().dataDir),
);
export const useLogStore = singleton(() => new LogStore(useConfig()));
export const useLogBroadcaster = singleton(() => new LogBroadcaster());
export const useLogger = singleton(
  () => new Logger(useConfig(), useLogStore(), useLogBroadcaster()),
);
export const useLogCollector = singleton(
  () => new LogCollector(useConfig(), useLogStore(), useLogBroadcaster()),
);
export const useExportJobManager = singleton(
  () =>
    new ExportJobManager(
      useConfig().dataDir,
      (workerId, opts) => useContainerManager().exportWorker(workerId, opts),
      (message) => useLogger().error(message),
    ),
);

/**
 * Removes all port and domain mappings for a worker (keyed by its globally
 * unique Docker container name) and reconciles Traefik if any were removed.
 * Called when a worker is permanently deleted — mappings are preserved across
 * stop, archive, unarchive, and rebuild because the container name is stable.
 */
export async function cleanupWorkerMappings(
  containerName: string,
): Promise<void> {
  const portRemoved =
    await usePortMappingStore().removeForContainerName(containerName);
  const domainRemoved =
    await useDomainMappingStore().removeForContainerName(containerName);
  if (portRemoved > 0 || domainRemoved > 0)
    await useTraefikManager().reconcile();
}

/**
 * Reconcile Traefik after a worker rebuild/unarchive. Traefik routes to workers
 * by name via Docker DNS so a fresh lookup automatically picks up the new
 * container — this just ensures Traefik is running and its config is current
 * (idempotent when nothing changed).
 */
export async function reassignWorkerMappings(
  containerName: string,
): Promise<void> {
  const hasPort = usePortMappingStore()
    .list()
    .some((m) => m.containerName === containerName);
  const hasDomain = useDomainMappingStore()
    .list()
    .some((m) => m.containerName === containerName);
  if (hasPort || hasDomain) await useTraefikManager().reconcile();
}
