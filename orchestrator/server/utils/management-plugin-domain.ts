import { definitionVisibleToWorker, groupAdminCanMutateDefinition } from './plugin-scope';
import {
  useContainerManager, usePluginDefinitionStore, usePluginInstallationStore,
  usePluginRuntimeManager, useWorkerGroupStore, useWorkerStore,
} from './services';

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const mutation = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const workerId = { type: 'string', description: 'Exact target worker ID. Authorization is evaluated against the authenticated administrative identity.' };
export class ManagementPluginDomain {
  tools() { return [
    tool('plugins.list', 'List definitions visible to a worker and its distinct installations. Secret values are never returned.', { type: 'object', additionalProperties: false, required: ['workerId'], properties: { workerId } }, read),
    tool('plugins.definitions.create', 'Create an owner-, group-, or worker-scoped reusable plugin definition for an authorized worker. Group administrators are limited to their subtree.', { type: 'object', additionalProperties: false, required: ['workerId', 'scope', 'manifest'], properties: { workerId, scope: { type: 'string', enum: ['owner','group','worker'] }, groupId: { type: 'string' }, manifest: { type: 'object' } } }, mutation),
    tool('plugins.definitions.update', 'Replace a mutable plugin definition visible to the target worker. Group administrators may modify only group/worker definitions in their subtree.', { type: 'object', additionalProperties: false, required: ['workerId', 'definitionId', 'manifest'], properties: { workerId, definitionId: { type: 'string' }, manifest: { type: 'object' } } }, mutation),
    tool('plugins.definitions.duplicate', 'Duplicate a visible definition into a new worker-scoped definition on the authorized target worker.', { type: 'object', additionalProperties: false, required: ['workerId', 'definitionId'], properties: { workerId, definitionId: { type: 'string' } } }, mutation),
    tool('plugins.definitions.delete', 'Delete an unused mutable definition in the authorized scope.', { type: 'object', additionalProperties: false, required: ['workerId', 'definitionId'], properties: { workerId, definitionId: { type: 'string' } } }, { ...mutation, destructiveHint: true }),
    tool('plugins.install', 'Install and reconcile one visible plugin definition on a running worker. Environment and secret fields contain key names only, never values. timeoutSeconds bounds the MCP wait.', { type: 'object', additionalProperties: false, required: ['workerId', 'definitionId'], properties: { workerId, definitionId: { type: 'string' }, envKeys: { type: 'array', items: { type: 'string' } }, secretKeys: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' }, timeoutSeconds: timeout() } }, mutation),
    tool('plugins.set-enabled', 'Enable or disable one plugin installation on its worker. timeoutSeconds bounds the MCP wait.', { type: 'object', additionalProperties: false, required: ['workerId', 'installationId', 'enabled'], properties: { workerId, installationId: { type: 'string' }, enabled: { type: 'boolean' }, timeoutSeconds: timeout() } }, mutation),
    tool('plugins.uninstall', 'Stop, clean up, and remove one plugin installation from its worker. timeoutSeconds bounds the MCP wait.', { type: 'object', additionalProperties: false, required: ['workerId', 'installationId'], properties: { workerId, installationId: { type: 'string' }, timeoutSeconds: timeout() } }, { ...mutation, destructiveHint: true }),
  ]; }
  async execute(name: string, args: Record<string, unknown>, authority?: { scope?: string; ownerId?: string; groupId?: string }) {
    if (!this.tools().some((item) => item.name === name)) return { handled: false };
    const id = required(args.workerId, 'workerId');
    const worker = useWorkerStore().findById(id);
    const runtime = useContainerManager().get(id);
    if (!worker || !runtime) throw fail(404, 'Worker not found');
    if (name === 'plugins.list') {
      const definitions = usePluginDefinitionStore().listForOwner(worker.userId)
        .filter((item) => definitionVisibleToWorker(item, worker, useWorkerGroupStore()));
      return { handled: true, result: { definitions, installations: usePluginInstallationStore().listForWorker(worker.userId, id) } };
    }
    if (name.startsWith('plugins.definitions.')) {
      const store = usePluginDefinitionStore();
      if (name === 'plugins.definitions.create') {
        const scope = String(args.scope || '');
        if (!['owner','group','worker'].includes(scope) || (authority?.scope === 'group' && scope === 'owner')) throw fail(403, 'Forbidden');
        const created = await store.create({ scope: scope as any, ownerId: worker.userId, groupId: scope === 'group' ? required(args.groupId, 'groupId') : undefined, workerId: scope === 'worker' ? worker.id : undefined, manifest: args.manifest });
        if (!definitionVisibleToWorker(created, worker, useWorkerGroupStore()) || (authority?.scope === 'group' && !groupAdminCanMutateDefinition(created, worker.userId, authority.groupId!, useWorkerGroupStore()))) { await store.delete(created.id).catch(() => undefined); throw fail(404, 'Resource not found'); }
        return { handled: true, result: created };
      }
      const definition = store.getById(required(args.definitionId, 'definitionId'));
      if (!definition || !definitionVisibleToWorker(definition, worker, useWorkerGroupStore()) || definition.builtIn || (authority?.scope === 'group' && !groupAdminCanMutateDefinition(definition, worker.userId, authority.groupId!, useWorkerGroupStore()))) throw fail(404, 'Resource not found');
      if (name === 'plugins.definitions.duplicate') return { handled: true, result: await store.create({ scope: 'worker', ownerId: worker.userId, workerId: worker.id, manifest: { ...definition.manifest, name: `${definition.manifest.name} copy`, slug: `${definition.manifest.slug}-copy-${Date.now().toString(36)}`.slice(0,64) } }) };
      if (name === 'plugins.definitions.update') return { handled: true, result: await store.update(definition.id, args.manifest) };
      if (usePluginInstallationStore().list().some((item) => item.definitionId === definition.id)) throw fail(409, 'Plugin definition is installed');
      await store.delete(definition.id); return { handled: true, result: { ok: true } };
    }
    if (runtime.status !== 'running') throw fail(409, 'Worker is not running');
    if (name === 'plugins.install') {
      const definition = usePluginDefinitionStore().getById(required(args.definitionId, 'definitionId'));
      if (!definition || !definitionVisibleToWorker(definition, worker, useWorkerGroupStore())) throw fail(404, 'Resource not found');
      const envKeys = stringArray(args.envKeys), secretKeys = stringArray(args.secretKeys);
      const declaredEnv = new Set(definition.manifest.environment?.envKeys ?? []);
      const declaredSecrets = new Set(definition.manifest.environment?.secretKeys ?? []);
      if (envKeys.some((key) => !declaredEnv.has(key)) || secretKeys.some((key) => !declaredSecrets.has(key))) throw fail(400, 'Undeclared environment key reference');
      const created = await usePluginInstallationStore().create({ userId: worker.userId, workerId: id, definitionId: definition.id, definitionVersion: definition.manifest.version, definitionHash: definition.definitionHash, desiredEnabled: args.enabled !== false, envKeys, secretKeys });
      try { return { handled: true, result: await usePluginRuntimeManager().reconcileInstallation(worker.userId, created.id, runtime.containerId) }; }
      catch (error) { await usePluginInstallationStore().delete(worker.userId, created.id).catch(() => undefined); throw error; }
    }
    const installationId = required(args.installationId, 'installationId');
    const installation = usePluginInstallationStore().getById(installationId);
    if (!installation || installation.userId !== worker.userId || installation.workerId !== id) throw fail(404, 'Resource not found');
    if (name === 'plugins.set-enabled') {
      if (typeof args.enabled !== 'boolean') throw fail(400, 'enabled must be boolean');
      return { handled: true, result: args.enabled ? await usePluginRuntimeManager().enable(worker.userId, installationId, runtime.containerId) : await usePluginRuntimeManager().disable(worker.userId, installationId, runtime.containerId) };
    }
    await usePluginRuntimeManager().uninstall(worker.userId, installationId, runtime.containerId);
    return { handled: true, result: { ok: true } };
  }
}
function tool(name: string, description: string, inputSchema: Record<string, unknown>, annotations: Record<string, boolean>) { return { name, group: 'apps' as const, description, inputSchema, annotations }; }
function timeout() { return { type: 'integer', minimum: 1, maximum: 120, default: 30, description: 'Maximum seconds to wait for this MCP call before returning a structured timeout.' }; }
function required(value: unknown, name: string) { if (typeof value !== 'string' || !value) throw fail(400, `${name} is required`); return value; }
function stringArray(value: unknown) { if (value === undefined) return []; if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw fail(400, 'Key references must be strings'); return value as string[]; }
function fail(statusCode: number, message: string) { return Object.assign(new Error(message), { statusCode }); }
