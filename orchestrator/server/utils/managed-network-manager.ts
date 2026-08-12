import Docker from "dockerode";
import {
  useContainerManager,
  useManagedNetworkStore,
  useWorkerGroupStore,
  useWorkerStore,
} from "./services";
import type { ManagedNetwork } from "./managed-network-store";

const forbidden = (name: string) =>
  name === "agentor-management" || /management|internal/i.test(name);

export class ManagedNetworkManager {
  private readonly docker = new Docker({ socketPath: "/var/run/docker.sock" });

  async members(network: ManagedNetwork) {
    let ids: string[];
    if (network.scope === "all")
      ids = useWorkerStore()
        .listForUser(network.userId)
        .filter((worker) => worker.status !== "archived")
        .map((worker) => worker.id);
    else if (network.scope === "group" && network.groupId)
      ids = useWorkerGroupStore().get(network.userId, network.groupId)?.workerIds ?? [];
    else ids = network.workerIds;
    return [...new Set(ids)].filter((id) => useWorkerStore().get(network.userId, id));
  }

  async reconcile(network: ManagedNetwork) {
    this.assertSafe(network);
    const dockerNetwork = await this.ensure(network);
    const target = new Set(await this.members(network));
    const failures: string[] = [];
    const manager = useContainerManager();
    const currentByName = new Map(
      Object.entries(dockerNetwork.Containers || {}).map(([id, member]) => [
        member.Name,
        id,
      ]),
    );
    for (const id of target) {
      const worker = manager.get(id);
      if (!worker || !worker.containerId || currentByName.has(worker.containerName)) continue;
      await this.docker
        .getNetwork(network.dockerName)
        .connect({ Container: worker.containerId })
        .catch((error: any) => failures.push(`attach ${id}: ${safeMessage(error)}`));
    }
    for (const [name, containerId] of currentByName) {
      const worker = manager.findByContainerName(name);
      // A managed bridge is only for its selected Agentor workers. Do not let
      // a manually attached container quietly become a peer on that network.
      if (worker && target.has(worker.id)) continue;
      await this.docker
        .getNetwork(network.dockerName)
        .disconnect({ Container: containerId, Force: true })
        .catch((error: any) => failures.push(`detach ${worker?.id || name}: ${safeMessage(error)}`));
    }
    return { workerIds: [...target], partialFailures: failures };
  }

  async reconcileOwner(userId: string) {
    const results = [];
    for (const network of useManagedNetworkStore().listForUser(userId))
      results.push({ networkId: network.id, ...(await this.reconcile(network)) });
    return results;
  }

  async remove(network: ManagedNetwork) {
    this.assertSafe(network);
    try {
      await this.docker.getNetwork(network.dockerName).remove();
    } catch (error: any) {
      if (error?.statusCode === 404) return;
      throw createError({ statusCode: 409, statusMessage: `Network removal failed: ${safeMessage(error)}` });
    }
  }

  async topology(network: ManagedNetwork) {
    this.assertSafe(network);
    const inspection = await this.docker.getNetwork(network.dockerName).inspect().catch(() => null);
    return {
      network,
      exists: Boolean(inspection),
      containers: Object.entries(inspection?.Containers || {}).map(([id, member]) => ({
        id,
        name: member.Name,
        ipv4Address: member.IPv4Address,
      })),
    };
  }

  async validate(network: ManagedNetwork) {
    const topology = await this.topology(network);
    const expected = await this.members(network);
    const names = new Set(topology.containers.map((container) => container.name));
    const missingWorkerIds = expected.filter((id) => {
      const worker = useContainerManager().get(id);
      return worker && !names.has(worker.containerName);
    });
    const unexpected = topology.containers.filter((container) => {
      const worker = useContainerManager().findByContainerName(container.name);
      return !worker || !expected.includes(worker.id);
    });
    return { ok: topology.exists && missingWorkerIds.length === 0 && unexpected.length === 0, missingWorkerIds, unexpected, actual: topology.containers };
  }

  private assertSafe(network: ManagedNetwork) {
    if (forbidden(network.dockerName))
      throw createError({ statusCode: 400, statusMessage: "Management networks cannot be managed or attached" });
  }

  private async ensure(network: ManagedNetwork) {
    try {
      const existing = await this.docker.getNetwork(network.dockerName).inspect();
      if (
        existing.Driver !== "bridge" ||
        existing.Internal ||
        existing.Labels?.["agentor.managed-network"] !== "true" ||
        existing.Labels?.["agentor.owner"] !== network.userId
      )
        throw createError({ statusCode: 409, statusMessage: "Existing Docker network fails Agentor ownership policy" });
      return existing;
    } catch (error: any) {
      if (error?.statusCode !== 404) throw error;
    }
    await this.docker.createNetwork({
      Name: network.dockerName,
      Driver: "bridge",
      Internal: false,
      CheckDuplicate: true,
      Labels: { "agentor.managed-network": "true", "agentor.owner": network.userId },
    });
    return this.docker.getNetwork(network.dockerName).inspect();
  }
}

function safeMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : "Docker operation failed";
}

let singleton: ManagedNetworkManager | undefined;
export const useManagedNetworkManager = () => (singleton ??= new ManagedNetworkManager());
