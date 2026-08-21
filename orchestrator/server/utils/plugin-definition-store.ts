import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  pluginDefinitionHash,
  validateDefinitionScope,
  validatePluginManifest,
  type PluginDefinitionScope,
  type PluginManifest,
} from "./plugin-manifest";
import { UserScopedJsonStore } from "./user-scoped-store";

export interface PluginDefinitionRecord {
  schemaVersion: 1;
  id: string;
  /** Matches UserScopedJsonStore's ownership convention; null is platform. */
  userId: string | null;
  scope: PluginDefinitionScope;
  groupId?: string;
  workerId?: string;
  name: string;
  builtIn: boolean;
  manifest: PluginManifest;
  definitionHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePluginDefinitionInput {
  scope: PluginDefinitionScope;
  ownerId?: string | null;
  groupId?: string;
  workerId?: string;
  manifest: unknown;
}

const PLATFORM_FILE = "plugin-definitions.platform.json";

/**
 * Versioned reusable plugin definitions. Owner/group/worker definitions use
 * the normal per-owner persistence boundary; platform definitions live in a
 * separate global file so they cannot be swept with a user account.
 */
export class PluginDefinitionStore extends UserScopedJsonStore<
  string,
  PluginDefinitionRecord
> {
  private platform = new Map<string, PluginDefinitionRecord>();
  private platformSave = Promise.resolve();
  private platformUnavailable = false;

  constructor(dataDir: string) {
    super(dataDir, "plugin-definitions.json", (definition) => {
      validatePersistedDefinition(definition, false);
      return definition.id;
    });
  }

  override async init(): Promise<void> {
    await Promise.all([super.init(), this.loadPlatform()]);
  }

  override list(): PluginDefinitionRecord[] {
    this.assertPlatformAvailable();
    return [...this.platform.values(), ...super.list()]
      .map((item) => structuredClone(item))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  listForOwner(ownerId: string): PluginDefinitionRecord[] {
    this.assertPlatformAvailable();
    return [...this.platform.values(), ...super.listForUser(ownerId)].map(
      (item) => structuredClone(item),
    );
  }

  getById(id: string): PluginDefinitionRecord | undefined {
    this.assertPlatformAvailable();
    const platform = this.platform.get(id);
    return platform
      ? structuredClone(platform)
      : this.findWithOwner((item) => item.id === id)?.item;
  }

  async create(
    input: CreatePluginDefinitionInput,
  ): Promise<PluginDefinitionRecord> {
    const identity = validateDefinitionScope({
      scope: input.scope,
      ownerId: input.ownerId,
      groupId: input.groupId,
      workerId: input.workerId,
    });
    const manifest = validatePluginManifest(input.manifest);
    const stamp = new Date().toISOString();
    const definition: PluginDefinitionRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      userId: identity.ownerId,
      scope: identity.scope,
      ...(identity.groupId ? { groupId: identity.groupId } : {}),
      ...(identity.workerId ? { workerId: identity.workerId } : {}),
      name: manifest.name,
      builtIn: false,
      manifest,
      definitionHash: pluginDefinitionHash(manifest),
      createdAt: stamp,
      updatedAt: stamp,
    };
    if (identity.scope === "platform") await this.setPlatform(definition);
    else await this.setItem(identity.ownerId!, definition);
    return structuredClone(definition);
  }

  async update(
    id: string,
    manifestInput: unknown,
  ): Promise<PluginDefinitionRecord> {
    const current = this.getById(id);
    if (!current) throw notFound();
    if (current.builtIn)
      throw Object.assign(
        new Error("Built-in plugin definitions are immutable"),
        {
          statusCode: 400,
        },
      );
    const manifest = validatePluginManifest(manifestInput);
    const updated: PluginDefinitionRecord = {
      ...current,
      name: manifest.name,
      manifest,
      definitionHash: pluginDefinitionHash(manifest),
      updatedAt: new Date().toISOString(),
    };
    if (updated.scope === "platform") await this.setPlatform(updated);
    else await this.setItem(updated.userId!, updated);
    return structuredClone(updated);
  }

  async delete(id: string): Promise<void> {
    const current = this.getById(id);
    if (!current) throw notFound();
    if (current.builtIn)
      throw Object.assign(
        new Error("Built-in plugin definitions are immutable"),
        {
          statusCode: 400,
        },
      );
    if (current.scope === "platform") {
      await this.mutatePlatform((map) => {
        map.delete(id);
      });
    } else await this.deleteItem(current.userId!, id);
  }

  async removeForWorker(ownerId: string, workerId: string): Promise<number> {
    return this.removeWhere(
      (definition) =>
        definition.userId === ownerId &&
        definition.scope === "worker" &&
        definition.workerId === workerId,
    );
  }

  /** Replaces only seeded platform rows and retains operator-created ones. */
  async seedBuiltIns(
    inputs: Array<{ id: string; manifest: unknown }>,
  ): Promise<void> {
    const stamp = new Date().toISOString();
    const builtIns = inputs.map(({ id, manifest: raw }) => {
      if (!id || typeof id !== "string")
        throw new Error("Built-in plugin id is required");
      const manifest = validatePluginManifest(raw);
      return {
        schemaVersion: 1 as const,
        id,
        userId: null,
        scope: "platform" as const,
        name: manifest.name,
        builtIn: true,
        manifest,
        definitionHash: pluginDefinitionHash(manifest),
        createdAt: stamp,
        updatedAt: stamp,
      };
    });
    if (new Set(builtIns.map((item) => item.id)).size !== builtIns.length)
      throw new Error("Duplicate built-in plugin id");
    await this.mutatePlatform((map) => {
      for (const [id, item] of map) if (item.builtIn) map.delete(id);
      for (const item of builtIns) map.set(item.id, item);
    });
  }

  private async loadPlatform(): Promise<void> {
    try {
      const raw = await readFile(this.platformPath(), "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed))
        throw new Error("Platform plugin definitions must be an array");
      const next = new Map<string, PluginDefinitionRecord>();
      for (const item of parsed) {
        validatePersistedDefinition(item, true);
        if (next.has(item.id))
          throw new Error("Duplicate platform plugin definition id");
        next.set(item.id, structuredClone(item));
      }
      this.platform = next;
      this.platformUnavailable = false;
    } catch (error: any) {
      if (error?.code === "ENOENT") return;
      this.platformUnavailable = true;
      throw error;
    }
  }

  private setPlatform(definition: PluginDefinitionRecord): Promise<void> {
    return this.mutatePlatform((map) =>
      map.set(definition.id, structuredClone(definition)),
    );
  }

  private mutatePlatform(
    operation: (map: Map<string, PluginDefinitionRecord>) => void,
  ): Promise<void> {
    const result = this.platformSave.then(async () => {
      this.assertPlatformAvailable();
      const previous = this.platform;
      const next = new Map(
        [...previous].map(([id, item]) => [id, structuredClone(item)]),
      );
      operation(next);
      this.platform = next;
      try {
        await this.persistPlatform();
      } catch (error) {
        this.platform = previous;
        throw error;
      }
    });
    this.platformSave = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persistPlatform(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const path = this.platformPath();
    const temporary = `${path}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;
    await writeFile(
      temporary,
      JSON.stringify([...this.platform.values()], null, 2),
      {
        mode: 0o600,
      },
    );
    await rename(temporary, path);
  }

  private platformPath(): string {
    return join(this.dataDir, PLATFORM_FILE);
  }

  private assertPlatformAvailable(): void {
    if (this.platformUnavailable)
      throw Object.assign(
        new Error("Stored platform plugin definitions are unavailable"),
        {
          statusCode: 503,
        },
      );
  }
}

function validatePersistedDefinition(
  input: unknown,
  platform: boolean,
): asserts input is PluginDefinitionRecord {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid persisted plugin definition");
  const item = input as PluginDefinitionRecord;
  if (
    item.schemaVersion !== 1 ||
    typeof item.id !== "string" ||
    !item.id ||
    typeof item.name !== "string" ||
    typeof item.builtIn !== "boolean" ||
    typeof item.definitionHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.definitionHash) ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  )
    throw new Error("Invalid persisted plugin definition");
  const identity = validateDefinitionScope({
    scope: item.scope,
    ownerId: item.userId,
    groupId: item.groupId,
    workerId: item.workerId,
  });
  if (platform !== (identity.scope === "platform"))
    throw new Error("Plugin definition is in the wrong persistence partition");
  const manifest = validatePluginManifest(item.manifest);
  if (
    item.name !== manifest.name ||
    pluginDefinitionHash(manifest) !== item.definitionHash
  )
    throw new Error("Persisted plugin definition hash mismatch");
}

function notFound() {
  return Object.assign(new Error("Plugin definition not found"), {
    statusCode: 404,
  });
}
