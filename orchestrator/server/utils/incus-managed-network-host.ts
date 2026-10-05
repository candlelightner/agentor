import { isIP } from 'node:net';
import type { Config } from './config';
import { IncusClient } from './incus-client';
import { readBackupInstallationId } from './backup-installation';
import type { ManagedNetwork } from './managed-network-store';
import { incusManagedBridgeIdentity } from './incus-managed-network-identity';

export interface IncusManagedBridge {
  name: string;
  subnet: string;
  gateway: string;
  dockerRange: string;
  installation: string;
  networkId: string;
  userId: string;
}

/** The only host operations are owned bridge lifecycle and exact allowlisting.
 * No raw Incus proxy, caller-selected host path, or CLI request transport. */
export class IncusManagedNetworkHost {
  private readonly client: Pick<IncusClient, 'request'>;

  constructor(private readonly config: Config, client?: Pick<IncusClient, 'request'>) {
    if (!config.incusNetworkHostEndpoint)
      throw new Error('Incus managed networks require the operator-installed Agentor network host service');
    this.client = client ?? IncusClient.fromConfig({ ...config,
      incusEndpoint: config.incusNetworkHostEndpoint,
      incusServerCertPath: config.incusNetworkHostServerCertPath || config.incusServerCertPath });
  }

  async readiness(): Promise<void> {
    const installation = await readBackupInstallationId(this.config.dataDir);
    const result = await this.client.request('GET', '/v1/managed-networks/readiness');
    if (!result || result.ready !== true || result.installation !== installation ||
        result.project !== this.config.incusProject || result.primary !== this.config.incusNetwork)
      throw new Error('Incus network host service installation, project or primary bridge does not match');
  }

  private async identity(network: ManagedNetwork) {
    const installation = await readBackupInstallationId(this.config.dataDir);
    const { name } = incusManagedBridgeIdentity(installation, network);
    return { installation, name };
  }

  async ensure(network: ManagedNetwork): Promise<IncusManagedBridge> {
    await this.identity(network);
    const result = await this.client.request('POST', '/v1/managed-networks/ensure',
      { userId: network.userId, networkId: network.id });
    return this.validateBridge(network, result);
  }

  async inspect(network: ManagedNetwork): Promise<(IncusManagedBridge & { references: string[] }) | null> {
    await this.identity(network);
    const result = await this.client.request('POST', '/v1/managed-networks/inspect',
      { userId: network.userId, networkId: network.id });
    if (result === null) return null;
    const bridge = await this.validateBridge(network, result);
    if (!Array.isArray(result.references) || result.references.length > 4096 ||
        result.references.some((reference: unknown) => typeof reference !== 'string' || !reference || reference.length > 1024))
      throw new Error('Incus managed bridge reference authority is unavailable');
    return { ...bridge, references: result.references };
  }

  private async validateBridge(network: ManagedNetwork, result: any): Promise<IncusManagedBridge> {
    const identity = await this.identity(network);
    if (!result || result.name !== identity.name || result.installation !== identity.installation ||
        result.networkId !== network.id || result.userId !== network.userId || typeof result.gateway !== 'string')
      throw new Error('Incus network host service returned foreign or ambiguous bridge authority');
    const match = /^(\d+\.\d+\.\d+)\.1$/.exec(result.gateway);
    const octets = result.gateway.split('.').map(Number);
    if (!match || isIP(result.gateway) !== 4 || !(octets[0] === 10 ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
        (octets[0] === 192 && octets[1] === 168)) || result.subnet !== `${match[1]}.0/24` ||
        result.dockerRange !== `${match[1]}.0/26`)
      throw new Error('Incus managed bridge has incompatible native DHCP and Docker allocation geometry');
    return { ...identity, userId: network.userId, networkId: network.id,
      gateway: result.gateway, subnet: result.subnet, dockerRange: result.dockerRange };
  }

  async remove(network: ManagedNetwork): Promise<void> {
    await this.identity(network);
    await this.client.request('POST', '/v1/managed-networks/remove',
      { userId: network.userId, networkId: network.id });
  }
}
