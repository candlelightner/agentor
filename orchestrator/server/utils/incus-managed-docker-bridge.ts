import type Docker from 'dockerode';
import { isIP } from 'node:net';
import type { ManagedNetwork } from './managed-network-store';
import type { IncusManagedBridge } from './incus-managed-network-host';
import { incusManagedBridgeIdentity } from './incus-managed-network-identity';
import { withOperationDeadline } from './operation-deadline';

const READ_TIMEOUT_MS = 8_000;
const MUTATION_TIMEOUT_MS = 30_000;

/** Docker peers join the already-owned Incus bridge using a separate Docker
 * network. The original legacy bridge is never renamed, detached or deleted.
 * Membership/authorization remain the manager's responsibility. */
export class IncusManagedDockerBridge {
  constructor(private readonly docker: Pick<Docker, 'getNetwork' | 'createNetwork'>) {}

  async inspect(network: ManagedNetwork, bridge: IncusManagedBridge): Promise<Docker.NetworkInspectInfo | null> {
    const options = this.options(network, bridge);
    let inspection: Docker.NetworkInspectInfo;
    try {
      inspection = await withOperationDeadline(
        this.docker.getNetwork(options.Name).inspect(), READ_TIMEOUT_MS,
        'Docker shared Incus bridge inspection');
    } catch (error: any) {
      if (error?.statusCode === 404) return null;
      throw error;
    }
    this.assertOwned(inspection, options);
    return inspection;
  }

  async ensure(network: ManagedNetwork, bridge: IncusManagedBridge): Promise<Docker.NetworkInspectInfo> {
    const existing = await this.inspect(network, bridge);
    if (existing) return existing;
    await withOperationDeadline(signal => this.docker.createNetwork({ ...this.options(network, bridge), abortSignal: signal }),
      MUTATION_TIMEOUT_MS, 'Docker shared Incus bridge creation');
    const created = await this.inspect(network, bridge);
    if (!created) throw new Error('Created Docker shared Incus bridge is missing');
    return created;
  }

  async remove(network: ManagedNetwork, bridge: IncusManagedBridge): Promise<void> {
    const inspection = await this.inspect(network, bridge);
    if (!inspection) return;
    if (!inspection.Containers || typeof inspection.Containers !== 'object' || Array.isArray(inspection.Containers))
      throw new Error('Docker shared Incus bridge endpoint state is unavailable');
    if (Object.keys(inspection.Containers).length)
      throw new Error('Docker shared Incus bridge still has attached endpoints');
    // Pin the inspected identity: a replacement with the same name must not be
    // deleted. Docker itself also rejects a newly attached endpoint on removal.
    await withOperationDeadline(signal => this.docker.getNetwork(inspection.Id).remove({ abortSignal: signal }), MUTATION_TIMEOUT_MS,
      'Docker shared Incus bridge removal');
  }

  private options(network: ManagedNetwork, bridge: IncusManagedBridge): Docker.NetworkCreateOptions {
    const identity = incusManagedBridgeIdentity(bridge.installation, network);
    if (!bridge.installation || identity.name !== bridge.name || bridge.userId !== network.userId || bridge.networkId !== network.id)
      throw new Error('Foreign Docker shared Incus bridge authority');
    const match = /^(\d+\.\d+\.\d+)\.1$/.exec(bridge.gateway);
    const octets = bridge.gateway.split('.').map(Number);
    if (!match || isIP(bridge.gateway) !== 4 || !(octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168)) || bridge.subnet !== `${match[1]}.0/24` || bridge.dockerRange !== `${match[1]}.0/26`)
      throw new Error('Invalid Docker shared Incus bridge allocation geometry');
    return {
      Name: `${network.dockerName}-incus`, Driver: 'bridge', CheckDuplicate: true,
      Internal: false, EnableIPv6: false,
      Labels: { 'agentor.managed-network': 'true', 'agentor.owner': network.userId,
        'agentor.network-id': network.id, 'agentor.installation': bridge.installation },
      Options: { 'com.docker.network.bridge.name': bridge.name, 'com.docker.network.bridge.inhibit_ipv4': 'true' },
      IPAM: { Driver: 'default', Config: [{ Subnet: bridge.subnet, IPRange: bridge.dockerRange, Gateway: bridge.gateway }] },
    };
  }

  private assertOwned(inspection: Docker.NetworkInspectInfo, options: Docker.NetworkCreateOptions): void {
    const ipam = inspection.IPAM;
    const config = ipam?.Config;
    const expected = options.IPAM!.Config![0]!;
    if (typeof inspection.Id !== 'string' || !inspection.Id || inspection.Name !== options.Name || inspection.Driver !== 'bridge' ||
        inspection.Internal !== false || inspection.EnableIPv6 !== false ||
        !exactStrings(inspection.Labels, options.Labels!) || !exactStrings(inspection.Options, options.Options!) ||
        ipam?.Driver !== 'default' || Object.keys(ipam).some(key => !['Driver', 'Options', 'Config'].includes(key)) ||
        !empty(ipam.Options) || !Array.isArray(config) || config.length !== 1 ||
        config[0]?.Subnet !== expected.Subnet || config[0]?.IPRange !== expected.IPRange || config[0]?.Gateway !== expected.Gateway ||
        Object.keys(config[0]!).some(key => !['Subnet', 'IPRange', 'Gateway', 'AuxiliaryAddresses'].includes(key)) ||
        !empty(config[0]?.AuxiliaryAddresses))
      throw new Error('Existing Docker shared Incus bridge fails ownership or fixed network policy');
  }
}

function empty(value: unknown): boolean {
  return value == null || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function exactStrings(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  return !!actual && Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => actual[key] === value);
}
