import { isIP } from 'node:net';
import type { Config } from './config';
import { IncusClient, type IncusDevice } from './incus-client';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner } from './admin-native-authority';
export interface AdminNativeNetwork {
    installation: string;
    workspaceId: string;
    ownerId: string;
    kind: string;
    groupId?: string;
    network: string;
    subnet: string;
    gateway: string;
    managementAddress: string;
    guestAddress: string;
    guestMac: string;
    gatewayUrl: string;
    mcpUrl: string;
}
export class IncusAdminNetworkBoundary {
    private client: IncusClient;
    constructor(config: Config, client?: IncusClient) {
        this.client = client ?? IncusClient.fromConfig({ ...config, incusEndpoint: config.incusNetworkHostEndpoint || '',
            incusServerCertPath: config.incusNetworkHostServerCertPath || config.incusServerCertPath });
    }
    async boundary(record: Readonly<AdministrativeWorkspaceRecord>, action: 'ensure' | 'inspect'): Promise<AdminNativeNetwork> {
        const owner = administrativeRuntimeOwner(record), native = record.nativeRuntime;
        if (!native || record.runtimeKind !== 'incus-vm')
            throw new Error('Native administrative intent must be durable before network admission');
        const v = await this.client.request<AdminNativeNetwork>('POST', `/v1/admin-networks/${action}`, { workspaceId: record.id });
        const prefix = v?.gateway?.split('.').slice(0, 3).join('.');
        if (!v || v.installation !== native.installationId || v.workspaceId !== record.id || v.ownerId !== owner.userId ||
            v.kind !== record.kind || v.groupId !== owner.groupId || !/^[A-Za-z0-9_-]{1,15}$/.test(v.network) ||
            ![v.gateway, v.managementAddress, v.guestAddress].every(a => isIP(a) === 4) ||
            v.gateway !== prefix + '.1' || v.managementAddress !== prefix + '.2' || v.guestAddress !== prefix + '.3' || v.subnet !== prefix + '.0/24' ||
            !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2[0-9]|3[01])\.)/.test(v.gateway) ||
            !/^02(?::[a-f0-9]{2}){5}$/.test(v.guestMac) || v.gatewayUrl !== `http://${v.managementAddress}:3000` ||
            v.mcpUrl !== `http://${v.managementAddress}:3099/mcp`)
            throw new Error('Administrative network boundary authority is invalid');
        return v;
    }
    device(v: AdminNativeNetwork): IncusDevice {
        return { type: 'nic', network: v.network, name: 'eth0', hwaddr: v.guestMac,
            'ipv4.address': v.guestAddress, 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' };
    }
}
