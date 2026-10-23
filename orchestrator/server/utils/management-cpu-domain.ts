import { useAdminWorkspaceStore } from './admin-workspace-store';
import { useGroupAdminWorkspaceStore } from './group-admin-workspace-store';
import { useContainerManager, useLogger, useWorkerGroupStore, useWorkerStore } from './services';
import { useWorkerProtectionLockStore } from './worker-protection-lock';
import { WorkerGroupHierarchy } from './worker-group-hierarchy';
import { effectiveGroupVcpuLimit } from './worker-vcpu-policy';
import { validateVcpuCount } from '../../shared/vcpu-count';
import { managementFailFastTimeoutSeconds, withinManagementFailFastDeadline } from './management-worker-domain';

export interface ManagementCpuAuthority {
  scope: 'platform' | 'group';
  workspaceId: string;
  ownerId?: string;
  groupId?: string;
  reauthorize: () => void;
}
const prefixes = ['workers.cpu', 'admin-workspace.cpu', 'groups.admin-workspace.cpu'];
export const managementCpuTools = prefixes.flatMap(prefix => ['get', 'set', 'reconcile'].map(action => {
  const target = prefix === 'workers.cpu' ? 'workerId' : prefix === 'groups.admin-workspace.cpu' ? 'groupId' : undefined;
  const read = action === 'get';
  return {
    name: `${prefix}.${action}`,
    group: read ? 'configuration-inspection' as const : 'worker-lifecycle' as const,
    description: `${read ? 'Inspect effective' : action === 'set' ? 'Set a stopped VM guest' : 'Reconcile only the recorded pending'} vCPU count for ${target === 'workerId' ? 'an ordinary worker' : target === 'groupId' ? 'a group administrative workspace' : 'the calling administrative workspace'}. Group callers are restricted to their live subtree and delegated per-worker ceiling. Protected mutations require lockPassword. A timeout never retries the backend resize; inspect and reconcile its recorded operation.`,
    inputSchema: { type: 'object', additionalProperties: false,
      required: [...(target ? [target] : []), ...(action === 'set' ? ['vcpuCount'] : [])],
      properties: {
        ...(target ? { [target]: { type: 'string', minLength: 1 } } : {}),
        ...(action === 'set' ? { vcpuCount: { type: 'integer', minimum: 1 } } : {}),
        ...(!read ? { lockPassword: { type: 'string', writeOnly: true } } : {}),
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120, description: 'Caller deadline; accepted work remains serialized after timeout.' },
      } },
    annotations: { readOnlyHint: read, destructiveHint: false, idempotentHint: action !== 'set', openWorldHint: false },
  };
}));
export const MANAGEMENT_CPU_NAMES = managementCpuTools.map(tool => tool.name);

const dependencies = {
  manager: useContainerManager,
  groups: useWorkerGroupStore,
  workers: useWorkerStore,
  admin: useAdminWorkspaceStore,
  groupAdmin: useGroupAdminWorkspaceStore,
  locks: useWorkerProtectionLockStore,
  limit: effectiveGroupVcpuLimit,
};

/** Uses the same serialized CPU transactions as REST; reconciliation can never submit a new resize. */
export class ManagementCpuDomain {
  constructor(private readonly deps = dependencies) {}

  async execute(name: string, args: Record<string, unknown>, authority: ManagementCpuAuthority) {
    const tool = managementCpuTools.find(tool => tool.name === name);
    if (!tool) return { handled: false };
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    for (const key of Object.keys(args))
      if (!Object.hasOwn(properties, key)) throw failure(400, 'Unexpected CPU argument');
    for (const key of tool.inputSchema.required)
      if (args[key] === undefined) throw failure(400, `${key} is required`);
    for (const key of ['workerId', 'groupId', 'lockPassword'])
      if (args[key] !== undefined && (typeof args[key] !== 'string' || key !== 'lockPassword' && !args[key]))
        throw failure(400, `${key} must be a string`);
    if (name.endsWith('.set')) validateVcpuCount(args.vcpuCount);
    const timeout = managementFailFastTimeoutSeconds(args.timeoutSeconds);
    try {
      return { handled: true, result: await withinManagementFailFastDeadline(
        () => this.operate(name, args, authority), timeout, name,
      ) };
    } catch (error: any) {
      if (error?.statusCode === 504)
        useLogger().warn(`[management-cpu] ${name} caller deadline exceeded; accepted work remains serialized. Inspect CPU settings and reconcile any recorded pending operation; no resize was replayed.`);
      throw error;
    }
  }

  private async operate(name: string, args: Record<string, unknown>, authority: ManagementCpuAuthority) {
    const ordinary = name.startsWith('workers.');
    const groupTarget = name.startsWith('groups.') || !ordinary && authority.scope === 'group';
    const groupId = name.startsWith('groups.') ? args.groupId as string : authority.groupId;
    const groups = this.deps.groups();
    const targetId = ordinary ? args.workerId as string : groupTarget
      ? groups.findById(groupId!)?.adminWorkspace?.id : this.deps.admin().getRecord()?.id;
    const authorize = () => {
      authority.reauthorize();
      if (!targetId) throw failure(404, 'CPU target is not provisioned');
      if (authority.scope === 'group') {
        const live = groups.findById(authority.groupId!);
        if (!live || live.userId !== authority.ownerId) throw failure(404, 'Resource not found');
        const hierarchy = new WorkerGroupHierarchy(groups);
        if (ordinary) {
          const worker = this.deps.manager().get(targetId);
          if (!worker || worker.userId !== authority.ownerId || !hierarchy.subtreeWorkerIds(authority.ownerId!, authority.groupId!).includes(targetId))
            throw failure(404, 'Resource not found');
        } else if (!hierarchy.canAdminister(authority.ownerId!, authority.groupId!, groupId!)) throw failure(404, 'Resource not found');
      }
      if (!ordinary && (groupTarget ? groups.findById(groupId!)?.adminWorkspace?.id : this.deps.admin().getRecord()?.id) !== targetId)
        throw failure(409, 'Administrative workspace changed; refresh CPU settings');
    };
    authorize();
    const settings = ordinary ? await this.deps.manager().getVcpuSettings(targetId!)
      : groupTarget ? await this.deps.groupAdmin().getCpuSettings(groupId!, authorize)
      : await this.deps.admin().getCpuSettings();
    authorize();
    if (name.endsWith('.get') || name.endsWith('.reconcile') && !settings.pending) return settings;
    const reconcileOnly = name.endsWith('.reconcile');
    const count = reconcileOnly ? validateVcpuCount(settings.pendingVcpuCount) : validateVcpuCount(args.vcpuCount);
    const authorizeMutation = () => {
      authorize();
      const pending = ordinary ? this.deps.workers().findById(targetId!)?.incusCpuResize
        : groupTarget ? groups.findById(groupId!)?.adminWorkspace?.nativeRuntime?.pending?.kind === 'cpu'
        : this.deps.admin().getRecord()?.nativeRuntime?.pending?.kind === 'cpu';
      if (authority.scope === 'group' && !reconcileOnly && (!settings.pending || !pending)) {
        const targetGroup = ordinary ? groups.listForUser(authority.ownerId!).find(group => group.workerIds.includes(targetId!))?.id : groupId;
        if (this.deps.limit(authority.ownerId!, targetGroup!) === null)
          throw failure(403, 'No per-worker vCPU ceiling has been delegated; CPU change stopped. Ask a parent administrator to delegate a ceiling.');
      }
    };
    await this.deps.locks().verify(targetId!, args.lockPassword);
    authorizeMutation();
    const result = await (ordinary ? this.deps.manager().setVcpuCount(targetId!, count, authorizeMutation, reconcileOnly)
      : groupTarget ? this.deps.groupAdmin().setCpuCount(groupId!, count, authorizeMutation, targetId, reconcileOnly)
      : this.deps.admin().setCpuCount(count, targetId, authorizeMutation, reconcileOnly));
    authorize();
    return result;
  }
}
function failure(statusCode: number, message: string) {
  useLogger().warn(`[management-cpu] ${message}; request stopped, recorded pending operations retained`);
  return Object.assign(new Error(message), { statusCode });
}
