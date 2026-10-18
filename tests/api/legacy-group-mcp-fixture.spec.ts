import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEGACY_GROUP_PRINCIPAL_CAS, validateLegacyGroupFixtureSource } from '../helpers/legacy-group-mcp-fixture';

const owner = 'fixture-owner', groupId = '11111111-1111-4111-8111-111111111111';
const record = { schemaVersion: 1, id: '22222222-2222-4222-8222-222222222222', kind: 'group-administrative', trusted: true,
  runtimeKind: 'legacy-docker', ownerId: owner, groupId, status: 'stopped', services: ['terminal'], createdAt: 'fixture', updatedAt: 'fixture' };
const fixture = () => ({ Id: 'a'.repeat(64), Image: 'sha256:' + 'b'.repeat(64), Name: '/agentor-orchestrator',
  Config: { Labels: { 'com.docker.compose.project': 'agentor-test', 'com.docker.compose.service': 'agentor-orchestrator' },
    Env: ['DATA_DIR=/data', 'ALLOW_ADMIN_DIAGNOSTICS=true'] }, HostConfig: { Privileged: false, NetworkMode: 'agentor-net', PidMode: '', Devices: [] },
  Mounts: [{ Destination: '/data', Type: 'volume', Name: 'agentor-test_agentor-data', RW: true }] });

test('legacy diagnostic principal accepts only the exact private CI application and DATA volume', () => {
  validateLegacyGroupFixtureSource(fixture());
  for (const mutate of [(x: any) => x.Id = 'short', (x: any) => x.Image = 'tag:latest', (x: any) => x.Name = '/other',
    (x: any) => x.Config.Labels['com.docker.compose.project'] = 'production',
    (x: any) => x.Config.Env.push('INCUS_ENABLED=true'), (x: any) => x.Config.Env = ['DATA_DIR=/other'],
    (x: any) => x.HostConfig.Privileged = true, (x: any) => x.HostConfig.NetworkMode = 'host',
    (x: any) => x.HostConfig.PidMode = 'host', (x: any) => x.HostConfig.Devices = [{}],
    (x: any) => x.Mounts[0].Type = 'bind', (x: any) => x.Mounts[0].Name = 'production-data',
    (x: any) => x.Mounts[0].RW = false, (x: any) => x.Mounts.push({ ...x.Mounts[0] })]) {
    const value = fixture(); mutate(value); expect(() => validateLegacyGroupFixtureSource(value)).toThrow('private Docker CI');
  }
});

async function stored(run: (root: string, file: string, change: (action: string) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'legacy-mcp-principal-')), folder = join(root, 'users', owner);
  await mkdir(folder, { recursive: true });
  const file = join(folder, 'worker-groups.json');
  await writeFile(file, JSON.stringify([{ id: groupId, userId: owner, name: 'Preserved', workerIds: ['member'] },
    { id: 'other', userId: owner, name: 'Other', workerIds: [] }]), { mode: 0o600 });
  const script = LEGACY_GROUP_PRINCIPAL_CAS.replace("const root='/fixture-data';", 'const root=' + JSON.stringify(root) + ';');
  const change = (action: string) => { execFileSync(process.execPath, ['-e', script, action, owner, groupId, JSON.stringify(record)], { stdio: 'pipe' }); };
  try { await run(root, file, change); } finally { await rm(root, { recursive: true, force: true }); }
}

test('actual cold CAS inserts/removes only its stopped legacy binding and preserves later membership edits', async () => {
  await stored(async (_root, file, change) => {
    const before = JSON.parse(await readFile(file, 'utf8')); change('insert');
    const inserted = JSON.parse(await readFile(file, 'utf8'));
    expect(inserted[0]).toEqual({ ...before[0], adminWorkspace: record }); expect(inserted[1]).toEqual(before[1]);
    inserted[0].workerIds = []; inserted[0].updatedAt = 'later API edit';
    await writeFile(file, JSON.stringify(inserted)); change('remove');
    const after = JSON.parse(await readFile(file, 'utf8'));
    expect(after[0]).toEqual({ ...before[0], workerIds: [], updatedAt: 'later API edit' }); expect(after[1]).toEqual(before[1]);
  });
});

test('actual cold CAS refuses existing/changed bindings, broad files and symlinks without changing their bytes', async () => {
  await stored(async (root, file, change) => {
    change('insert'); const inserted = await readFile(file, 'utf8');
    expect(() => change('insert')).toThrow(); expect(await readFile(file, 'utf8')).toBe(inserted);
    const rows = JSON.parse(inserted); rows[0].adminWorkspace.status = 'running'; await writeFile(file, JSON.stringify(rows));
    const changed = await readFile(file, 'utf8'); expect(() => change('remove')).toThrow(); expect(await readFile(file, 'utf8')).toBe(changed);
    await rm(file); const target = join(root, 'retained'); await writeFile(target, inserted, { mode: 0o600 }); await symlink(target, file);
    expect(() => change('remove')).toThrow(); expect(await readFile(target, 'utf8')).toBe(inserted);
    await rm(file); await writeFile(file, inserted, { mode: 0o666 });
    // chmod is explicit because a restrictive caller umask may mask writeFile's mode.
    const { chmod } = await import('node:fs/promises'); await chmod(file, 0o666);
    expect(() => change('remove')).toThrow(); expect(await readFile(file, 'utf8')).toBe(inserted);
  });
});
