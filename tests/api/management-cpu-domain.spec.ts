import { test, expect } from '@playwright/test';
import { ManagementCpuDomain, managementCpuTools, type ManagementCpuAuthority } from '../../orchestrator/server/utils/management-cpu-domain';
import { ManagementWorkerDomain } from '../../orchestrator/server/utils/management-worker-domain';

function fixture() {
  const groups: any[] = [
    { id: 'parent', userId: 'owner', workerIds: ['member'], adminWorkspace: { id: 'admin-parent' } },
    { id: 'child', userId: 'owner', parentId: 'parent', workerIds: ['descendant'], adminWorkspace: { id: 'admin-child' } },
    { id: 'sibling', userId: 'owner', workerIds: ['outsider'], adminWorkspace: { id: 'admin-sibling' } },
  ];
  let settings: any = { vcpuCount: 2, maxVcpuCount: 8, pending: false, status: 'stopped' };
  let limit: number | null = 4;
  let locked = false, revoked = false;
  let afterLock = () => {}, beforeMutation = () => {};
  let mutationWait = async () => {};
  const writes: any[] = [];
  const mutate = async (id: string, count: number, authorize: () => void, reconcileOnly = false) => {
    await mutationWait(); beforeMutation(); authorize();
    if (reconcileOnly && !settings.pending) throw Object.assign(new Error('No pending CPU change'), { statusCode: 409 });
    if (settings.status === 'running') throw Object.assign(new Error('Stop the VM'), { statusCode: 409 });
    if (settings.pending && count !== settings.pendingVcpuCount) throw Object.assign(new Error('Reconcile recorded target'), { statusCode: 409 });
    writes.push({ id, count, reconcileOnly }); return { ...settings, vcpuCount: count, pending: false };
  };
  const store: any = { findById: (id: string) => groups.find(g => g.id === id), get: (owner: string, id: string) => groups.find(g => g.userId === owner && g.id === id), listForUser: (owner: string) => groups.filter(g => g.userId === owner) };
  const deps: any = {
    groups: () => store,
    workers: () => ({ findById: () => settings.pending ? { incusCpuResize: { targetCount: settings.pendingVcpuCount } } : {} }),
    manager: () => ({ get: (id: string) => ['member', 'descendant', 'outsider'].includes(id) ? { id, userId: 'owner' } : undefined, getVcpuSettings: async () => settings, setVcpuCount: mutate }),
    admin: () => ({ getRecord: () => ({ id: 'platform-admin' }), getCpuSettings: async () => settings, setCpuCount: (count: number, id: string, auth: () => void, reconcile: boolean) => mutate(id, count, auth, reconcile) }),
    groupAdmin: () => ({ getCpuSettings: async () => settings, setCpuCount: (_id: string, count: number, auth: () => void, workspaceId: string, reconcile: boolean) => mutate(workspaceId, count, auth, reconcile) }),
    locks: () => ({ verify: async (_id: string, password: unknown) => { if (locked && password !== 'unlock') throw Object.assign(new Error('Worker protected'), { statusCode: 403 }); afterLock(); } }),
    limit: () => limit,
  };
  const authority: ManagementCpuAuthority = { scope: 'group', ownerId: 'owner', groupId: 'parent', workspaceId: 'admin-parent', reauthorize: () => { if (revoked) throw Object.assign(new Error('Identity revoked'), { statusCode: 401 }); } };
  return { domain: new ManagementCpuDomain(deps), authority, groups, writes,
    settings: (value: any) => { settings = { ...settings, ...value }; }, limit: (value: number | null) => { limit = value; },
    mutationWait: (value: () => Promise<void>) => { mutationWait = value; },
    lock: () => { locked = true; }, revoke: () => { revoked = true; },
    afterLock: (value: () => void) => { afterLock = value; }, beforeMutation: (value: () => void) => { beforeMutation = value; },
  };
}

test('CPU schemas are strict, separate inspection from mutation, and expose descendant ceilings', () => {
  expect(managementCpuTools).toHaveLength(9);
  for (const t of managementCpuTools) {
    expect(t.inputSchema.additionalProperties).toBe(false);
    expect(t.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false, readOnlyHint: t.name.endsWith('.get') });
    if (t.name.startsWith('admin-workspace.')) {
      expect(t.inputSchema.properties).not.toHaveProperty('workerId'); expect(t.inputSchema.properties).not.toHaveProperty('groupId');
    }
    if (t.name.endsWith('.reconcile')) { expect(t.inputSchema.properties).not.toHaveProperty('vcpuCount'); expect(t.annotations.idempotentHint).toBe(true); }
  }
  for (const name of ['groups.create', 'groups.update']) expect((new ManagementWorkerDomain().tools().find(t => t.name === name)?.inputSchema as any).properties.maxVcpuCount).toMatchObject({ type: ['integer', 'null'], minimum: 1 });
});

test('group inspection permits members/self/descendants and denies siblings/platform targets', async () => {
  const f = fixture();
  for (const workerId of ['member', 'descendant']) expect((await f.domain.execute('workers.cpu.get', { workerId }, f.authority)).result).toMatchObject({ vcpuCount: 2 });
  for (const groupId of ['parent', 'child']) expect((await f.domain.execute('groups.admin-workspace.cpu.get', { groupId }, f.authority)).result).toMatchObject({ vcpuCount: 2 });
  expect((await f.domain.execute('admin-workspace.cpu.get', {}, f.authority)).result).toMatchObject({ vcpuCount: 2 });
  for (const workerId of ['outsider', 'platform-admin']) await expect(f.domain.execute('workers.cpu.get', { workerId }, f.authority)).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.domain.execute('groups.admin-workspace.cpu.get', { groupId: 'sibling' }, f.authority)).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.domain.execute('admin-workspace.cpu.get', { workerId: 'platform-admin' }, f.authority)).rejects.toMatchObject({ statusCode: 400 });
  expect(f.writes).toHaveLength(0);
});

test('platform and delegated self/descendant workspace writes derive exact protected targets', async () => {
  const f = fixture();
  await f.domain.execute('admin-workspace.cpu.set', { vcpuCount: 3 }, f.authority);
  await f.domain.execute('groups.admin-workspace.cpu.set', { groupId: 'child', vcpuCount: 3 }, f.authority);
  await f.domain.execute('admin-workspace.cpu.set', { vcpuCount: 3 }, { ...f.authority, scope: 'platform', workspaceId: 'platform-admin' });
  expect(f.writes).toEqual([
    { id: 'admin-parent', count: 3, reconcileOnly: false },
    { id: 'admin-child', count: 3, reconcileOnly: false },
    { id: 'platform-admin', count: 3, reconcileOnly: false },
  ]);
});

test('protection locks and running VM rejection reach every CPU mutation target', async () => {
  const f = fixture(); f.lock();
  for (const [name, args] of [['workers.cpu.set', { workerId: 'member', vcpuCount: 3 }], ['admin-workspace.cpu.set', { vcpuCount: 3 }], ['groups.admin-workspace.cpu.set', { groupId: 'child', vcpuCount: 3 }]] as const)
    await expect(f.domain.execute(name, args, f.authority)).rejects.toMatchObject({ statusCode: 403 });
  f.settings({ status: 'running' });
  await expect(f.domain.execute('workers.cpu.set', { workerId: 'member', vcpuCount: 3, lockPassword: 'unlock' }, f.authority)).rejects.toMatchObject({ statusCode: 409 });
  expect(f.writes).toHaveLength(0);
});

test('missing delegation denies group resizing; global authority may resize', async () => {
  const f = fixture(); f.limit(null);
  await f.domain.execute('workers.cpu.get', { workerId: 'member' }, f.authority);
  await expect(f.domain.execute('workers.cpu.set', { workerId: 'member', vcpuCount: 3 }, f.authority)).rejects.toMatchObject({ statusCode: 403 });
  await f.domain.execute('workers.cpu.set', { workerId: 'member', vcpuCount: 3 }, { ...f.authority, scope: 'platform', workspaceId: 'platform-admin' });
  expect(f.writes).toEqual([{ id: 'member', count: 3, reconcileOnly: false }]);
});

test('reconciliation observes the recorded target despite cap removal and no pending operation is a read', async () => {
  const f = fixture(); f.limit(null); f.settings({ pending: true, pendingVcpuCount: 6 });
  await f.domain.execute('workers.cpu.reconcile', { workerId: 'member' }, f.authority);
  await f.domain.execute('admin-workspace.cpu.reconcile', {}, f.authority);
  await f.domain.execute('groups.admin-workspace.cpu.reconcile', { groupId: 'child' }, f.authority);
  expect(f.writes).toEqual([
    { id: 'member', count: 6, reconcileOnly: true },
    { id: 'admin-parent', count: 6, reconcileOnly: true },
    { id: 'admin-child', count: 6, reconcileOnly: true },
  ]);
  f.settings({ pending: false }); await f.domain.execute('workers.cpu.reconcile', { workerId: 'member' }, f.authority);
  expect(f.writes).toHaveLength(3);
});

test('reconcile cannot allocate when its pending operation settles while queued', async () => {
  const f = fixture(); f.settings({ pending: true, pendingVcpuCount: 3 });
  f.beforeMutation(() => f.settings({ pending: false }));
  await expect(f.domain.execute('workers.cpu.reconcile', { workerId: 'member' }, f.authority)).rejects.toMatchObject({ statusCode: 409 });
  expect(f.writes).toHaveLength(0);
});

test('identity, membership, workspace binding and delegation are live after lock verification', async () => {
  for (const change of ['identity', 'membership', 'workspace', 'delegation']) {
    const f = fixture(); f.afterLock(() => {
      if (change === 'identity') f.revoke(); if (change === 'membership') f.groups[0].workerIds = [];
      if (change === 'workspace') f.groups[0].adminWorkspace.id = 'replacement'; if (change === 'delegation') f.limit(null);
    });
    const name = change === 'workspace' ? 'admin-workspace.cpu.set' : 'workers.cpu.set';
    await expect(f.domain.execute(name, change === 'workspace' ? { vcpuCount: 3 } : { workerId: 'member', vcpuCount: 3 }, f.authority)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(f.writes).toHaveLength(0);
  }
});

test('queued mutations reauthorize; malformed and owner-selecting CPU arguments fail before writes', async () => {
  const f = fixture(); f.beforeMutation(() => { f.groups[0].workerIds = []; });
  await expect(f.domain.execute('workers.cpu.set', { workerId: 'member', vcpuCount: 3 }, f.authority)).rejects.toMatchObject({ statusCode: 404 });
  for (const args of [{ workerId: 'member', vcpuCount: '3' }, { workerId: 'member', vcpuCount: 0 }, { workerId: 'member', vcpuCount: 3, ownerId: 'other' }]) await expect(f.domain.execute('workers.cpu.set', args, f.authority)).rejects.toMatchObject({ statusCode: 400 });
  expect(f.writes).toHaveLength(0);
});


test('caller timeout keeps one accepted mutation serialized and never retries resize', async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.mutationWait(() => gate);
  await expect(f.domain.execute('workers.cpu.set', { workerId: 'member', vcpuCount: 3, timeoutSeconds: 1 }, f.authority))
    .rejects.toMatchObject({ statusCode: 504 });
  expect(f.writes).toHaveLength(0);
  release();
  await expect.poll(() => f.writes.length).toBe(1);
  await f.domain.execute('workers.cpu.reconcile', { workerId: 'member' }, f.authority);
  expect(f.writes).toEqual([{ id: 'member', count: 3, reconcileOnly: false }]);
});
