import type { Config } from './config';
import type { IncusClient, IncusCustomVolume, IncusDevice } from './incus-client';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { administrativeRuntimeOwner, type AdminNativeRuntimeIdentity } from './admin-native-authority';
/** Administrative roots retain ordinary canonical archive roles, with an
 * additional dedicated authority that cannot adopt historical worker data. */
export class IncusAdminWorkspaceStorage {
    constructor(private config: Config, private client: IncusClient) { }
    names(identity: AdminNativeRuntimeIdentity) {
        return { workspace: `${identity.name}-workspace`, agents: `${identity.name}-agents` };
    }
    metadata(record: Readonly<AdministrativeWorkspaceRecord>, identity: AdminNativeRuntimeIdentity, role: 'workspace' | 'agents') {
        const owner = administrativeRuntimeOwner(record);
        return { 'user.agentor.installation': identity.installationId, 'user.agentor.id': owner.id,
            'user.agentor.owner': owner.userId, 'user.agentor.storage-role': role,
            'user.agentor.administrative': owner.kind, 'user.agentor.admin-group': owner.groupId ?? '',
            'user.agentor.admin-storage-nonce': identity.nonce };
    }
    async inspect(record: Readonly<AdministrativeWorkspaceRecord>, identity: AdminNativeRuntimeIdentity, role: 'workspace' | 'agents'): Promise<IncusCustomVolume | undefined> {
        const name = this.names(identity)[role];
        let volume: IncusCustomVolume;
        try {
            volume = await this.client.getCustomVolume(this.config.incusStoragePool, name);
        }
        catch (error) {
            if ((error as {
                statusCode?: number;
            }).statusCode === 404)
                return;
            throw error;
        }
        if (volume.name !== name || volume.type !== 'custom' || volume.content_type !== 'filesystem' ||
            Object.entries(this.metadata(record, identity, role)).some(([key, value]) => volume.config[key] !== value) ||
            (volume.used_by ?? []).some(ref => {
                const url = new URL(ref, this.client.endpoint);
                return url.origin !== new URL(this.client.endpoint).origin || !!url.username || !!url.password || !!url.hash ||
                    url.pathname !== `/1.0/instances/${identity.name}` || url.searchParams.getAll('project').length !== 1 ||
                    url.searchParams.get('project') !== this.config.incusProject || [...url.searchParams.keys()].some(key => key !== 'project');
            }))
            throw new Error('Administrative persistent storage authority is ambiguous');
        return volume;
    }
    async devices(record: Readonly<AdministrativeWorkspaceRecord>, identity: AdminNativeRuntimeIdentity, fresh: boolean): Promise<Record<string, IncusDevice>> {
        const devices: Record<string, IncusDevice> = {};
        for (const role of ['workspace', 'agents'] as const) {
            let volume = await this.inspect(record, identity, role);
            if (!volume && fresh) {
                await this.client.createCustomVolume(this.config.incusStoragePool, { name: this.names(identity)[role], content_type: 'filesystem', config: this.metadata(record, identity, role) });
                volume = await this.inspect(record, identity, role);
            }
            if (!volume)
                throw new Error('Administrative persistent data is missing; explicit recovery is required');
            devices[role] = { type: 'disk', pool: this.config.incusStoragePool, source: volume.name,
                path: role === 'workspace' ? '/workspace' : '/home/agent/.agent-data' };
        }
        return devices;
    }
}
