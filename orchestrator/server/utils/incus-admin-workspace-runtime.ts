import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { Config } from './config';
import { IncusClient, IncusRequestRejected, type IncusInstance, type IncusDevice } from './incus-client';
import type { AdministrativeWorkspaceRecord, AdminWorkspaceRuntimeAdapter, AdminWorkspaceRuntimeImage, AdminWorkspaceStartupScriptRuntimeStatus } from './admin-workspace-store';
import { normalizedRevision } from './admin-workspace-store';
import { administrativeRuntimeOwner, adminNativeInstanceName, readAdministrativeRuntimeRecord, applyAdminNativePatch, validateAdminNativeState, type AdminNativeAcknowledge, type AdminNativeRuntimeIdentity } from './admin-native-authority';
import { IncusAdminWorkspaceStorage } from './incus-admin-workspace-storage';
import { IncusAdminNetworkBoundary, type AdminNativeNetwork } from './incus-admin-network';
import { incusImageIdentity, type IncusWorkerImageIdentity } from './incus-worker-image';
import { readBackupInstallationId } from './backup-installation';
import { readCanonicalIncusBootstrap, incusConversionRecipeId } from './incus-image-converter';
import { serializeIncusWorkerEnv, INCUS_GUEST_READINESS_SCRIPT, INCUS_MAIN_SESSION_PROBE } from './incus-worker-runtime';
import { administrativeOwnerEnvironment, renderAdministrativeStartupScript, administrativeControlRepresentation } from './admin-workspace-runtime';
import type { ContainerInfo, UserEnvVars } from '../../shared/types';
const failure = (message: string) => Object.assign(new Error(message), { statusCode: 503 });
const absent = (error: unknown) => (error as {
    statusCode?: number;
}).statusCode === 404;
export function administrativeNativeOverlay(record: Readonly<AdministrativeWorkspaceRecord>) {
    const owner = administrativeRuntimeOwner(record);
    const banner = owner.groupId ? 'GROUP ADMIN' : 'ADMIN / ORCHESTRATOR';
    return {
        '/etc/profile.d/agentor-admin.sh': { mode: 0o644, content: `export AGENTOR_ADMIN_WORKSPACE=1\nexport PS1='[${banner}] \\u@\\h:\\w \\$ '\n` },
        '/etc/agentor-admin': { mode: 0o644, content: banner + '\n' },
        '/usr/local/bin/agentor-admin-start-gate': { mode: 0o755, content: '#!/bin/sh\nset -eu\nwhile [ ! -s /run/agentor-management/credential ]; do sleep 0.05; done\nexec "$@"\n' },
    };
}
export function administrativeNativeOverlaySha256(record: Readonly<AdministrativeWorkspaceRecord>) {
    return createHash('sha256').update(JSON.stringify(administrativeNativeOverlay(record))).digest('hex');
}
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
export const ADMIN_NATIVE_INITIALIZE_ROOTS=String.raw`import os
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
        this.storage = new IncusAdminWorkspaceStorage(config, client);
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
        const alias = await this.client.getImageAlias(this.config.incusWorkerImage);
        const image = incusImageIdentity(await this.client.getImage(alias.target));
        const files = await readCanonicalIncusBootstrap(join(process.cwd(), '.output/server/incus-bootstrap'));
        if (image.sourceImageId !== source.Id || image.recipeId !== incusConversionRecipeId(source.Id, files) ||
            image.converterVersion !== 'v0.4.0')
            throw failure('Approved native administrative base is not available for the exact worker OCI source');
        return image;
    }
    async prepareCredential(record: Readonly<AdministrativeWorkspaceRecord>, issuer: () => Promise<string>) {
        await this.validateAuthority(record);
        this.issuers.set(record.id, issuer);
        if (record.nativeRuntime?.pending)
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
                const result = await this.client.exec(record.nativeRuntime!.name, ['/usr/bin/true'], { command: [], user: 0, group: 0, timeoutMs: 5000 });
                if (result.returnCode === 0) { await this.assertOwned(record); return; }
            } catch { /* Only this harmless agent probe is safe to retry. */ }
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
    private async inspectOwned(record: Readonly<AdministrativeWorkspaceRecord>, incarnation = record.nativeRuntime?.incarnation, allowPending = false): Promise<IncusInstance> {
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
            c['user.agentor.admin-group'] !== (owner.groupId ?? '') || c['user.agentor.admin-nonce'] !== native.nonce ||
            c['volatile.base_image'] !== native.image.fingerprint || c['boot.autostart'] !== 'false' ||
            c['user.agentor.admin-overlay-sha256'] !== native.overlaySha256 || c['limits.memory'] !== '4GiB' || c['limits.cpu'] !== '2' ||
            incarnation && c['volatile.uuid'] !== incarnation || Object.keys(c).some(k => k.startsWith('raw.')) ||
            Object.keys(instance.expanded_config ?? {}).some(k => k.startsWith('raw.')))
            throw failure('Administrative VM ownership or incarnation is ambiguous');
        const network = await this.network.boundary(record, 'inspect');
        const persistent = await this.storage.devices(record, native, false);
        const expected = { ...persistent, root: { type: 'disk', path: '/', pool: this.config.incusStoragePool }, eth0: this.network.device(network) };
        if (!isDeepStrictEqual(instance.devices, expected) || !isDeepStrictEqual(instance.expanded_devices ?? instance.devices, expected))
            throw failure('Administrative VM storage or network boundary changed');
        return instance;
    }
    async ensure(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge): Promise<AdminWorkspaceRuntimeImage> {
        return this.ensureRecord(input, acknowledge, input.status === 'running');
    }
    private async ensureRecord(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge: AdminNativeAcknowledge | undefined, running: boolean, explicitStart = false): Promise<AdminWorkspaceRuntimeImage> {
        const record = structuredClone(input), ack = this.patch(record, acknowledge);
        await this.installation();
        await this.validateAuthority(record);
        if (record.nativeRuntime?.deleting || record.nativeRuntime?.pending)
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
            const network = await this.network.boundary(record, 'ensure');
            const devices = await this.storage.devices(record, native, !native.storageReady);
            if (!native.storageReady)
                await ack({ ...record.nativeRuntime!, storageReady: true });
            await this.mutation(record, 'create', ack, onAccepted => this.client.createInstance({ name: native.name, type: 'virtual-machine', profiles: [],
                source: { type: 'image', fingerprint: native.image.fingerprint }, config: { 'user.agentor.installation': native.installationId,
                    'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId, 'user.agentor.administrative': owner.kind,
                    'user.agentor.admin-group': owner.groupId ?? '', 'user.agentor.admin-nonce': native.nonce,
                    'user.agentor.admin-overlay-sha256': native.overlaySha256, 'security.secureboot': 'false', 'boot.autostart': 'false', 'limits.memory':'4GiB','limits.cpu':'2' },
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
        const issuer = this.issuers.get(record.id);
        if (!issuer)
            throw failure('Administrative start identity was not prepared');
        try {
            await this.mutation(record, 'start', ack, accepted => this.client.startInstance(record.nativeRuntime!.name, accepted));
            instance = await this.assertOwned(record);
            await this.waitAgent(record);
            await this.execute(record, ['/bin/sh', '-ec', PREPARE]);
            if(!record.nativeRuntime!.storageInitialized){
                await this.execute(record,['/usr/bin/python3','-c',ADMIN_NATIVE_INITIALIZE_ROOTS]);
                await ack({...record.nativeRuntime!,storageInitialized:true});
            }
            await this.client.pushFile(instance.name,'/run/agentor/preserve-storage-ownership','agentor-preserve-storage-ownership-v1\n',{uid:0,gid:0,mode:0o600});
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
        const instance = await this.inspectOwned(record, native.incarnation, true);
        if (pending.kind === 'start' && instance.status !== 'Running' || pending.kind === 'stop' && instance.status !== 'Stopped')
            throw failure('Administrative operation state is unsettled');
        await ack({ ...native, pending: undefined });
    }
    async rebuild(input: Readonly<AdministrativeWorkspaceRecord>, acknowledge?: AdminNativeAcknowledge) {
        const record = structuredClone(input), ack = this.patch(record, acknowledge);
        if (record.nativeRuntime?.pending)
            await this.settlePending(record, async (patch) => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
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
        if (present) await this.mutation(record, 'delete', ack, accepted => this.client.deleteInstance(record.nativeRuntime!.name, accepted));
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
    async assertRunning(record:Readonly<AdministrativeWorkspaceRecord>,incarnation=record.nativeRuntime?.incarnation):Promise<IncusInstance>{
        if(record.status!=='running' || !incarnation || !record.nativeRuntime?.storageInitialized)throw failure('Administrative runtime is not ready');
        const instance=await this.assertOwned(record,incarnation);
        if(instance.status!=='Running')throw failure('Administrative VM is not running');
        const result=await this.client.exec(instance.name,['/bin/bash','-c',INCUS_GUEST_READINESS_SCRIPT,'admin-ready',
          '/bin/bash','-ec','set -a; . /run/agentor/worker.env; set +a; exec /bin/sh -c "$1"','admin-session',INCUS_MAIN_SESSION_PROBE],{command:[],user:0,group:0});
        if(result.returnCode!==0 || !/^[a-f0-9-]{36} 1 1\s*$/.test(result.stdout))throw failure('Administrative guest service is not ready');
        await this.assertOwned(record,incarnation);return instance;
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
            if (instance.status !== 'Stopped') throw failure('Stop administrative workspace before deletion');
            await ack({ ...record.nativeRuntime!, deleting: true });
            await this.mutation(record, 'delete', ack, accepted => this.client.deleteInstance(instance.name, accepted));
        } else {
            // A lost delete result still requires its exact terminal receipt.
            if (record.nativeRuntime.pending) {
                await this.settlePending(record, async patch => { await acknowledge!(patch); applyAdminNativePatch(record, patch); });
            }
            // A durable intent does not authorize retrying an ambiguous delete.
            try { await this.client.getInstance(record.nativeRuntime.name); throw failure('Administrative compute deletion requires explicit recovery'); }
            catch (error) { if (!absent(error)) throw error; }
        }
        for (const role of ['workspace', 'agents'] as const) {
            await this.validateAuthority(record);
            const volume = await this.storage.inspect(record, record.nativeRuntime!, role);
            if (!volume) continue; // Earlier acknowledged deletion may already have completed.
            if (volume.used_by?.length) throw failure('Administrative storage deletion authority is unavailable');
            await this.client.deleteCustomVolume(this.config.incusStoragePool, volume.name);
        }
        (await import('./services')).useContainerManager().unregisterExternal(record.id);
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
