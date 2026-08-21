import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginDefinitionStore } from "../../orchestrator/server/utils/plugin-definition-store";
import { PluginInstallationStore } from "../../orchestrator/server/utils/plugin-installation-store";
import {
  readPortablePluginConfiguration,
  restoreWorkerPlugins,
  snapshotWorkerPlugins,
  writePortablePluginConfiguration,
} from "../../orchestrator/server/utils/plugin-portability";

const manifest = {
  schemaVersion: 1,
  name: "Portable test app",
  slug: "portable-test",
  description: "A test plugin",
  version: "1",
  lifecycle: { start: { argv: ["sh", "-c", "serve --token $APP_TOKEN"] } },
  environment: { envKeys: ["APP_MODE"], secretKeys: ["APP_TOKEN"] },
  documentation: { skillMarkdown: "Use the portable test app when asked." },
} as const;

test("plugin clone/export snapshot is credential-free and remints worker-local state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentor-plugin-portable-"));
  try {
    const definitions = new PluginDefinitionStore(dir);
    const installations = new PluginInstallationStore(dir);
    await Promise.all([definitions.init(), installations.init()]);
    const definition = await definitions.create({
      scope: "worker", ownerId: "owner-a", workerId: "worker-a", manifest,
    });
    const installation = await installations.create({
      userId: "owner-a",
      workerId: "worker-a",
      definitionId: definition.id,
      definitionVersion: definition.manifest.version,
      definitionHash: definition.definitionHash,
      desiredEnabled: true,
      envKeys: ["APP_MODE"],
      secretKeys: ["APP_TOKEN"],
    });
    await installations.reserveResources("owner-a", installation.id, definition.manifest);

    const snapshot = snapshotWorkerPlugins("owner-a", "worker-a", definitions, installations);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("runtimeGeneration");
    expect(serialized).not.toContain("allocations");
    expect(serialized).not.toContain("secret-value");

    const path = join(dir, "plugins.json");
    await writePortablePluginConfiguration(path, snapshot);
    const parsed = await readPortablePluginConfiguration(path);
    const result = await restoreWorkerPlugins(
      parsed, "owner-b", "worker-b", definitions, installations,
    );
    expect(result.missingSecretNames).toEqual(["APP_TOKEN"]);
    const restored = installations.listForWorker("owner-b", "worker-b");
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      desiredEnabled: true,
      envKeys: ["APP_MODE"],
      secretKeys: ["APP_TOKEN"],
      observed: { state: "pending", ready: false },
    });
    expect(restored[0]!.id).not.toBe(installation.id);
    expect(restored[0]!.allocations).toBeUndefined();
    const copiedDefinition = definitions.getById(restored[0]!.definitionId)!;
    expect(copiedDefinition).toMatchObject({
      scope: "worker", userId: "owner-b", workerId: "worker-b", builtIn: false,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
