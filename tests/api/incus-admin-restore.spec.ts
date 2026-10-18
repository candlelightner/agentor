import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { INCUS_CANONICAL_RESTORE_SCRIPT } from '../../orchestrator/server/utils/incus-canonical-restore';
import { validateIncusLegacyAdministrativeRestoreArchive, validateIncusCanonicalRestoreArchive, validatePortableManagedVolumeArchive } from '../../orchestrator/server/utils/portable-managed-volume-archive';

for (const role of ['workspace', 'agents', 'managed'] as const) test(`legacy ${role} inverse preserves original GNU PAX bytes, root metadata, binary xattrs, hardlinks and symlink text`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-legacy-inverse-'));
  try {
    const source = join(root, 'capture'), target = join(root, 'restore'), archive = join(root, 'source.tar');
    await mkdir(source); await mkdir(target); await mkdir(join(target, 'workspace')); await mkdir(join(target, '.agent-data'));
    execFileSync('python3', ['-c', String.raw`
import os,sys
root=sys.argv[1];os.mkdir(root+'/source',0o751)
with open(root+'/source/data','wb') as f:f.write(b'known\x00payload\xff')
os.chmod(root+'/source/data',0o640);os.chown(root+'/source/data',1061,1062)
os.setxattr(root+'/source/data','user.binary',b'\x00\xff\xfehello\x80')
os.link(root+'/source/data',root+'/source/hard');os.symlink('source/data',root+'/source/link')
os.chown(root+'/source',1063,1064);os.utime(root+'/source',(1234567890,1234567890))
`, source]);
    execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', source, '-cf', archive, 'source']);
    const raw = await readFile(archive), digest = createHash('sha256').update(raw).digest('hex');
    await expect(validateIncusLegacyAdministrativeRestoreArchive(archive, {}, role === 'managed' ? '/srv/legacy' : undefined)).resolves.toMatchObject({ entries: 4 });
    if (role === 'managed') await expect(validatePortableManagedVolumeArchive(archive, { target: '/srv/legacy', requirePosixUstar: true })).rejects.toThrow('outside');
    else await expect(validateIncusCanonicalRestoreArchive(archive, role)).rejects.toThrow('outside');
    const managedId = '11111111-2222-3333-4444-555555555555';
    const roots = { workspace: join(target, 'workspace'), agents: join(target, '.agent-data'), managed: join(target, 'managed', managedId, 'volume') };
    if (role === 'managed') await mkdir(roots.managed, { recursive: true });
    let script = INCUS_CANONICAL_RESTORE_SCRIPT.replace('ROOTS={"workspace":"/restore/workspace","agents":"/restore/.agent-data"}', 'ROOTS=' + JSON.stringify({ workspace: roots.workspace, agents: roots.agents }));
    script = script.replace('ROOTS[role]="/restore/managed/"+managed.group(1)+"/volume"', 'ROOTS[role]=' + JSON.stringify(roots.managed));
    script = script.replace('parents=("/restore/managed",os.path.dirname(root)) if managed else ()', 'parents=tuple(' + JSON.stringify([join(target,'managed'),join(target,'managed',managedId)]) + ') if managed else ()');
    script = script.replace('("/restore",)+parents', '(' + JSON.stringify(target) + ',)+parents');
    const fixture = String.raw`
import builtins,io,os,subprocess,types
real_open=builtins.open
mounts=` + JSON.stringify((role === 'managed' ? Object.values(roots) : [roots.workspace, roots.agents]).map(path => `1 0 0:1 / ${path} rw - ext4 fixture rw\n`).join('')) + String.raw`
builtins.open=lambda path,*a,**k:io.BytesIO(mounts.encode()) if path=='/proc/self/mountinfo' else real_open(path,*a,**k)
os.path.lexists=lambda path:False
subprocess.run=lambda *a,**k:types.SimpleNamespace(returncode=3)
`;
    execFileSync('python3', ['-c', fixture + script, role === 'managed' ? 'managed:' + managedId : role, 'legacy-source'], { input: raw });
    const destination = roots[role], info = await stat(destination), file = await stat(join(destination, 'data'));
    expect(info.uid).toBe(1063); expect(info.gid).toBe(1064); expect(info.mode & 0o777).toBe(0o751); expect(info.mtimeMs).toBe(1234567890000);
    expect(file.uid).toBe(1061); expect(file.gid).toBe(1062); expect(file.mode & 0o777).toBe(0o640);
    expect((await stat(join(destination, 'hard'))).ino).toBe(file.ino); expect(await readlink(join(destination, 'link'))).toBe('source/data');
    expect(await readFile(join(destination, 'data'))).toEqual(Buffer.from('known\0payload\xff', 'latin1'));
    const xattr = execFileSync('python3', ['-c', "import os,sys;sys.stdout.buffer.write(os.getxattr(sys.argv[1],'user.binary'))", join(destination, 'data')]);
    expect(xattr).toEqual(Buffer.from([0,255,254,104,101,108,108,111,128]));
    expect(createHash('sha256').update(await readFile(archive)).digest('hex')).toBe(digest);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import { randomUUID } from 'node:crypto';
import { Writable, PassThrough } from 'node:stream';
import { restoreAdministrativeArchives } from '../../orchestrator/server/utils/incus-admin-restore';
import { IncusAdminWorkspaceStorage } from '../../orchestrator/server/utils/incus-admin-workspace-storage';
import { adminNativeInstanceName } from '../../orchestrator/server/utils/admin-native-identity';
import type { AdministrativeWorkspaceRecord } from '../../orchestrator/server/utils/admin-workspace-store';
import type { Config } from '../../orchestrator/server/utils/config';

async function writerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentor-admin-writer-')), config = { dataDir: root, incusStoragePool: 'pool', incusProject: 'agentor' } as Config;
  const record: AdministrativeWorkspaceRecord = { schemaVersion: 1, id: randomUUID(), kind: 'administrative', trusted: true,
    status: 'stopped', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), runtimeKind: 'incus-vm' };
  record.nativeRuntime = { version: 1, name: adminNativeInstanceName(record), installationId: randomUUID(), nonce: randomUUID(),
    overlayVersion: '6', overlaySha256: 'd'.repeat(64), image: { version: 1, sourceImageId: 'sha256:' + 'b'.repeat(64), recipeId: 'c'.repeat(64),
      architecture: 'amd64', converterVersion: 'v0.4.0', bootstrapGeneration: '3', fingerprint: 'a'.repeat(64) } };
  const volumes = new Map<string, any>(), calls: any[] = [], inputs: Buffer[] = [];
  let code = 0;
  const client: any = { endpoint: 'https://fixture.invalid',
    getCustomVolume: async (_pool: string, name: string) => structuredClone(volumes.get(name)),
    execStream: async (name: string, command: string[], options: any) => {
      calls.push({ name, command, options }); let resolve!: (code: number) => void;
      const result = new Promise<number>(yes => { resolve = yes; });
      const stdin = new Writable({ write(chunk, _encoding, done) { inputs.push(Buffer.from(chunk)); done(); }, final(done) { resolve(code); done(); } });
      return { stdin, stdout: new PassThrough(), stderr: new PassThrough(), result, close() {} };
    } };
  const storage = new IncusAdminWorkspaceStorage(config, client, async () => { throw Error('No application managed-store authority'); });
  for (const role of ['workspace', 'agents'] as const) {
    const name = storage.names(record.nativeRuntime)[role];
    volumes.set(name, { name, project: config.incusProject, type: 'custom', content_type: 'filesystem',
      created_at: '2026-10-18T00:00:00Z', config: storage.metadata(record, record.nativeRuntime, role), used_by: [] });
  }
  const stage = join(root, 'stage'); await mkdir(stage); await mkdir(join(stage, 'workspace'));
  execFileSync('python3', ['-c', "import pathlib,sys;pathlib.Path(sys.argv[1],'workspace','file').write_bytes(b'known payload')", stage]);
  const archive = join(root, 'workspace.tar'); execFileSync('tar', ['--format=pax', '-C', stage, '-cf', archive, 'workspace']);
  const helper: any = { withGuest: async (_owner: any, sources: any, validate: any, _signal: any, apply: any) => {
    calls.push({ sources }); await validate();
    for (const volume of volumes.values()) volume.used_by = ['/1.0/instances/isolated-helper?project=agentor'];
    try { await validate('isolated-helper'); return await apply('isolated-helper', async () => {}); }
    finally { for (const volume of volumes.values()) volume.used_by = []; await validate(); }
  } };
  return { root, record, config, volumes, client, archive, helper, calls, inputs, fail: () => { code = 2; },
    run: () => restoreAdministrativeArchives(config, client, record, { workspace: archive, managed: [] }, async () => {}, undefined, helper),
    cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('shared administrative inverse passes exact raw bytes to one isolated helper and leaves publication to its dedicated caller', async () => {
  const f = await writerFixture(); try {
    await f.run(); expect(Buffer.concat(f.inputs)).toEqual(await readFile(f.archive));
    const dispatch = f.calls.filter(call => call.command); expect(dispatch).toHaveLength(2);
    expect(dispatch[0].command).toEqual(['/usr/bin/python3', '-c', INCUS_CANONICAL_RESTORE_SCRIPT, 'workspace']);
    expect(dispatch[1].command.at(-1)).toBe('empty'); expect(dispatch.every(call => call.name === 'isolated-helper')).toBe(true);
    expect(f.record.nativeRuntime?.storageInitialized).toBeUndefined(); expect(f.record.nativeRuntime?.incarnation).toBeUndefined();
    expect(f.calls.find(call => call.sources).sources.administrativeRestore.managed).toEqual({});
  } finally { await f.cleanup(); }
});

test('administrative inverse refuses foreign or already initialized authority before opening the writer', async () => {
  for (const variant of ['initialized', 'pending', 'incarnation', 'foreign-owner', 'foreign-reference']) {
    const f = await writerFixture(); try {
      if (variant === 'initialized') f.record.nativeRuntime!.storageInitialized = true;
      if (variant === 'pending') f.record.nativeRuntime!.pending = { kind: 'create' };
      if (variant === 'incarnation') f.record.nativeRuntime!.incarnation = randomUUID();
      const first = [...f.volumes.values()][0];
      if (variant === 'foreign-owner') first.config['user.agentor.owner'] = 'foreign';
      if (variant === 'foreign-reference') first.used_by = ['/1.0/instances/foreign?project=agentor'];
      await expect(f.run()).rejects.toThrow(); expect(f.calls).toEqual([]);
    } finally { await f.cleanup(); }
  }
});

test('failed administrative extraction cannot publish initialized storage or allocate administrative compute', async () => {
  const f = await writerFixture(); try {
    f.fail(); await expect(f.run()).rejects.toThrow('extraction failed');
    expect(f.record.nativeRuntime?.storageInitialized).toBeUndefined(); expect(f.record.nativeRuntime?.incarnation).toBeUndefined();
    expect(f.calls.filter(call => call.command)).toHaveLength(1);
  } finally { await f.cleanup(); }
});


test('legacy selected source-root validation keeps target-contained links and Kilo-parent admission strict', async () => {
  const root = await mkdtemp(join(tmpdir(), 'admin-legacy-selected-codec-'));
  try {
    const source = join(root,'source'), archive = join(root,'source.tar'); await mkdir(source);
    for (const [link, allowed] of [['/foreign/data',false],['../../escape',false],['/srv/legacy/data',true]] as const) {
      await rm(join(source,'link'),{force:true});
      execFileSync('python3',['-c','import os,sys;os.symlink(sys.argv[2],sys.argv[1])',join(source,'link'),link]);
      execFileSync('tar',['--format=pax','-C',root,'-cf',archive,'source']);
      const check=validateIncusLegacyAdministrativeRestoreArchive(archive,{},'/srv/legacy');
      if(allowed) await expect(check).resolves.toMatchObject({entries:2});else await expect(check).rejects.toThrow('symlink');
    }
    await rm(join(source,'link'));
    execFileSync('tar',['--format=pax','-C',root,'-cf',archive,'source']);
    await expect(validateIncusLegacyAdministrativeRestoreArchive(archive,{},'/home/agent/.local/share')).rejects.toThrow('canonical Kilo');
    execFileSync('python3',['-c',"import os,sys;os.symlink('/home/agent/.agent-data/.kilo/shared-data',sys.argv[1])",join(source,'kilo')]);
    execFileSync('tar',['--format=pax','-C',root,'-cf',archive,'source']);
    await expect(validateIncusLegacyAdministrativeRestoreArchive(archive,{},'/home/agent/.local/share')).resolves.toMatchObject({entries:2});
  } finally { await rm(root,{recursive:true,force:true}); }
});
