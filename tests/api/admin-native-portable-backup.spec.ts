import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const tar = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('tar-stream');
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import { administrativeNativeOverlaySha256 } from '../../orchestrator/server/utils/incus-admin-overlay';
import { adminNativeInstanceName } from '../../orchestrator/server/utils/admin-native-identity';
import { assertAdministrativeBackupPrincipal, resolveAdministrativeBackup, withAdministrativeBackupIdentity } from '../../orchestrator/server/utils/admin-backup-authority';
import { exportAdministrativeWorkspaceBundle, openAdministrativeSelectedArchive } from '../../orchestrator/server/utils/admin-portable-backup';
import { useConfig, useEnvironmentStore, useContainerManager, useWorkerStore, useAdministrativeWorkspaceRuntime, useWorkerGroupStore } from '../../orchestrator/server/utils/services';
import { useAdminWorkspaceStore } from '../../orchestrator/server/utils/admin-workspace-store';
import { BackupManager } from '../../orchestrator/server/utils/backup-manager';
import { extractBundle, BUNDLE_FILES } from '../../orchestrator/server/utils/worker-export';
import { IncusAdminBackup } from '../../orchestrator/server/utils/incus-admin-backup';
import { getAuthDb, migrateAuth } from '../../orchestrator/server/utils/auth';

(globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
const stamp = new Date(0).toISOString();
function record(group = false, running = false): AdministrativeWorkspaceRecord {
  const r: AdministrativeWorkspaceRecord = { schemaVersion: 1, id: randomUUID(), trusted: true,
    kind: group ? 'group-administrative' : 'administrative', ownerId: 'human-owner', ...(group ? { groupId: 'group-1' } : {}),
    status: running ? 'running' : 'stopped', runtimeKind: 'incus-vm', createdAt: stamp, updatedAt: stamp, startupScript: 'echo retained' };
  r.nativeRuntime = { version: 1, name: adminNativeInstanceName(r), installationId: randomUUID(), nonce: randomUUID(), incarnation: randomUUID(),
    overlayVersion: '6', overlaySha256: administrativeNativeOverlaySha256(r), storageReady: true, storageInitialized: true,
    image: { version: 1, fingerprint: 'a'.repeat(64), sourceImageId: 'sha256:'+'b'.repeat(64), recipeId: 'c'.repeat(64),
      architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3' } };
  return r;
}
async function raw(root: string) {
  const pack = tar.pack(), chunks: Buffer[] = []; pack.on('data', (chunk: Buffer) => chunks.push(chunk));
  const completed = new Promise<Buffer>((resolve, reject) => { pack.on('end', () => resolve(Buffer.concat(chunks))); pack.on('error', reject); });
  pack.entry({ name: root+'/', type: 'directory', mode: 0o755, uid: 1000, gid: 1000 });
  pack.entry({ name: root+'/retained', mode: 0o640, uid: 1000, gid: 1000 }, 'exact retained data'); pack.finalize(); return completed;
}
for (const group of [false, true]) test(`${group ? 'group' : 'global'} account authorization is independent of runtime namespace`, () => {
  const r = record(group);
  expect(() => assertAdministrativeBackupPrincipal('human-owner', r, !group)).not.toThrow();
  expect(() => assertAdministrativeBackupPrincipal('other-account', r, true)).toThrow('Workspace not found');
  if (!group) {
    expect(() => assertAdministrativeBackupPrincipal('human-owner', r, false)).toThrow();
    delete r.ownerId;
    expect(() => assertAdministrativeBackupPrincipal('new-admin', r, true)).not.toThrow();
    expect(() => assertAdministrativeBackupPrincipal('__agentor_admin__', r, false)).toThrow();
  }
});

for (const running of [false, true]) test(`${running ? 'running' : 'stopped'} dedicated canonical bundle includes opted-in attached managed data without ordinary worker authority`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-portable-fixture-')), r = record(false, running);
  const environment = useEnvironmentStore(), originalEnvironment = environment.getById;
  environment.getById = () => ({ id: randomUUID(), name: 'Default', cpuLimit: 2, memoryLimit: '4g', networkMode: 'full', allowedDomains: [],
    includePackageManagerDomains: false, dockerEnabled: false, envVars: 'NEVER_EXPORT=value', setupScript: '', exposeApis: {},
    enabledCapabilityIds: null, enabledInstructionIds: null, builtIn: true, userId: null, createdAt: stamp, updatedAt: stamp }) as any;
  try {
    let checks = 0, offline = 0, live = 0, selected = 0;
    const state: any = { name: r.nativeRuntime!.name, status: running ? 'Running' : 'Stopped', devices: {
      workspace: { type: 'disk', path: '/workspace' }, agents: { type: 'disk', path: '/home/agent/.agent-data' }, managed: { type: 'disk', path: '/opt/data' },
    } };
    const managed = { record: { id: randomUUID(), target: '/opt/data', name: 'Persistent data', attached: true, seeded: true }, volume: { name: 'private', used_by: ['owned'] } };
    const pending = { id: randomUUID(), target: '/opt/pending', name: 'Pending data', attached: true, seeded: false };
    const runtime: any = { validateAuthority: async () => {}, assertOwned: async () => structuredClone(state), storage: { selectedRecords: async () => [managed.record, pending], inspectSelectedVolume: async (r: any, value: any) => { expect(value.id).toBe(managed.record.id); return managed.volume; } },
      client: { exec: async () => ({ returnCode: 0, stdout: 'aaaaaaaa-1111-1111-1111-111111111111\n' }), execStream: async (_name: string, command: string[]) => {
        live++; expect(command[5]).toBeUndefined();
        const isManaged = command[3] === '/opt/data';
        if (isManaged) expect(JSON.parse(command[4]!)).toMatchObject({ wrapper: 'volume', credentials: false });
        return { stdin: new PassThrough(), stdout: Readable.from([await raw(command[3] === '/opt/data' ? 'volume' : command[3] === 'workspace' ? 'workspace' : '.agent-data')]),
          stderr: Readable.from([]), result: Promise.resolve(0), close() {} };
      } } };
    const backup: any = { capture: async (_record: any, outputs: any, options: any) => {
      offline++; expect(options.exclusions).toEqual(['/opt/data']);
      for (const [role, path] of Object.entries(outputs)) await writeFile(path as string, gzipSync(await raw(role === 'workspace' ? 'workspace' : '.agent-data')));
    }, capturePortableSelected: async (_record: any, id: string, path: string, _signal: any, options: any) => {
      selected++; expect(id).toBe(managed.record.id); expect(options).toBeUndefined();
      await writeFile(path, gzipSync(await raw('volume')));
    } };
    const destination = join(directory, 'portable.tar');
    await exportAdministrativeWorkspaceBundle({ ...useConfig(), dataDir: directory }, runtime, r, destination, new AbortController().signal,
      async () => { checks++; }, { includeWorkspace: true, includeAgents: true, includeManagedVolumes: true }, backup);
    const bundle = await extractBundle(destination, join(directory, 'verified'));
    expect(bundle.manifest.source.id).toBe(r.id); expect(bundle.manifest.runtime!.kind).toBe('incus-vm');
    expect(bundle.manifest.environment.envVars).toBe(''); expect(JSON.stringify(bundle.manifest)).not.toContain(r.nativeRuntime!.incarnation);
    expect(bundle.manifest.managedVolumes).toEqual([{ target: '/opt/data', name: 'Persistent data', archive: 'volumes/0.tar' }]);
    expect(bundle.manifest.localPersistence).toEqual([{ path: '/opt/data', included: true }, { path: '/opt/pending', included: false }]);
    expect(bundle.manifest.contents).toMatchObject({ rootfs: false, workspace: true, agents: true, managedVolumes: true });
    expect(bundle.managedVolumesPath).toBeTruthy(); expect(checks).toBeGreaterThan(3);
    expect({ offline, live, selected }).toEqual({ offline: running ? 0 : 1, live: running ? 3 : 0, selected: running ? 0 : 1 });
  } finally { environment.getById = originalEnvironment; await rm(directory, { recursive: true, force: true }); }
});

test('revoked account after canonical capture prevents any portable artifact publication', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-portable-revoke-')), r = record(); let revoked = false;
  const runtime: any = { validateAuthority: async () => {}, assertOwned: async () => ({ status: 'Stopped' }), storage: { selectedRecords: async () => [] } };
  const destination = join(directory, 'portable.tar');
  try {
    await expect(exportAdministrativeWorkspaceBundle({ ...useConfig(), dataDir: directory }, runtime, r, destination, new AbortController().signal,
      async () => { if (revoked) throw Error('role revoked'); }, { includeWorkspace: true, includeAgents: false, includeManagedVolumes: false },
      { capture: async () => { revoked = true; } } as any)).rejects.toThrow('role revoked');
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const drift of ['role', 'boot', 'layout', 'exit'] as const) test(`selected path ${drift} change refuses stream completion`, async () => {
  const r = record(false, true); let changed = false, closed = 0;
  const before: any = { name: r.nativeRuntime!.name, status: 'Running', devices: { workspace: { type: 'disk', path: '/workspace' } } };
  const runtime: any = { assertOwned: async () => ({ ...before, ...(changed && drift === 'layout' ? { status: 'Stopped' } : {}) }), client: {
    exec: async () => ({ returnCode: 0, stdout: (changed && drift === 'boot' ? 'b' : 'a').repeat(8)+'-1111-1111-1111-111111111111\n' }),
    execStream: async (_name: string, command: string[]) => {
      expect(JSON.parse(command[4]!)).toEqual({ mounts: ['/workspace'], credentials: false });
      return { stdin: new PassThrough(), stdout: Readable.from([await raw('project')]), stderr: Readable.from([]),
        result: Promise.resolve().then(() => { changed = true; return drift === 'exit' ? 7 : 0; }), close() { closed++; } };
    } } };
  const stream = await openAdministrativeSelectedArchive(runtime, r, '/workspace/project', async () => { if (changed && drift === 'role') throw Error('role revoked'); });
  await expect((async () => { for await (const _ of stream) {} })()).rejects.toThrow();
  expect(closed).toBe(1);
});

test('daily selected global admin remains account-owned and queues after native namespace change; revocation is rechecked', async () => {
  const dataDir = process.env.DATA_DIR!; expect(dataDir).toMatch(/^\/tmp\/agentor-incus-acceptance-/);
  const adminPath = join(dataDir, 'admin', 'workspace.v1.json'), prior = await readFile(adminPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  const r = record(); r.id = '8b5c936e-a859-4039-873a-6f7af0960b61'; r.ownerId = randomUUID();
  r.nativeRuntime!.name = adminNativeInstanceName(r); r.nativeRuntime!.overlaySha256 = administrativeNativeOverlaySha256(r);
  const manager = new BackupManager(), cm = useContainerManager(), originalGet = cm.get, originalList = cm.list;
  const global = useAdminWorkspaceStore() as any, saved = { record: global.record, loading: global.loading, unavailable: global.unavailable };
  const ids = ['updater', 'gpu', 'metod', 'retired-jmicron'], ordinary = ids.map(id => ({ id, userId: r.ownerId!, status: 'stopped', displayName: id }));
  cm.get = id => ordinary.find(item => item.id === id) as any; cm.list = () => ordinary as any;
  (manager as any).triggerScheduleTick = async () => {};
  let queued = 0; (manager as any).enqueue = () => { queued++; };
  try {
    await mkdir(join(dataDir, 'admin'), { recursive: true }); await writeFile(adminPath, JSON.stringify(r));
    Object.assign(global, { record: undefined, loading: undefined, unavailable: false }); await global.init();
    await migrateAuth(); const db = getAuthDb();
    db.prepare('INSERT INTO user (id,name,email,emailVerified,createdAt,updatedAt,role) VALUES (?,?,?,?,?,?,?)')
      .run(r.ownerId, 'Fixture', r.ownerId+'@invalid.test', 0, Date.now(), Date.now(), 'admin');
    const selected = [r.id, ...ids]; const paths = { gpu: ['/workspace'], metod: ['/home/agent/.local/share'] };
    await manager.setConfig(r.ownerId!, { provider: 'google-drive', enabled: true, intervalMinutes: 1440, selectedWorkspaceIds: selected,
      selectedPathsByWorkspace: paths, persistSelectedDirectories: false });
    await (manager as any).store.update(r.ownerId, (data: any) => { data.config.nextRunAt = new Date(0).toISOString(); });
    await (manager as any).tickSchedules(); expect(queued).toBe(1);
    const jobs = (manager as any).store.get(r.ownerId).jobs;
    expect(jobs[0]).toMatchObject({ userId: r.ownerId, ownerId: r.ownerId, workspaceIds: selected, selectedPathsByWorkspace: paths, provider: 'google-drive' });
    expect(jobs[0].selectedPathsByWorkspace[r.id]).toBeUndefined();
    expect((await manager.listWorkspaces(r.ownerId!)).find(item => item.id === r.id)).toMatchObject({ administrativeKind: 'platform', status: 'stopped' });
    const native = useAdministrativeWorkspaceRuntime().native, env = useEnvironmentStore(), workerStore = useWorkerStore();
    const originals = { assertOwned: native.assertOwned, validateAuthority: native.validateAuthority, selectedRecords: native.storage.selectedRecords,
      capture: IncusAdminBackup.prototype.capture, getEnvironment: env.getById, findWorker: workerStore.findById };
    const destination = join(dataDir, 'tmp', 'daily-global-fixture.tar');
    try {
      native.assertOwned = async () => ({ status: 'Stopped' }) as any; native.validateAuthority = async () => r;
      native.storage.selectedRecords = async () => [];
      workerStore.findById = id => { if (id === r.id) throw Error('Ordinary shadow cannot authorize admin backup'); return originals.findWorker.call(workerStore, id); };
      cm.get = id => { if (id === r.id) throw Error('Live projection cannot authorize admin backup'); return originalGet.call(cm, id); };
      env.getById = () => ({ id: randomUUID(), name: 'Default', cpuLimit: 2, memoryLimit: '4g', networkMode: 'full', allowedDomains: [],
        includePackageManagerDomains: false, dockerEnabled: false, envVars: '', setupScript: '', exposeApis: {},
        enabledCapabilityIds: null, enabledInstructionIds: null, builtIn: true, userId: null, createdAt: stamp, updatedAt: stamp }) as any;
      IncusAdminBackup.prototype.capture = async (_record, outputs) => {
        for (const [role, path] of Object.entries(outputs)) await writeFile(path, gzipSync(await raw(role === 'workspace' ? 'workspace' : '.agent-data')));
        return {} as any;
      };
      await (manager as any).exportWorkspaceBundle(r.ownerId, r.id, destination, new AbortController().signal);
      const exported = await extractBundle(destination, join(dataDir, 'tmp', 'daily-global-verified'));
      expect(exported.manifest.source.id).toBe(r.id); expect(exported.manifest.contents).toMatchObject({ workspace: true, agents: true });
    } finally {
      native.assertOwned = originals.assertOwned; native.validateAuthority = originals.validateAuthority; native.storage.selectedRecords = originals.selectedRecords;
      IncusAdminBackup.prototype.capture = originals.capture; env.getById = originals.getEnvironment; workerStore.findById = originals.findWorker;
      await rm(destination, { force: true }); await rm(join(dataDir, 'tmp', 'daily-global-verified'), { recursive: true, force: true });
    }
    db.prepare('UPDATE user SET role=? WHERE id=?').run('user', r.ownerId);
    await expect(resolveAdministrativeBackup(r.ownerId!, r.id)).rejects.toThrow('Workspace not found');
    expect((await manager.listWorkspaces(r.ownerId!)).some(item => item.id === r.id)).toBe(false);
    await expect(manager.createMany(r.ownerId!, [r.id])).rejects.toThrow('Workspace not found');
  } finally {
    cm.get = originalGet; cm.list = originalList; Object.assign(global, saved);
    if (prior) await writeFile(adminPath, prior); else await unlink(adminPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if ((manager as any).scheduleTimer) clearInterval((manager as any).scheduleTimer);
    getAuthDb().prepare('DELETE FROM user WHERE id=?').run(r.ownerId);
    await (manager as any).store.forget(r.ownerId);
  }
});


test('fresh dedicated group owner binding denies foreign accounts and quarantines malformed authority without adopting a shadow', async () => {
  const groups = useWorkerGroupStore(), owner = randomUUID(), group = await groups.create(owner, 'Portable group fixture');
  const r = record(true); r.ownerId = owner; (r as any).groupId = group.id;
  r.nativeRuntime!.overlaySha256 = administrativeNativeOverlaySha256(r);
  const path = join(useConfig().dataDir, 'users', owner, 'worker-groups.json');
  try {
    await groups.update(owner, group.id, { adminWorkspace: r });
    expect(await resolveAdministrativeBackup(owner, r.id)).toEqual(r);
    const duplicate = await groups.create(owner, 'Ambiguous fixture');
    try {
      await groups.update(owner, duplicate.id, { adminWorkspace: { ...r, groupId: duplicate.id } });
      await expect(resolveAdministrativeBackup(owner, r.id)).rejects.toMatchObject({ statusCode: 409 });
    } finally { await groups.remove(owner, duplicate.id); }
    await expect(resolveAdministrativeBackup('other-account', r.id)).rejects.toThrow('Workspace not found');
    const bytes = await readFile(path);
    const malformed = JSON.parse(bytes.toString()); malformed[0].adminWorkspace.ownerId = 'other-account';
    await writeFile(path, JSON.stringify(malformed));
    await expect(resolveAdministrativeBackup(owner, r.id)).rejects.toMatchObject({ statusCode: 503 });
    expect(await readFile(path)).not.toEqual(bytes);
    await writeFile(path, bytes);
    expect(await resolveAdministrativeBackup(owner, r.id)).toEqual(r);
  } finally { await groups.remove(owner, group.id); }
});


test('long held capture renews identity without lifecycle changes, drains before release and aborts on revocation', async () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick!: () => void, clears = 0, renewals = 0, validations = 0, revoked = false;
  const handle: any = { unref() {} };
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return handle; }) as any;
  globalThis.clearInterval = ((value: any) => { expect(value).toBe(handle); clears++; }) as any;
  let releaseRenewal!: () => void, captureSignal!: AbortSignal;
  try {
    const operation = withAdministrativeBackupIdentity(new AbortController().signal,
      async () => { validations++; if (revoked) throw Error('role revoked'); },
      async () => { if (++renewals === 2) await new Promise<void>(resolve => { releaseRenewal = resolve; }); },
      async signal => { captureSignal = signal; await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); });
    await expect.poll(() => Boolean(tick)).toBe(true);
    tick(); await expect.poll(() => renewals).toBe(2);
    tick(); expect(renewals).toBe(2); // No duplicate issuance while the callback is pending.
    revoked = true; releaseRenewal();
    await expect(operation).rejects.toThrow('role revoked');
    expect(captureSignal.aborted).toBe(true); expect(clears).toBe(1); expect(validations).toBeGreaterThanOrEqual(3);
  } finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
});


test('successful long capture clears its timer and waits for the in-flight identity write before returning', async () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let tick!: () => void, cleared = false, count = 0, finishCapture!: () => void, finishRefresh!: () => void;
  const handle: any = { unref() {} };
  globalThis.setInterval = ((callback: () => void) => { tick = callback; return handle; }) as any;
  globalThis.clearInterval = (() => { cleared = true; }) as any;
  try {
    let returned = false;
    const operation = withAdministrativeBackupIdentity(new AbortController().signal, async () => {}, async () => {
      if (++count === 2) await new Promise<void>(resolve => { finishRefresh = resolve; });
    }, async () => { await new Promise<void>(resolve => { finishCapture = resolve; }); return 'complete'; });
    void operation.then(() => { returned = true; });
    await expect.poll(() => Boolean(finishCapture)).toBe(true); tick(); await expect.poll(() => count).toBe(2);
    finishCapture(); await expect.poll(() => cleared).toBe(true); expect(returned).toBe(false);
    finishRefresh(); await expect(operation).resolves.toBe('complete'); tick(); await Promise.resolve(); expect(count).toBe(2);
  } finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
});


test('pending administrative selections remain explicit-path data and never become canonical managed payloads before rebuild', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-portable-pending-')), r = record(false, true);
  const environment = useEnvironmentStore(), original = environment.getById;
  environment.getById = () => ({ id: randomUUID(), name: 'Default', cpuLimit: 2, memoryLimit: '4g', networkMode: 'full', allowedDomains: [],
    includePackageManagerDomains: false, dockerEnabled: false, envVars: '', setupScript: '', exposeApis: {},
    enabledCapabilityIds: null, enabledInstructionIds: null, builtIn: true, userId: null, createdAt: stamp, updatedAt: stamp }) as any;
  let physicalReads = 0;
  const pending = { id: randomUUID(), target: '/opt/new', name: 'Pending selection', attached: true, seeded: false, state: 'pending' };
  const runtime: any = { validateAuthority: async () => {}, assertOwned: async () => ({ status: 'Running' }),
    storage: { selectedRecords: async () => [pending], inspectSelectedVolume: async () => { physicalReads++; throw Error('Provisional volume must not be read'); } } };
  try {
    const destination = join(directory, 'bundle.tar');
    await exportAdministrativeWorkspaceBundle({ ...useConfig(), dataDir: directory }, runtime, r, destination, new AbortController().signal, async () => {},
      { includeWorkspace: false, includeAgents: false, includeManagedVolumes: true });
    const bundle = await extractBundle(destination, join(directory, 'verified'));
    expect(bundle.manifest.managedVolumes).toEqual([]); expect(bundle.manifest.localPersistence).toEqual([{ path: '/opt/new', included: false }]);
    expect(physicalReads).toBe(0);
    // A native parent selection excludes nested mounts; it must not promise
    // complete managed coverage merely from a lexical path prefix.
    await (new BackupManager({ dataDir: directory }) as any).appendExplicitBackupPaths(destination, '', ['/opt'], new AbortController().signal,
      undefined, async () => Readable.from([await raw('opt')]));
    const repacked = await extractBundle(destination, join(directory, 'repacked'));
    expect(repacked.manifest.localPersistence).toEqual([{ path: '/opt/new', included: false }]);
  } finally { environment.getById = original; await rm(directory, { recursive: true, force: true }); }
});
