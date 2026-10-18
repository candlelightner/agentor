import { test, expect } from '@playwright/test';
import { mkdtemp, writeFile, rm, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { IncusAdminWorkspaceRuntime, ADMIN_NATIVE_CONTROL_WRITE, ADMIN_NATIVE_INITIALIZE_ROOTS } from '../../orchestrator/server/utils/incus-admin-workspace-runtime';
import { AdministrativeWorkspaceRuntime } from '../../orchestrator/server/utils/administrative-workspace-runtime';
import { IncusAdminNetworkBoundary } from '../../orchestrator/server/utils/incus-admin-network';
import { applyAdminNativePatch } from '../../orchestrator/server/utils/admin-native-authority';
import { IncusRequestRejected } from '../../orchestrator/server/utils/incus-client';
import { IncusOfflineArchiveHelper } from '../../orchestrator/server/utils/incus-offline-archive-helper';
import { MANAGED_KILO_PARENT, MANAGED_KILO_LINK, MANAGED_KILO_PARENT_CHECK } from '../../orchestrator/server/utils/managed-volume-kilo-parent';
import { ManagedVolumeStore } from '../../orchestrator/server/utils/managed-volume-store';
import { INCUS_SELECTION_DIRECTORY_CHECK, INCUS_PERSISTENCE_COPY } from '../../orchestrator/server/utils/incus-managed-volume-runtime';
import { INCUS_GUEST_READINESS_SCRIPT } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
const incusConfig = (config: Record<string, string>) => Object.fromEntries(Object.entries(config).filter(([, value]) => value !== ''));
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'admin-vm-core-')), installation = randomUUID(), incarnation = randomUUID();
    await writeFile(join(directory, 'backup-installation-id'), installation);
    const stamp = new Date(0).toISOString();
    let record: AdministrativeWorkspaceRecord = { schemaVersion: 1, id: randomUUID(), kind: 'administrative', trusted: true, runtimeKind: 'incus-vm', status: 'running', createdAt: stamp, updatedAt: stamp };
    const image = { version: 1 as const, sourceImageId: 'sha256:' + '1'.repeat(64), recipeId: '2'.repeat(64), architecture: 'amd64' as const, converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const, fingerprint: '3'.repeat(64) };
    const config: any = { incusEnabled: true, dataDir: directory, incusProject: 'agentor', incusStoragePool: 'pool', incusWorkerImage: 'approved', incusEndpoint: 'https://invalid.example' };
    const managed = new ManagedVolumeStore(directory);
    await managed.init();
    const events: string[] = [], files = new Map<string, string>(), volumes = new Map<string, any>();
    let instance: any, failCredential = false, unknownStart = false;
    const boundary: any = { boundary: async () => { events.push('network'); return { network: 'aa123', managementAddress: '10.88.0.2', gatewayUrl: 'http://10.88.0.2:3000', mcpUrl: 'http://10.88.0.2:3099/mcp', guestAddress: '10.88.0.3' }; }, device: () => ({ type: 'nic', network: 'aa123', name: 'eth0', hwaddr: '02:00:00:00:00:01', 'ipv4.address': '10.88.0.3', 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' }) };
    const client: any = { endpoint: 'https://invalid.example', project: 'agentor',
        getCustomVolume: async (_pool: string, name: string) => {
            if (!volumes.has(name))
                throw Object.assign(Error('absent'), { statusCode: 404 });
            return structuredClone(volumes.get(name));
        },
        createCustomVolume: async (_pool: string, v: any) => { events.push('volume-create'); volumes.set(v.name, { ...structuredClone(v), config: incusConfig(v.config), type: 'custom', project: config.incusProject, created_at: stamp, used_by: [] }); },
        deleteCustomVolume: async (_pool: string, name: string) => { events.push('volume-delete'); volumes.delete(name); },
        updateInstanceDevices: async (_name: string, devices: any, accepted: any) => { await accepted?.('/1.0/operations/' + randomUUID()); instance.devices = structuredClone(devices); events.push('devices'); },
        getInstance: async () => {
            if (!instance)
                throw Object.assign(Error('absent'), { statusCode: 404 });
            return structuredClone(instance);
        },
        createInstance: async (spec: any, accepted: any) => { events.push('vm-create'); await accepted?.('/1.0/operations/' + randomUUID()); instance = { ...structuredClone(spec), status: 'Stopped', config: { ...incusConfig(spec.config), 'volatile.uuid': randomUUID(), 'volatile.base_image': image.fingerprint } }; return structuredClone(instance); },
        startInstance: async (_name: string, accepted: any) => {
            events.push('vm-start');
            await accepted?.('/1.0/operations/' + randomUUID());
            if (unknownStart)
                throw Error('transport');
            instance.status = 'Running';
        },
        stopInstance: async (_name: string, _options: any, accepted: any) => { events.push('vm-stop'); await accepted?.('/1.0/operations/' + randomUUID()); instance.status = 'Stopped'; },
        deleteInstance: async (_name: string, accepted: any) => { events.push('vm-delete'); await accepted?.('/1.0/operations/' + randomUUID()); instance = undefined; },
        getImage: async () => ({ type: 'virtual-machine', fingerprint: image.fingerprint, properties: { source_image_id: image.sourceImageId, recipe_id: image.recipeId, source_architecture: 'amd64', converter_version: 'v0.4.0', bootstrap_generation: '3' } }),
        pushFile: async (_name: string, path: string, content: string) => { events.push('file:' + path); files.set(path, content); },
        exec: async (_name: string, command: string[]) => {
            if (command.includes('start'))
                events.push('service-start');
            return { returnCode: 0, stdout: command.includes(INCUS_GUEST_READINESS_SCRIPT) ? randomUUID() + ' 1 1\n' : command.includes(INCUS_SELECTION_DIRECTORY_CHECK) ? 'directory\n' : '', stderr: '' };
        },
        execStream: async (_name: string, command: string[]) => {
            const credential = command[2]!.includes("b'mcp1.'");
            events.push(credential ? 'credential-write' : 'control-write');
            return { stdout: { resume() { } }, stderr: { resume() { } }, stdin: { end(value: string) {
                        if (credential)
                            expect(value).toBe('mcp1.' + 'a'.repeat(43));
                        else
                            expect(Object.keys(JSON.parse(value)).sort()).toEqual(['README.md', 'image-definitions.json', 'runtime.json']);
                    } }, result: Promise.resolve(failCredential ? 1 : 0), close() { } };
        },
    };
    const runtime = new IncusAdminWorkspaceRuntime(config, client, boundary, { managedStore: async () => managed, readRecord: async () => structuredClone(record), resolveImage: async () => { events.push('image'); return image; }, register: () => events.push('register') });
    runtime.setManagementListener(async () => { events.push('listener'); });
    const ack = async (patch: any) => { events.push('ack' + (patch.nativeRuntime?.pending ? ':' + patch.nativeRuntime.pending.kind : '')); applyAdminNativePatch(record, patch); };
    const prepare = () => runtime.prepareCredential(structuredClone(record), async () => { events.push('credential-issue'); return 'mcp1.' + 'a'.repeat(43); });
    return { runtime, client, managed, config, boundary, events, files, volumes, image, ack, prepare, get record() { return record; }, get instance() { return instance; }, set failCredential(v: boolean) { failCredential = v; }, set unknownStart(v: boolean) { unknownStart = v; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
for (const project of ['agdr1cf75b31', 'agdr1cf75b31r']) test(`native admin compute and canonical storage fit virtiofs in ${project}`, async () => {
    const f = await fixture();
    try {
        f.config.incusProject = project;
        f.record.id = '1524edb5-320e-4d6e-a032-542dfe16258b';
        f.record.status = 'stopped';
        await f.runtime.ensure(f.record, f.ack);
        const name = 'agentor-admin-b53020e559e68e3fb2634e3a7b2708';
        expect(f.instance.name).toBe(name);
        expect([...f.volumes.keys()].sort()).toEqual([name + '-agents', name + '-workspace']);
        for (const key of Object.keys(f.instance.devices).filter(key => f.instance.devices[key].type === 'disk'))
            expect(Buffer.byteLength(`/var/lib/incus/devices/${project}_${name}/virtio-fs.${key}.sock`)).toBeLessThanOrEqual(107);
        expect(f.record.nativeRuntime?.pending).toBeUndefined();
        expect(f.events).not.toContain('vm-start');
    } finally { await f.cleanup(); }
});
test('overlong admin socket paths reject before image resolution, acknowledgement or native resources', async () => {
    const f = await fixture();
    try {
        f.config.incusProject = 'p'.repeat(15);
        const before = structuredClone(f.record);
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('107 bytes');
        expect(f.events).toEqual([]);
        expect(f.record).toEqual(before);
        expect(f.volumes.size).toBe(0);
        expect(f.instance).toBeUndefined();
    } finally { await f.cleanup(); }
});
test('overlong project rebuild retains the existing admin compute, canonical roots and pending authority', async () => {
    const f = await fixture();
    try {
        f.record.status = 'stopped';
        await f.runtime.ensure(f.record, f.ack);
        f.record.nativeRuntime!.pending = { kind: 'start', operation: '/1.0/operations/' + randomUUID() };
        const before = structuredClone(f.record), instance = structuredClone(f.instance), volumes = structuredClone(f.volumes);
        f.config.incusProject = 'p'.repeat(15);
        f.events.length = 0;
        await expect(f.runtime.rebuild(f.record, f.ack)).rejects.toThrow('107 bytes');
        expect(f.events).toEqual([]);
        expect(f.record).toEqual(before);
        expect(f.instance).toEqual(instance);
        expect(f.volumes).toEqual(volumes);
    } finally { await f.cleanup(); }
});
test('fresh admin VM persists authority, proves network, and mints tmpfs identity only at actual gated start', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        expect(f.events).toEqual([]);
        await f.runtime.ensure(structuredClone(f.record), f.ack);
        expect(f.events.indexOf('ack')).toBeLessThan(f.events.indexOf('network'));
        expect(f.events.indexOf('vm-start')).toBeLessThan(f.events.indexOf('credential-issue'));
        expect(f.events.indexOf('credential-write')).toBeLessThan(f.events.indexOf('file:/run/agentor/provisioned'));
        expect(f.files.get('/run/agentor/preserve-storage-ownership')).toBe('agentor-preserve-storage-ownership-v1\n');
        expect(f.events.indexOf('file:/run/agentor/preserve-storage-ownership')).toBeLessThan(f.events.indexOf('file:/run/agentor/provisioned'));
        expect(f.record.nativeRuntime?.storageInitialized).toBe(true);
        expect(f.events.indexOf('file:/run/agentor/provisioned')).toBeLessThan(f.events.indexOf('service-start'));
        expect(f.record.nativeRuntime?.incarnation).toBeTruthy();
        expect(f.record.nativeRuntime?.pending).toBeUndefined();
        expect(f.instance.profiles).toEqual([]);
        expect(f.instance.config['boot.autostart']).toBe('false');
        const env = f.files.get('/run/agentor/worker.env')!;
        expect(env).toContain("AGENTOR_RUNTIME_ROLE='platform-admin'");
        expect(env).toContain("AGENTOR_MANAGEMENT_MCP_URL='http://10.88.0.2:3099/mcp'");
        expect(env).not.toContain('mcp1.');
        expect(JSON.stringify(f.record)).not.toContain('mcp1.');
    }
    finally {
        await f.cleanup();
    }
});
for (const group of [false, true]) test(`Incus empty-label removal preserves ${group ? 'group exact' : 'global absent-or-empty'} VM and canonical storage authority`, async () => {
    const f = await fixture();
    try {
        f.record.status = 'stopped';
        if (group) Object.assign(f.record, { kind: 'group-administrative', groupId: 'fixture-group', ownerId: 'fixture-owner' });
        await f.runtime.ensure(f.record, f.ack);
        const key = 'user.agentor.admin-group', expected = group ? 'fixture-group' : '';
        const configs = [f.instance.config, ...[...f.volumes.values()].map(v => v.config)];
        for (const config of configs) {
            expect(config[key]).toBe(group ? expected : undefined);
            for (const value of [undefined, '', null, 'foreign']) {
                if (value === undefined) delete config[key]; else config[key] = value;
                if (!group && (value === undefined || value === '')) await expect(f.runtime.assertOwned(f.record)).resolves.toBeTruthy();
                else await expect(f.runtime.assertOwned(f.record)).rejects.toThrow(/ambiguous/);
            }
            if (group) config[key] = expected; else delete config[key];
        }
        await expect(f.runtime.assertOwned(f.record)).resolves.toBeTruthy();
        expect(f.volumes.size).toBe(2);
    } finally { await f.cleanup(); }
});
test('unavailable Incus never calls the retained Docker provisioning backend', async () => {
    const f = await fixture();
    try {
        f.config.incusEnabled = false;
        let dockerCalls = 0;
        const legacy: any = { ensure: async () => { dockerCalls++; }, start: async () => { dockerCalls++; }, rebuild: async () => { dockerCalls++; } };
        const dispatch = new AdministrativeWorkspaceRuntime(f.config, f.runtime, legacy);
        await expect(dispatch.ensure(f.record, f.ack)).rejects.toThrow('Docker fallback is forbidden');
        expect(dockerCalls).toBe(0);
        expect(f.events).toEqual([]);
        await expect(dispatch.start({ ...f.record, runtimeKind: undefined })).rejects.toMatchObject({ code: 'ADMIN_NATIVE_MIGRATION_REQUIRED' });
        await expect(dispatch.rebuild({ ...f.record, runtimeKind: undefined })).rejects.toMatchObject({ code: 'ADMIN_NATIVE_MIGRATION_REQUIRED' });
        expect(dockerCalls).toBe(0);
    }
    finally {
        await f.cleanup();
    }
});
test('failed durable intent acknowledgement precedes all native storage/network/VM writes', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await expect(f.runtime.ensure(f.record, async () => { throw Error('disk'); })).rejects.toThrow('disk');
        expect(f.events).toEqual(['image']);
        expect(f.volumes.size).toBe(0);
    }
    finally {
        await f.cleanup();
    }
});
test('credential materialization failure stops only the captured VM before any worker service marker', async () => {
    const f = await fixture();
    try {
        f.failCredential = true;
        await f.prepare();
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('materialization');
        expect(f.events).toContain('vm-stop');
        expect(f.instance.status).toBe('Stopped');
        expect(f.files.has('/run/agentor/provisioned')).toBe(false);
        expect(f.record.nativeRuntime?.pending).toBeUndefined();
    }
    finally {
        await f.cleanup();
    }
});
test('unknown accepted start remains fenced and retry neither restarts nor writes guest data', async () => {
    const f = await fixture();
    try {
        f.unknownStart = true;
        await f.prepare();
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('transport');
        expect(f.record.nativeRuntime?.pending?.kind).toBe('start');
        const events = [...f.events];
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('explicit recovery');
        expect(f.events).toEqual(events);
        expect(f.files.size).toBe(0);
    }
    finally {
        await f.cleanup();
    }
});
test('foreign incarnation and lost retained data fail before guest preparation', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        f.events.length = 0;
        f.instance.config['volatile.uuid'] = randomUUID();
        await expect(f.runtime.assertOwned(f.record)).rejects.toThrow('ambiguous');
        expect(f.events).toEqual([]);
        f.instance.config['volatile.uuid'] = f.record.nativeRuntime!.incarnation;
        f.volumes.delete(f.record.nativeRuntime!.name + '-agents');
        await expect(f.runtime.assertOwned(f.record)).rejects.toThrow('persistent data is missing');
        expect(f.events).not.toContain('volume-create');
        expect(f.events).not.toContain('credential-write');
    }
    finally {
        await f.cleanup();
    }
});
test('explicit start preserves stopped durable intent until caller commits and applies desired script revision', async () => {
    const f = await fixture();
    try {
        f.record.status = 'stopped';
        await f.runtime.ensure(f.record, f.ack);
        expect(f.instance.status).toBe('Stopped');
        f.record.startupScript = 'echo desired';
        f.record.startupScriptRevision = 4;
        await f.prepare();
        const result = await f.runtime.start(f.record, f.ack);
        expect(f.record.status).toBe('stopped');
        expect(result.appliedStartupScriptRevision).toBe(4);
        expect(f.files.get('/run/agentor/worker.env')).toContain('platform-admin');
    }
    finally {
        await f.cleanup();
    }
});
test('ordinary ensure does not falsely apply a script pending on an already running VM', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        f.record.startupScriptRevision = 3;
        f.record.startupScript = 'echo pending';
        f.events.length = 0;
        const result = await f.runtime.ensure(f.record, f.ack);
        expect(result.appliedStartupScriptRevision).toBe(0);
        expect(f.events).not.toContain('service-start');
        expect(f.events).not.toContain('vm-stop');
    }
    finally {
        await f.cleanup();
    }
});
test('administrative network response is bound to exact private owner/address/endpoint authority', async () => {
    const f = await fixture();
    try {
        f.record.status = 'stopped';
        await f.runtime.ensure(f.record, f.ack);
        const native = f.record.nativeRuntime!;
        const owner = '__agentor_admin__';
        const response: any = { installation: native.installationId, workspaceId: f.record.id, ownerId: owner, kind: 'administrative', network: 'aa123', subnet: '10.88.0.0/24', gateway: '10.88.0.1', managementAddress: '10.88.0.2', guestAddress: '10.88.0.3', guestMac: '02:00:00:00:00:01', gatewayUrl: 'http://10.88.0.2:3000', mcpUrl: 'http://10.88.0.2:3099/mcp' };
        const transport: any = { request: async () => response };
        const boundary = new IncusAdminNetworkBoundary(f.config, transport);
        await expect(boundary.boundary(f.record, 'inspect')).resolves.toEqual(response);
        for (const [field, value] of [['ownerId', 'other'], ['mcpUrl', 'http://other:3099/mcp'], ['managementAddress', '10.88.0.4'], ['guestMac', 'ff:00:00:00:00:00']] as const) {
            const previous = response[field];
            response[field] = value;
            await expect(boundary.boundary(f.record, 'inspect')).rejects.toThrow('authority');
            response[field] = previous;
        }
    }
    finally {
        await f.cleanup();
    }
});
test('generated control representation writes only fixed files through pinned no-follow workspace directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-control-'));
    try {
        const workspace = join(directory, 'workspace');
        await mkdir(workspace);
        const files = { 'README.md': 'admin control', 'image-definitions.json': '[]', 'runtime.json': '{}' };
        const script = ADMIN_NATIVE_CONTROL_WRITE.replace("os.open('/workspace',flags)", "os.open(sys.argv[1],flags)");
        const result = spawnSync('python3', ['-c', script, workspace], { input: JSON.stringify(files), encoding: 'utf8', timeout: 5000 });
        expect(result.status, result.stderr).toBe(0);
        for (const [name, value] of Object.entries(files))
            expect(await readFile(join(workspace, 'agentor-control', name), 'utf8')).toBe(value);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('generated control representation rejects parent symlinks and extra files without writing outside workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-control-'));
    try {
        const workspace = join(directory, 'workspace'), outside = join(directory, 'outside');
        await mkdir(workspace);
        await mkdir(outside);
        await writeFile(join(outside, 'README.md'), 'untouched');
        await symlink(outside, join(workspace, 'agentor-control'));
        const files = { 'README.md': 'replacement', 'image-definitions.json': '[]', 'runtime.json': '{}' };
        const script = ADMIN_NATIVE_CONTROL_WRITE.replace("os.open('/workspace',flags)", "os.open(sys.argv[1],flags)");
        for (const content of [files, { ...files, '../escape': 'bad' }]) {
            const result = spawnSync('python3', ['-c', script, workspace], { input: JSON.stringify(content), encoding: 'utf8', timeout: 5000 });
            expect(result.status).not.toBe(0);
            expect(await readFile(join(outside, 'README.md'), 'utf8')).toBe('untouched');
        }
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('group VM trusted role and generated routing override historical owner environment', async () => {
    const f = await fixture();
    try {
        f.record.kind = 'group-administrative';
        (f.record as any).groupId = randomUUID();
        f.record.ownerId = 'group-owner';
        (f.runtime as any).dependencies.ownerEnvironment = () => ({ userId: 'group-owner', createdAt: '', updatedAt: '', envVars: [{ key: 'AGENTOR_RUNTIME_ROLE', value: 'platform-admin' }, { key: 'AGENTOR_TRUSTED_RUNTIME_ROLE', value: 'platform-admin' }, { key: 'AGENTOR_MANAGEMENT_MCP_URL', value: 'http://foreign' }, { key: 'SAFE_SETTING', value: 'preserved' }] });
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        const env = f.files.get('/run/agentor/worker.env')!;
        expect(env).toContain("AGENTOR_RUNTIME_ROLE='group-admin'");
        expect(env).not.toContain("AGENTOR_TRUSTED_RUNTIME_ROLE=");
        expect(env).not.toContain('foreign');
        expect(env).toContain("SAFE_SETTING='preserved'");
        expect(f.instance.config['user.agentor.owner']).toBe('group-owner');
        expect(f.instance.config['user.agentor.admin-group']).toBe((f.record as any).groupId);
    }
    finally {
        await f.cleanup();
    }
});
test('explicit rebuild settles acknowledged start against captured incarnation and preserves canonical volumes', async () => {
    const f = await fixture();
    try {
        f.unknownStart = true;
        await f.prepare();
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('transport');
        const old = f.record.nativeRuntime!.incarnation;
        f.unknownStart = false;
        f.instance.status = 'Running';
        f.client.request = async () => ({ status: 'Success', status_code: 200 });
        f.events.length = 0;
        await f.prepare();
        await f.runtime.rebuild(f.record, f.ack);
        expect(f.events).toContain('vm-stop');
        expect(f.events).toContain('vm-delete');
        expect(f.events).toContain('vm-create');
        expect(f.events).not.toContain('volume-create');
        expect(f.record.nativeRuntime!.incarnation).not.toBe(old);
        expect(f.record.nativeRuntime!.pending).toBeUndefined();
        expect(f.volumes.size).toBe(2);
    }
    finally {
        await f.cleanup();
    }
});
test('unacknowledged or still-running native operation cannot be guessed complete from VM state', async () => {
    const f = await fixture();
    try {
        f.unknownStart = true;
        await f.prepare();
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('transport');
        f.client.request = async () => ({ status: 'Running', status_code: 103 });
        const pending = structuredClone(f.record.nativeRuntime!.pending);
        f.events.length = 0;
        await expect(f.runtime.rebuild(f.record, f.ack)).rejects.toThrow('not acknowledged');
        expect(f.events).toEqual([]);
        expect(f.record.nativeRuntime!.pending).toEqual(pending);
        f.record.nativeRuntime!.pending!.operation = undefined;
        await expect(f.runtime.rebuild(f.record, f.ack)).rejects.toThrow('operator recovery');
        expect(f.events).toEqual([]);
    }
    finally {
        await f.cleanup();
    }
});
test('fresh-root initialization rejects populated or symlinked canonical data before metadata mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'admin-root-init-'));
    try {
        const workspace = join(directory, 'workspace'), agents = join(directory, 'agents');
        await mkdir(workspace);
        await mkdir(agents);
        await writeFile(join(agents, 'retained'), 'unchanged');
        const script = ADMIN_NATIVE_INITIALIZE_ROOTS.replace("roots=['/workspace','/home/agent/.agent-data']", 'roots=' + JSON.stringify([workspace, agents]));
        const result = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 });
        expect(result.status).not.toBe(0);
        expect(await readFile(join(agents, 'retained'), 'utf8')).toBe('unchanged');
        const outside = join(directory, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'retained'), 'outside');
        await rm(agents, { recursive: true });
        await symlink(outside, agents);
        const symlinkResult = spawnSync('python3', ['-c', script], { encoding: 'utf8', timeout: 5000 });
        expect(symlinkResult.status).not.toBe(0);
        expect(await readFile(join(outside, 'retained'), 'utf8')).toBe('outside');
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test('cold guest agent transient retries only the harmless probe before preparation', async () => {
    const f = await fixture();
    try {
        const execute = f.client.exec;
        let probes = 0;
        f.client.exec = async (name: string, command: string[], options: any) => {
            if (command.length === 3 && command[0] === 'timeout' && command[2] === '/usr/bin/true' && ++probes === 1)
                throw Object.assign(Error('Guest agent not ready'), { statusCode: 503 });
            return execute(name, command, options);
        };
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        expect(probes).toBe(2);
        expect(f.instance.status).toBe('Running');
        expect(f.events).toContain('credential-write');
        expect(f.events).not.toContain('vm-stop');
    }
    finally {
        await f.cleanup();
    }
});
test('explicit remove retains storage cleanup authority after a partial volume deletion', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        await f.runtime.stop(f.record, f.ack);
        let calls = 0;
        f.client.deleteCustomVolume = async (_pool: string, name: string) => {
            if (++calls === 2)
                throw Error('temporary storage failure');
            f.volumes.delete(name);
        };
        await expect(f.runtime.remove(f.record, f.ack)).rejects.toThrow('temporary storage failure');
        expect(f.instance).toBeUndefined();
        expect(f.record.nativeRuntime?.deleting).toBe(true);
        expect(f.volumes.size).toBe(1);
        await expect(f.runtime.start(f.record, f.ack)).rejects.toThrow('explicit recovery');
        // Avoid service singleton access after the final cleanup, without masking storage work.
        const { useContainerManager } = await import('../../orchestrator/server/utils/services');
        const manager = useContainerManager(), unregister = manager.unregisterExternal;
        manager.unregisterExternal = () => { };
        try {
            await f.runtime.remove(f.record, f.ack);
        }
        finally {
            manager.unregisterExternal = unregister;
        }
        expect(f.volumes.size).toBe(0);
        expect(f.events.filter(x => x === 'vm-delete')).toHaveLength(1);
    }
    finally {
        await f.cleanup();
    }
});
test('fresh VM without a daemon incarnation never starts or provisions', async () => {
    const f = await fixture();
    try {
        const create = f.client.createInstance;
        f.client.createInstance = async (...args: any[]) => { const value = await create(...args); delete value.config['volatile.uuid']; return value; };
        await f.prepare();
        await expect(f.runtime.ensure(f.record, f.ack)).rejects.toThrow('incarnation is unavailable');
        expect(f.record.nativeRuntime?.pending?.kind).toBe('create');
        expect(f.events).not.toContain('vm-start');
        expect(f.events).not.toContain('credential-write');
    }
    finally {
        await f.cleanup();
    }
});
test('admin selected directory snapshots remain provisional and explicit rebuild recopies before root replacement', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        let copies = 0;
        const execute = f.client.exec;
        f.client.exec = async (name: string, command: string[], options: any) => { if (command.includes(INCUS_PERSISTENCE_COPY))
            copies++; return execute(name, command, options); };
        await f.runtime.adoptSelections(f.record, ['/home/agent/projects', '/workspace/a', '/etc/hosts'], f.ack);
        expect(copies).toBe(1);
        const id = f.record.nativeRuntime!.selectedVolumeIds![0]!, before = f.managed.get('__agentor_admin__', id)!;
        expect(before.seeded).toBe(false);
        expect(f.record.nativeRuntime!.selectedOperation).toBeUndefined();
        expect(Object.values(f.instance.devices).some((d: any) => d.source === before.dockerName)).toBe(false);
        await expect(f.runtime.inspectSelectedStorage(f.record)).rejects.toThrow('explicit rebuild');
        await f.prepare();
        await f.runtime.rebuild(f.record, f.ack);
        expect(copies).toBe(2);
        expect(f.managed.get('__agentor_admin__', id)!.seeded).toBe(true);
        const descriptor = await f.runtime.inspectSelectedStorage(f.record);
        expect(descriptor.map(v => v.record.id)).toEqual([id]);
        expect(f.instance.devices['m' + id.replaceAll('-', '').slice(0, 6)].path).toBe('/home/agent/projects');
        expect(f.instance.status).toBe('Running');
    }
    finally {
        await f.cleanup();
    }
});
test('admin selected directory failed unknown attach retains source and refuses recovery replay', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        let submissions = 0;
        f.client.updateInstanceDevices = async () => { submissions++; throw Error('lost attach response'); };
        await expect(f.runtime.adoptSelections(f.record, ['/home/agent/projects'], f.ack)).rejects.toThrow();
        expect(f.record.nativeRuntime!.selectedOperation!.device!.state).toBe('unknown');
        expect(f.instance.status).toBe('Running');
        expect(f.events).not.toContain('vm-delete');
        await expect(f.runtime.recoverSelectedStorage(f.record, f.ack)).rejects.toThrow('operator recovery');
        await expect(f.runtime.start(f.record, f.ack)).rejects.toThrow('explicit recovery');
        await expect(f.runtime.inspectSelectedStorage(f.record)).rejects.toThrow('explicit recovery');
        expect(submissions).toBe(1);
    }
    finally {
        await f.cleanup();
    }
});
test('admin selected canonical sources reject cross-owner records, missing data and forged extra devices', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        await f.runtime.adoptSelections(f.record, ['/home/agent/projects'], f.ack);
        const id = f.record.nativeRuntime!.selectedVolumeIds![0]!, v = f.managed.get('__agentor_admin__', id)!;
        await f.managed.save({ ...v, userId: 'foreign-owner' });
        await f.managed.forget('__agentor_admin__', id);
        await expect(f.runtime.assertOwned(f.record)).rejects.toThrow('explicit recovery');
        await f.managed.save({ ...v, seeded: true, state: 'ready' });
        const key = 'm' + id.replaceAll('-', '').slice(0, 6);
        f.instance.devices[key] = { type: 'disk', pool: 'pool', source: v.dockerName, path: v.target };
        // Fixture returns clones: replacing getInstance models exact daemon state.
        const get = f.client.getInstance;
        const instance = await get();
        instance.devices[key] = { type: 'disk', pool: 'pool', source: v.dockerName, path: v.target };
        f.client.getInstance = async () => structuredClone(instance);
        await f.runtime.assertOwned(f.record);
        f.volumes.delete(v.dockerName);
        await expect(f.runtime.assertOwned(f.record)).rejects.toThrow('missing');
    }
    finally {
        await f.cleanup();
    }
});
test('explicit admin rebuild recovers a settled failed provisional copy while retaining the original source', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        const execute = f.client.exec;
        let fail = true;
        f.client.exec = async (name: string, command: string[], options: any) => {
            if (fail && command.includes(INCUS_PERSISTENCE_COPY)) {
                fail = false;
                return { returnCode: 1, stdout: '', stderr: '' };
            }
            return execute(name, command, options);
        };
        await expect(f.runtime.adoptSelections(f.record, ['/home/agent/projects'], f.ack)).rejects.toThrow('copy failed');
        expect(f.record.nativeRuntime!.selectedOperation!.device!.state).toBe('settled');
        expect(f.instance.status).toBe('Running');
        expect(f.events).not.toContain('vm-delete');
        await f.prepare();
        await f.runtime.rebuild(f.record, f.ack);
        expect(f.record.nativeRuntime!.selectedOperation).toBeUndefined();
        expect((await f.runtime.inspectSelectedStorage(f.record))[0]!.record.seeded).toBe(true);
    }
    finally {
        await f.cleanup();
    }
});
test('group admin selected records stay in the dedicated group owner namespace and never adopt historical Docker records', async () => {
    const f = await fixture();
    try {
        Object.assign(f.record, { kind: 'group-administrative', ownerId: 'group-owner', groupId: 'legacy_group' });
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        const created = await f.managed.create('group-owner', f.record.id, '/home/agent/old-data', undefined, 'legacy-docker'), legacy = structuredClone(f.managed.get('group-owner', created.id))!;
        await f.runtime.adoptSelections(f.record, ['/home/agent/new-data'], f.ack);
        expect(f.record.nativeRuntime!.selectedVolumeIds).not.toContain(legacy.id);
        const selected = f.managed.get('group-owner', f.record.nativeRuntime!.selectedVolumeIds![0]!)!;
        expect(selected.storageRuntimeKind).toBe('incus-vm');
        expect(selected.workerId).toBe(f.record.id);
        expect(f.managed.get('group-owner', legacy.id)).toEqual(legacy);
        expect(f.managed.forWorker('__agentor_admin__', f.record.id)).toEqual([]);
    }
    finally {
        await f.cleanup();
    }
});
test('native admin removal retries selected-volume cleanup without retargeting retained Docker selections', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        await f.runtime.adoptSelections(f.record, ['/home/agent/projects'], f.ack);
        const id = f.record.nativeRuntime!.selectedVolumeIds![0]!, selected = f.managed.get('__agentor_admin__', id)!;
        const created = await f.managed.create('__agentor_admin__', f.record.id, '/home/agent/legacy', undefined, 'legacy-docker'), legacy = structuredClone(f.managed.get('__agentor_admin__', created.id))!;
        await f.runtime.stop(f.record, f.ack);
        const remove = f.client.deleteCustomVolume;
        let fail = true;
        f.client.deleteCustomVolume = async (pool: string, name: string) => { if (name === selected.dockerName && fail) {
            fail = false;
            throw Error('selected delete failed');
        } return remove(pool, name); };
        await expect(f.runtime.remove(f.record, f.ack)).rejects.toThrow('selected delete failed');
        expect(f.instance).toBeUndefined();
        expect(f.managed.get('__agentor_admin__', id)).toBeTruthy();
        await f.runtime.remove(f.record, f.ack);
        expect(f.managed.get('__agentor_admin__', id)).toBeUndefined();
        expect(f.managed.get('__agentor_admin__', legacy.id)).toEqual(legacy);
    }
    finally {
        await f.cleanup();
    }
});
test('backup settings dispatch authorized human selections through dedicated native transactions without ordinary managed adoption', async () => {
    const f = await fixture();
    const { useAdminWorkspaceStore } = await import('../../orchestrator/server/utils/admin-workspace-store');
    const { useConfig, useAdministrativeWorkspaceRuntime } = await import('../../orchestrator/server/utils/services');
    const { migrateAuth, getAuthDb } = await import('../../orchestrator/server/utils/auth');
    const { useManagedVolumeManager } = await import('../../orchestrator/server/utils/managed-volume-manager');
    const { PersistentBackupPathManager } = await import('../../orchestrator/server/utils/persistent-backup-paths');
    const dataDir = useConfig().dataDir; expect(dataDir).toMatch(/^\/tmp\/agentor-incus-acceptance-/);
    const path = join(dataDir, 'admin', 'workspace.v1.json');
    const previousBytes = await readFile(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const store = useAdminWorkspaceStore(), runtime = useAdministrativeWorkspaceRuntime(), managed = useManagedVolumeManager();
    const original = { init: store.init, get: store.getRecord, transaction: store.withNativeRuntimeTransaction, adopt: runtime.native.adoptSelections, ordinary: managed.adoptIncusSelections };
    const owner = randomUUID(); f.record.ownerId = owner;
    try {
        await f.prepare(); await f.runtime.ensure(f.record, f.ack);
        await mkdir(join(dataDir, 'admin'), { recursive: true }); await writeFile(path, JSON.stringify(f.record));
        await migrateAuth(); getAuthDb().prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role) VALUES (?,?,?,?,?,?,?)')
            .run(owner, 'Fixture', owner+'@invalid.test', 0, Date.now(), Date.now(), 'admin');
        store.init = async () => {}; store.getRecord = () => structuredClone(f.record);
        let transactions = 0;
        store.withNativeRuntimeTransaction = async operation => {
            transactions++;
            const current = structuredClone(f.record);
            return operation(current, async patch => { await f.ack(patch); applyAdminNativePatch(current, patch); await writeFile(path, JSON.stringify(f.record)); }, async () => {});
        };
        runtime.native.adoptSelections = (record, paths, ack) => f.runtime.adoptSelections(record, paths, ack);
        managed.adoptIncusSelections = async () => { throw Error('ordinary authority must not be used'); };
        const manager = new PersistentBackupPathManager(f.config, () => ({ id: f.record.id, userId: '__agentor_admin__', runtimeKind: 'incus-vm', administrativeKind: 'platform' } as any), async () => true);
        await manager.reconcileSelections(owner, { [f.record.id]: ['/home/agent/projects'] });
        expect(transactions).toBe(1); expect(f.record.nativeRuntime!.selectedVolumeIds).toHaveLength(1);
        await expect(manager.reconcileSelections('foreign', { [f.record.id]: ['/home/agent/other'] })).rejects.toMatchObject({ statusCode: 404 });
        await expect(manager.reconcileSelections('__agentor_admin__', { [f.record.id]: ['/home/agent/other'] })).rejects.toMatchObject({ statusCode: 404 });
    } finally {
        store.init = original.init; store.getRecord = original.get;
        store.withNativeRuntimeTransaction = original.transaction; runtime.native.adoptSelections = original.adopt; managed.adoptIncusSelections = original.ordinary;
        if (previousBytes) await writeFile(path, previousBytes); else await rm(path, { force: true });
        getAuthDb().prepare('DELETE FROM user WHERE id=?').run(owner);
        await f.cleanup();
    }
});
test('native admin retained XDG parent proves the literal Kilo leaf in a fixed readonly helper before mounting or starting', async () => {
    const f = await fixture(), parent = await mkdtemp(join(tmpdir(), 'admin-kilo-proof-'));
    const previous = IncusOfflineArchiveHelper.prototype.withGuest;
    try {
        f.record.id = 'legacy_admin';
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        await f.runtime.stop(f.record, f.ack);
        const id = randomUUID(), stamp = new Date(0).toISOString(), v: any = { id, userId: '__agentor_admin__', workerId: f.record.id, target: MANAGED_KILO_PARENT, name: 'retained-parent',
            dockerName: 'agentor-persist-' + id, storageRuntimeKind: 'incus-vm', purpose: 'persistent-path', seeded: true, attached: true, state: 'ready', createdAt: stamp, updatedAt: stamp };
        await f.managed.save(v);
        await f.ack({ runtimeKind: 'incus-vm', nativeRuntime: { ...f.record.nativeRuntime!, selectedVolumeIds: [id] } });
        const volume: any = { name: v.dockerName, type: 'custom', content_type: 'filesystem', project: 'agentor', created_at: stamp, used_by: [], config: {
                'user.agentor.installation': f.record.nativeRuntime!.installationId, 'user.agentor.owner': v.userId, 'user.agentor.id': v.workerId, 'user.agentor.volume-id': id, 'user.agentor.target': v.target
            } };
        f.volumes.set(v.dockerName, volume);
        let helpers = 0, checks = 0;
        const execute = f.client.exec;
        f.client.exec = async (name: string, command: string[], options: any) => {
            if (command.includes(MANAGED_KILO_PARENT_CHECK)) {
                checks++;
                expect(command.at(-1)).toBe('/volume');
                const result = spawnSync('python3', ['-c', MANAGED_KILO_PARENT_CHECK, parent]);
                return { returnCode: result.status, stdout: '', stderr: '' };
            }
            return execute(name, command, options);
        };
        IncusOfflineArchiveHelper.prototype.withGuest = async function (owner, sources, validate, _signal, action) {
            helpers++;
            expect(owner).toEqual({ id: f.record.nativeRuntime!.nonce, userId: '__agentor_admin__', containerName: f.record.nativeRuntime!.name });
            expect(sources).toEqual({ managed: v.dockerName });
            await validate();
            const name = 'abk-' + randomUUID();
            volume.used_by.push(`/1.0/instances/${name}?project=agentor`);
            try {
                return await action(name, async () => { await validate(name); });
            }
            finally {
                volume.used_by = [];
                await validate();
            }
        };
        await symlink(MANAGED_KILO_LINK, join(parent, 'kilo'));
        await f.runtime.storage.verifySelectedBeforeMount(f.record, () => f.runtime.validateAuthority(f.record));
        for (const kind of ['missing', 'wrong-link', 'real-directory']) {
            await rm(join(parent, 'kilo'), { force: true, recursive: true });
            if (kind === 'wrong-link')
                await symlink('/outside', join(parent, 'kilo'));
            if (kind === 'real-directory')
                await mkdir(join(parent, 'kilo'));
            await expect(f.runtime.storage.verifySelectedBeforeMount(f.record, () => f.runtime.validateAuthority(f.record))).rejects.toThrow('exact canonical Kilo');
            expect(volume.used_by).toEqual([]);
        }
        expect(helpers).toBe(4);
        expect(checks).toBe(4);
        expect(f.events.filter(x => x === 'vm-start')).toHaveLength(1);
    }
    finally {
        IncusOfflineArchiveHelper.prototype.withGuest = previous;
        await rm(parent, { recursive: true, force: true });
        await f.cleanup();
    }
});
test('accepted selected-device receipt must be terminal before explicit recovery can stop or change compute', async () => {
    const f = await fixture();
    try {
        await f.prepare();
        await f.runtime.ensure(f.record, f.ack);
        let submissions = 0;
        const operation = '/1.0/operations/' + randomUUID();
        f.client.updateInstanceDevices = async (_name: string, _devices: any, accepted: any) => { submissions++; await accepted(operation); throw Error('lost accepted response'); };
        await expect(f.runtime.adoptSelections(f.record, ['/home/agent/projects'], f.ack)).rejects.toThrow();
        expect(f.record.nativeRuntime!.selectedOperation!.device).toEqual({ state: 'accepted', operation });
        f.client.request = async () => ({ status: 'Running', status_code: 103 });
        await expect(f.runtime.recoverSelectedStorage(f.record, f.ack)).rejects.toThrow('not terminal');
        expect(f.instance.status).toBe('Running');
        expect(submissions).toBe(1);
        f.client.request = async () => ({ status: 'Failure', status_code: 400 });
        await f.runtime.recoverSelectedStorage(f.record, f.ack);
        expect(f.record.nativeRuntime!.selectedOperation).toBeUndefined();
        expect(submissions).toBe(1);
        expect(f.instance.status).toBe('Stopped');
        expect(f.events).not.toContain('vm-delete');
        await expect(f.runtime.start(f.record, f.ack)).rejects.toThrow('explicit rebuild');
    }
    finally {
        await f.cleanup();
    }
});

test('failed first selected-reference acknowledgement removes only its fresh unallocated record',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.runtime.ensure(f.record,f.ack);
  await expect(f.runtime.adoptSelections(f.record,['/home/agent/projects'],async patch=>{if(patch.nativeRuntime?.selectedVolumeIds?.length)throw Error('ref commit failed');await f.ack(patch);})).rejects.toThrow('ref commit failed');
  expect(f.managed.forWorker('__agentor_admin__',f.record.id)).toEqual([]);expect(f.record.nativeRuntime!.selectedVolumeIds).toBeUndefined();
  await f.runtime.assertOwned(f.record);await f.runtime.adoptSelections(f.record,['/home/agent/projects'],f.ack);
  expect(f.record.nativeRuntime!.selectedVolumeIds).toHaveLength(1);
 }finally{await f.cleanup();}
});
test('failed pre-copy operation acknowledgement restores prior metadata or retains its exact adopted recovery receipt',async()=>{
 for(const adopted of [false,true]){
  const f=await fixture();try{
   await f.prepare();await f.runtime.ensure(f.record,f.ack);
   await expect(f.runtime.adoptSelections(f.record,['/home/agent/projects'],async patch=>{
    if(patch.nativeRuntime?.selectedOperation){if(adopted)await f.ack(patch);throw Error('operation commit failed');}await f.ack(patch);
   })).rejects.toThrow('operation commit failed');
   const id=f.record.nativeRuntime!.selectedVolumeIds![0]!,v=f.managed.get('__agentor_admin__',id)!;
   expect(v.seeded).toBe(false);expect(v.state).toBe(adopted?'preparing':'pending');
   expect(!!f.record.nativeRuntime!.selectedOperation).toBe(adopted);
   expect(f.events.filter(x=>x==='devices')).toEqual([]);expect(f.instance.status).toBe('Running');
   await f.prepare();await f.runtime.rebuild(f.record,f.ack);
   expect((await f.runtime.inspectSelectedStorage(f.record))[0]!.record.seeded).toBe(true);
  }finally{await f.cleanup();}
 }
});
test('native selection never relabels or adopts an existing historical same-target Docker record',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.runtime.ensure(f.record,f.ack);
  const v=await f.managed.create('__agentor_admin__',f.record.id,'/home/agent/projects',undefined,'legacy-docker'),before=f.managed.get('__agentor_admin__',v.id);
  await expect(f.runtime.adoptSelections(f.record,[v.target],f.ack)).rejects.toThrow('Migrate the retained historical selection');
  expect(f.managed.get('__agentor_admin__',v.id)).toEqual(before);expect(f.record.nativeRuntime!.selectedVolumeIds).toBeUndefined();
  expect(f.events.filter(x=>x==='devices')).toEqual([]);
 }finally{await f.cleanup();}
});

test('explicitly rejected admin deletion releases only its unsubmitted cleanup intent and remains retryable',async()=>{
 const f=await fixture();try{
  await f.prepare();await f.runtime.ensure(f.record,f.ack);await f.runtime.stop(f.record,f.ack);
  const remove=f.client.deleteInstance;f.client.deleteInstance=async()=>{throw new IncusRequestRejected('rejected delete',409);};
  await expect(f.runtime.remove(f.record,f.ack)).rejects.toThrow('rejected delete');
  expect(f.record.nativeRuntime!.deleting).toBeUndefined();expect(f.record.nativeRuntime!.pending).toBeUndefined();
  expect(f.instance.status).toBe('Stopped');expect(f.events).not.toContain('volume-delete');
  await f.runtime.assertOwned(f.record);f.client.deleteInstance=remove;await f.runtime.remove(f.record,f.ack);
  expect(f.instance).toBeUndefined();expect(f.volumes.size).toBe(0);
 }finally{await f.cleanup();}
});

test('selected seeding journals retained-guest start and never stops or detaches after a lost start acknowledgement',async()=>{
 for(const accepted of [false,true]){
  const f=await fixture();try{
   await f.prepare();await f.runtime.ensure(f.record,f.ack);await f.runtime.adoptSelections(f.record,['/home/agent/projects'],f.ack);
   let starts=0;f.client.startInstance=async(_name:string,onAccepted:any)=>{starts++;if(accepted)await onAccepted('/1.0/operations/'+randomUUID());throw Error('lost retained start');};
   await expect(f.runtime.rebuild(f.record,f.ack)).rejects.toThrow();
   expect(f.record.nativeRuntime!.pending!.kind).toBe('start');expect(!!f.record.nativeRuntime!.pending!.operation).toBe(accepted);
   expect(f.record.nativeRuntime!.selectedOperation).toBeTruthy();
   const stops=f.events.filter(x=>x==='vm-stop').length,devices=f.events.filter(x=>x==='devices').length;
   f.client.request=async()=>({status:'Running',status_code:103});
   await expect(f.runtime.recoverSelectedStorage(f.record,f.ack)).rejects.toThrow();
   expect(f.events.filter(x=>x==='vm-stop')).toHaveLength(stops);expect(f.events.filter(x=>x==='devices')).toHaveLength(devices);
   expect(starts).toBe(1);expect(f.events).not.toContain('vm-delete');
  }finally{await f.cleanup();}
 }
});
