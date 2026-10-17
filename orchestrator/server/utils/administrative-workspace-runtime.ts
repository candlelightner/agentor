import Docker from 'dockerode';
import type { Config } from './config';
import type { AdministrativeWorkspaceRecord, AdminWorkspaceRuntimeAdapter, AdminWorkspaceIdentityMaterializationIntent } from './admin-workspace-store';
import { DockerAdminWorkspaceRuntime, administrativeWorkspaceResourceNames } from './admin-workspace-runtime';
import { IncusAdminWorkspaceRuntime } from './incus-admin-workspace-runtime';
import { readAdministrativeRuntimeRecord, type AdminNativeAcknowledge } from './admin-native-authority';
/** Native is the sole provisioning backend. Legacy sources are inspect/stop
 * only here; explicit migration/rollback owns any legacy recreation. */
export class AdministrativeWorkspaceRuntime implements AdminWorkspaceRuntimeAdapter {
    readonly native: IncusAdminWorkspaceRuntime;
    readonly legacy: DockerAdminWorkspaceRuntime;
    private docker = new Docker({ socketPath: '/var/run/docker.sock' });
    private listener?: (host: string) => Promise<void>;
    constructor(config: Config, native = new IncusAdminWorkspaceRuntime(config), legacy = new DockerAdminWorkspaceRuntime(config)) {
        this.native = native;
        this.legacy = legacy;
    }
    setManagementListener(listener: (host: string) => Promise<void>) { this.listener = listener; this.native.setManagementListener(listener); this.legacy.setManagementListener(listener); }
    async initializeBoundary() { } // A durable record is required before any boundary allocation.
    private isNative(record: Readonly<AdministrativeWorkspaceRecord>) { return record.runtimeKind === 'incus-vm'; }
    private migrationRequired(): never { throw Object.assign(new Error('Explicit administrative workspace migration is required before native start or recreation'), { statusCode: 409, code: 'ADMIN_NATIVE_MIGRATION_REQUIRED' }); }
    async ensure(record: Readonly<AdministrativeWorkspaceRecord>, ack?: AdminNativeAcknowledge) {
        if (this.isNative(record))
            return this.native.ensure(record, ack);
        const names = administrativeWorkspaceResourceNames(record), container = await this.docker.getContainer(names.container).inspect();
        const labels = container.Config?.Labels ?? {};
        if (labels['agentor.administrative'] !== 'true' || labels['agentor.admin.workspace-id'] !== record.id ||
            labels['agentor.admin.group-id'] !== names.groupId || container.Name !== `/${names.container}` ||
            record.imageDigest && container.Image !== record.imageDigest)
            throw Object.assign(new Error('Retained administrative Docker source is not authoritative'), { statusCode: 503 });
        const image = await this.docker.getImage(container.Image).inspect();
        if (image.Config.Labels?.['agentor.admin.overlay'] !== 'true' || !/^sha256:[a-f0-9]{64}$/.test(image.Config.Labels?.['agentor.admin.base'] ?? ''))
            throw new Error('Retained administrative image provenance changed');
        const { useContainerManager } = await import('./services');
        useContainerManager().registerExternal({ id: record.id, userId: record.ownerId ?? '__agentor_admin__', runtimeKind: 'legacy-docker',
            administrativeKind: names.groupId ? 'group' : 'platform', containerId: container.Id, containerName: names.container,
            imageName: record.imageName ?? '', imageId: container.Image, imageDigest: container.Image, displayName: names.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR',
            status: container.State.Running ? 'running' : 'stopped', createdAt: record.createdAt, updatedAt: record.updatedAt });
        if (container.State.Running)
            await this.listener?.(await this.legacy.managementAddress(names.managementNetwork));
        return { name: record.imageName ?? '', digest: container.Image };
    }
    async start(record: Readonly<AdministrativeWorkspaceRecord>, ack?: AdminNativeAcknowledge) { if (!this.isNative(record))
        return this.migrationRequired(); return this.native.start(record, ack); }
    async stop(record: Readonly<AdministrativeWorkspaceRecord>, ack?: AdminNativeAcknowledge) { return this.isNative(record) ? this.native.stop(record, ack) : this.legacy.stop(record); }
    async rebuild(record: Readonly<AdministrativeWorkspaceRecord>, ack?: AdminNativeAcknowledge) { if (!this.isNative(record))
        return this.migrationRequired(); return this.native.rebuild(record, ack); }
    async remove(record: Readonly<AdministrativeWorkspaceRecord>, ack?: AdminNativeAcknowledge) { return this.isNative(record) ? this.native.remove(record, ack) : this.legacy.remove(record); }
    async prepareCredential(record: Readonly<AdministrativeWorkspaceRecord>, issue: () => Promise<string>) { if (this.isNative(record))
        await this.native.prepareCredential(record, issue); }
    async materializeCredential(credential: string, record: Readonly<AdministrativeWorkspaceRecord>, intent?: AdminWorkspaceIdentityMaterializationIntent) {
        if (this.isNative(record))
            await this.native.materializeCredential(credential, record);
        else
            await this.legacy.materializeCredential(credential, record, intent);
    }
    async startupScriptStatus(record: Readonly<AdministrativeWorkspaceRecord>) { return this.isNative(record) ? this.native.startupScriptStatus(record) : this.legacy.startupScriptStatus(record); }
    private async globalRecord() { const { useAdminWorkspaceStore } = await import('./admin-workspace-store'); const store = useAdminWorkspaceStore(); await store.init(); const record = store.getRecord(); if (!record)
        throw new Error('Administrative workspace is not provisioned'); return record; }
    async setClipboard(mime: 'image/png' | 'text/plain', bytes: Buffer, record?: Readonly<AdministrativeWorkspaceRecord>) { record ??= await this.globalRecord(); return this.isNative(record) ? this.native.setClipboard(mime, bytes, record) : this.legacy.setClipboard(mime, bytes, record); }
    async security(workerId?: string): Promise<Record<string, unknown> | undefined> {
        const record = workerId ? await readAdministrativeRuntimeRecord(workerId).catch(error => { if (error?.statusCode === 404)
            return undefined; throw error; }) : await this.globalRecord();
        if (!record)
            return this.legacy.security(workerId);
        return this.isNative(record) ? this.native.securityForRecord(record) : this.legacy.security(workerId);
    }
    async managementNetworkSecurity() { const record = await this.globalRecord(); return this.isNative(record) ? this.native.securityForRecord(record) : this.legacy.managementNetworkSecurity(); }
}
