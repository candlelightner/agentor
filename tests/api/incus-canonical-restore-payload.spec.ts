import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES, prepareIncusCanonicalRestorePayload } from '../../orchestrator/server/utils/incus-canonical-restore';

async function fixture(run: (f: { dir: string; scratch: string; payload: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-native-gzip-')), scratch = join(dir, 'private');
  await mkdir(scratch, { mode: 0o700 });
  try { await run({ dir, scratch, payload: join(dir, 'payload.tar.gz') }); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function actualTar(dir: string, root: string) {
  const stage = join(dir, 'stage'), source = join(stage, root), archive = join(dir, 'source.tar');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'file'), Buffer.from([0, 255, 128, 10]));
  await chmod(source, 0o751); await chmod(join(source, 'file'), 0o640);
  await link(join(source, 'file'), join(source, 'hard')); await symlink('/home/agent/shared', join(source, 'symlink'));
  execFileSync('python3', ['-c', String.raw`
import os,struct,sys
p=sys.argv[1]
os.setxattr(p+'/file','user.binary',bytes([0,255,128,10,61,0]))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,12345),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/file','system.posix_acl_access',acl)
os.setxattr(p,'system.posix_acl_default',acl)
`, source]);
  execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', stage, '-cf', archive, root]);
  return { source, raw: await readFile(archive) };
}

for (const role of ['workspace', 'agents'] as const) test(`gzip preparation retains real GNU PAX ${role} bytes and metadata without repacking`, async () => {
  await fixture(async ({ dir, scratch, payload }) => {
    const root = role === 'workspace' ? 'workspace' : '.agent-data', { source, raw } = await actualTar(dir, root);
    await writeFile(payload, gzipSync(raw));
    await writeFile(join(scratch, 'preexisting.tar'), 'existing state', { mode: 0o600 });
    const prepared = await prepareIncusCanonicalRestorePayload(payload, role, scratch);
    expect(prepared).toMatchObject({ rawBytes: raw.length, entries: 4, expandedBytes: 4 });
    expect(await readFile(prepared.archivePath)).toEqual(raw);
    expect((await lstat(prepared.archivePath)).mode & 0o777).toBe(0o600);
    const again = await prepareIncusCanonicalRestorePayload(payload, role, scratch);
    expect(again.archivePath).not.toBe(prepared.archivePath);
    expect(await readFile(join(scratch, 'preexisting.tar'), 'utf8')).toBe('existing state');
    const fresh = join(dir, 'fresh'); await mkdir(fresh);
    execFileSync('tar', ['--numeric-owner', '--same-owner', '--same-permissions', '--xattrs', '--xattrs-include=*', '--acls', '-C', fresh, '-xf', prepared.archivePath]);
    execFileSync('python3', ['-c', String.raw`
import os,sys
a,b=sys.argv[1:]
for path,key in [('file','user.binary'),('file','system.posix_acl_access'),('','system.posix_acl_default')]:
 assert os.getxattr(a+'/'+path,key)==os.getxattr(b+'/'+path,key),(path,key)
assert os.stat(a+'/file').st_mtime_ns==os.stat(b+'/file').st_mtime_ns
assert os.readlink(b+'/symlink')=='/home/agent/shared'
assert os.stat(b+'/file').st_ino==os.stat(b+'/hard').st_ino
for path in ('','/file'):
 x,y=os.stat(a+path),os.stat(b+path)
 assert (x.st_uid,x.st_gid,x.st_mode)==(y.st_uid,y.st_gid,y.st_mode)
`, source, join(fresh, root)]);
  });
});

test('corrupt gzip and compressed bombs remove only their own incomplete raw output', async () => {
  await fixture(async ({ scratch, payload }) => {
    const sentinel = join(scratch, 'keep.tar'); await writeFile(sentinel, 'preserved', { mode: 0o600 });
    for (const bytes of [Buffer.from('not gzip'), gzipSync(Buffer.alloc(4096)).subarray(0, -8)]) {
      await writeFile(payload, bytes);
      await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch)).rejects.toThrow();
      expect(await readdir(scratch)).toEqual(['keep.tar']);
    }
    await writeFile(payload, gzipSync(Buffer.alloc(1024 * 1024)));
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch, { maxRawBytes: 512 }))
      .rejects.toThrow(/raw-byte limit/);
    expect(await readdir(scratch)).toEqual(['keep.tar']); expect(await readFile(sentinel, 'utf8')).toBe('preserved');
  });
});

test('unsafe root archives are rejected after decode without extraction or retained output', async () => {
  await fixture(async ({ dir, scratch, payload }) => {
    const { raw } = await actualTar(dir, '.agent-data'); await writeFile(payload, gzipSync(raw));
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch)).rejects.toThrow(/outside workspace/);
    expect(await readdir(scratch)).toEqual([]);
    expect(await readdir(dir)).not.toContain('workspace');
  });
});

test('fixed roles, private scratch, regular inputs and caller byte ceilings are enforced', async () => {
  await fixture(async ({ dir, scratch, payload }) => {
    const { raw } = await actualTar(dir, 'workspace'); await writeFile(payload, gzipSync(raw));
    await expect(prepareIncusCanonicalRestorePayload(payload, 'arbitrary-root' as any, scratch)).rejects.toThrow(/role/);
    for (const maxRawBytes of [-1, 0, NaN, Infinity, 0.5])
      await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch, { maxRawBytes })).rejects.toThrow(/limit/);
    await chmod(scratch, 0o755);
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch)).rejects.toThrow(/private/);
    await chmod(scratch, 0o700);
    const alias = join(dir, 'alias'); await symlink(scratch, alias);
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', alias)).rejects.toThrow(/non-symlink/);
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', payload)).rejects.toThrow(/directory/);
    const inputAlias = join(dir, 'alias.gz'); await symlink(payload, inputAlias);
    await expect(prepareIncusCanonicalRestorePayload(inputAlias, 'workspace', scratch)).rejects.toThrow();
    await expect(prepareIncusCanonicalRestorePayload(scratch, 'workspace', scratch)).rejects.toThrow(/regular/);
    expect(await readdir(scratch)).toEqual([]);
    expect(MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES).toBe(100 * 1024 ** 3);
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch, { maxRawBytes: MAX_INCUS_CANONICAL_RESTORE_RAW_BYTES + 1 }))
      .resolves.toMatchObject({ rawBytes: raw.length });
  });
});

test('pre-cancellation and cancellation after exclusive file creation clean only owned output', async () => {
  await fixture(async ({ scratch, payload }) => {
    await writeFile(payload, gzipSync(Buffer.alloc(8 * 1024 * 1024)));
    const aborted = new AbortController(); aborted.abort(new Error('cancelled before preparation'));
    await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch, { signal: aborted.signal })).rejects.toThrow(/cancelled/);
    expect(await readdir(scratch)).toEqual([]);
    const active = new AbortController(); let observed = false;
    const observer = watch(scratch, (_event, name) => {
      if (name?.startsWith('workspace-')) { observed = true; active.abort(new Error('cancelled active preparation')); }
    });
    try {
      await expect(prepareIncusCanonicalRestorePayload(payload, 'workspace', scratch, { signal: active.signal })).rejects.toThrow(/cancel|abort/i);
      expect(observed).toBe(true); expect(await readdir(scratch)).toEqual([]);
    } finally { observer.close(); }
  });
});
