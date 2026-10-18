import { expect, test } from '@playwright/test';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { extractIncusSelectedRestorePayload } from '../../orchestrator/server/utils/portable-managed-volume-archive';
const tar = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('tar-stream');

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-selected-payload-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function pack(dir: string, items: Array<{ name: string; body: Buffer; type?: string }>) {
  const stream = tar.pack(), output = join(dir, 'payload.tar.gz');
  const writing = pipeline(stream, createGzip(), createWriteStream(output));
  for (const item of items) await new Promise<void>((resolve, reject) => {
    stream.entry({ name: item.name, type: item.type ?? 'file', size: item.body.length }, item.body,
      (error: Error | null) => error ? reject(error) : resolve());
  });
  stream.finalize(); await writing; return output;
}
async function inner(dir: string, name = 'selected') {
  await writeFile(join(dir, name), Buffer.from([0, 255, 128, 10]));
  execFileSync('python3', ['-c', "import os,sys; os.setxattr(sys.argv[1],'user.binary',bytes([0,255,128,10,61]))", join(dir, name)]);
  const path = join(dir, name + '.tar');
  execFileSync('tar', ['--format=pax', '--numeric-owner', '--xattrs', '--acls', '-cf', path, '-C', dir, '--', name]);
  return readFile(path);
}

test('selected payload stages exact raw binary metadata in manifest order, not outer order', async () => fixture(async dir => {
  const first = await inner(dir), second = await inner(dir, 'auth.json');
  const payload = await pack(dir, [{ name: 'paths/7.tar', body: second }, { name: 'paths/0.tar', body: first }]);
  const originalPayload = await readFile(payload);
  const dest = join(dir, 'decoded');
  const result = await extractIncusSelectedRestorePayload(payload,
    [{ path: '/tmp/selected', archive: 'paths/0.tar' }, { path: '/home/agent/.codex/auth.json', archive: 'paths/7.tar' }], dest);
  expect(result.map(item => item.path)).toEqual(['/tmp/selected', '/home/agent/.codex/auth.json']);
  expect(await readFile(result[0]!.archivePath)).toEqual(first);
  expect(await readFile(result[1]!.archivePath)).toEqual(second);
  expect((await readdir(dest)).sort()).toEqual(['paths-0.tar', 'paths-7.tar']);
  expect(await readFile(payload)).toEqual(originalPayload);
}));

test('selected wrapper rejects missing, extra, duplicate, link and unsafe members without leaving staged data', async () => fixture(async dir => {
  const bytes = await inner(dir), entries = [{ path: '/tmp/selected', archive: 'paths/0.tar' }];
  const cases = [[], [{ name: 'paths/1.tar', body: bytes }],
    [{ name: 'paths/0.tar', body: bytes }, { name: 'paths/0.tar', body: bytes }],
    [{ name: '../paths/0.tar', body: bytes }], [{ name: 'paths/0.tar', body: Buffer.alloc(0), type: 'symlink' as const }],
    [{ name: 'paths/0.tar', body: Buffer.alloc(0) }]];
  for (const [index, items] of cases.entries()) {
    const payload = await pack(dir, items), dest = join(dir, 'rejected-' + index);
    await expect(extractIncusSelectedRestorePayload(payload, entries, dest)).rejects.toThrow();
    expect(await readdir(dest)).toEqual([]);
  }
}));

test('invalid later inner archive removes already-staged selected bytes', async () => fixture(async dir => {
  const bytes = await inner(dir);
  const payload = await pack(dir, [{ name: 'paths/0.tar', body: bytes }, { name: 'paths/1.tar', body: bytes }]);
  const dest = join(dir, 'rejected');
  await expect(extractIncusSelectedRestorePayload(payload,
    [{ path: '/tmp/selected', archive: 'paths/0.tar' }, { path: '/tmp/other', archive: 'paths/1.tar' }], dest)).rejects.toThrow(/selected/);
  expect(await readdir(dest)).toEqual([]);
}));

test('selected wrapper checks manifest bounds, cancellation and private empty staging', async () => fixture(async dir => {
  const bytes = await inner(dir), payload = await pack(dir, [{ name: 'paths/0.tar', body: bytes }]);
  const entry = { path: '/tmp/selected', archive: 'paths/0.tar' };
  for (const entries of [[entry, entry], [{ ...entry, path: '/tmp/selected/' }],
    [{ ...entry, path: '../selected' }], [{ ...entry, archive: '/paths/0.tar' }],
    Array.from({ length: 33 }, (_, i) => ({ path: '/tmp/' + i, archive: 'paths/' + i + '.tar' }))])
    await expect(extractIncusSelectedRestorePayload(payload, entries, join(dir, 'unused'))).rejects.toThrow(/manifest/);
  const cancelled = new AbortController(); cancelled.abort(new Error('selected-cancelled'));
  await expect(extractIncusSelectedRestorePayload(payload, [entry], join(dir, 'unused'), { signal: cancelled.signal }))
    .rejects.toThrow(/selected-cancelled/);
  const occupied = join(dir, 'occupied'); await mkdir(occupied); await writeFile(join(occupied, 'keep'), 'retained');
  await expect(extractIncusSelectedRestorePayload(payload, [entry], occupied)).rejects.toThrow(/empty/);
  expect(await readFile(join(occupied, 'keep'), 'utf8')).toBe('retained');
}));

test('native outer V7/GNU prefix disagreement cannot disguise selected members', async () => fixture(async dir => {
  const bytes = await inner(dir), raw = join(dir, 'wrapper.tar');
  const stream = tar.pack(), writing = pipeline(stream, createWriteStream(raw));
  stream.entry({ name: '0.tar', size: bytes.length }, bytes); stream.finalize(); await writing;
  const original = await readFile(raw);
  for (const [index, magic] of ['', 'ustar  \0'].entries()) {
    const bad = Buffer.from(original), header = bad.subarray(0, 512);
    header.fill(0, 257, 265); header.write(magic, 257, 8, 'ascii'); header.write('paths', 345, 155, 'ascii');
    header.fill(32, 148, 156);
    header.write([...header].reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    await writeFile(raw, bad);
    const payload = join(dir, 'bad.gz'); await pipeline(createReadStream(raw), createGzip(), createWriteStream(payload));
    const dest = join(dir, 'bad-' + index);
    await expect(extractIncusSelectedRestorePayload(payload, [{ path: '/tmp/selected', archive: 'paths/0.tar' }], dest))
      .rejects.toThrow(/USTAR|magic/);
    expect(await readdir(dest)).toEqual([]);
  }
}));

test('real Incus GNU/PAX selected directory and explicit file bytes survive native wrapper decoding', async () => {
  test.skip(process.env.INCUS_SELECTED_CODEC_TEST !== 'true', 'Explicit serial disposable selected codec gate');
  test.setTimeout(600_000);
  (globalThis as any).useLogger ??= () => ({ info() {}, warn() {}, debug() {}, error() {} });
  const [{ IncusWorkerRuntime }, { WorkerStore }, { zeroUserEnvVars }, { backupInstallationId }] = await Promise.all([
    import('../../orchestrator/server/utils/incus-worker-runtime'), import('../../orchestrator/server/utils/worker-store'),
    import('../../orchestrator/server/utils/user-env-store'), import('../../orchestrator/server/utils/backup-installation')]);
  const dir = await mkdtemp(join(tmpdir(), 'agentor-selected-codec-live-')), id = randomUUID(), nonce = randomUUID();
  const config = { dataDir: dir, containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor', incusStoragePool: 'default', incusNetwork: 'incusbr0',
    incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase10-preserve-ownership',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt' } as any;
  const opts = { id, userId: 'selected-codec-gate', containerName: 'agentor-worker-' + id,
    start: false, recreationNonce: nonce, dockerEnabled: false, cpuLimit: 1, memoryLimit: '1GiB',
    userEnv: zeroUserEnvVars('selected-codec-gate'),
    environmentJson: { dockerEnabled: false, networkMode: 'full', allowedDomains: [], setupScript: '', envVars: '', exposeApis: {} },
    workerJson: { id, displayName: 'Selected codec gate', repos: [], initScript: '', gitName: '', gitEmail: '' },
    capabilitiesJson: [], instructionsJson: [] };
  const runtime = new IncusWorkerRuntime(config), store = new WorkerStore(dir); await store.init();
  let marker: any = { nonce, initialCreate: true, importIncomplete: true }, submitted = false, cleaned = false;
  const exec = async (command: string[]) => {
    const result = await runtime.client.exec(opts.containerName, command);
    expect(result.returnCode, result.stderr).toBe(0); return result.stdout;
  };
  const validate = () => {
    if (JSON.stringify(store.get(opts.userId, id)?.incusRecreation) !== JSON.stringify(marker)) throw new Error('Lost selected codec fixture authority');
  };
  try {
    await store.upsert({ id, userId: opts.userId, runtimeKind: 'incus-vm', status: 'active', displayName: 'Selected codec gate',
      desiredRuntimeStatus: 'stopped', incusRecreation: marker, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    console.info('Exact selected codec fixture', { dir, id, nonce, installation: await backupInstallationId(dir) });
    submitted = true;
    const created = await runtime.createCanonicalRestore(opts);
    marker = { ...marker, replacementIncarnation: created.config['volatile.uuid'] };
    expect(marker.replacementIncarnation).toBeTruthy();
    await store.transitionIncusRecreation(opts.userId, id, { status: 'active', desiredRuntimeStatus: 'stopped', incusRecreation: marker });
    await runtime.restoreCanonicalArchives(opts, marker.replacementIncarnation, {}, validate);
    const original = await runtime.client.getInstance(opts.containerName);
    await exec(['bash', '-ec', 'test ! -e /run/agentor/provisioned; ! systemctl is-active --quiet agentor-worker; ! systemctl is-active --quiet docker; test "$(ls /sys/class/net | wc -l)" = 1']);
    await exec(['python3', '-c', String.raw`
import os,struct
p='/tmp/selected';os.mkdir(p);os.chmod(p,0o751)
open(p+'/auth.json','wb').write(bytes([0,255,128,10,61,0]))
os.chown(p+'/auth.json',12345,23456);os.chmod(p+'/auth.json',0o640)
os.setxattr(p+'/auth.json','user.binary',bytes([0,255,128,10,61,0]))
os.setxattr(p+'/auth.json','security.capability',struct.pack('<IIIII',0x02000001,1<<10,0,0,0))
acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,ident) for tag,perm,ident in [(1,6,0xffffffff),(2,4,34567),(4,4,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
os.setxattr(p+'/auth.json','system.posix_acl_access',acl);os.setxattr(p,'system.posix_acl_default',acl)
os.link(p+'/auth.json',p+'/hard');os.symlink('/home/agent/.codex/auth.json',p+'/absolute')
os.utime(p+'/auth.json',ns=(1700000000123456789,1700000000987654321))
os.mkdir('/tmp/fresh-selected');os.mkdir('/tmp/fresh-file')
`]);
    const observe = String.raw`import base64,json,os,stat,sys
p=sys.argv[1];s=os.stat(p+'/auth.json')
print(json.dumps(dict(bytes=base64.b64encode(open(p+'/auth.json','rb').read()).decode(),uid=s.st_uid,gid=s.st_gid,
mode=stat.S_IMODE(s.st_mode),mtime=str(s.st_mtime_ns),rootMode=stat.S_IMODE(os.stat(p).st_mode),
hard=s.st_ino==os.stat(p+'/hard').st_ino,link=os.readlink(p+'/absolute'),
attrs={key:base64.b64encode(os.getxattr(p+'/auth.json',key)).decode() for key in ('user.binary','system.posix_acl_access','security.capability')},
defaultAcl=base64.b64encode(os.getxattr(p,'system.posix_acl_default')).decode())))`;
    const expected = JSON.parse(await exec(['python3', '-c', observe, '/tmp/selected']));
    const captured = [];
    for (const [index, selected] of ['/tmp/selected', '/tmp/selected/auth.json'].entries()) {
      const archive = join(dir, index + '.tar'), parent = index ? '/tmp/selected' : '/tmp', basename = index ? 'auth.json' : 'selected';
      const session = await runtime.client.execStream(opts.containerName,
        ['/usr/bin/tar', '--format=pax', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', parent, '-cf', '-', '--', basename],
        { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 60_000 });
      session.stderr.resume(); session.stdin.end();
      try { await Promise.all([pipeline(session.stdout, createWriteStream(archive, { mode: 0o600 })),
        session.result.then(code => expect(code).toBe(0))]); } finally { session.close(); }
      captured.push({ name: 'paths/' + index + '.tar', body: await readFile(archive) });
    }
    const payload = await pack(dir, captured);
    const decoded = await extractIncusSelectedRestorePayload(payload,
      [{ path: '/tmp/selected', archive: 'paths/0.tar' }, { path: '/home/agent/.codex/auth.json', archive: 'paths/1.tar' }], join(dir, 'decoded'));
    for (const [index, item] of decoded.entries()) {
      expect(await readFile(item.archivePath)).toEqual(captured[index]!.body);
      const session = await runtime.client.execStream(opts.containerName,
        ['/usr/bin/tar', '--same-owner', '--same-permissions', '--numeric-owner', '--xattrs', '--xattrs-include=*', '--acls', '-C', index ? '/tmp/fresh-file' : '/tmp/fresh-selected', '-xf', '-'],
        { command: [], user: 0, group: 0, cwd: '/', environment: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeoutMs: 60_000 });
      session.stdout.resume(); session.stderr.resume();
      try { await Promise.all([pipeline(createReadStream(item.archivePath), session.stdin),
        session.result.then(code => expect(code).toBe(0))]); } finally { session.close(); }
    }
    expect(JSON.parse(await exec(['python3', '-c', observe, '/tmp/fresh-selected/selected']))).toEqual(expected);
    await exec(['python3', '-c', String.raw`import os
a,b='/tmp/selected/auth.json','/tmp/fresh-file/auth.json'
assert open(a,'rb').read()==open(b,'rb').read()
for key in ('user.binary','system.posix_acl_access','security.capability'): assert os.getxattr(a,key)==os.getxattr(b,key)
assert os.stat(a).st_mtime_ns==os.stat(b).st_mtime_ns
assert (os.stat(a).st_uid,os.stat(a).st_gid,os.stat(a).st_mode)==(os.stat(b).st_uid,os.stat(b).st_gid,os.stat(b).st_mode)
`]);
    validate(); const after = await runtime.client.getInstance(opts.containerName);
    expect(after.config['volatile.uuid']).toBe(marker.replacementIncarnation);
    expect(after.devices).toEqual(original.devices); expect(after.expanded_devices).toEqual(original.expanded_devices);
    console.info('Native selected codec only: unchanged bytes/UID/GID/modes/nsmtime/hardlinks/ACLs/binary xattrs/capabilities; no services/grants/network, not shared restore completion');
  } finally {
    if (submitted) {
      try { await runtime.rollbackRecreation(opts, marker); await runtime.removeStorage(opts); cleaned = true; }
      catch (error) { console.error('Exact selected codec fixture retained', { dir, id, marker, error: String(error) }); }
    } else cleaned = true;
    if (cleaned) await rm(dir, { recursive: true, force: true });
  }
  expect(cleaned, 'Exact fixture compute/private storage cleanup must be verified').toBe(true);
});
