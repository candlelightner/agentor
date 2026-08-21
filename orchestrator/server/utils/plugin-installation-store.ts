import { randomUUID } from "node:crypto";
import type {
  PluginDisplayRequirement,
  PluginManifest,
  PluginPortRequirement,
} from "./plugin-manifest";
import { USER_ENV_KEY_RE } from "./user-env-store";
import { UserScopedJsonStore } from "./user-scoped-store";

export interface PluginResourceAllocation {
  ports: Record<string, number>;
  display?: number;
}

export type PluginObservedState =
  | "disabled"
  | "pending"
  | "installing"
  | "starting"
  | "ready"
  | "degraded"
  | "stopping"
  | "stopped"
  | "cleaning"
  | "error";

export interface PluginObservedStatus {
  state: PluginObservedState;
  ready: boolean;
  runtimeGeneration?: string;
  checkedAt: string;
  error?: { code: string; message: string };
}

export interface PluginInstallationRecord {
  schemaVersion: 1;
  id: string;
  userId: string;
  workerId: string;
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  desiredEnabled: boolean;
  /** Names only. Values remain in existing worker/group secret stores. */
  envKeys: string[];
  secretKeys: string[];
  allocations?: PluginResourceAllocation;
  observed: PluginObservedStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePluginInstallationInput {
  userId: string;
  workerId: string;
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  desiredEnabled?: boolean;
  envKeys?: string[];
  secretKeys?: string[];
}

export class PluginInstallationStore extends UserScopedJsonStore<
  string,
  PluginInstallationRecord
> {
  constructor(dataDir: string) {
    super(dataDir, "plugin-installations.json", (installation) => {
      validatePersistedInstallation(installation);
      return installation.id;
    });
  }

  getById(id: string): PluginInstallationRecord | undefined {
    return this.findWithOwner((item) => item.id === id)?.item;
  }

  listForWorker(userId: string, workerId: string): PluginInstallationRecord[] {
    return this.listForUser(userId).filter(
      (item) => item.workerId === workerId,
    );
  }

  async create(
    input: CreatePluginInstallationInput,
  ): Promise<PluginInstallationRecord> {
    assertIdentifier(input.userId, "userId");
    assertIdentifier(input.workerId, "workerId");
    assertIdentifier(input.definitionId, "definitionId");
    if (!/^[0-9a-f]{64}$/.test(input.definitionHash))
      bad("definitionHash is invalid");
    if (!input.definitionVersion || typeof input.definitionVersion !== "string")
      bad("definitionVersion is required");
    const envKeys = validateKeyReferences(input.envKeys, "envKeys");
    const secretKeys = validateKeyReferences(input.secretKeys, "secretKeys");
    if (envKeys.some((key) => secretKeys.includes(key)))
      bad("A key cannot be both an env and secret reference");
    const stamp = new Date().toISOString();
    const installation: PluginInstallationRecord = {
      schemaVersion: 1,
      id: randomUUID(),
      userId: input.userId,
      workerId: input.workerId,
      definitionId: input.definitionId,
      definitionVersion: input.definitionVersion,
      definitionHash: input.definitionHash,
      desiredEnabled: input.desiredEnabled ?? true,
      envKeys,
      secretKeys,
      observed: {
        state: input.desiredEnabled === false ? "disabled" : "pending",
        ready: false,
        checkedAt: stamp,
      },
      createdAt: stamp,
      updatedAt: stamp,
    };
    await this.setItem(input.userId, installation);
    return structuredClone(installation);
  }

  async setDesiredEnabled(
    userId: string,
    id: string,
    desiredEnabled: boolean,
  ): Promise<PluginInstallationRecord> {
    return this.mutateInstallation(userId, id, (current) => ({
      ...current,
      desiredEnabled,
      observed: {
        state: desiredEnabled ? "pending" : "stopping",
        ready: false,
        checkedAt: new Date().toISOString(),
      },
    }));
  }

  async setObserved(
    userId: string,
    id: string,
    observed: PluginObservedStatus,
  ): Promise<PluginInstallationRecord> {
    validateObserved(observed);
    return this.mutateInstallation(userId, id, (current) => ({
      ...current,
      observed: structuredClone(observed),
    }));
  }

  /**
   * Allocates all declared ports/displays in the same durable owner mutation.
   * Existing valid allocations are retained, giving stable resources across
   * disable/enable, orchestrator restart, and worker rebuild.
   */
  async reserveResources(
    userId: string,
    id: string,
    manifest: PluginManifest,
  ): Promise<PluginInstallationRecord> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      const current = map?.get(id);
      if (!map || !current) throw notFound();
      const previous = structuredClone(current);
      const usedPorts = new Set<number>();
      const usedDisplays = new Set<number>();
      for (const candidate of map.values()) {
        if (candidate.id === id || candidate.workerId !== current.workerId)
          continue;
        for (const port of Object.values(candidate.allocations?.ports ?? {}))
          usedPorts.add(port);
        if (
          candidate.allocations?.display !== undefined &&
          candidate.allocations.display !== 99
        )
          usedDisplays.add(candidate.allocations.display);
      }
      const ports: Record<string, number> = {};
      for (const requirement of manifest.resources?.ports ?? []) {
        const reusable = current.allocations?.ports[requirement.id];
        if (
          reusable !== undefined &&
          portMatches(reusable, requirement) &&
          !usedPorts.has(reusable)
        ) {
          ports[requirement.id] = reusable;
          usedPorts.add(reusable);
          continue;
        }
        const port = allocatePort(requirement, usedPorts);
        ports[requirement.id] = port;
        usedPorts.add(port);
      }
      const display = allocateDisplay(
        manifest.resources?.display,
        current.allocations?.display,
        usedDisplays,
      );
      const updated: PluginInstallationRecord = {
        ...current,
        allocations: {
          ports,
          ...(display !== undefined ? { display } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
      map.set(id, updated);
      try {
        await this.persistUser(userId);
      } catch (error) {
        map.set(id, previous);
        throw error;
      }
      return structuredClone(updated);
    });
  }

  async releaseResources(
    userId: string,
    id: string,
  ): Promise<PluginInstallationRecord> {
    return this.mutateInstallation(userId, id, (current) => {
      const updated = { ...current };
      delete updated.allocations;
      return updated;
    });
  }

  async delete(userId: string, id: string): Promise<void> {
    if (!(await this.deleteItem(userId, id))) throw notFound();
  }

  async removeForWorker(userId: string, workerId: string): Promise<number> {
    return this.removeWhere(
      (installation) =>
        installation.userId === userId && installation.workerId === workerId,
    );
  }

  private async mutateInstallation(
    userId: string,
    id: string,
    operation: (current: PluginInstallationRecord) => PluginInstallationRecord,
  ): Promise<PluginInstallationRecord> {
    return this.withUserMutation(userId, async () => {
      const map = this.items.get(userId);
      const current = map?.get(id);
      if (!map || !current) throw notFound();
      const updated = {
        ...operation(structuredClone(current)),
        id: current.id,
        userId: current.userId,
        workerId: current.workerId,
        definitionId: current.definitionId,
        definitionVersion: current.definitionVersion,
        definitionHash: current.definitionHash,
        createdAt: current.createdAt,
        updatedAt: new Date().toISOString(),
      };
      validatePersistedInstallation(updated);
      map.set(id, updated);
      try {
        await this.persistUser(userId);
      } catch (error) {
        map.set(id, current);
        throw error;
      }
      return structuredClone(updated);
    });
  }
}

function allocatePort(
  requirement: PluginPortRequirement,
  used: Set<number>,
): number {
  if (requirement.fixedPort !== undefined) {
    if (used.has(requirement.fixedPort))
      conflict(`Port ${requirement.fixedPort} is already allocated`);
    return requirement.fixedPort;
  }
  for (
    let port = requirement.rangeStart!;
    port <= requirement.rangeEnd!;
    port++
  )
    if (!used.has(port)) return port;
  conflict(`No port is available for ${requirement.id}`);
}

function portMatches(
  port: number,
  requirement: PluginPortRequirement,
): boolean {
  return requirement.fixedPort !== undefined
    ? port === requirement.fixedPort
    : port >= requirement.rangeStart! && port <= requirement.rangeEnd!;
}

function allocateDisplay(
  requirement: PluginDisplayRequirement | undefined,
  current: number | undefined,
  used: Set<number>,
): number | undefined {
  if (!requirement || requirement.mode === "none") return undefined;
  if (requirement.mode === "shared") return 99;
  if (
    current !== undefined &&
    current >= requirement.rangeStart! &&
    current <= requirement.rangeEnd! &&
    !used.has(current)
  )
    return current;
  for (
    let display = requirement.rangeStart!;
    display <= requirement.rangeEnd!;
    display++
  )
    if (!used.has(display)) return display;
  conflict("No dedicated display is available");
}

function validatePersistedInstallation(
  input: unknown,
): asserts input is PluginInstallationRecord {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid persisted plugin installation");
  const item = input as PluginInstallationRecord;
  if (
    item.schemaVersion !== 1 ||
    !item.id ||
    typeof item.id !== "string" ||
    !item.userId ||
    typeof item.userId !== "string" ||
    !item.workerId ||
    typeof item.workerId !== "string" ||
    !item.definitionId ||
    typeof item.definitionId !== "string" ||
    !item.definitionVersion ||
    typeof item.definitionVersion !== "string" ||
    !/^[0-9a-f]{64}$/.test(item.definitionHash) ||
    typeof item.desiredEnabled !== "boolean" ||
    typeof item.createdAt !== "string" ||
    typeof item.updatedAt !== "string"
  )
    throw new Error("Invalid persisted plugin installation");
  validateKeyReferences(item.envKeys, "envKeys");
  validateKeyReferences(item.secretKeys, "secretKeys");
  if (item.envKeys.some((key) => item.secretKeys.includes(key)))
    throw new Error("Overlapping plugin key references");
  validateObserved(item.observed);
  if (item.allocations) {
    if (
      !item.allocations.ports ||
      typeof item.allocations.ports !== "object" ||
      Array.isArray(item.allocations.ports)
    )
      throw new Error("Invalid plugin resource allocation");
    for (const [key, value] of Object.entries(item.allocations.ports))
      if (!key || !Number.isInteger(value) || value < 1 || value > 65_535)
        throw new Error("Invalid plugin port allocation");
    if (
      item.allocations.display !== undefined &&
      (!Number.isInteger(item.allocations.display) ||
        item.allocations.display < 1 ||
        item.allocations.display > 999)
    )
      throw new Error("Invalid plugin display allocation");
  }
}

function validateObserved(
  input: unknown,
): asserts input is PluginObservedStatus {
  const states: PluginObservedState[] = [
    "disabled",
    "pending",
    "installing",
    "starting",
    "ready",
    "degraded",
    "stopping",
    "stopped",
    "cleaning",
    "error",
  ];
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid plugin observed state");
  const observed = input as PluginObservedStatus;
  if (
    !states.includes(observed.state) ||
    typeof observed.ready !== "boolean" ||
    typeof observed.checkedAt !== "string"
  )
    throw new Error("Invalid plugin observed state");
  if (
    observed.error &&
    (typeof observed.error.code !== "string" ||
      typeof observed.error.message !== "string")
  )
    throw new Error("Invalid plugin observed error");
}

function validateKeyReferences(input: unknown, label: string): string[] {
  if (input === undefined) return [];
  if (
    !Array.isArray(input) ||
    input.length > 256 ||
    input.some((key) => typeof key !== "string" || !USER_ENV_KEY_RE.test(key))
  )
    bad(`${label} must contain valid environment key names`);
  if (new Set(input).size !== input.length) bad(`${label} contains duplicates`);
  return [...input];
}

function assertIdentifier(
  input: unknown,
  label: string,
): asserts input is string {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 200 ||
    input.includes("\0")
  )
    bad(`${label} is invalid`);
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

function conflict(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 409 });
}

function notFound() {
  return Object.assign(new Error("Plugin installation not found"), {
    statusCode: 404,
  });
}
