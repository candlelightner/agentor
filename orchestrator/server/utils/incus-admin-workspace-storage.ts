import { isDeepStrictEqual } from 'node:util';
import { IncusOfflineArchiveHelper } from './incus-offline-archive-helper';
import { MANAGED_KILO_PARENT, MANAGED_KILO_PARENT_CHECK } from './managed-volume-kilo-parent';
import type { Config } from './config';
import type { IncusClient, IncusCustomVolume, IncusDevice } from './incus-client';
import type { AdministrativeWorkspaceRecord } from './admin-workspace-store';
import { ManagedVolumeStore, pathsOverlap, type StoredManagedVolume } from './managed-volume-store';
import { incusManagedVolumeDeviceKey } from './incus-managed-volume-device';
import { administrativeRuntimeOwner, type AdminNativeRuntimeIdentity } from './admin-native-identity';
/** Incus drops empty configuration values; global administration has no group. */
export function matchesIncusAdminConfig(actual: Record<string, string>, expected: Record<string, string>): boolean {
    return Object.entries(expected).every(([key, value]) => actual[key] === value ||
        key === 'user.agentor.admin-group' && value === '' && !Object.hasOwn(actual, key));
}
/** Administrative roots retain ordinary canonical archive roles, with an
 * additional dedicated authority that cannot adopt historical worker data. */
export class IncusAdminWorkspaceStorage {
    constructor(private config: Config, private client: IncusClient, private managedStore: () => Promise<ManagedVolumeStore>) { }
    store() { return this.managedStore(); }
    async selectedRecords(record: Readonly<AdministrativeWorkspaceRecord>, settled = false): Promise<StoredManagedVolume[]> {
        const owner = administrativeRuntimeOwner(record), ids = record.nativeRuntime?.selectedVolumeIds ?? [];
        const store = await this.store(), targets: string[] = [], keys = new Set<string>(), sources = new Set<string>();
        const records = ids.map(id => {
            const v = store.get(owner.userId, id);
            if (!v || v.id !== id || v.workerId !== owner.id || v.userId !== owner.userId || !v.attached || v.incusLive || v.retainedAfterAccountDeletion ||
                !['pending', 'preparing', 'ready', 'failed'].includes(v.state) || v.operation && v.operation.stage !== 'complete' &&
                (!record.nativeRuntime?.selectedOperation || record.nativeRuntime.selectedOperation.volumeId !== id ||
                    record.nativeRuntime.selectedOperation.operationId !== v.operation.id))
                throw new Error('Administrative selected storage requires explicit recovery');
            const intent = record.nativeRuntime?.selectedOperation?.volumeId === id ? record.nativeRuntime.selectedOperation : undefined;
            if (intent ? !v.operation || v.operation.id !== intent.operationId || v.operation.mode !== 'recreate' ||
                !['copying', 'failed', 'complete'].includes(v.operation.stage) || !['preparing', 'failed', 'ready'].includes(v.state) ||
                intent.kind === 'snapshot' && v.seeded
                : v.seeded ? v.state !== 'ready' || v.operation && v.operation.stage !== 'complete'
                    : v.state !== 'pending' || v.operation && v.operation.stage !== 'complete')
                throw new Error('Administrative selected storage state is unsettled');
            const key = incusManagedVolumeDeviceKey(v);
            if (keys.has(key) || sources.has(v.dockerName) || targets.some(target => pathsOverlap(target, v.target)) ||
                pathsOverlap(v.target, '/home/agent/.agent-data'))
                throw new Error('Administrative selected storage overlaps canonical data');
            keys.add(key);
            sources.add(v.dockerName);
            targets.push(v.target);
            if (settled && (!v.seeded || v.state !== 'ready' || v.operation && v.operation.stage !== 'complete'))
                throw new Error('Apply administrative selected directories through explicit rebuild before capturing canonical storage');
            return structuredClone(v);
        });
        if (store.forWorker(owner.userId, owner.id).some(v => v.storageRuntimeKind === 'incus-vm' && v.attached && !ids.includes(v.id)))
            throw new Error('Administrative selected storage has unreferenced durable records');
        return records;
    }
    async inspectSelectedVolume(record: Readonly<AdministrativeWorkspaceRecord>, v: StoredManagedVolume): Promise<IncusCustomVolume | undefined> {
        const native = record.nativeRuntime!, owner = administrativeRuntimeOwner(record);
        if (v.userId !== owner.userId || v.workerId !== owner.id || !v.attached || v.incusLive || v.retainedAfterAccountDeletion || !native.selectedVolumeIds?.includes(v.id))
            throw new Error('Administrative selected volume authority changed');
        incusManagedVolumeDeviceKey(v);
        let volume: IncusCustomVolume;
        try {
            volume = await this.client.getCustomVolume(this.config.incusStoragePool, v.dockerName);
        }
        catch (error) {
            if ((error as {
                statusCode?: number;
            }).statusCode === 404)
                return;
            throw error;
        }
        const expected = { 'user.agentor.installation': native.installationId, 'user.agentor.owner': owner.userId,
            'user.agentor.id': owner.id, 'user.agentor.volume-id': v.id, 'user.agentor.target': v.target };
        if (volume.name !== v.dockerName || volume.project !== this.config.incusProject || !volume.created_at || !Number.isFinite(Date.parse(volume.created_at)) || volume.type !== 'custom' || volume.content_type !== 'filesystem' ||
            Object.entries(expected).some(([key, value]) => volume.config[key] !== value) || !Array.isArray(volume.used_by) || new Set(volume.used_by).size !== volume.used_by.length ||
            volume.used_by.some(ref => {
                const url = new URL(ref, this.client.endpoint);
                return url.origin !== new URL(this.client.endpoint).origin || !!url.username || !!url.password || !!url.hash ||
                    url.pathname !== `/1.0/instances/${native.name}` || url.searchParams.getAll('project').length !== 1 ||
                    url.searchParams.get('project') !== this.config.incusProject || [...url.searchParams.keys()].some(k => k !== 'project');
            }))
            throw new Error('Administrative selected volume ownership or references changed');
        return volume;
    }
    /** Detached history is verified identically at startup and whole-instance capture. */
    async inspectDetachedSelectedVolume(record: Readonly<AdministrativeWorkspaceRecord>, value: StoredManagedVolume): Promise<IncusCustomVolume | undefined> {
        const owner = administrativeRuntimeOwner(record);
        if (value.attached || value.storageRuntimeKind !== 'incus-vm' || value.userId !== owner.userId || value.workerId !== owner.id || value.retainedAfterAccountDeletion)
            throw new Error('Administrative detached storage authority changed');
        incusManagedVolumeDeviceKey(value);
        if (value.incusLive || value.liveContainerId || value.previousRestartPolicy || value.operation && value.operation.stage !== 'complete' ||
            (value.seeded ? value.state !== 'detached' : !['pending', 'detached'].includes(value.state)))
          throw new Error('Administrative detached storage is unsettled');
        let volume;
        try { volume = await this.client.getCustomVolume(this.config.incusStoragePool, value.dockerName); }
        catch (error) { if ((error as { statusCode?: number }).statusCode === 404 && !value.seeded) return; throw error; }
        if (!value.seeded || volume.name !== value.dockerName || volume.project !== this.config.incusProject ||
            volume.type !== 'custom' || volume.content_type !== 'filesystem' || !Number.isFinite(Date.parse(volume.created_at)) ||
            !Array.isArray(volume.used_by) || volume.used_by.length || Object.entries({
              'user.agentor.installation': record.nativeRuntime!.installationId, 'user.agentor.owner': owner.userId,
              'user.agentor.id': owner.id, 'user.agentor.volume-id': value.id, 'user.agentor.target': value.target,
            }).some(([key, expected]) => volume.config[key] !== expected))
          throw new Error('Administrative detached storage ownership is ambiguous');
        return volume;
    }
    async selectedDevices(record: Readonly<AdministrativeWorkspaceRecord>, allowOperation = false) {
        const native = record.nativeRuntime!, operation = native.selectedOperation;
        if (operation && !allowOperation)
            throw new Error('Administrative selected storage operation requires explicit recovery');
        const devices: Record<string, IncusDevice> = {};
        for (const v of await this.selectedRecords(record)) {
            const staging = operation?.volumeId === v.id;
            if (!v.seeded && !staging)
                continue;
            const volume = await this.inspectSelectedVolume(record, v);
            if (!volume) {
                if (staging && !v.seeded)
                    continue;
                throw new Error('Administrative selected persistent data is missing; no replacement was created');
            }
            if (operation?.canonical && !v.seeded)
                throw new Error('Administrative canonical seed is uncommitted');
            if (staging && (!v.operation || v.operation.id !== operation.operationId ||
                !['preparing', 'failed', 'ready'].includes(v.state)))
                throw new Error('Administrative selected staging authority changed');
            devices[incusManagedVolumeDeviceKey(v)] = { type: 'disk', pool: this.config.incusStoragePool, source: v.dockerName,
                path: staging && !operation.canonical ? `/run/agentor-volume-seed/${v.id}` : v.target };
        }
        return devices;
    }
    async inspectSelected(record: Readonly<AdministrativeWorkspaceRecord>) {
        if (record.nativeRuntime?.selectedOperation || record.nativeRuntime?.deleting)
            throw new Error('Administrative storage operation is unsettled');
        const result = [];
        for (const value of await this.selectedRecords(record, true)) {
            const volume = await this.inspectSelectedVolume(record, value);
            if (!volume)
                throw new Error('Administrative selected storage is missing');
            result.push({ record: value, volume });
        }
        return result;
    }
    /** No ordinary-worker identity expansion: this fixed readonly helper is
     * bound to the private admin nonce and freshly checked dedicated source. */
    async verifySelectedBeforeMount(record: Readonly<AdministrativeWorkspaceRecord>, validate: () => Promise<unknown>) {
        for (const v of await this.selectedRecords(record)) {
            if (!v.seeded || v.target !== MANAGED_KILO_PARENT)
                continue;
            const native = record.nativeRuntime!, owner = administrativeRuntimeOwner(record), before = await this.inspectSelectedVolume(record, v);
            if (!before || before.project !== this.config.incusProject || !before.created_at || !Number.isFinite(Date.parse(before.created_at)))
                throw new Error('Administrative XDG parent source authority is unavailable');
            const references = (values: string[]) => values.map(ref => {
                const url = new URL(ref, this.client.endpoint);
                if (url.origin !== new URL(this.client.endpoint).origin || url.username || url.password || url.hash ||
                    url.searchParams.getAll('project').length !== 1 || url.searchParams.get('project') !== this.config.incusProject ||
                    [...url.searchParams.keys()].some(key => key !== 'project'))
                    throw new Error('Administrative XDG parent reference is foreign');
                return url.pathname;
            }).sort();
            const baseline = references(before.used_by);
            const assertSource = async (helper?: string) => {
                await validate();
                if (!isDeepStrictEqual((await this.store()).get(owner.userId, v.id), v))
                    throw new Error('Administrative XDG parent durable source changed');
                const current = await this.client.getCustomVolume(this.config.incusStoragePool, v.dockerName);
                if (current.name !== before.name || current.project !== before.project || current.type !== before.type ||
                    current.content_type !== before.content_type || current.created_at !== before.created_at ||
                    !isDeepStrictEqual(current.config, before.config) || !Array.isArray(current.used_by) ||
                    !isDeepStrictEqual(references(current.used_by), [...baseline, ...(helper ? [`/1.0/instances/${helper}`] : [])].sort()))
                    throw new Error('Administrative XDG parent source changed');
                await validate();
            };
            await assertSource();
            await new IncusOfflineArchiveHelper(this.config, this.client, native.installationId).withGuest({ id: native.nonce, userId: owner.userId, containerName: native.name }, { managed: v.dockerName }, assertSource, undefined, async (name, assertHelper) => {
                await assertHelper();
                await assertSource(name);
                const result = await this.client.exec(name, ['timeout', '15', 'python3', '-c', MANAGED_KILO_PARENT_CHECK, '/volume']);
                if (result.returnCode !== 0)
                    throw new Error('Administrative XDG parent requires the exact canonical Kilo symlink');
                await assertHelper();
                await assertSource(name);
            });
            await assertSource();
        }
    }
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
            !matchesIncusAdminConfig(volume.config, this.metadata(record, identity, role)) ||
            !Array.isArray(volume.used_by) || new Set(volume.used_by).size !== volume.used_by.length ||
            volume.used_by.some(ref => {
                const url = new URL(ref, this.client.endpoint);
                return url.origin !== new URL(this.client.endpoint).origin || !!url.username || !!url.password || !!url.hash ||
                    url.pathname !== `/1.0/instances/${identity.name}` || url.searchParams.getAll('project').length !== 1 ||
                    url.searchParams.get('project') !== this.config.incusProject || [...url.searchParams.keys()].some(key => key !== 'project');
            }))
            throw new Error('Administrative persistent storage authority is ambiguous');
        return volume;
    }
    async devices(record: Readonly<AdministrativeWorkspaceRecord>, identity: AdminNativeRuntimeIdentity, fresh: boolean, allowSelectedOperation = false): Promise<Record<string, IncusDevice>> {
        const selected = await this.selectedDevices(record, allowSelectedOperation);
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
        return { ...devices, ...selected };
    }
}
