import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, link, symlink, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { historicalDockerAdmin, HISTORICAL_ADMIN_VOLUMES, INSPECT_ADMIN_VOLUME } from '../helpers/instance-docker-admin';
function fixture() {
  const record = { schemaVersion: 1, trusted: true, kind: 'administrative', id: '11111111-1111-4111-8111-111111111111', status: 'running' };
  const admin = { id: record.id, userId: '__agentor_admin__', administrativeKind: 'platform', runtimeKind: 'legacy-docker',
    containerId: 'a'.repeat(64), containerName: 'agentor-admin-workspace', status: 'running' };
  const info = { Id: admin.containerId, Name: '/agentor-admin-workspace', State: { Running: true },
    Config: { Labels: { 'agentor.administrative': 'true', 'agentor.admin.workspace-id': record.id, 'agentor.managed': 'false' } },
    Mounts: HISTORICAL_ADMIN_VOLUMES.map((Name, i) => ({ Name, Type: 'volume', Destination: i ? '/home/agent/.agent-data' : '/workspace', RW: true })) };
  return { record, admin, info };
}
test('fresh ordinary account admits only its exact dedicated historical platform admin', () => {
  const f = fixture(); expect(historicalDockerAdmin([f.admin], f.record, f.info).id).toBe(f.record.id);
  f.record.status = 'stopped'; f.admin.status = 'stopped'; f.info.State.Running = false;
  expect(() => historicalDockerAdmin([f.admin], f.record, f.info)).not.toThrow();
  expect(() => historicalDockerAdmin([], f.record, f.info)).toThrow('only its existing platform admin');
  expect(() => historicalDockerAdmin([f.admin, { id: 'ordinary' }], f.record, f.info)).toThrow('no ordinary workers');
});
test('ordinary shadows, native defaults and foreign admin authority cannot be treated as this Docker fixture', () => {
  const f = fixture();
  for (const record of [{ ...f.record, trusted: false }, { ...f.record, kind: 'group-administrative' },
    { ...f.record, runtimeKind: 'incus-vm' }, { ...f.record, nativeRuntime: {} }, { ...f.record, ownerId: [] }, { ...f.record, runtimeKind: null }])
    expect(() => historicalDockerAdmin([f.admin], record, f.info)).toThrow('historical Docker gate');
  for (const admin of [{ ...f.admin, administrativeKind: undefined }, { ...f.admin, userId: 'foreign' },
    { ...f.admin, id: '22222222-2222-4222-8222-222222222222' }, { ...f.admin, containerId: 'b'.repeat(64) }])
    expect(() => historicalDockerAdmin([admin], f.record, f.info)).toThrow();
});
test('exact admin Docker labels and both canonical named-volume mounts are mandatory', () => {
  const f = fixture();
  for (const change of [(v: any) => v.Config.Labels['agentor.administrative'] = 'false',
    (v: any) => v.Config.Labels['agentor.admin.workspace-id'] = 'foreign',
    (v: any) => v.State.Running = false, (v: any) => v.Mounts.pop(),
    (v: any) => v.Mounts[0].Name = 'foreign-volume', (v: any) => v.Mounts[1].Type = 'bind',
    (v: any) => v.Mounts.push(v.Mounts[0])]) {
    const info = structuredClone(f.info); change(info); expect(() => historicalDockerAdmin([f.admin], f.record, info)).toThrow();
  }
});
test('actual admin-volume snapshot includes pre-existing nested data, exact links and detects metadata/content changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'instance-admin-snapshot-'));
  const inspect = () => JSON.parse(execFileSync('python3', ['-c', INSPECT_ADMIN_VOLUME, root], { encoding: 'utf8', stdio: 'pipe' }));
  try {
    await mkdir(join(root, 'pre-existing')); await writeFile(join(root, 'pre-existing', 'control'), 'existing control data');
    await writeFile(join(root, 'data'), Buffer.from([0, 255, 128])); await link(join(root, 'data'), join(root, 'hard'));
    await symlink('data', join(root, 'link')); const before = inspect();
    expect(before.find((r: any) => r.path === 'pre-existing/control').hash).toMatch(/^[a-f0-9]{64}$/);
    expect(before.find((r: any) => r.path === 'hard').hardlink).toBe('data');
    expect(before.find((r: any) => r.path === 'link').link).toBe('data'); expect(inspect()).toEqual(before);
    await chmod(join(root, 'data'), 0o600); expect(inspect()).not.toEqual(before);
    await writeFile(join(root, 'pre-existing', 'control'), 'changed control data'); expect(inspect()).not.toEqual(before);
    execFileSync('mkfifo', [join(root, 'special')]);
    expect(() => inspect()).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
