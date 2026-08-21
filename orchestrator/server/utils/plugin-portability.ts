import type {
  PluginDefinitionRecord,
  PluginDefinitionStore,
} from "./plugin-definition-store";
import type {
  PluginInstallationRecord,
  PluginInstallationStore,
} from "./plugin-installation-store";
import { validatePluginManifest, type PluginManifest } from "./plugin-manifest";
import { readFile, writeFile } from "node:fs/promises";

export const PORTABLE_PLUGIN_SCHEMA_VERSION = 1 as const;

export interface PortablePluginDefinition {
  sourceId: string;
  manifest: PluginManifest;
}

export interface PortablePluginInstallation {
  definitionSourceId: string;
  desiredEnabled: boolean;
  envKeys: string[];
  /** Names only. Values are deliberately never portable. */
  secretKeys: string[];
}

export interface PortablePluginConfiguration {
  schemaVersion: typeof PORTABLE_PLUGIN_SCHEMA_VERSION;
  definitions: PortablePluginDefinition[];
  installations: PortablePluginInstallation[];
}

/**
 * Make a credential-free worker snapshot. Observed process state and resource
 * allocations are runtime facts and therefore never leave the source worker.
 */
export function snapshotWorkerPlugins(
  userId: string,
  workerId: string,
  definitions: PluginDefinitionStore,
  installations: PluginInstallationStore,
): PortablePluginConfiguration {
  const installed = installations.listForWorker(userId, workerId);
  const referenced = new Map<string, PluginDefinitionRecord>();
  for (const definition of definitions.listForOwner(userId)) {
    if (definition.scope === "worker" && definition.workerId === workerId)
      referenced.set(definition.id, definition);
  }
  for (const installation of installed) {
    const definition = definitions.getById(installation.definitionId);
    if (
      !definition ||
      definition.definitionHash !== installation.definitionHash ||
      definition.manifest.version !== installation.definitionVersion
    ) {
      throw Object.assign(
        new Error("A pinned plugin definition is unavailable for export"),
        { statusCode: 409 },
      );
    }
    referenced.set(definition.id, definition);
  }
  return {
    schemaVersion: PORTABLE_PLUGIN_SCHEMA_VERSION,
    definitions: [...referenced.values()].map((definition) => ({
      sourceId: definition.id,
      manifest: structuredClone(definition.manifest),
    })),
    installations: installed.map((installation) => ({
      definitionSourceId: installation.definitionId,
      desiredEnabled: installation.desiredEnabled,
      envKeys: [...installation.envKeys],
      secretKeys: [...installation.secretKeys],
    })),
  };
}

export async function writePortablePluginConfiguration(
  path: string,
  configuration: PortablePluginConfiguration,
): Promise<number> {
  const payload = `${JSON.stringify(parsePortablePluginConfiguration(configuration), null, 2)}\n`;
  const bytes = Buffer.byteLength(payload);
  if (bytes > 16 * 1024 * 1024)
    throw Object.assign(
      new Error("Portable plugin configuration is too large"),
      {
        statusCode: 413,
      },
    );
  await writeFile(path, payload, { mode: 0o600 });
  return bytes;
}

export async function readPortablePluginConfiguration(
  path: string,
): Promise<PortablePluginConfiguration> {
  const payload = await readFile(path);
  if (payload.byteLength > 16 * 1024 * 1024)
    throw Object.assign(
      new Error("Portable plugin configuration is too large"),
      {
        statusCode: 400,
      },
    );
  try {
    return parsePortablePluginConfiguration(
      JSON.parse(payload.toString("utf8")),
    );
  } catch (error) {
    if ((error as any)?.statusCode) throw error;
    throw Object.assign(new Error("Invalid portable plugin configuration"), {
      statusCode: 400,
    });
  }
}

export function parsePortablePluginConfiguration(
  input: unknown,
): PortablePluginConfiguration {
  if (!record(input) || input.schemaVersion !== PORTABLE_PLUGIN_SCHEMA_VERSION)
    invalid();
  if (
    !Array.isArray(input.definitions) ||
    input.definitions.length > 256 ||
    !Array.isArray(input.installations) ||
    input.installations.length > 1_024
  )
    invalid();

  const definitions: PortablePluginDefinition[] = [];
  const ids = new Set<string>();
  for (const raw of input.definitions) {
    if (!record(raw) || !safeId(raw.sourceId) || ids.has(raw.sourceId))
      invalid();
    ids.add(raw.sourceId);
    definitions.push({
      sourceId: raw.sourceId,
      manifest: validatePluginManifest(raw.manifest),
    });
  }
  const installations: PortablePluginInstallation[] = [];
  for (const raw of input.installations) {
    if (
      !record(raw) ||
      !safeId(raw.definitionSourceId) ||
      !ids.has(raw.definitionSourceId)
    )
      invalid();
    if (typeof raw.desiredEnabled !== "boolean") invalid();
    installations.push({
      definitionSourceId: raw.definitionSourceId,
      desiredEnabled: raw.desiredEnabled,
      envKeys: keyNames(raw.envKeys),
      secretKeys: keyNames(raw.secretKeys),
    });
  }
  return {
    schemaVersion: PORTABLE_PLUGIN_SCHEMA_VERSION,
    definitions,
    installations,
  };
}

/**
 * Restore every definition as worker-scoped. This preserves behavior without
 * accidentally widening an imported/cloned definition to owner or group
 * scope. New installation IDs and allocations are always minted locally.
 */
export async function restoreWorkerPlugins(
  snapshot: PortablePluginConfiguration,
  userId: string,
  workerId: string,
  definitions: PluginDefinitionStore,
  installations: PluginInstallationStore,
): Promise<{ installationIds: string[]; missingSecretNames: string[] }> {
  const validated = parsePortablePluginConfiguration(snapshot);
  const definitionIds = new Map<string, PluginDefinitionRecord>();
  const createdDefinitions: string[] = [];
  const createdInstallations: PluginInstallationRecord[] = [];
  try {
    for (const portable of validated.definitions) {
      const definition = await definitions.create({
        scope: "worker",
        ownerId: userId,
        workerId,
        manifest: portable.manifest,
      });
      createdDefinitions.push(definition.id);
      definitionIds.set(portable.sourceId, definition);
    }
    for (const portable of validated.installations) {
      const definition = definitionIds.get(portable.definitionSourceId)!;
      createdInstallations.push(
        await installations.create({
          userId,
          workerId,
          definitionId: definition.id,
          definitionVersion: definition.manifest.version,
          definitionHash: definition.definitionHash,
          desiredEnabled: portable.desiredEnabled,
          envKeys: portable.envKeys,
          secretKeys: portable.secretKeys,
        }),
      );
    }
  } catch (error) {
    for (const installation of createdInstallations.reverse())
      await installations.delete(userId, installation.id).catch(() => {});
    for (const id of createdDefinitions.reverse())
      await definitions.delete(id).catch(() => {});
    throw error;
  }
  return {
    installationIds: createdInstallations.map(({ id }) => id),
    missingSecretNames: [
      ...new Set(
        validated.installations.flatMap(({ secretKeys }) => secretKeys),
      ),
    ].sort(),
  };
}

function record(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.includes("\0")
  );
}

function keyNames(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some(
      (item) =>
        typeof item !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(item),
    ) ||
    new Set(value).size !== value.length
  )
    invalid();
  return [...value];
}

function invalid(): never {
  throw Object.assign(new Error("Invalid portable plugin configuration"), {
    statusCode: 400,
  });
}
