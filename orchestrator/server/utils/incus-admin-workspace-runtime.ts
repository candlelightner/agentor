import { sameIncusDevices } from './incus-device-layout';
import { administrativeNativeOverlay, administrativeNativeOverlaySha256 } from './incus-admin-overlay';
export { administrativeNativeOverlay, administrativeNativeOverlaySha256 } from './incus-admin-overlay';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient, IncusRequestRejected, type IncusInstance, type IncusDevice } from './incus-client';
import type { AdministrativeWorkspaceRecord, AdminWorkspaceRuntimeAdapter, AdminWorkspaceRuntimeImage, AdminWorkspaceStartupScriptRuntimeStatus } from './admin-workspace-store';
import { normalizedRevision } from './admin-workspace-store';
import { administrativeRuntimeOwner, adminNativeInstanceName, readAdministrativeRuntimeRecord, applyAdminNativePatch, validateAdminNativeState, type AdminNativeAcknowledge, type AdminNativeRuntimeIdentity } from './admin-native-authority';
import { ManagedVolumeStore, pathsOverlap, validatePersistenceTarget, type StoredManagedVolume } from './managed-volume-store';
import { IncusManagedVolumeRuntime, incusManagedVolumeDeviceKey } from './incus-managed-volume-runtime';
import { normalizeBackupPaths } from './backup-paths';
import { MANAGED_KILO_PARENT, MANAGED_KILO_PARENT_CHECK } from './managed-volume-kilo-parent';
import { IncusAdminWorkspaceStorage, matchesIncusAdminConfig } from './incus-admin-workspace-storage';
import { IncusAdminNetworkBoundary, type AdminNativeNetwork } from './incus-admin-network';
import { incusImageIdentity, type IncusWorkerImageIdentity } from './incus-worker-image';
import { readBackupInstallationId } from './backup-installation';
import { resolveAdministrativeNativeBase } from './admin-native-image';
import { assertIncusWorkerSocketPath, serializeIncusWorkerEnv, INCUS_GUEST_READINESS_SCRIPT, INCUS_MAIN_SESSION_PROBE } from './incus-worker-runtime';
import { administrativeOwnerEnvironment, renderAdministrativeStartupScript, administrativeControlRepresentation } from './admin-workspace-runtime';
import type { ContainerInfo, UserEnvVars } from '../../shared/types';
const failure = (message: string) => Object.assign(new Error(message), { statusCode: 503 });
const absent = (error: unknown) => (error as {
    statusCode?: number;
}).statusCode === 404;
const PREPARE = String.raw `set -eu
test ! -L /run
test "$(findmnt -n -o FSTYPE --target /run)" = tmpfs
test "$(findmnt -n -o TARGET --target /run)" = /run
systemctl stop agentor-worker.service
for path in /run/agentor /run/agentor-management; do
 test ! -L "$path"
 install -d -m 0700 -o root -g root "$path"
done
chmod 0711 /run/agentor
if mountpoint -q /run/agentor-management; then
 test "$(findmnt -n -o FSTYPE --target /run/agentor-management)" = tmpfs
else
 mount -t tmpfs -o rw,nosuid,nodev,noexec,size=1048576,mode=0700,uid=1000,gid=1000 tmpfs /run/agentor-management
fi
rm -f /run/agentor/provisioned /run/agentor/worker.env
install -d -m 0755 /run/systemd/system/agentor-worker.service.d
printf '[Service]\nExecStart=\nExecStart=/usr/local/bin/agentor-admin-start-gate /home/agent/entrypoint.sh\n' > /run/systemd/system/agentor-worker.service.d/admin.conf
systemctl daemon-reload
`;
export const ADMIN_NATIVE_CONTROL_WRITE = String.raw `import json,os,sys,secrets
files=json.load(sys.stdin)
if set(files)!={'README.md','image-definitions.json','runtime.json'} or any(not isinstance(v,str) or len(v.encode())>8388608 for v in files.values()): raise ValueError('Invalid control representation')
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
root=os.open('/workspace',flags)
try:
 try: os.mkdir('agentor-control',0o755,dir_fd=root)
 except FileExistsError: pass
 directory=os.open('agentor-control',flags,dir_fd=root)
 try:
  for name,value in files.items():
   temporary='.'+name+'-'+secrets.token_hex(16)
   fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444,dir_fd=directory)
   original=os.fstat(fd);published=False
   try:
    with os.fdopen(fd,'wb') as out:
     out.write(value.encode());out.flush();os.fsync(out.fileno())
    os.rename(temporary,name,src_dir_fd=directory,dst_dir_fd=directory);published=True
   finally:
    if not published:
     try:
      current=os.stat(temporary,dir_fd=directory,follow_symlinks=False)
      if (current.st_dev,current.st_ino)==(original.st_dev,original.st_ino): os.unlink(temporary,dir_fd=directory)
     except FileNotFoundError: pass
 finally: os.close(directory)
finally: os.close(root)
`;
export const ADMIN_NATIVE_INITIALIZE_ROOTS = String.raw `import os
roots=['/workspace','/home/agent/.agent-data']
flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
opened=[]
try:
 for path in roots:
  fd=os.open('/',flags)
  try:
   for part in path.strip('/').split('/'):
    child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child
   with os.scandir(fd) as entries:
    if next(entries,None) is not None: raise ValueError('Administrative canonical root is not empty; restore acknowledgement required')
   opened.append(fd);fd=None
  finally:
   if fd is not None: os.close(fd)
 for fd in opened: os.fchown(fd,1000,1000);os.fchmod(fd,0o755)
finally:
 for fd in opened: os.close(fd)
`;
const WRITE_CREDENTIAL = String.raw `import os,sys,secrets
value=sys.stdin.buffer.read(256)
if len(value)>128 or not value.startswith(b'mcp1.') or b'\n' in value: raise ValueError('Invalid administrative identity')
root=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 run=os.open('run',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
 try: fd=os.open('agentor-management',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=run)
 finally: os.close(run)
finally: os.close(root)
name='.credential-'+secrets.token_hex(16)
try:
 out=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
 try:
  os.fchown(out,1000,1000);os.write(out,value+b'\n');os.fsync(out)
 finally: os.close(out)
 os.rename(name,'credential',src_dir_fd=fd,dst_dir_fd=fd)
finally: os.close(fd)
`;
interface Dependencies {
    managedStore?: () => Promise<ManagedVolumeStore>;
    readRecord?: (id: string) => Promise<AdministrativeWorkspaceRecord>;
    resolveImage?: (record: Readonly<AdministrativeWorkspaceRecord>, refresh: boolean) => Promise<IncusWorkerImageIdentity>;
    ownerEnvironment?: (ownerId: string) => UserEnvVars;
    register?: (info: ContainerInfo) => void;
}
/** Dedicated administrative VM lifecycle; ordinary WorkerRecords confer no authority. */
export class IncusAdminWorkspaceRuntime implements AdminWorkspaceRuntimeAdapter {
    readonly client: IncusClient;
    readonly storage: IncusAdminWorkspaceStorage;
    readonly network: IncusAdminNetworkBoundary;
    private issuers = new Map<string, () => Promise<string>>();
    private listener?: (host: string) => Promise<void>;
    constructor(private config: Config, client = IncusClient.fromConfig(config), network = new IncusAdminNetworkBoundary(config), private dependencies: Dependencies = {}) {
        this.client = client;
        this.storage = new IncusAdminWorkspaceStorage(config, client, dependencies.managedStore ?? (async () => {
            const { useManagedVolumeManager } = await import('./managed-volume-manager');
            const manager = useManagedVolumeManager();
            await manager.init();
            return manager.store;
        }));
        this.network = network;
    }
    setManagementListener(listener: (host: string) => Promise<void>) { this.listener = listener; }
    async validateAuthority(record: Readonly<AdministrativeWorkspaceRecord>, incarnation?: string) {
        administrativeRuntimeOwner(record);
        validateAdminNativeState(record);
        const current = await (this.dependencies.readRecord ?? readAdministrativeRuntimeRecord)(record.id);
        const fields = (r: Readonly<AdministrativeWorkspaceRecord>) => ({ id: r.id, kind: r.kind, trusted: r.trusted, ownerId: r.ownerId,
            groupId: (r as any).groupId, status: r.status, startupScript: r.startupScript, startupScriptRevision: r.startupScriptRevision,
            runtimeKind: r.runtimeKind, nativeRuntime: r.nativeRuntime, nativeMigration: r.nativeMigration });
        if (record.runtimeKind !== 'incus-vm' || !isDeepStrictEqual(fields(current), fields(record)) ||
            current.nativeMigration && current.nativeMigration.phase !== 'retained')
            throw failure('Administrative runtime authority changed');
        if (incarnation && current.nativeRuntime?.incarnation !== incarnation)
            throw failure('Administrative VM incarnation changed');
        return current;
    }
    private async installation() {
        if (!this.config.incusEnabled)
            throw failure('Administrative workspaces require configured Incus; Docker fallback is forbidden');
        return readBackupInstallationId(this.config.dataDir);
    }
    private async image(record: Readonly<AdministrativeWorkspaceRecord>, refresh = false) {
        if (this.dependencies.resolveImage)
            return this.dependencies.resolveImage(record, refresh);
        if (record.nativeRuntime && !refresh) {
            const actual = incusImageIdentity(await this.client.getImage(record.nativeRuntime.image.fingerprint));
            if (!isDeepStrictEqual(actual, record.nativeRuntime.image))
                throw failure('Pinned administrative VM image changed');
            return actual;
        }
        const { useDockerService } = await import('./services');
        const reference = this.config.workerImagePrefix + this.config.workerImage;
        await useDockerService().ensureImage(reference);
        const source = await useDockerService().workerOciImage(reference).inspect();
        return resolveAdministrativeNativeBase(this.config, this.client, source.Id,
            join(process.cwd(), '.output/server/incus-bootstrap'));
    }
    async prepareCredential(record: Readonly<AdministrativeWorkspaceRecord>, issuer: () => Promise<string>) {
        await this.validateAuthority(record);
        this.issuers.set(record.id, issuer);
        if (record.nativeRuntime?.pending || record.nativeRuntime?.selectedOperation || record.nativeRuntime?.deleting)
            return;
        if (record.nativeRuntime?.incarnation) {
            let instance: IncusInstance;
            try {
                instance = await this.assertOwned(record);
            }
            catch (error) {
                if (absent(error))
                    return;
                throw error;
            }
            if (instance.status === 'Running')
                await this.writeCredential(record, await issuer());
        }
    }
    async materializeCredential(credential: string, record: Readonly<AdministrativeWorkspaceRecord>) {
        await this.validateAuthority(record);
        const instance = await this.assertOwned(record);
        if (instance.status === 'Running')
            await this.writeCredential(record, credential);
    }
    private async waitAgent(record: Readonly<AdministrativeWorkspaceRecord>) {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            await this.assertOwned(record);
            try {
                const result = await this.client.exec(record.nativeRuntime!.name, ['timeout', '5', '/usr/bin/true'], { command: [], user: 0, group: 0 });
                if (result.returnCode === 0) {
                    await this.assertOwned(record);
                    return;
                }
            }
            catch { /* Only this harmless agent probe is safe to retry. */ }
            await this.assertOwned(record);
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw failure('Administrative VM agent did not become ready');
    }
    private async execute(record: Readonly<AdministrativeWorkspaceRecord>, command: string[]) {
        await this.assertOwned(record);
        const result = await this.client.exec(record.nativeRuntime!.name, command, { user: 0, group: 0, environment: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C' }, command: [] });
        if (result.returnCode !== 0)
            throw failure('Administrative VM preparation failed');
        await this.assertOwned(record);
    }
    private async writeCredential(record: Readonly<AdministrativeWorkspaceRecord>, credential: string) {
        if (!/^mcp1\.[A-Za-z0-9_-]{43}$/.test(credential))
            throw failure('Administrative identity is invalid');
        await this.assertOwned(record);
        const stream = await this.client.execStream(record.nativeRuntime!.name, ['/usr/bin/python3', '-c', WRITE_CREDENTIAL], { command: [], user: 0, group: 0, recordOutput: false, timeoutMs: 8000 });
        stream.stdout.resume();
        stream.stderr.resume();
        try {
            stream.stdin.end(credential);
            if (await stream.result !== 0)
                throw failure('Administrative identity materialization failed');
        }
        finally {
            stream.close();
        }
        await this.assertOwned(record);
    }
    private patch(record: AdministrativeWorkspaceRecord, acknowledge?: AdminNativeAcknowledge) {
        if (!acknowledge)
            throw failure('Administrative runtime acknowledgement is unavailable');
        return async (native: AdminNativeRuntimeIdentity) => {
            const patch = { runtimeKind: 'incus-vm' as const, nativeRuntime: structuredClone(native), nativeMigration: record.nativeMigration };
            await acknowledge(patch);
            applyAdminNativePatch(record, patch);
        };
    }
    private async mutation(record: AdministrativeWorkspaceRecord, kind: 'create' | 'start' | 'stop' | 'delete', ack: ReturnType<IncusAdminWorkspaceRuntime['patch']>, action: (accepted: (path: string | undefined) => Promise<void>) => Promise<unknown>) {
        await this.validateAuthority(record);
        if (record.nativeRuntime!.pending)
            throw failure('Administrative VM operation requires explicit recovery');
        await ack({ ...record.nativeRuntime!, pending: { kind } });
        try {
            await action(async (operation) => ack({ ...record.nativeRuntime!, pending: { kind, ...(operation ? { operation } : {}) } }));
        }
        catch (error) {
            if (error instanceof IncusRequestRejected)
                await ack({ ...record.nativeRuntime!, pending: undefined });
            throw error;
        }
        await ack({ ...record.nativeRuntime!, pending: undefined });
    }
    async assertOwned(record: Readonly<AdministrativeWorkspaceRecord>, incarnation = record.nativeRuntime?.incarnation): Promise<IncusInstance> {
        return this.inspectOwned(record, incarnation);
    }
    private async inspectOwned(record: Readonly<AdministrativeWorkspaceRecord>, incarnation = record.nativeRuntime?.incarnation, allowPending = false, allowSelectedOperation = false): Promise<IncusInstance> {
        await this.validateAuthority(record, incarnation);
        const native = record.nativeRuntime, owner = administrativeRuntimeOwner(record);
        if (!native || native.deleting || native.pending && !allowPending || native.name !== adminNativeInstanceName(record) || native.installationId !== await this.installation() ||
            native.overlaySha256 !== administrativeNativeOverlaySha256(record))
            throw failure('Administrative native identity is unavailable');
        const instance = await this.client.getInstance(native.name), c = instance.config;
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(c['volatile.uuid'] ?? ''))
            throw failure('Administrative VM incarnation is unavailable');
        if (instance.name !== native.name || instance.type !== 'virtual-machine' || instance.profiles?.length ||
            c['user.agentor.installation'] !== native.installationId || c['user.agentor.id'] !== owner.id ||
            c['user.agentor.owner'] !== owner.userId || c['user.agentor.administrative'] !== owner.kind ||
            !matchesIncusAdminConfig(c, { 'user.agentor.admin-group': owner.groupId ?? '' }) || c['user.agentor.admin-nonce'] !== native.nonce ||
            c['volatile.base_image'] !== native.image.fingerprint || c['boot.autostart'] !== 'false' ||
            c['user.agentor.admin-overlay-sha256'] !== native.overlaySha256 || c['limits.memory'] !== '4GiB' || c['limits.cpu'] !== '2' ||
            incarnation && c['volatile.uuid'] !== incarnation || Object.keys(c).some(k => k.startsWith('raw.')) ||
            Object.keys(instance.expanded_config ?? {}).some(k => k.startsWith('raw.')))
            throw failure('Administrative VM ownership or incarnation is ambiguous');
        const network = await this.network.boundary(record, 'inspect');
        const persistent = await this.storage.devices(record, native, false, allowSelectedOperation);
        const operation = native.selectedOperation;
        if(operation?.canonical && instance.status !== 'Stopped') throw failure('Administrative canonical seed transition requires stopped compute');
        if (operation && allowSelectedOperation) {
            const v = (await this.storage.selectedRecords(record)).find(value => value.id === operation.volumeId)!;
            const key = incusManagedVolumeDeviceKey(v);
            if (!instance.devices[key]) {
                if (v.seeded && operation.canonical)
                    throw failure('Committed administrative selection is unexpectedly detached');
                delete persistent[key];
            }
            else if (operation.canonical && v.seeded && instance.status === 'Stopped' &&
                isDeepStrictEqual(instance.devices[key], { ...persistent[key], path: `/run/agentor-volume-seed/${v.id}` })) {
                persistent[key] = instance.devices[key];
            }
        }
        const expected = { ...persistent, root: { type: 'disk', path: '/', pool: this.config.incusStoragePool }, eth0: this.network.device(network) };
        if (!sameIncusDevices(instance.devices, expected) || !sameIncusDevices(instance.expanded_devices ?? instance.devices, expected))
            throw failure('Administrative VM storage or network boundary changed');
        return instance;
    }
    async ensure(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge): Promise<AdminWorkspaceRuntimeImage> {
        return this.ensureRecord(input, acknowledge, input.status === 'running');
    }
    private async ensureRecord(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge: AdminNativeAcknowledge | undefined, running: boolean, explicitStart = false): Promise<AdminWorkspaceRuntimeImage> {
        const record = structuredClone(input), ack = this.patch(record, acknowledge);
        assertIncusWorkerSocketPath(this.config.incusProject, adminNativeInstanceName(record));
        await this.installation();
        await this.validateAuthority(record);
        if (record.nativeRuntime?.deleting || record.nativeRuntime?.selectedOperation || record.nativeRuntime?.pending)
            throw failure('Administrative VM operation requires explicit recovery');
        if (!record.nativeRuntime) {
            const image = await this.image(record);
            await ack({ version: 1, name: adminNativeInstanceName(record), installationId: await this.installation(), nonce: randomUUID(), image,
                overlayVersion: '6', overlaySha256: administrativeNativeOverlaySha256(record) });
        }
        await this.image(record);
        const native = record.nativeRuntime!, owner = administrativeRuntimeOwner(record);
        let instance: IncusInstance | undefined;
        try {
            instance = await this.client.getInstance(native.name);
        }
        catch (error) {
            if (!absent(error))
                throw error;
        }
        if (!instance) {
            if (native.incarnation)
                throw failure('Administrative compute is missing; explicit recovery is required');
            await this.storage.verifySelectedBeforeMount(record, () => this.validateAuthority(record));
            await this.storage.selectedDevices(record);
            const network = await this.network.boundary(record, 'ensure');
            const devices = await this.storage.devices(record, native, !native.storageReady);
            if (!native.storageReady)
                await ack({ ...record.nativeRuntime!, storageReady: true });
            await this.mutation(record, 'create', ack, onAccepted => this.client.createInstance({ name: native.name, type: 'virtual-machine', profiles: [],
                source: { type: 'image', fingerprint: native.image.fingerprint }, config: { 'user.agentor.installation': native.installationId,
                    'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId, 'user.agentor.administrative': owner.kind,
                    'user.agentor.admin-group': owner.groupId ?? '', 'user.agentor.admin-nonce': native.nonce,
                    'user.agentor.admin-overlay-sha256': native.overlaySha256, 'security.secureboot': 'false', 'boot.autostart': 'false', 'limits.memory': '4GiB', 'limits.cpu': '2' },
                devices: { ...devices, root: { type: 'disk', path: '/', pool: this.config.incusStoragePool }, eth0: this.network.device(network) } }, onAccepted).then(async (created) => {
                if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(created.config['volatile.uuid'] ?? ''))
                    throw failure('Administrative VM incarnation is unavailable');
                await ack({ ...record.nativeRuntime!, incarnation: created.config['volatile.uuid'] });
                return created;
            }));
            instance = await this.client.getInstance(native.name);
            await ack({ ...record.nativeRuntime!, incarnation: instance.config['volatile.uuid'] });
        }
        await this.assertOwned(record);
        if (!record.nativeRuntime!.incarnation)
            await ack({ ...record.nativeRuntime!, incarnation: instance.config['volatile.uuid'] });
        if (running) {
            if (explicitStart && instance.status === 'Running' && normalizedRevision(record.nativeRuntime!.appliedStartupScriptRevision) !== normalizedRevision(record.startupScriptRevision))
                await this.mutation(record, 'stop', ack, accepted => this.client.stopInstance(native.name, { timeout: 15 }, accepted));
            await this.startRecord(record, ack);
        }
        else if (instance.status === 'Running')
            await this.mutation(record, 'stop', ack, accepted => this.client.stopInstance(native.name, { timeout: 15 }, accepted));
        return this.register(record);
    }
    private async startRecord(record: AdministrativeWorkspaceRecord, ack: ReturnType<IncusAdminWorkspaceRuntime['patch']>) {
        let instance = await this.assertOwned(record);
        const boundary = await this.network.boundary(record, 'ensure');
        await this.listener?.(boundary.managementAddress);
        if (instance.status === 'Running')
            return this.waitReady(record);
        if ((await this.storage.selectedRecords(record)).some(v => !v.seeded))
            throw failure('Apply administrative selected directories through explicit rebuild before starting');
        await this.storage.verifySelectedBeforeMount(record, () => this.validateAuthority(record));
        const issuer = this.issuers.get(record.id);
        if (!issuer)
            throw failure('Administrative start identity was not prepared');
        try {
            await this.mutation(record, 'start', ack, accepted => this.client.startInstance(record.nativeRuntime!.name, accepted));
            instance = await this.assertOwned(record);
            await this.waitAgent(record);
            await this.execute(record, ['/bin/sh', '-ec', PREPARE]);
            if (!record.nativeRuntime!.storageInitialized) {
                await this.execute(record, ['/usr/bin/python3', '-c', ADMIN_NATIVE_INITIALIZE_ROOTS]);
                await ack({ ...record.nativeRuntime!, storageInitialized: true });
            }
            for (const v of await this.storage.selectedRecords(record, true)) {
                if (v.target === MANAGED_KILO_PARENT)
                    await this.execute(record, ['/usr/bin/python3', '-c', MANAGED_KILO_PARENT_CHECK, v.target]);
            }
            await this.client.pushFile(instance.name, '/run/agentor/preserve-storage-ownership', 'agentor-preserve-storage-ownership-v1\n', { uid: 0, gid: 0, mode: 0o600 });
            for (const [path, file] of Object.entries(administrativeNativeOverlay(record))) {
                await this.client.pushFile(instance.name, path, file.content, { uid: 0, gid: 0, mode: file.mode });
            }
            await this.writeCredential(record, await issuer());
            const owner = administrativeRuntimeOwner(record);
            const environment = { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '',
                exposeApis: { portMappings: false, domainMappings: false, usage: false, tmux: false } };
            const worker = { id: record.id, displayName: owner.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR', repos: [],
                initScript: renderAdministrativeStartupScript(record), gitName: 'Agentor Administrator', gitEmail: 'admin@agentor.internal' };
            const values: Record<string, string> = Object.fromEntries(record.ownerId ? administrativeOwnerEnvironment(this.dependencies.ownerEnvironment?.(record.ownerId) ?? (await import('./services')).useUserEnvStore().getOrDefault(record.ownerId))
                .map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }) : []);
            Object.assign(values, { ENVIRONMENT: JSON.stringify(environment), WORKER: JSON.stringify(worker), CAPABILITIES: '[]', INSTRUCTIONS: '[]',
                AGENTOR_ADMIN_WORKSPACE: '1', AGENTOR_ADMIN_BANNER: worker.displayName, WORKER_CONTAINER_NAME: instance.name,
                AGENTOR_RUNTIME_ROLE: owner.groupId ? 'group-admin' : 'platform-admin', ORCHESTRATOR_URL: boundary.gatewayUrl,
                AGENTOR_MANAGEMENT_MCP_URL: boundary.mcpUrl, ...(owner.groupId ? { AGENTOR_GROUP_ADMIN_WORKSPACE: '1', AGENTOR_GROUP_ID: owner.groupId } : {}) });
            await this.client.pushFile(instance.name, '/run/agentor/worker.env', serializeIncusWorkerEnv(values), { uid: 0, gid: 1000, mode: 0o640 });
            await this.client.pushFile(instance.name, '/run/agentor/provisioned', 'agentor-runtime-v1\n', { uid: 0, gid: 0, mode: 0o600 });
            await this.execute(record, ['systemctl', 'start', 'agentor-worker.service']);
            await this.waitReady(record);
            await ack({ ...record.nativeRuntime!, appliedStartupScriptRevision: normalizedRevision(record.startupScriptRevision) });
        }
        catch (error) {
            if (!record.nativeRuntime!.pending)
                await this.mutation(record, 'stop', ack, accepted => this.client.stopInstance(record.nativeRuntime!.name, { force: true, timeout: 1 }, accepted)).catch(() => { });
            throw error;
        }
        finally {
            this.issuers.delete(record.id);
        }
    }
    private async waitReady(record: Readonly<AdministrativeWorkspaceRecord>) {
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
            const result = await this.client.exec(record.nativeRuntime!.name, ['/bin/bash', '-c', INCUS_GUEST_READINESS_SCRIPT, 'admin-ready', '/bin/bash', '-ec', 'set -a; . /run/agentor/worker.env; set +a; exec /bin/sh -c "$1"', 'admin-session', INCUS_MAIN_SESSION_PROBE], { command: [], user: 0, group: 0 });
            await this.assertOwned(record);
            if (result.returnCode !== 0)
                throw failure('Administrative guest readiness is unknown');
            if (/^[a-f0-9-]{36} 1 1\s*$/.test(result.stdout))
                return;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        throw failure('Administrative VM did not become ready');
    }
    async start(record: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge) {
        return this.ensureRecord(record, acknowledge, true, true);
    }
    async stop(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge), instance = await this.assertOwned(record);
        if (instance.status === 'Running')
            await this.mutation(record, 'stop', ack, accepted => this.client.stopInstance(instance.name, { timeout: 15 }, accepted));
        await this.register(record);
    }
    /** Explicit recovery may settle only an acknowledged terminal operation
     * against an already captured incarnation. No path/404 creates authority. */
    async settlePending(record: AdministrativeWorkspaceRecord, acknowledge: AdminNativeAcknowledge) {
        const ack = this.patch(record, acknowledge), native = record.nativeRuntime, pending = native?.pending;
        if (!pending)
            return;
        await this.validateAuthority(record);
        if (!pending.operation || !native.incarnation)
            throw failure('Administrative operation acknowledgement requires operator recovery');
        const operation = await this.client.request<{
            status: string;
            status_code: number;
        }>('GET', pending.operation);
        if (operation.status !== 'Success' || operation.status_code !== 200)
            throw failure('Administrative operation is not acknowledged successful');
        if (pending.kind === 'delete') {
            try {
                await this.client.getInstance(native.name);
            }
            catch (error) {
                if (absent(error)) {
                    await ack({ ...native, pending: undefined, incarnation: undefined });
                    return;
                }
                throw error;
            }
            throw failure('Administrative removal is not complete');
        }
        const instance = await this.inspectOwned(record, native.incarnation, true, !!native.selectedOperation);
        if (pending.kind === 'start' && instance.status !== 'Running' || pending.kind === 'stop' && instance.status !== 'Stopped')
            throw failure('Administrative operation state is unsettled');
        await ack({ ...native, pending: undefined });
    }
    async rebuild(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge);
        assertIncusWorkerSocketPath(this.config.incusProject, adminNativeInstanceName(record));
        if (record.nativeRuntime?.pending)
            await this.settlePending(record, async (patch) => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
        if (record.nativeRuntime?.deleting)
            throw failure('Administrative deletion requires cleanup before rebuild');
        if (record.nativeRuntime?.selectedOperation)
            await this.recoverSelectedStorage(record, async (patch) => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
        for (const volume of await this.storage.selectedRecords(record)) {
            if (!volume.seeded)
                await this.copySelection(record, volume, 'seed', ack);
        }
        let present = true;
        try {
            await this.assertOwned(record);
            await this.stop(record, async (patch) => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
        }
        catch (error) {
            if (!absent(error) || !record.nativeRuntime?.storageReady || record.nativeRuntime.pending)
                throw error;
            await this.storage.devices(record, record.nativeRuntime, false);
            present = false;
        }
        const selected = await this.image(record, true);
        if (present)
            await this.mutation(record, 'delete', ack, accepted => this.client.deleteInstance(record.nativeRuntime!.name, accepted));
        await ack({ ...record.nativeRuntime!, incarnation: undefined, image: selected });
        return this.ensureRecord(record, acknowledge, true, true);
    }
    private async register(record: Readonly<AdministrativeWorkspaceRecord>): Promise<AdminWorkspaceRuntimeImage> {
        const instance = await this.assertOwned(record), owner = administrativeRuntimeOwner(record);
        const info: ContainerInfo = { runtimeKind: 'incus-vm', administrativeKind: owner.groupId ? 'group' : 'platform', id: record.id,
            userId: owner.userId, containerId: `incus:${instance.config['volatile.uuid']}`, containerName: instance.name,
            displayName: owner.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR', imageName: this.config.incusWorkerImage,
            imageId: record.nativeRuntime!.image.sourceImageId, imageDigest: record.nativeRuntime!.image.sourceImageId,
            status: instance.status === 'Running' ? 'running' : 'stopped', createdAt: record.createdAt, updatedAt: record.updatedAt };
        if (instance.status === 'Running')
            await this.syncControl(record);
        if (this.dependencies.register)
            this.dependencies.register(info);
        else
            (await import('./services')).useContainerManager().registerExternal(info);
        return { name: this.config.incusWorkerImage, digest: record.nativeRuntime!.image.sourceImageId,
            ...(instance.status === 'Running' ? { appliedStartupScriptRevision: record.nativeRuntime!.appliedStartupScriptRevision } : {}) };
    }
    private async syncControl(record: Readonly<AdministrativeWorkspaceRecord>) {
        const files = await administrativeControlRepresentation(record, this.config.incusWorkerImage, '');
        const boundary = await this.network.boundary(record, 'inspect');
        const topology = JSON.parse(files['runtime.json']!);
        topology.managementNetwork = boundary.network;
        delete topology.workerNetwork;
        files['runtime.json'] = JSON.stringify(topology, null, 2) + '\n';
        const content = JSON.stringify(files);
        if (Buffer.byteLength(content) > 8 * 1024 * 1024)
            throw failure('Administrative control representation exceeds its bound');
        await this.assertOwned(record);
        const session = await this.client.execStream(record.nativeRuntime!.name, ['/usr/bin/python3', '-c', ADMIN_NATIVE_CONTROL_WRITE], { command: [], user: 0, group: 0, timeoutMs: 8000 });
        session.stdout.resume();
        session.stderr.resume();
        try {
            session.stdin.end(content);
            if (await session.result !== 0)
                throw failure('Administrative control representation write failed');
            await this.assertOwned(record);
        }
        finally {
            session.close();
        }
    }
    async assertRunning(record: Readonly<AdministrativeWorkspaceRecord>, incarnation = record.nativeRuntime?.incarnation): Promise<IncusInstance> {
        if (record.status !== 'running' || !incarnation || !record.nativeRuntime?.storageInitialized)
            throw failure('Administrative runtime is not ready');
        const instance = await this.assertOwned(record, incarnation);
        if (instance.status !== 'Running')
            throw failure('Administrative VM is not running');
        const result = await this.client.exec(instance.name, ['/bin/bash', '-c', INCUS_GUEST_READINESS_SCRIPT, 'admin-ready',
            '/bin/bash', '-ec', 'set -a; . /run/agentor/worker.env; set +a; exec /bin/sh -c "$1"', 'admin-session', INCUS_MAIN_SESSION_PROBE], { command: [], user: 0, group: 0 });
        if (result.returnCode !== 0 || !/^[a-f0-9-]{36} 1 1\s*$/.test(result.stdout))
            throw failure('Administrative guest service is not ready');
        await this.assertOwned(record, incarnation);
        return instance;
    }
    async resolveHost(record: Readonly<AdministrativeWorkspaceRecord>): Promise<{
        address: string;
        incarnation: string;
    }> {
        const instance = await this.assertRunning(record), boundary = await this.network.boundary(record, 'inspect');
        if (instance.status !== 'Running')
            throw failure('Administrative VM is not running');
        const { resolveIncusPrimaryLease } = await import('./incus-worker-network');
        const result = resolveIncusPrimaryLease(instance, await this.client.listInstances(), await this.client.getNetwork(boundary.network), await this.client.getNetworkLeases(boundary.network), boundary.network);
        if (result.address !== boundary.guestAddress || result.incarnation !== record.nativeRuntime!.incarnation)
            throw failure('Administrative private lease changed');
        await this.assertOwned(record, result.incarnation);
        return result;
    }
    async securityForRecord(record: Readonly<AdministrativeWorkspaceRecord>) {
        const instance = await this.assertOwned(record), network = await this.network.boundary(record, 'inspect');
        return { managedWorker: true, administrative: true, runtimeKind: 'incus-vm', managementNetworkAttached: true, networks: [network.network],
            publishedPorts: [], rawDockerSocket: false, hostExecution: false, hostFilesystemMounts: [],
            mounts: Object.values(instance.devices).filter(device => device.type === 'disk').map(device => ({ destination: device.path, source: device.source ?? '' })) };
    }
    async setClipboard(mime: 'image/png' | 'text/plain', bytes: Buffer, record?: Readonly<AdministrativeWorkspaceRecord>) {
        if (!record || !['image/png', 'text/plain'].includes(mime) || bytes.length > 16 * 1024 * 1024)
            throw failure('Administrative clipboard request is invalid');
        const instance = await this.assertOwned(record);
        if (instance.status !== 'Running')
            throw failure('Administrative VM is not running');
        const session = await this.client.execStream(instance.name, ['/bin/sh', '-ec', 'head -c "$1" | /home/agent/clipboard/set.sh "$2"', 'admin-clipboard', String(bytes.length), mime], { command: [], user: 1000, group: 1000, timeoutMs: 8000 });
        session.stdout.resume();
        session.stderr.resume();
        try {
            session.stdin.end(bytes);
            if (await session.result !== 0)
                throw failure('Administrative clipboard helper failed');
            await this.assertOwned(record);
        }
        finally {
            session.close();
        }
    }
    async remove(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge);
        await this.validateAuthority(record);
        if (!record.nativeRuntime?.deleting) {
            const instance = await this.assertOwned(record);
            if (instance.status !== 'Stopped')
                throw failure('Stop administrative workspace before deletion');
            await ack({ ...record.nativeRuntime!, deleting: true });
            try {
                await this.mutation(record, 'delete', ack, accepted => this.client.deleteInstance(instance.name, accepted));
            } catch(error) {
                if(error instanceof IncusRequestRejected && !record.nativeRuntime!.pending)
                    await ack({...record.nativeRuntime!,deleting:undefined});
                throw error;
            }
        }
        else {
            // A lost delete result still requires its exact terminal receipt.
            if (record.nativeRuntime.pending) {
                await this.settlePending(record, async (patch) => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
            }
            // A durable intent does not authorize retrying an ambiguous delete.
            try {
                await this.client.getInstance(record.nativeRuntime.name);
                throw failure('Administrative compute deletion requires explicit recovery');
            }
            catch (error) {
                if (!absent(error))
                    throw error;
            }
        }
        for (const role of ['workspace', 'agents'] as const) {
            await this.validateAuthority(record);
            const volume = await this.storage.inspect(record, record.nativeRuntime!, role);
            if (!volume)
                continue; // Earlier acknowledged deletion may already have completed.
            if (volume.used_by?.length)
                throw failure('Administrative storage deletion authority is unavailable');
            await this.client.deleteCustomVolume(this.config.incusStoragePool, volume.name);
        }
        const owner = administrativeRuntimeOwner(record), ids = record.nativeRuntime!.selectedVolumeIds ?? [];
        if (ids.length) {
            const store = await this.storage.store();
            for (const id of ids) {
                await this.validateAuthority(record);
                const v = store.get(owner.userId, id);
                if (!v)
                    continue;
                const volume = await this.storage.inspectSelectedVolume(record, v);
                if (volume?.used_by?.length)
                    throw failure('Administrative selected deletion source is still referenced');
                if (volume)
                    await this.client.deleteCustomVolume(this.config.incusStoragePool, volume.name);
            }
            for (const id of ids)
                await store.forget(owner.userId, id);
            await ack({ ...record.nativeRuntime!, selectedVolumeIds: [] });
        }
        (await import('./services')).useContainerManager().unregisterExternal(record.id);
    }
    /** Private adapter: all source reads use dedicated authority, never WorkerStore. */
    private selectedAdapter(record: AdministrativeWorkspaceRecord, ack: ReturnType<IncusAdminWorkspaceRuntime['patch']>) {
        const owner = administrativeRuntimeOwner(record);
        const check = (userId: string, workerId: string) => {
            if (userId !== owner.userId || workerId !== owner.id)
                throw failure('Administrative selected owner changed');
            return { id: owner.id, userId: owner.userId, containerName: record.nativeRuntime!.name };
        };
        const client = new Proxy(this.client, { get: (target, key) => {
                if(key === 'startInstance') return async (name: string) => {
                    if(name !== record.nativeRuntime!.name) throw failure('Administrative selected boot identity changed');
                    await this.mutation(record,'start',ack,accepted => target.startInstance(name,accepted));
                };
                if (key !== 'updateInstanceDevices') {
                    const value = Reflect.get(target, key);
                    return typeof value === 'function' ? value.bind(target) : value;
                }
                return async (name: string, devices: Record<string, IncusDevice>, _accepted?: unknown, before?: IncusInstance) => {
                    const intent = record.nativeRuntime!.selectedOperation!;
                    if (intent.device && intent.device.state !== 'settled')
                        throw failure('Administrative selected device acknowledgement requires explicit recovery');
                    await ack({ ...record.nativeRuntime!, selectedOperation: { ...intent, device: { state: 'unknown' } } });
                    await target.updateInstanceDevices(name, devices, async (operation) => {
                        await ack({ ...record.nativeRuntime!, selectedOperation: { ...record.nativeRuntime!.selectedOperation!, device: operation ? { state: 'accepted', operation } : { state: 'settled' } } });
                    }, before);
                    await ack({ ...record.nativeRuntime!, selectedOperation: { ...record.nativeRuntime!.selectedOperation!, device: { state: 'settled' } } });
                };
            } });
        return new IncusManagedVolumeRuntime(this.config, {
            client, matchesWorkerIdentity: async () => false,
            commands: () => { throw failure('Use the dedicated administrative command authority'); },
            openOfflineManagedArchive: async () => { throw failure('Use the dedicated administrative archive capture adapter'); },
            stop: async (_owner, incarnation) => {
                const current = await this.inspectOwned(record, incarnation, false, true);
                if (current.status === 'Running')
                    await this.mutation(record, 'stop', ack, accepted => this.client.stopInstance(current.name, { timeout: 15 }, accepted));
            },
        }, { owner: check, inspect: async (userId, workerId, handle) => {
                check(userId, workerId);
                if (handle !== `incus:${record.nativeRuntime!.incarnation}`)
                    throw failure('Administrative selected source incarnation changed');
                return this.inspectOwned(record, record.nativeRuntime!.incarnation, false, true);
            } });
    }
    private async copySelection(record: AdministrativeWorkspaceRecord, input: StoredManagedVolume, kind: 'snapshot' | 'seed', ack: ReturnType<IncusAdminWorkspaceRuntime['patch']>) {
        const store = await this.storage.store(), operationId = randomUUID(), native = record.nativeRuntime!;
        if (kind === 'seed') await this.network.boundary(record, 'ensure');
        let v: StoredManagedVolume = { ...input, state: 'preparing', operation: { id: operationId, mode: 'recreate', stage: 'copying' } };
        const previous = structuredClone(store.get(v.userId,v.id))!;
        try {
            await store.save(v);
            await ack({ ...native, selectedOperation: { volumeId: v.id, operationId, incarnation: native.incarnation!, kind } });
        } catch(error) {
            // No daemon mutation has been submitted at this boundary. Restore
            // only our exact prepared metadata when no native receipt adopted it.
            try {
                await this.validateAuthority(record);
                const current = store.get(v.userId,v.id);
                if(current && isDeepStrictEqual(current,{...v,updatedAt:current.updatedAt})) await store.save(previous);
            } catch { /* Preserve an adopted receipt or unresolved store fault. */ }
            throw error;
        }
        const adapter = this.selectedAdapter(record, ack), handle = `incus:${native.incarnation}`;
        try {
            if (kind === 'snapshot')
                await adapter.stageSelection(handle, v);
            else {
                await adapter.seed(handle, v, async () => {
                    if (v.target === MANAGED_KILO_PARENT) {
                        const result = await this.client.exec(native.name, ['timeout', '15', 'python3', '-c', MANAGED_KILO_PARENT_CHECK, `/run/agentor-volume-seed/${v.id}`]);
                        if (result.returnCode !== 0)
                            throw failure('Administrative XDG parent requires the exact canonical Kilo symlink');
                    }
                    v = { ...v, seeded: true, state: 'ready' };
                    await store.save(v);
                });
                const current = await this.inspectOwned(record, native.incarnation, false, true), key = adapter.deviceKey(v);
                if (current.status !== 'Stopped' || !isDeepStrictEqual(current.devices[key], { ...adapter.device(v), path: `/run/agentor-volume-seed/${v.id}` }))
                    throw failure('Administrative selection seed is unsettled; retained source was preserved');
                await ack({ ...record.nativeRuntime!, selectedOperation: { ...record.nativeRuntime!.selectedOperation!, canonical: true } });
                await adapter.worker.client.updateInstanceDevices(current.name, { ...current.devices, [key]: adapter.device(v) }, undefined, current);
                // The fixed canonical device is checked only after the staging receipt is cleared.
            }
            await store.save({ ...v, state: v.seeded ? 'ready' : 'pending', operation: { ...v.operation!, stage: 'complete' } });
            await ack({ ...record.nativeRuntime!, selectedOperation: undefined });
            await this.assertOwned(record);
        }
        catch (error) {
            await store.save({ ...v, state: 'failed', operation: { ...v.operation!, stage: 'failed', error: 'Selected directory copy requires explicit recovery' } }).catch(() => { });
            throw error;
        }
    }
    /** Caller holds the dedicated store transaction and its owner/worker fence. */
    async adoptSelections(input: Readonly<AdministrativeWorkspaceRecord>, rawPaths: string[], acknowledge: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge), owner = administrativeRuntimeOwner(record);
        if (record.nativeRuntime?.selectedOperation || record.nativeRuntime?.deleting)
            throw failure('Recover administrative selected storage before changing selections');
        const instance = await this.assertOwned(record);
        const store = await this.storage.store(), adapter = this.selectedAdapter(record, ack);
        for (const target of normalizeBackupPaths(rawPaths)) {
            const known = await this.storage.selectedRecords(record);
            if (['/workspace', '/home/agent/.agent-data'].some(root => target === root || target.startsWith(root + '/')))
                continue;
            const covered = known.find(v => target === v.target || target.startsWith(v.target+'/'));
            if(covered) {
                if(!covered.seeded && !covered.operation) {
                    if(instance.status !== 'Running') throw failure('Start the retained administrative VM before refreshing its selected directory');
                    await this.copySelection(record,covered,'snapshot',ack);
                }
                continue;
            }
            try {
                validatePersistenceTarget(target);
            }
            catch (error) {
                if ((error as {
                    statusCode?: number;
                }).statusCode === 400)
                    continue;
                throw error;
            }
            if (known.some(v => pathsOverlap(v.target, target)))
                throw failure('Administrative selected directories overlap retained persistence');
            if (!await adapter.isSelectionDirectory(owner.userId, owner.id, `incus:${instance.config['volatile.uuid']}`, target))
                continue;
            if (store.forWorker(owner.userId, owner.id).some(v => v.attached && v.target === target))
                throw failure('Migrate the retained historical selection before adopting this administrative path');
            const v = await store.create(owner.userId, owner.id, target, undefined, 'incus-vm');
            incusManagedVolumeDeviceKey(v);
            const created = structuredClone(store.get(owner.userId,v.id));
            try {
                await ack({ ...record.nativeRuntime!, selectedVolumeIds: [...(record.nativeRuntime!.selectedVolumeIds ?? []), v.id] });
            } catch(error) {
                // Roll back only this new, still-unallocated record when the
                // fresh durable admin authority proves the ref was not adopted.
                try {
                    await this.validateAuthority(record);
                    if (!isDeepStrictEqual(store.get(owner.userId,v.id),created)) throw failure('Administrative selection changed');
                    let absentVolume = false;
                    try {await this.client.getCustomVolume(this.config.incusStoragePool,v.dockerName);}
                    catch(inspectError) {if(absent(inspectError)) absentVolume=true;else throw inspectError;}
                    if(absentVolume) await store.forget(owner.userId,v.id);
                } catch { /* An acknowledged or ambiguous ref remains quarantined. */ }
                throw error;
            }
            await this.copySelection(record, v, 'snapshot', ack);
        }
    }
    /** Backup/migration callers receive only fully seeded, settled canonical sources. */
    async inspectSelectedStorage(record: Readonly<AdministrativeWorkspaceRecord>) {
        await this.assertOwned(record);
        return this.storage.inspectSelected(record);
    }
    /** Startup verifies dedicated admin storage without ordinary shadow authority or mutations. */
    async inspectManagedStorage(record: Readonly<AdministrativeWorkspaceRecord>) {
        await this.validateAuthority(record);
        const owner = administrativeRuntimeOwner(record), native = record.nativeRuntime;
        if (!native || native.pending || native.deleting || native.selectedOperation || native.installationId !== await this.installation())
            throw failure('Administrative storage requires explicit recovery');
        const store = await this.storage.store(), records = store.forWorker(owner.userId, owner.id);
        if (records.some(v => v.storageRuntimeKind !== 'incus-vm' || v.incusLive || v.liveContainerId || v.previousRestartPolicy))
            throw failure('Administrative storage has incompatible recovery state');
        if (native.incarnation) await this.assertOwned(record);
        else {
            // Controlled restore publishes stopped storage before allocating fresh compute.
            if (record.status !== 'stopped' || !native.storageReady || !native.storageInitialized)
                throw failure('Administrative restored storage is not ready');
            try { await this.client.getInstance(native.name); throw failure('Administrative restored compute is uncaptured'); }
            catch (error) { if (!absent(error)) throw error; }
            const devices = await this.storage.devices(record, native, false);
            for (const device of Object.values(devices)) {
                const volume = await this.client.getCustomVolume(this.config.incusStoragePool, device.source!);
                if (!Array.isArray(volume.used_by) || volume.used_by.length)
                    throw failure('Administrative restored storage has unexpected references');
            }
        }
        for (const v of records.filter(v => !v.attached)) await this.storage.inspectDetachedSelectedVolume(record, v);
        await this.validateAuthority(record);
    }
    /** Explicit recovery never guesses data completion or deletes either copy. */
    async recoverSelectedStorage(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge), intent = record.nativeRuntime?.selectedOperation;
        if (!intent)
            return;
        if (record.nativeRuntime?.pending)
            await this.settlePending(record, async (patch) => { await acknowledge(patch); applyAdminNativePatch(record, patch); });
        const device = record.nativeRuntime!.selectedOperation!.device;
        if (device && device.state !== 'settled') {
            if (device.state === 'unknown')
                throw failure('Unacknowledged administrative device change requires operator recovery');
            const operation = await this.client.request<{
                status: string;
                status_code: number;
            }>('GET', device.operation!);
            if (!['Success', 'Failure'].includes(operation.status) || ![200, 400].includes(operation.status_code))
                throw failure('Administrative selected device operation is not terminal');
            await ack({ ...record.nativeRuntime!, selectedOperation: { ...record.nativeRuntime!.selectedOperation!, device: { state: 'settled' } } });
        }
        const store = await this.storage.store(), v = (await this.storage.selectedRecords(record)).find(v => v.id === intent.volumeId)!;
        let instance = await this.inspectOwned(record, intent.incarnation, false, true);
        const adapter = this.selectedAdapter(record, ack);
        if (instance.status === 'Running') {
            await adapter.worker.stop({ id: v.workerId, userId: v.userId, containerName: instance.name }, intent.incarnation);
            instance = await this.inspectOwned(record, intent.incarnation, false, true);
        }
        if (instance.status !== 'Stopped')
            throw failure('Administrative selected recovery requires stopped captured compute');
        const key = incusManagedVolumeDeviceKey(v), stage = { type: 'disk', pool: this.config.incusStoragePool, source: v.dockerName, path: `/run/agentor-volume-seed/${v.id}` };
        if (instance.devices[key]) {
            if (!isDeepStrictEqual(instance.devices[key], stage) && !(v.seeded && intent.canonical && isDeepStrictEqual(instance.devices[key], { ...stage, path: v.target })))
                throw failure('Administrative selected recovery attachment changed');
            const devices = { ...instance.devices };
            if (v.seeded)
                devices[key] = { ...stage, path: v.target };
            else
                delete devices[key];
            if (v.seeded)
                await ack({ ...record.nativeRuntime!, selectedOperation: { ...record.nativeRuntime!.selectedOperation!, canonical: true } });
            if(!isDeepStrictEqual(devices,instance.devices)) await adapter.worker.client.updateInstanceDevices(instance.name, devices, undefined, instance);
        }
        else if (v.seeded)
            throw failure('Committed administrative selected storage is unexpectedly detached');
        await store.save({ ...v, state: v.seeded ? 'ready' : 'pending', operation: undefined });
        await ack({ ...record.nativeRuntime!, selectedOperation: undefined });
        await this.assertOwned(record);
    }
    async startupScriptStatus(record: Readonly<AdministrativeWorkspaceRecord>): Promise<AdminWorkspaceStartupScriptRuntimeStatus> {
        if (!record.startupScript)
            return { state: 'not-configured' };
        if (normalizedRevision(record.startupScriptRevision) !== normalizedRevision(record.appliedStartupScriptRevision))
            return { state: 'pending-rebuild', revision: normalizedRevision(record.startupScriptRevision) };
        const instance = await this.assertOwned(record);
        if (instance.status !== 'Running')
            return { state: 'unavailable' };
        const result = await this.client.exec(instance.name, ['/usr/bin/head', '-c', '8193', '/home/agent/.agent-data/.agentor/admin-startup-script-status.json'], { command: [], user: 1000, group: 1000 });
        await this.assertOwned(record);
        if (result.returnCode !== 0 || result.stdout.length > 8192)
            return { state: 'unavailable' };
        let value: any;
        try {
            value = JSON.parse(result.stdout);
        }
        catch {
            return { state: 'unavailable' };
        }
        if (!value || !['starting', 'running', 'succeeded', 'failed'].includes(value.state) || value.revision !== record.appliedStartupScriptRevision)
            return { state: 'unavailable' };
        return { state: value.state, revision: value.revision,
            ...(typeof value.startedAt === 'string' ? { startedAt: value.startedAt } : {}),
            ...(typeof value.finishedAt === 'string' ? { finishedAt: value.finishedAt } : {}),
            ...(Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}) };
    }
}
