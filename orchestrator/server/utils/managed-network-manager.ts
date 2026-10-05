import Docker from "dockerode";
import { createError } from 'h3';
import {
  useContainerManager,
  useManagedNetworkStore,
  useWorkerStore,
  useConfig,
} from "./services";
import type { ManagedNetwork } from "./managed-network-store";
import { WorkerGroupHierarchy } from "./worker-group-hierarchy";
import { WorkerGroupStore } from './worker-group-store';
import { withOperationDeadline, operationSettlement } from "./operation-deadline";
import { IncusManagedNetworkHost } from './incus-managed-network-host';
import { IncusManagedDockerBridge } from './incus-managed-docker-bridge';
import { normalizeWorkerRuntimeKind } from '../../shared/types';
import { verifyWorkerMutationUnlocks } from './worker-protection-lock';
import { withOwnerWorkerLifecycleMutation, isWorkerLifecycleMutationPending } from './worker-lifecycle-coordinator';
import type { IncusManagedBridge } from './incus-managed-network-host';

const DOCKER_READ_TIMEOUT_MS = 8_000;
const DOCKER_MUTATION_TIMEOUT_MS = 30_000;

const forbidden = (name: string) =>
  name === "agentor-management" || /management|internal/i.test(name);

export class ManagedNetworkManager {
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" });
  private hostClient?: IncusManagedNetworkHost;

  constructor(private readonly dependencies: {
    manager?: () => ReturnType<typeof useContainerManager>;
    workers?: () => ReturnType<typeof useWorkerStore>;
    host?: () => IncusManagedNetworkHost;
    config?: () => ReturnType<typeof useConfig>;
  } = {}) {}

  private manager() { return this.dependencies.manager?.() ?? useContainerManager(); }
  private workers() { return this.dependencies.workers?.() ?? useWorkerStore(); }
  private config() { return this.dependencies.config?.() ?? useConfig(); }
  private host() { return this.dependencies.host?.() ?? (this.hostClient ??= new IncusManagedNetworkHost(this.config())); }
  private async nativeBridge(network: ManagedNetwork) {
    const config = this.config();
    return this.dependencies.host || config.incusEnabled || config.incusNetworkHostEndpoint
      ? this.host().inspect(network) : null;
  }

  /** Authorization preflight, not user-facing diagnostic topology. Every actual
   * peer must map to current durable owner/runtime + captured native identity.
   * Callers union these IDs with desired IDs before verifying protection locks,
   * then repeat this read before dispatch to reject newly uncovered peers. */
  async actualWorkerIds(network: ManagedNetwork, lifecycleRead?: {
    workerId: string; containerId: string; inspect: () => Promise<{ attached: boolean }>;
  }): Promise<string[]> {
    this.assertSafe(network);
    const manager = this.manager(), workers = this.workers();
    const ids = new Set<string>();
    const inspect = async (name: string) => {
      try { return await withOperationDeadline(this.docker.getNetwork(name).inspect(),
        DOCKER_READ_TIMEOUT_MS, 'Docker managed-network authority inspection'); }
      catch (error: any) { if (error?.statusCode === 404) return null; throw error; }
    };
    const legacy = await inspect(network.dockerName);
    if (legacy) this.assertDockerOwnership(network, legacy);
    const sharedProbe = await inspect(`${network.dockerName}-incus`);
    const config = this.dependencies.config?.() ?? useConfig();
    const native = sharedProbe || this.dependencies.host || config.incusEnabled || config.incusNetworkHostEndpoint
      ? await this.host().inspect(network) : null;
    let shared: Docker.NetworkInspectInfo | null = null;
    if (sharedProbe) {
      if (!native) throw new Error('Shared Docker network has no authoritative native backing bridge');
      shared = await new IncusManagedDockerBridge(this.docker).inspect(network, native);
      if (!shared) throw new Error('Shared Docker network changed during authority inspection');
    }
    for (const inspection of [legacy, shared]) {
      if (!inspection) continue;
      if (!inspection.Containers || typeof inspection.Containers !== 'object' || Array.isArray(inspection.Containers))
        throw new Error('Managed network endpoint authority is unavailable');
      for (const [containerId, endpoint] of Object.entries(inspection.Containers)) {
        const candidates = manager.list().filter(worker => worker.containerId === containerId &&
          worker.containerName === endpoint.Name);
        const worker = candidates.length === 1 ? candidates[0] : undefined;
        const record = worker && workers.get(network.userId, worker.id);
        if (!worker || worker.userId !== network.userId || worker.administrativeKind || !record ||
            record.id !== worker.id || record.userId !== network.userId || record.status !== 'active' || record.deletionPending || record.incusRecreation ||
            normalizeWorkerRuntimeKind(record.runtimeKind) !== 'legacy-docker' ||
            normalizeWorkerRuntimeKind(worker.runtimeKind) !== 'legacy-docker' || containerId.startsWith('incus:'))
          throw new Error('Managed network has a foreign, stale or ambiguous Docker endpoint');
        ids.add(worker.id);
      }
    }
    // Native root-side references include VMs missing from our cache or in a
    // foreign project. Reject them, never omit/adopt/name-manage them. Do not
    // probe unrelated unavailable owner VMs that have no NIC on this bridge.
    for (const reference of native?.references ?? []) {
      if (!reference.startsWith('/1.0/instances/'))
        throw new Error('Managed native bridge has a foreign or unsupported reference');
      const url = new URL(reference, 'https://incus.invalid');
      const match = /^\/1\.0\/instances\/([^/]+)$/.exec(url.pathname);
      const project = url.searchParams.get('project') ?? 'default';
      if (url.origin !== 'https://incus.invalid' || url.hash || !match || project !== config.incusProject ||
          [...url.searchParams.keys()].some(key => key !== 'project') || url.searchParams.getAll('project').length > 1)
        throw new Error('Managed native bridge has a foreign or unsupported reference');
      const name = decodeURIComponent(match[1]!);
      const candidates = manager.list().filter(worker => worker.containerName === name);
      const worker = candidates.length === 1 ? candidates[0] : undefined;
      const record = worker && workers.get(network.userId, worker.id);
      if (!worker || worker.userId !== network.userId || worker.runtimeKind !== 'incus-vm' || worker.administrativeKind ||
          !record || record.userId !== network.userId || record.id !== worker.id || record.runtimeKind !== 'incus-vm' ||
          record.status !== 'active' || record.deletionPending || record.incusRecreation)
        throw new Error('Managed native bridge has an unmapped, foreign or stale instance reference');
      // Only this lifecycle's captured worker can use its already-fenced native
      // leaf. Sibling reads still go through ordinary mutation/generation guards.
      const state = lifecycleRead?.workerId === worker.id && lifecycleRead.containerId === worker.containerId &&
        isWorkerLifecycleMutationPending(worker.id)
        ? await lifecycleRead.inspect() : await manager.inspectIncusManagedNetwork(worker.id, network.id);
      if (!state.attached) throw new Error('Managed native bridge reference has no verified worker NIC');
      ids.add(worker.id);
    }
    return [...ids].sort();
  }

  async members(network: ManagedNetwork) {
    let ids: string[];
    if (network.scope === "all")
      ids = this.workers()
        .listForUser(network.userId)
        .filter((worker) => worker.status !== "archived")
        .map((worker) => worker.id);
    else if (network.scope === "group" && network.groupId) {
      const groups = new WorkerGroupStore(this.config().dataDir); await groups.loadUser(network.userId);
      ids = groups.get(network.userId, network.groupId)
        ? new WorkerGroupHierarchy(groups).subtreeWorkerIds(network.userId, network.groupId)
        : [];
    }
    else ids = network.workerIds;
    return [...new Set(ids)].filter((id) => this.workers().get(network.userId, id));
  }

  async reconcile(network: ManagedNetwork, workerIds?: Iterable<string>, coveredWorkerIds?: ReadonlySet<string>) {
    this.assertSafe(network);
    const target = new Set(workerIds === undefined ? await this.members(network) : workerIds);
    const coverage = await this.mutationCoverage(network, target, coveredWorkerIds);
    if (workerIds !== undefined && !target.size && !(await this.actualWorkerIds(network)).length)
      return { workerIds: [], partialFailures: [] };
    for (const id of target) this.authoritativeWorker(network, id);
    const existingNative = await this.nativeBridge(network);
    const needsNative = existingNative || (!target.size && this.config().incusEnabled) || [...target].some(id =>
      normalizeWorkerRuntimeKind(this.workers().get(network.userId, id)?.runtimeKind) === 'incus-vm');
    // Detach/delete only observes existing resources. Never create an adapter
    // or repair/regrant a host bridge just to remove a NIC from it.
    const materialize = workerIds === undefined || target.size > 0;
    const bridge = needsNative ? existingNative ?? (materialize ? await this.host().ensure(network) : undefined) : undefined;
    const adapter = new IncusManagedDockerBridge(this.docker);
    const dockerNetwork = bridge ? materialize ? await adapter.ensure(network, bridge) : await adapter.inspect(network, bridge)
      : materialize ? await this.ensure(network) : await this.inspectLegacy(network);
    await this.mutationCoverage(network, target, coverage);
    const actual = new Set(await this.actualWorkerIds(network));
    const failures: string[] = [];
    for (const id of new Set([...target, ...actual])) {
      try {
        // Inspect again outside the per-worker mutation fence. Native topology
        // intentionally refuses pending lifecycle changes, including our own.
        await this.mutationCoverage(network, target, coverage);
        const worker = this.authoritativeWorker(network, id);
        if (!worker) continue; // absent/archived desired compute is not adopted
        const attach = target.has(id);
        if (worker.runtimeKind === 'incus-vm') {
          if (attach && !bridge) throw new Error('Incus managed bridge is unavailable');
          if (!attach || !actual.has(id)) await this.manager().setIncusManagedNetwork(id, network.id, attach);
        } else {
          const destination = dockerNetwork ?? await this.inspectLegacy(network);
          if (!destination) throw new Error('Managed Docker backing bridge is missing');
          await withOwnerWorkerLifecycleMutation(network.userId, id, async () => {
            const current = this.authoritativeWorker(network, id);
            if (!current || current.containerId !== worker.containerId)
              throw new Error('Managed Docker worker changed before network mutation');
            await this.setDockerMembership(network, current.containerId, destination, attach, bridge);
          });
        }
      } catch (error: any) {
        // Preserve late-request settlement authority. Do not attempt subsequent
        // mutations/rollback against an unclosed Docker request as if it ended.
        if (error?.[operationSettlement]) throw error;
        failures.push(`${target.has(id) ? 'attach' : 'detach'} ${id}: ${safeMessage(error)}`);
      }
    }
    const settled = new Set(await this.actualWorkerIds(network));
    for (const id of settled) if (!target.has(id)) failures.push(`detach ${id}: endpoint remains attached; retry reconciliation`);
    for (const id of target) if (this.manager().get(id) && !settled.has(id))
      failures.push(`attach ${id}: endpoint is not present; retry reconciliation`);
    return { workerIds: [...target], partialFailures: failures };
  }

  async reconcileOwner(userId: string) {
    const results = [];
    for (const network of useManagedNetworkStore().listForUser(userId))
      results.push({ networkId: network.id, ...(await this.reconcile(network)) });
    return results;
  }

  /** Lifecycle-only leaf: the caller already owns owner→worker admission and
   * any protection unlock. Restore only this captured worker, never adapt or
   * detach siblings during create/rebuild/recovery. Do not reacquire its queue. */
  async reconcileWorker(network: ManagedNetwork, workerId: string, containerId: string,
    incus: { inspect: () => Promise<{ attached: boolean }>; set: (attach: boolean) => Promise<void> }) {
    this.assertSafe(network);
    if (!isWorkerLifecycleMutationPending(workerId))
      throw new Error('Worker-local network reconciliation requires lifecycle admission');
    const worker = this.authoritativeWorker(network, workerId);
    if (!worker || worker.containerId !== containerId)
      throw new Error('Worker-local network incarnation changed');
    const attach = (await this.members(network)).includes(workerId);
    const read = { workerId, containerId, inspect: incus.inspect };
    await this.actualWorkerIds(network, read);
    const native = await this.nativeBridge(network);
    if (worker.runtimeKind === 'incus-vm') {
      if (attach && !native) {
        const legacy = await this.inspectLegacy(network);
        if (legacy && (!legacy.Containers || Object.keys(legacy.Containers).length))
          throw new Error('Managed network requires an authorized mixed-bridge reconciliation before this VM can join');
        await this.host().ensure(network);
      }
      await this.actualWorkerIds(network, read);
      if ((await incus.inspect()).attached !== attach) await incus.set(attach);
    } else {
      const adapter = new IncusManagedDockerBridge(this.docker);
      const destination = native ? attach ? await adapter.ensure(network, native) : await adapter.inspect(network, native)
        : attach ? await this.ensure(network) : await this.inspectLegacy(network);
      await this.actualWorkerIds(network, read);
      if (destination) await this.setDockerMembership(network, containerId, destination, attach, native ?? undefined);
    }
  }

  async remove(network: ManagedNetwork, coveredWorkerIds?: ReadonlySet<string>) {
    this.assertSafe(network);
    const coverage = await this.mutationCoverage(network, await this.members(network), coveredWorkerIds);
    try {
      const result = await this.reconcile(network, [], coverage);
      if (result.partialFailures.length) throw new Error(result.partialFailures.join('; '));
      await this.mutationCoverage(network, await this.members(network), coverage);
      const native = await this.nativeBridge(network);
      if (native) await new IncusManagedDockerBridge(this.docker).remove(network, native);
      const legacy = await this.inspectLegacy(network);
      if (legacy) {
        if (!legacy.Containers || Object.keys(legacy.Containers).length)
          throw new Error('Legacy managed bridge still has endpoints or unknown endpoint authority');
        await withOperationDeadline(signal => this.docker.getNetwork(legacy.Id).remove({ abortSignal: signal }),
          DOCKER_MUTATION_TIMEOUT_MS, 'Docker managed-network removal');
      }
      if (native) await this.host().remove(network);
    } catch (error: any) {
      if (error?.[operationSettlement]) throw error;
      throw createError({ statusCode: 409, statusMessage: `Network removal failed: ${safeMessage(error)}` });
    }
  }

  private authoritativeWorker(network: ManagedNetwork, id: string) {
    const record = this.workers().get(network.userId, id), worker = this.manager().get(id);
    if (!worker && (!record || record.status === 'archived')) return undefined;
    if (!worker || !record || record.status !== 'active' || record.userId !== network.userId || record.id !== id ||
        record.deletionPending || record.incusRecreation || worker.userId !== network.userId || worker.administrativeKind ||
        normalizeWorkerRuntimeKind(worker.runtimeKind) !== normalizeWorkerRuntimeKind(record.runtimeKind) || !worker.containerId ||
        (normalizeWorkerRuntimeKind(record.runtimeKind) === 'legacy-docker' && worker.containerId.startsWith('incus:')))
      throw new Error('Managed network worker authority is missing, foreign or stale');
    return { ...worker, runtimeKind: normalizeWorkerRuntimeKind(record.runtimeKind) };
  }

  private async inspectLegacy(network: ManagedNetwork) {
    try {
      const inspection = await withOperationDeadline(this.docker.getNetwork(network.dockerName).inspect(),
        DOCKER_READ_TIMEOUT_MS, 'Docker managed-network inspection');
      this.assertDockerOwnership(network, inspection); return inspection;
    } catch (error: any) { if (error?.statusCode === 404) return null; throw error; }
  }

  private async setDockerMembership(network: ManagedNetwork, containerId: string,
    destination: Docker.NetworkInspectInfo, attach: boolean, bridge?: IncusManagedBridge) {
    // Capture the exact endpoint configuration to preserve aliases during the
    // one-time connect-new-before-disconnect-old adaptation. Never recreate or
    // delete a populated original bridge to change its immutable IPAM/options.
    const container = await withOperationDeadline(signal => this.docker.getContainer(containerId).inspect({ abortSignal: signal }),
      DOCKER_READ_TIMEOUT_MS, 'Docker managed worker endpoint inspection');
    if (container.Id !== containerId) throw new Error('Managed Docker endpoint identity changed');
    const endpoints = container.NetworkSettings?.Networks;
    if (!endpoints || typeof endpoints !== 'object') throw new Error('Managed Docker endpoint state is unavailable');
    const source = endpoints[network.dockerName], target = endpoints[destination.Name];
    const legacy = source && bridge ? await this.inspectLegacy(network) : null;
    if (target && target.NetworkID !== destination.Id || source && bridge && source.NetworkID !== legacy?.Id)
      throw new Error('Managed Docker endpoint belongs to a replaced bridge');
    if (attach && !target) {
      const aliases = source?.Aliases;
      if (aliases != null && (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string' || alias.length > 253)))
        throw new Error('Managed Docker endpoint aliases are unavailable');
      await withOperationDeadline(signal => {
        const options = { Container: containerId, EndpointConfig: aliases ? { Aliases: aliases } : undefined, abortSignal: signal };
        return this.docker.getNetwork(destination.Id).connect(options);
      },
        DOCKER_MUTATION_TIMEOUT_MS, 'Docker managed-network attachment');
      const confirmed = await withOperationDeadline(signal => this.docker.getContainer(containerId).inspect({ abortSignal: signal }),
        DOCKER_READ_TIMEOUT_MS, 'Docker managed-network attachment verification');
      if (confirmed.Id !== containerId || confirmed.NetworkSettings?.Networks?.[destination.Name]?.NetworkID !== destination.Id)
        throw new Error('New managed Docker endpoint did not settle; original endpoint retained');
    }
    if (!attach && target)
      await withOperationDeadline(signal => this.docker.getNetwork(destination.Id).disconnect({ Container: containerId, Force: false, abortSignal: signal }),
        DOCKER_MUTATION_TIMEOUT_MS, 'Docker managed-network detachment');
    if (source && bridge && legacy && legacy.Id !== destination.Id)
      await withOperationDeadline(signal => this.docker.getNetwork(legacy.Id).disconnect({ Container: containerId, Force: false, abortSignal: signal }),
        DOCKER_MUTATION_TIMEOUT_MS, 'Docker original managed-network detachment');
  }

  async topology(network: ManagedNetwork) {
    this.assertSafe(network);
    const actualIds = await this.actualWorkerIds(network);
    const legacy = await this.inspectLegacy(network), native = await this.nativeBridge(network);
    const shared = native ? await new IncusManagedDockerBridge(this.docker).inspect(network, native) : null;
    const containers = new Map<string, { id: string; name: string; ipv4Address: string }>();
    for (const inspection of [legacy, shared])
      for (const [id, member] of Object.entries(inspection?.Containers ?? {}))
        containers.set(id, { id, name: member.Name, ipv4Address: member.IPv4Address });
    for (const id of actualIds) {
      const worker = this.authoritativeWorker(network, id);
      if (worker?.runtimeKind !== 'incus-vm') continue;
      const state = await this.manager().inspectIncusManagedNetwork(id, network.id);
      if (!state.attached) throw new Error('Managed network changed during topology inspection');
      containers.set(worker.containerId, { id: worker.containerId, name: worker.containerName,
        ipv4Address: state.ipv4Address });
    }
    return {
      network,
      exists: Boolean(legacy || native || shared),
      containers: [...containers.values()],
    };
  }

  async validate(network: ManagedNetwork) {
    const topology = await this.topology(network);
    const expected = await this.members(network);
    const names = new Set(topology.containers.map((container) => container.name));
    const missingWorkerIds = expected.filter((id) => {
      const worker = this.manager().get(id), record = this.workers().get(network.userId, id);
      return record?.status !== 'archived' && (!worker || !names.has(worker.containerName));
    });
    const unexpected = topology.containers.filter((container) => {
      const worker = this.manager().list().find(worker => worker.containerName === container.name);
      return !worker || !expected.includes(worker.id);
    });
    return { ok: topology.exists && missingWorkerIds.length === 0 && unexpected.length === 0, missingWorkerIds, unexpected, actual: topology.containers };
  }

  private assertSafe(network: ManagedNetwork) {
    if (forbidden(network.dockerName))
      throw createError({ statusCode: 400, statusMessage: "Management networks cannot be managed or attached" });
  }

  private async mutationCoverage(network: ManagedNetwork, desiredIds: Iterable<string>, covered?: ReadonlySet<string>) {
    const affected = new Set([...desiredIds, ...await this.actualWorkerIds(network)]);
    if (covered) {
      if ([...affected].some(id => !covered.has(id)))
        throw createError({ statusCode: 409, statusMessage: 'Managed network acquired an uncovered worker; retry authorization before mutation' });
      return covered;
    }
    // Internal/background callers have no password authority over protected
    // siblings. They may only perform an owner-wide reconciliation if every
    // affected worker is currently unlocked; worker-local hooks stay separate.
    await verifyWorkerMutationUnlocks(affected, undefined);
    return affected;
  }

  private async ensure(network: ManagedNetwork) {
    try {
      const existing = await withOperationDeadline(
        this.docker.getNetwork(network.dockerName).inspect(),
        DOCKER_READ_TIMEOUT_MS,
        'Docker managed-network inspection',
      );
      this.assertDockerOwnership(network, existing);
      return existing;
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    await withOperationDeadline(this.docker.createNetwork({
      Name: network.dockerName,
      Driver: "bridge",
      Internal: false,
      CheckDuplicate: true,
      Labels: { "agentor.managed-network": "true", "agentor.owner": network.userId },
    }), DOCKER_MUTATION_TIMEOUT_MS, 'Docker managed-network creation');
    const created = await withOperationDeadline(
      this.docker.getNetwork(network.dockerName).inspect(),
      DOCKER_READ_TIMEOUT_MS,
      'Docker managed-network post-create inspection',
    );
    this.assertDockerOwnership(network, created);
    return created;
  }

  private assertDockerOwnership(network: ManagedNetwork, inspection: Docker.NetworkInspectInfo) {
    if (inspection.Name !== network.dockerName || inspection.Driver !== 'bridge' || inspection.Internal ||
        inspection.Labels?.['agentor.managed-network'] !== 'true' || inspection.Labels?.['agentor.owner'] !== network.userId)
      throw createError({ statusCode: 409, statusMessage: 'Existing Docker network fails Agentor ownership policy' });
  }
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "Docker operation failed";
}

let singleton: ManagedNetworkManager | undefined;
export const useManagedNetworkManager = () => (singleton ??= new ManagedNetworkManager());
