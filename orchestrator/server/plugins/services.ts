import {
  useConfig,
  useDockerService,
  useContainerManager,
  usePortMappingStore,
  useDomainMappingStore,
  useTraefikManager,
  useEnvironmentStore,
  useWorkerStore,
  useWorkerGroupStore,
  useManagedNetworkStore,
  useUpdateChecker,
  useUsageChecker,
  useResourceMonitor,
  useUserCredentialManager,
  useUserEnvStore,
  useOrphanSweeper,
  useStorageManager,
  useCapabilityStore,
  useInstructionStore,
  useInitScriptStore,
  useLogStore,
  useLogger,
  useLogCollector,
  useExportJobManager,
  usePluginDefinitionStore,
  usePluginInstallationStore,
  usePluginRuntimeManager,
  usePersistentBackupPathManager,
} from "../utils/services";
import {
  loadBuiltInCapabilities,
  loadBuiltInInstructions,
  loadBuiltInInitScripts,
  loadBuiltInEnvironments,
} from "../utils/built-in-content";
import { BUILT_IN_PLUGINS } from "../utils/plugin-builtins";
import { migrateAuth, getAuthDb } from "../utils/auth";
import { cleanupWorkspaceHelpers } from "../utils/workspace-access";
import { useBackupManager } from "../utils/backup-manager";
import { useImageCatalogManager } from "../utils/image-catalog";
import { useAdminWorkspaceStore } from "../utils/admin-workspace-store";
import { useGroupAdminWorkspaceStore } from "../utils/group-admin-workspace-store";
import { DockerAdminWorkspaceRuntime } from "../utils/admin-workspace-runtime";
import { useManagementMcpStore } from "../utils/management-mcp-store";
import { ManagementMcpTransport } from "../utils/management-mcp-transport";
import { useGitImageCatalogManager } from "../utils/git-image-manager";

export default defineNitroPlugin(async (nitroApp) => {
  // Initialize logging infrastructure first
  const logStore = useLogStore();
  await logStore.init();
  const logger = useLogger();

  // Surface stray promise rejections / uncaught exceptions in the centralized
  // log instead of relying on the stdout self-capture (which may not flush in
  // time, e.g. if the process is exiting). Registered once, guarded so the
  // dev-mode hot reload doesn't stack duplicate listeners.
  if (!(globalThis as any).__agentorProcessHandlers) {
    (globalThis as any).__agentorProcessHandlers = true;
    process.on("unhandledRejection", (reason: unknown) => {
      const msg =
        reason instanceof Error
          ? reason.stack || reason.message
          : String(reason);
      try {
        useLogger().error(`[process] unhandledRejection: ${msg}`);
      } catch {}
    });
    process.on("uncaughtException", (err: Error) => {
      try {
        useLogger().error(
          `[process] uncaughtException: ${err.stack || err.message}`,
        );
      } catch {}
    });
  }

  // Attach the log collector to our own container as early as possible so
  // framework/runtime stdout (Nuxt, Nitro, Vite, console.warn outside
  // useLogger, unhandled errors) is captured into orchestrator.log.
  // Intentional useLogger() output buffers in-memory until setReady() below
  // and is written to the same file directly — no duplication because
  // useLogger never prints to stdout.
  const logCollector = useLogCollector();
  await logCollector.attachSelf();

  // Auth DB + Docker network are independent of each other. `migrateAuth()`
  // builds (and memoizes) the auth instance internally, so no standalone
  // `useAuth()` is needed here.
  const dockerService = useDockerService();
  const [, , staleWorkspaceHelpers] = await Promise.all([
    migrateAuth(),
    dockerService.ensureNetwork(),
    cleanupWorkspaceHelpers(),
  ]);
  logger.info("[agentor] auth initialized");
  if (staleWorkspaceHelpers > 0)
    logger.info(
      `[agentor] removed ${staleWorkspaceHelpers} stale workspace helper container(s)`,
    );

  // Storage manager must finish before any store init — stores resolve paths
  // via `<DATA_DIR>/...` and seedBuiltIns writes into `<DATA_DIR>/defaults/`.
  const storageManager = useStorageManager();
  await storageManager.init();
  await storageManager.ensureDefaultsDir();

  const userEnvStore = useUserEnvStore();
  const userCredentialManager = useUserCredentialManager();
  const containerManager = useContainerManager();
  containerManager.setStorageManager(storageManager);
  containerManager.setUserEnvStore(userEnvStore);
  containerManager.setUserCredentialManager(userCredentialManager);

  // All stores load independently; built-in seeding also writes to a separate
  // defaults/ file per store, so we fan them out. Docker synchronization must
  // run only after WorkerStore is loaded and attached: resolving an
  // `agentor.id` label to its authoritative owner/config is required before a
  // ContainerInfo can safely enter the user-scoped reconciliation path.
  const environmentStore = useEnvironmentStore();
  const capabilityStore = useCapabilityStore();
  const instructionStore = useInstructionStore();
  const initScriptStore = useInitScriptStore();
  const workerStore = useWorkerStore();
  const portMappingStore = usePortMappingStore();
  const domainMappingStore = useDomainMappingStore();
  const pluginDefinitionStore = usePluginDefinitionStore();
  const pluginInstallationStore = usePluginInstallationStore();

  await Promise.all([
    userEnvStore.init(),
    (async () => {
      await environmentStore.init();
      await environmentStore.seedBuiltIns(await loadBuiltInEnvironments());
    })(),
    (async () => {
      await capabilityStore.init();
      await capabilityStore.seedBuiltIns(await loadBuiltInCapabilities());
    })(),
    (async () => {
      await instructionStore.init();
      await instructionStore.seedBuiltIns(await loadBuiltInInstructions());
    })(),
    (async () => {
      await initScriptStore.init();
      await initScriptStore.seedBuiltIns(await loadBuiltInInitScripts());
    })(),
    workerStore.init(),
    useWorkerGroupStore().init(),
    useManagedNetworkStore().init(),
    portMappingStore.init(),
    domainMappingStore.init(),
    useExportJobManager().init(),
    useBackupManager().init(),
    useImageCatalogManager().init(),
    useGitImageCatalogManager().init(),
    useAdminWorkspaceStore().init(),
    useManagementMcpStore().init(),
    (async () => {
      await pluginDefinitionStore.init();
      await pluginDefinitionStore.seedBuiltIns(BUILT_IN_PLUGINS);
    })(),
    pluginInstallationStore.init(),
  ]);

  containerManager.setEnvironmentStore(environmentStore);
  containerManager.setCapabilityStore(capabilityStore);
  containerManager.setInstructionStore(instructionStore);
  containerManager.setWorkerStore(workerStore);
  await containerManager.sync();
  useBackupManager().setPathPersistenceAdapter(
    usePersistentBackupPathManager(),
  );
  await containerManager.reconcileWorkers();
  for (const worker of containerManager.list()) {
    if (
      worker.status !== "running" ||
      worker.administrativeKind ||
      worker.userId === "__agentor_admin__"
    )
      continue;
    await usePluginRuntimeManager()
      .reconcileWorker(worker.userId, worker.id, worker.containerId)
      .catch((error) =>
        logger.warn(
          `[agentor] plugin reconciliation failed for ${worker.id}: ${error instanceof Error ? error.message : error}`,
        ),
      );
  }
  // Restore desired managed-network membership after a daemon/orchestrator
  // restart. Keep worker startup available if a user-created bridge is broken;
  // validation/UI will expose the failed network instead of hiding it.
  const { useManagedNetworkManager } =
    await import("../utils/managed-network-manager");
  for (const userId of useManagedNetworkStore().listUserIds())
    await useManagedNetworkManager()
      .reconcileOwner(userId)
      .catch((error) =>
        logger.warn(
          `[agentor] managed network reconciliation failed for ${userId}: ${error instanceof Error ? error.message : error}`,
        ),
      );

  // The administrative workspace uses a separate, generated Docker boundary:
  // its image/mount/network inputs are not accepted from dashboard requests.
  // The MCP listener binds only to the orchestrator's address on the internal
  // management network and still authenticates + authorizes every JSON-RPC
  // call through ManagementMcpStore.
  const adminRuntime = new DockerAdminWorkspaceRuntime(useConfig());
  const managementMcp = new ManagementMcpTransport(useManagementMcpStore());
  adminRuntime.setManagementListener((host) => managementMcp.start(host));
  const adminWorkspace = useAdminWorkspaceStore();
  adminWorkspace.setRuntimeAdapter(adminRuntime);
  const groupAdminWorkspaces = useGroupAdminWorkspaceStore();
  groupAdminWorkspaces.setRuntimeAdapter(adminRuntime);
  groupAdminWorkspaces.setIdentityMaterializer(async (record) => {
    const identity = await useManagementMcpStore().issue(record.id, 60);
    await adminRuntime.materializeCredential(identity.credential, record);
  });
  await adminRuntime.initializeBoundary();
  await managementMcp.start(await adminRuntime.managementAddress());
  let adminIdentityTimer: NodeJS.Timeout | undefined;
  const refreshAdminIdentity = async () => {
    try {
      const workspace = await adminWorkspace.ensure();
      const identity = await useManagementMcpStore().issue(workspace.id, 60);
      await adminRuntime.materializeCredential(identity.credential);
      for (const group of useWorkerGroupStore().list()) {
        if (!group.adminWorkspace) continue;
        await groupAdminWorkspaces.ensure(group.id);
      }
    } catch (error) {
      logger.error(
        `[agentor] administrative workspace identity refresh failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  };
  await refreshAdminIdentity();
  adminIdentityTimer = setInterval(() => void refreshAdminIdentity(), 45_000);
  adminIdentityTimer.unref?.();

  // Mappings survive stop/archive/unarchive/rebuild, so the cleanup set
  // includes BOTH active containers and archived workers (matched by containerName).
  const knownContainerNames = new Set<string>();
  for (const c of containerManager.list())
    knownContainerNames.add(c.containerName);
  // Archived workers have no live container — derive their stable name from the id.
  for (const w of workerStore.list())
    knownContainerNames.add(containerManager.buildContainerName(w.id));

  const [staleCount, staleDomainCount] = await Promise.all([
    portMappingStore.cleanupStaleContainers(knownContainerNames),
    domainMappingStore.cleanupStaleContainers(knownContainerNames),
  ]);
  if (staleCount > 0)
    logger.info(`[agentor] cleaned up ${staleCount} stale port mapping(s)`);
  if (staleDomainCount > 0)
    logger.info(
      `[agentor] cleaned up ${staleDomainCount} stale domain mapping(s)`,
    );

  // Traefik reads the mapping stores; init it once they are clean.
  const traefikManager = useTraefikManager();
  await traefikManager.init();

  const updateChecker = useUpdateChecker();
  const usageChecker = useUsageChecker();
  usageChecker.setUserEnvStore(userEnvStore);
  usageChecker.setCredentialManager(userCredentialManager);
  // ResourceMonitor enumerates running workers, so init it after reconcile.
  const resourceMonitor = useResourceMonitor();
  await Promise.all([
    updateChecker.init(),
    usageChecker.init(),
    resourceMonitor.init(),
  ]);

  // Start the orphan sweeper — on a 10-minute interval, prunes per-user
  // data for users that no longer exist in the auth DB. Uses a timer rather
  // than a middleware to avoid ever touching better-auth's request pipeline.
  useOrphanSweeper().addPreCleanupHook((userId) =>
    useBackupManager().forgetUser(userId),
  );
  useOrphanSweeper().addLifecycleCleanupHook((userId) =>
    useContainerManager().removeWorkersForDeletedOwner(userId),
  );
  useOrphanSweeper().addCandidateSource(() => useBackupManager().ownerIds());
  useOrphanSweeper().addCleanupHook((userId) =>
    useImageCatalogManager().forgetOwner(userId),
  );
  useOrphanSweeper().addCandidateSource(() =>
    useImageCatalogManager().ownerIds(),
  );
  useOrphanSweeper().addCleanupHook(async (userId) => {
    await pluginInstallationStore.removeForUser(userId);
  });
  useOrphanSweeper().addCleanupHook(async (userId) => {
    await pluginDefinitionStore.removeForUser(userId);
  });
  useOrphanSweeper().addCandidateSource(() =>
    pluginInstallationStore.listUserIds(),
  );
  useOrphanSweeper().addCandidateSource(() =>
    pluginDefinitionStore.listUserIds(),
  );
  useOrphanSweeper().start();

  logger.info(
    `[agentor] Synced ${containerManager.list().length} containers, ${workerStore.listArchived().length} archived, ${environmentStore.list().length} environments, ${capabilityStore.list().length} capabilities, ${instructionStore.list().length} instructions, ${initScriptStore.list().length} init scripts, ${portMappingStore.list().length} port mappings, ${domainMappingStore.list().length} domain mappings`,
  );

  // Mark logger as ready (flushes buffered entries) and start collecting
  // logs from worker + traefik containers. Self-attach already ran at the
  // top of this plugin so orchestrator stdout is being captured.
  logger.setReady();
  await logCollector.init();

  // Graceful shutdown: on a normal container stop / redeploy (the update
  // mechanism stops the orchestrator container), tear down long-lived
  // resources so the SQLite WAL isn't left mid-write and the in-flight log
  // write-queue flushes its last buffered lines. Nitro fires `close` on
  // SIGTERM/SIGINT.
  nitroApp.hooks.hook("close", async () => {
    try {
      useOrphanSweeper().stop();
    } catch {}
    try {
      useUpdateChecker().stop?.();
    } catch {}
    try {
      useUsageChecker().stop?.();
    } catch {}
    try {
      useResourceMonitor().stop?.();
    } catch {}
    try {
      useExportJobManager().stop();
    } catch {}
    try {
      useBackupManager().stop();
    } catch {}
    try {
      if (adminIdentityTimer) clearInterval(adminIdentityTimer);
    } catch {}
    try {
      await managementMcp.stop();
    } catch {}
    try {
      useLogCollector().detachAll();
    } catch {}
    try {
      await useLogStore().destroy();
    } catch {}
    try {
      getAuthDb().close();
    } catch {}
  });
});
