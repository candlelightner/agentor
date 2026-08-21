import type { WorkerSelfContext } from "./worker-auth";
import type { WorkerSelfMcpDomain } from "./worker-self-mcp";
import { assertDefinitionVisibleToWorker } from "./plugin-scope";
import { usePluginDefinitionStore, usePluginInstallationStore, usePluginRuntimeManager, useWorkerGroupStore } from "./services";

export class WorkerSelfPluginDomain implements WorkerSelfMcpDomain {
  tools() { return [
    tool("plugins.list", "List plugins installed on this worker, including status, local allocations, actions, and documentation. Secret values are never returned.", {}, true),
    tool("plugins.inspect", "Inspect one installation belonging to this worker. Other workers are never addressable.", { installationId: { type: "string" } }, true, ["installationId"]),
    tool("plugins.definitions.list", "List reusable definitions visible to this worker. No other-worker metadata or secret value is exposed.", {}, true),
    tool("plugins.definitions.create", "Create a definition scoped only to this worker. Use secret key names in the manifest; literal secret values are rejected.", { manifest: { type: "object" } }, false, ["manifest"]),
    tool("plugins.definitions.update", "Replace a definition owned by this worker. Platform, owner, group, and other-worker definitions are read-only.", { definitionId: { type: "string" }, manifest: { type: "object" } }, false, ["definitionId", "manifest"]),
    tool("plugins.definitions.delete", "Delete an unused definition owned by this worker.", { definitionId: { type: "string" } }, false, ["definitionId"]),
    tool("plugins.install", "Install a visible definition on this worker. envKeys and secretKeys contain names only, never values.", { definitionId: { type: "string" }, enabled: { type: "boolean" }, envKeys: { type: "array", items: { type: "string" } }, secretKeys: { type: "array", items: { type: "string" } } }, false, ["definitionId"]),
    tool("plugins.set-enabled", "Enable or disable one installation belonging to this worker and return its bounded lifecycle result.", { installationId: { type: "string" }, enabled: { type: "boolean" } }, false, ["installationId", "enabled"]),
    tool("plugins.uninstall", "Stop, clean up, and remove one installation belonging to this worker.", { installationId: { type: "string" } }, false, ["installationId"]),
  ]; }

  async invoke(context: WorkerSelfContext, name: string, args: Record<string, unknown>) {
    const definitions = usePluginDefinitionStore(), installations = usePluginInstallationStore();
    const records = installations.listForWorker(context.userId, context.workerId);
    if (name === "plugins.list") return records.map(publicInstallation).filter(Boolean);
    if (name === "plugins.inspect") {
      const found = records.find((item) => item.id === args.installationId);
      if (!found) throw failure(404, "Resource not found");
      return publicInstallation(found);
    }
    if (name === "plugins.definitions.list") return definitions.listForOwner(context.userId).filter((definition) => visible(context, definition));
    if (name === "plugins.definitions.create") return definitions.create({ scope: "worker", ownerId: context.userId, workerId: context.workerId, manifest: args.manifest });
    if (name === "plugins.definitions.update" || name === "plugins.definitions.delete") {
      const definition = owned(context, String(args.definitionId || ""));
      if (name.endsWith("update")) return definitions.update(definition.id, args.manifest);
      if (records.some((item) => item.definitionId === definition.id)) throw failure(409, "Plugin definition is installed");
      await definitions.delete(definition.id); return { ok: true };
    }
    if (name === "plugins.install") {
      const definition = definitions.getById(String(args.definitionId || ""));
      assertDefinitionVisibleToWorker(definition, context.container, useWorkerGroupStore());
      const envKeys = strings(args.envKeys), secretKeys = strings(args.secretKeys);
      const declaredEnv = new Set(definition.manifest.environment?.envKeys ?? []), declaredSecrets = new Set(definition.manifest.environment?.secretKeys ?? []);
      if (envKeys.some((key) => !declaredEnv.has(key)) || secretKeys.some((key) => !declaredSecrets.has(key))) throw failure(400, "Undeclared environment key reference");
      const created = await installations.create({ userId: context.userId, workerId: context.workerId, definitionId: definition.id, definitionVersion: definition.manifest.version, definitionHash: definition.definitionHash, desiredEnabled: args.enabled !== false, envKeys, secretKeys });
      try { return created.desiredEnabled ? await usePluginRuntimeManager().reconcileInstallation(context.userId, created.id, context.container.containerId) : created; }
      catch (error) { await installations.delete(context.userId, created.id).catch(() => undefined); throw error; }
    }
    const installation = records.find((item) => item.id === args.installationId);
    if (!installation) throw failure(404, "Resource not found");
    if (name === "plugins.uninstall") { await usePluginRuntimeManager().uninstall(context.userId, installation.id, context.container.containerId); return { ok: true }; }
    if (name === "plugins.set-enabled") {
      if (typeof args.enabled !== "boolean") throw failure(400, "enabled must be boolean");
      return args.enabled ? usePluginRuntimeManager().enable(context.userId, installation.id, context.container.containerId) : usePluginRuntimeManager().disable(context.userId, installation.id, context.container.containerId);
    }
    throw failure(404, "Unknown worker plugin tool");
  }
}

function tool(name: string, description: string, properties: Record<string, unknown>, readOnly: boolean, required: string[] = []) { return { name, description, inputSchema: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) }, annotations: { readOnlyHint: readOnly, destructiveHint: name.endsWith("delete") || name.endsWith("uninstall") } }; }
function failure(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
function strings(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw failure(400, "Key references must be strings"); return value as string[]; }
function visible(context: WorkerSelfContext, definition: any) { try { assertDefinitionVisibleToWorker(definition, context.container, useWorkerGroupStore()); return true; } catch { return false; } }
function owned(context: WorkerSelfContext, id: string) { const definition = usePluginDefinitionStore().getById(id); if (!definition || definition.scope !== "worker" || definition.userId !== context.userId || definition.workerId !== context.workerId || definition.builtIn) throw failure(404, "Resource not found"); return definition; }

function publicInstallation(installation: ReturnType<ReturnType<typeof usePluginInstallationStore>["getById"]>) {
  if (!installation) return undefined;
  const definition = usePluginDefinitionStore().getById(installation.definitionId);
  if (!definition || definition.definitionHash !== installation.definitionHash) return undefined;
  return { id: installation.id, definitionId: definition.id, name: definition.manifest.name, version: definition.manifest.version, desiredEnabled: installation.desiredEnabled, observed: installation.observed, allocations: installation.allocations ?? { ports: {} }, actions: definition.manifest.actions ?? [], documentation: definition.manifest.documentation ?? {}, environment: { envKeys: installation.envKeys, secretKeys: installation.secretKeys } };
}
