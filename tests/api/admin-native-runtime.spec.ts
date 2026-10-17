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
import { INCUS_GUEST_READINESS_SCRIPT } from '../../orchestrator/server/utils/incus-worker-runtime';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'admin-vm-core-')), installation = randomUUID(), incarnation = randomUUID();
    await writeFile(join(directory, 'backup-installation-id'), installation);
    const stamp = new Date(0).toISOString();
    let record: AdministrativeWorkspaceRecord = { schemaVersion: 1, id: randomUUID(), kind: 'administrative', trusted: true, runtimeKind: 'incus-vm', status: 'running', createdAt: stamp, updatedAt: stamp };
    const image = { version: 1 as const, sourceImageId: 'sha256:' + '1'.repeat(64), recipeId: '2'.repeat(64), architecture: 'amd64' as const, converterVersion: 'v0.4.0', bootstrapGeneration: '3' as const, fingerprint: '3'.repeat(64) };
    const config: any = { incusEnabled: true, dataDir: directory, incusProject: 'agentor', incusStoragePool: 'pool', incusWorkerImage: 'approved', incusEndpoint: 'https://invalid.example' };
    const events: string[] = [], files = new Map<string, string>(), volumes = new Map<string, any>();
    let instance: any, failCredential = false, unknownStart = false;
    const boundary: any = { boundary: async () => { events.push('network'); return { network: 'aa123', managementAddress: '10.88.0.2', gatewayUrl: 'http://10.88.0.2:3000', mcpUrl: 'http://10.88.0.2:3099/mcp', guestAddress: '10.88.0.3' }; }, device: () => ({ type: 'nic', network: 'aa123', name: 'eth0', hwaddr: '02:00:00:00:00:01', 'ipv4.address': '10.88.0.3', 'security.mac_filtering': 'true', 'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' }) };
    const client: any = { endpoint: 'https://invalid.example', project: 'agentor',
        getCustomVolume: async (_pool: string, name: string) => { if (!volumes.has(name))
            throw Object.assign(Error('absent'), { statusCode: 404 }); return structuredClone(volumes.get(name)); },
        createCustomVolume: async (_pool: string, v: any) => { events.push('volume-create'); volumes.set(v.name, { ...structuredClone(v), type: 'custom', used_by: [] }); },
        getInstance: async () => { if (!instance)
            throw Object.assign(Error('absent'), { statusCode: 404 }); return structuredClone(instance); },
        createInstance: async (spec: any, accepted: any) => { events.push('vm-create'); await accepted('/1.0/operations/' + randomUUID()); instance = { ...structuredClone(spec), status: 'Stopped', config: { ...spec.config, 'volatile.uuid': randomUUID(), 'volatile.base_image': image.fingerprint } }; return structuredClone(instance); },
        startInstance: async (_name: string, accepted: any) => { events.push('vm-start'); await accepted('/1.0/operations/' + randomUUID()); if (unknownStart)
            throw Error('transport'); instance.status = 'Running'; },
        stopInstance: async (_name: string, _options: any, accepted: any) => { events.push('vm-stop'); await accepted('/1.0/operations/' + randomUUID()); instance.status = 'Stopped'; },
        deleteInstance: async (_name: string, accepted: any) => { events.push('vm-delete'); await accepted('/1.0/operations/' + randomUUID()); instance = undefined; },
        getImage: async () => ({ type: 'virtual-machine', fingerprint: image.fingerprint, properties: { source_image_id: image.sourceImageId, recipe_id: image.recipeId, source_architecture: 'amd64', converter_version: 'v0.4.0', bootstrap_generation: '3' } }),
        pushFile: async (_name: string, path: string, content: string) => { events.push('file:' + path); files.set(path, content); },
        exec: async (_name: string, command: string[]) => { if (command.includes('start'))
            events.push('service-start'); return { returnCode: 0, stdout: command.includes(INCUS_GUEST_READINESS_SCRIPT) ? randomUUID() + ' 1 1\n' : '', stderr: '' }; },
        execStream: async (_name: string, command: string[]) => { const credential = command[2]!.includes("b'mcp1.'"); events.push(credential ? 'credential-write' : 'control-write'); return { stdout: { resume() { } }, stderr: { resume() { } }, stdin: { end(value: string) { if (credential)
                    expect(value).toBe('mcp1.' + 'a'.repeat(43));
                else
                    expect(Object.keys(JSON.parse(value)).sort()).toEqual(['README.md', 'image-definitions.json', 'runtime.json']); } }, result: Promise.resolve(failCredential ? 1 : 0), close() { } }; },
    };
    const runtime = new IncusAdminWorkspaceRuntime(config, client, boundary, { readRecord: async () => structuredClone(record), resolveImage: async () => { events.push('image'); return image; }, register: () => events.push('register') });
    runtime.setManagementListener(async () => { events.push('listener'); });
    const ack = async (patch: any) => { events.push('ack' + (patch.nativeRuntime?.pending ? ':' + patch.nativeRuntime.pending.kind : '')); applyAdminNativePatch(record, patch); };
    const prepare = () => runtime.prepareCredential(structuredClone(record), async () => { events.push('credential-issue'); return 'mcp1.' + 'a'.repeat(43); });
    return { runtime, client, config, boundary, events, files, volumes, image, ack, prepare, get record() { return record; }, get instance() { return instance; }, set failCredential(v: boolean) { failCredential = v; }, set unknownStart(v: boolean) { unknownStart = v; }, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
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

test('group VM trusted role and generated routing override historical owner environment',async()=>{
 const f=await fixture();try{f.record.kind='group-administrative';(f.record as any).groupId=randomUUID();f.record.ownerId='group-owner';
 (f.runtime as any).dependencies.ownerEnvironment=()=>({userId:'group-owner',createdAt:'',updatedAt:'',envVars:[{key:'AGENTOR_RUNTIME_ROLE',value:'platform-admin'},{key:'AGENTOR_TRUSTED_RUNTIME_ROLE',value:'platform-admin'},{key:'AGENTOR_MANAGEMENT_MCP_URL',value:'http://foreign'},{key:'SAFE_SETTING',value:'preserved'}]});
 await f.prepare();await f.runtime.ensure(f.record,f.ack);const env=f.files.get('/run/agentor/worker.env')!;
 expect(env).toContain("AGENTOR_RUNTIME_ROLE='group-admin'");expect(env).not.toContain("AGENTOR_TRUSTED_RUNTIME_ROLE=");expect(env).not.toContain('foreign');expect(env).toContain("SAFE_SETTING='preserved'");expect(f.instance.config['user.agentor.owner']).toBe('group-owner');expect(f.instance.config['user.agentor.admin-group']).toBe((f.record as any).groupId);
 }finally{await f.cleanup();}
});
test('explicit rebuild settles acknowledged start against captured incarnation and preserves canonical volumes',async()=>{
 const f=await fixture();try{f.unknownStart=true;await f.prepare();await expect(f.runtime.ensure(f.record,f.ack)).rejects.toThrow('transport');const old=f.record.nativeRuntime!.incarnation;
 f.unknownStart=false;f.instance.status='Running';f.client.request=async()=>({status:'Success',status_code:200});f.events.length=0;await f.prepare();await f.runtime.rebuild(f.record,f.ack);
 expect(f.events).toContain('vm-stop');expect(f.events).toContain('vm-delete');expect(f.events).toContain('vm-create');expect(f.events).not.toContain('volume-create');expect(f.record.nativeRuntime!.incarnation).not.toBe(old);expect(f.record.nativeRuntime!.pending).toBeUndefined();expect(f.volumes.size).toBe(2);
 }finally{await f.cleanup();}
});
test('unacknowledged or still-running native operation cannot be guessed complete from VM state',async()=>{
 const f=await fixture();try{f.unknownStart=true;await f.prepare();await expect(f.runtime.ensure(f.record,f.ack)).rejects.toThrow('transport');f.client.request=async()=>({status:'Running',status_code:103});const pending=structuredClone(f.record.nativeRuntime!.pending);f.events.length=0;
 await expect(f.runtime.rebuild(f.record,f.ack)).rejects.toThrow('not acknowledged');expect(f.events).toEqual([]);expect(f.record.nativeRuntime!.pending).toEqual(pending);
 f.record.nativeRuntime!.pending!.operation=undefined;await expect(f.runtime.rebuild(f.record,f.ack)).rejects.toThrow('operator recovery');expect(f.events).toEqual([]);
 }finally{await f.cleanup();}
});

test('fresh-root initialization rejects populated or symlinked canonical data before metadata mutation',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'admin-root-init-'));try{const workspace=join(directory,'workspace'),agents=join(directory,'agents');await mkdir(workspace);await mkdir(agents);await writeFile(join(agents,'retained'),'unchanged');
 const script=ADMIN_NATIVE_INITIALIZE_ROOTS.replace("roots=['/workspace','/home/agent/.agent-data']",'roots='+JSON.stringify([workspace,agents]));
 const result=spawnSync('python3',['-c',script],{encoding:'utf8',timeout:5000});expect(result.status).not.toBe(0);expect(await readFile(join(agents,'retained'),'utf8')).toBe('unchanged');
 const outside=join(directory,'outside');await mkdir(outside);await writeFile(join(outside,'retained'),'outside');await rm(agents,{recursive:true});await symlink(outside,agents);const symlinkResult=spawnSync('python3',['-c',script],{encoding:'utf8',timeout:5000});expect(symlinkResult.status).not.toBe(0);expect(await readFile(join(outside,'retained'),'utf8')).toBe('outside');
 }finally{await rm(directory,{recursive:true,force:true});}
});
