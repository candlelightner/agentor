import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Config } from "../../orchestrator/server/utils/config";
import { BackupKeyring } from "../../orchestrator/server/utils/backup-keyring";
import { encryptBackupV2 } from "../../orchestrator/server/utils/backup-crypto";
import { BackupManager } from "../../orchestrator/server/utils/backup-manager";
import { FakeBackupProvider } from "../../orchestrator/server/utils/backup-provider";
import { BUNDLE_FILES, packBundle, writeManifest, writeWorkerReconstruction, type WorkerExportManifest } from "../../orchestrator/server/utils/worker-export";
import { useImageCatalogManager } from "../../orchestrator/server/utils/image-catalog";
import { writePortablePluginConfiguration } from "../../orchestrator/server/utils/plugin-portability";
import { usePluginDefinitionStore } from "../../orchestrator/server/utils/services";

function config(dataDir: string): Config { return { dataDir } as Config; }

async function waitForJob(manager: BackupManager, id: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const job = await manager.getJob(id);
    if (job && ["succeeded", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error(`Backup job ${id} did not settle`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function createPortableWorkerBundle(dir: string, sourceId: string) {
  const manifest: WorkerExportManifest = {
    version: 3,
    exportedAt: "2026-01-01T00:00:00.000Z",
    source: { id: sourceId, displayName: "Recovered worker", containerName: "source-container", imageName: "agentor-worker:approved-test" },
    worker: { displayName: "Recovered worker", repos: [], mounts: [], initScript: "" },
    environment: { id: "default", name: "Default" } as WorkerExportManifest["environment"],
    portMappings: [], domainMappings: [],
    contents: {
      rootfs: false,
      workspace: false,
      agents: false,
      plugins: true,
      reconstruction: true,
    },
  };
  const manifestPath = join(dir, "manifest.json");
  const bundle = join(dir, "worker.tar");
  const reconstructionPath = join(dir, "reconstruction.json");
  const pluginsPath = join(dir, "plugins.json");
  await writeManifest(manifest, manifestPath);
  await writeWorkerReconstruction(reconstructionPath, {
    schemaVersion: 1,
    image: {
      kind: "custom", definitionId: "source-image", version: "v1",
      digest: `sha256:${"c".repeat(64)}`,
      definition: {
        name: "Source portable image", description: "", baseImage: "agentor-worker:approved-current",
        dockerfileFragment: "", contextFiles: [], provisioningMode: "safe",
        pluginComposition: [{ definitionId: "source-plugin", validation: "optional" }],
      },
      imageVersion: { baseImage: "agentor-worker:approved-current", provisioningMode: "safe" },
    }, requiredSecretNames: [],
  });
  await writePortablePluginConfiguration(pluginsPath, {
    schemaVersion: 1,
    definitions: [{ sourceId: "source-plugin", manifest: {
      schemaVersion: 1, name: "Portable image plugin", slug: "portable-image-plugin",
      description: "", version: "1", lifecycle: { start: { argv: ["sh", "-lc", "true"] } },
      imageBuild: { provisioning: [{ type: "packages", manager: "apt", packages: ["jq"] }] },
    } }],
    installations: [],
  });
  await pipeline(packBundle([
    { name: BUNDLE_FILES.manifest, path: manifestPath },
    { name: BUNDLE_FILES.reconstruction, path: reconstructionPath },
    { name: BUNDLE_FILES.plugins, path: pluginsPath },
  ]), await import("node:fs").then(({ createWriteStream }) => createWriteStream(bundle, { mode: 0o600 })));
  return bundle;
}

test("independent installations discover, adopt, and deduplicate a shared fake-provider backup after key import", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentor-cross-instance-"));
  const sourceDir = join(root, "instance-a");
  const destinationDir = join(root, "instance-b");
  const provider = new FakeBackupProvider(join(root, "provider"));
  const sourceOwner = "source_owner";
  const destinationOwner = "destination_owner";
  provider.bindAccount(sourceOwner, "shared-account");
  provider.bindAccount(destinationOwner, "shared-account");
  const source = new BackupManager({ dataDir: sourceDir, providers: { fake: provider } });
  const destination = new BackupManager({ dataDir: destinationDir, providers: { fake: provider } });
  try {
    await source.init(); await destination.init();
    source.connectFake(sourceOwner); destination.connectFake(destinationOwner);

    const plain = await createPortableWorkerBundle(root, "source_worker");
    const encrypted = join(root, "worker.backup");
    const sourceKeys = new BackupKeyring(config(sourceDir));
    const encryptedResult = await encryptBackupV2(config(sourceDir), sourceOwner, plain, encrypted, {
      backupId: "source-backup", sourceInstallationId: "installation-a",
      createdAt: "2026-01-01T00:00:00.000Z", workspaceIds: ["source_worker"], formatVersion: 2,
    }, sourceKeys);
    await provider.upload(sourceOwner, "source-backup", encrypted, () => {}, undefined, undefined, {
      artifactId: "source-backup", formatVersion: 2,
      keyFingerprint: encryptedResult.header.keyFingerprint,
      integritySha256: encryptedResult.sha256,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const firstScan = await destination.createDiscovery(destinationOwner, "fake", "scan-1");
    const duplicateScan = await destination.createDiscovery(destinationOwner, "fake", "scan-1");
    expect(duplicateScan.id).toBe(firstScan.id);
    expect((await destination.createDiscovery(destinationOwner, "fake")).id).toBe(firstScan.id);
    await expect(waitForJob(destination, firstScan.id)).resolves.toMatchObject({ status: "succeeded", operation: "discovery" });
    const missing = await destination.listRemoteBackups(destinationOwner);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ state: "missing-key", keyFingerprint: encryptedResult.header.keyFingerprint, sourceInstallationId: "installation-a", workspaceIds: ["source_worker"] });

    const kit = await sourceKeys.exportKit(sourceOwner);
    const imported = await destination.importRecoveryKit(destinationOwner, kit);
    expect(imported).toMatchObject({ imported: true, fingerprint: encryptedResult.header.keyFingerprint, matchingRemoteBackupIds: [missing[0]!.id] });

    const rescan = await destination.createDiscovery(destinationOwner, "fake", "scan-2");
    await expect(waitForJob(destination, rescan.id)).resolves.toMatchObject({ status: "succeeded" });
    const ready = await destination.listRemoteBackups(destinationOwner);
    expect(ready).toHaveLength(1);
    expect(ready[0]).toMatchObject({ id: missing[0]!.id, state: "ready-to-adopt" });

    const adoption = await destination.createAdoption(destinationOwner, ready[0]!.id, "adopt-1");
    const duplicateAdoption = await destination.createAdoption(destinationOwner, ready[0]!.id, "adopt-1");
    expect(duplicateAdoption.id).toBe(adoption.id);
    expect((await destination.createAdoption(destinationOwner, ready[0]!.id)).id).toBe(adoption.id);
    const adopted = await waitForJob(destination, adoption.id);
    expect(adopted.status, adopted.error ?? JSON.stringify(adopted)).toBe("succeeded");
    expect(adopted).toMatchObject({ operation: "adoption", integrityVerified: true });
    const artifacts = await destination.list(destinationOwner);
    expect(artifacts.artifacts).toHaveLength(1);
    expect(artifacts.artifacts[0]).toMatchObject({ provenance: "remote-adopted", formatVersion: 2, workspaceIds: ["source_worker"], integrityStatus: "verified" });
    expect(artifacts.artifacts[0]!.reconstruction?.[0]?.image).toMatchObject({ kind: "custom", recoveryAvailable: true });
    expect((await destination.listRemoteBackups(destinationOwner))[0]).toMatchObject({ state: "adopted", adoptedArtifactId: artifacts.artifacts[0]!.id });

    const repeatAdoption = await destination.createAdoption(destinationOwner, ready[0]!.id, "adopt-2");
    expect(repeatAdoption).toMatchObject({ status: "succeeded", artifactId: artifacts.artifacts[0]!.id });

    const recovery = await destination.createImageRecovery(
      destinationOwner, artifacts.artifacts[0]!.id, "source_worker", "image-recovery-1", false,
    );
    const duplicateRecovery = await destination.createImageRecovery(
      destinationOwner, artifacts.artifacts[0]!.id, "source_worker", "image-recovery-1", false,
    );
    expect(duplicateRecovery.id).toBe(recovery.id);
    const completedRecovery = await waitForJob(destination, recovery.id);
    expect(completedRecovery).toMatchObject({
      status: "succeeded", operation: "dependency-resolution", phase: "definition-recovered",
    });
    expect(completedRecovery.recoveredImageDefinitionId).toBeTruthy();
    const catalog = useImageCatalogManager(); await catalog.init();
    const recoveredDefinition = catalog.definition(completedRecovery.recoveredImageDefinitionId!, destinationOwner, false);
    expect(recoveredDefinition).toMatchObject({
      name: "Source portable image (recovered)", provisioningMode: "safe",
    });
    const recoveredPluginId = recoveredDefinition.pluginComposition?.[0]?.definitionId;
    expect(recoveredPluginId).toBeTruthy();
    expect(recoveredPluginId).not.toBe("source-plugin");
    expect(usePluginDefinitionStore().getById(recoveredPluginId!)).toMatchObject({
      userId: destinationOwner, scope: "owner", name: "Portable image plugin",
    });
    await catalog.removeDefinition(completedRecovery.recoveredImageDefinitionId!, destinationOwner, false);
    await usePluginDefinitionStore().delete(recoveredPluginId!);

    // Restore admission is durable and retry-safe before the asynchronous
    // worker-import phase starts. The captured custom image is deliberately
    // not built in this manager-only test, so use the explicit acknowledged
    // workspace-only path rather than silently substituting a default image.
    const imageResolutions = {
      source_worker: { mode: "workspace-only" as const, acknowledged: true as const },
    };
    const restore = await destination.createRestore(
      destinationOwner, artifacts.artifacts[0]!, "new", undefined, undefined,
      ["source_worker"], "restore-1", imageResolutions,
    );
    const duplicateRestore = await destination.createRestore(
      destinationOwner, artifacts.artifacts[0]!, "new", undefined, undefined,
      ["source_worker"], "restore-1", imageResolutions,
    );
    expect(duplicateRestore.id).toBe(restore.id);
    expect(restore).toMatchObject({ operation: "restore", selectedWorkspaceIds: ["source_worker"] });
    await expect(destination.cancel(restore)).resolves.toMatchObject({ status: expect.stringMatching(/cancelled|queued|running/) });
    await expect(destination.cancel(restore)).resolves.toMatchObject({ id: restore.id });
    await expect(destination.createAdoption("unrelated_owner", ready[0]!.id)).rejects.toMatchObject({ statusCode: 404 });
  } finally {
    source.stop(); destination.stop();
    await rm(root, { recursive: true, force: true });
  }
});
