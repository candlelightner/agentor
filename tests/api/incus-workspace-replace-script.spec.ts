import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INCUS_WORKSPACE_REPLACE_SCRIPT } from '../../orchestrator/server/utils/incus-workspace-replace';

// Real directory/file/rename/xattr operations inside one private test fixture.
// Only fixed guest paths and systemd/mount observations are substituted here;
// production takes no caller-selected filesystem path or fault-injection flag.
const HARNESS = String.raw`
import base64,json,os,stat,struct,subprocess,sys
input=json.load(sys.stdin);case=input['case'];base=input['root'];target=base+'/target';outside=base+'/outside'
os.mkdir(outside);open(outside+'/untouched','wb').write(b'outside')
os.mkdir(target);open(target+'/old','wb').write(b'original');open(target+'/deleted','wb').write(b'delete on success')
os.chmod(target,0o751);os.setxattr(target,'user.old',b'original-root');os.utime(target,ns=(1700000000000000000,1700000000123456789))
nonce='11111111-2222-3333-4444-555555555555';stage=target+'/.agentor-restore-stage-'+nonce;rollback=target+'/.agentor-restore-rollback-'+nonce
mountinfo=base+'/mountinfo';line='1 0 0:1 / '+target+' rw - virtiofs fixture rw\n'
if case.get('mount')=='ro': line=line.replace(' rw ', ' ro ')
if case.get('mount')=='stacked': line=line+line
if case.get('mount')=='overlay': line+='2 1 0:2 / '+target+'/nested rw - tmpfs fixture rw\n'
if case.get('mount')=='foreignfs': line=line.replace('virtiofs','ext4')
if case.get('mount')=='missing': line='1 0 0:1 / /elsewhere rw - virtiofs fixture rw\n'
open(mountinfo,'w').write(line)
script=input['script'].replace("ROOT='/target'",'ROOT='+repr(target)).replace("MOUNTINFO='/proc/self/mountinfo'",'MOUNTINFO='+repr(mountinfo))
for path in ('/run/agentor/provisioned','/run/agentor/worker.env','/run/agentor/runtime.env'):
    script=script.replace(repr(path),repr(base+'/'+path.rsplit('/',1)[1]))
if case.get('provisioned'): open(base+'/provisioned','w').close()
if case.get('configured'): open(base+'/runtime.env','w').close()
original_run=subprocess.run
def systemd(args,**kwargs):
    assert args[:4]==['/usr/bin/systemctl','show','--no-pager','--property=LoadState,ActiveState,SubState']
    observed=case.get('service',{'LoadState':'loaded','ActiveState':'inactive','SubState':'dead'})
    output=case.get('serviceOutput','\n'.join(k+'='+v for k,v in observed.items())+'\n').encode()
    return subprocess.CompletedProcess(args,case.get('serviceExit',0),output,b'')
subprocess.run=systemd
steps=[];fault=[False]
sync_failure=[False];real_fsync=os.fsync
def durable(fd):
    if case.get('syncFailure')==sys.argv[1] and not sync_failure[0]:
        sync_failure[0]=True;raise OSError('Synthetic directory sync error')
    return real_fsync(fd)
os.fsync=durable
def audit(event,args):
    if event=='os.rename' and case.get('failure')=='promote' and args[0]=='new' and not fault[0]:
        fault[0]=True;raise OSError('Synthetic ordinary promotion error')
sys.addaudithook(audit)
def execute(mode):
    sys.argv=['guest-script',mode,case.get('nonce',nonce)]
    try: exec(compile(script,'<fixed-guest-script>','exec'),{});steps.append({'mode':mode,'ok':True});return True
    except Exception as error: steps.append({'mode':mode,'ok':False,'error':str(error)});return False
def metadata(path):
    value=os.lstat(path)
    return {'uid':value.st_uid,'gid':value.st_gid,'mode':stat.S_IMODE(value.st_mode),'mtime':value.st_mtime_ns,
        'attrs':{name:base64.b64encode(os.getxattr(path,name)).decode() for name in os.listxattr(path)}}
def old_tree():
    return {name:open(target+'/'+name,'rb').read().hex() for name in ('old','deleted') if os.path.isfile(target+'/'+name)}
before=metadata(target)
if case.get('existing'): os.mkdir(stage);open(stage+'/retained','w').write('retained')
if case.get('targetSymlink'):
    os.rename(target,base+'/real-target');os.symlink(outside,target)
prepared=execute('prepare')
result={'prepared':prepared}
if prepared and not case.get('prepareOnly'):
    payload=stage+'/workspace'
    if case.get('payloadSymlink'): os.symlink(outside,payload)
    else:
        os.mkdir(payload);open(payload+'/new','wb').write(bytes([0,255,128,10,61,0]));os.link(payload+'/new',payload+'/hard')
        os.symlink('/external/inert',payload+'/absolute');os.symlink('../relative-inert',payload+'/relative')
        os.chown(payload+'/new',12345,23456);os.chmod(payload+'/new',0o640)
        os.setxattr(payload+'/new','user.binary',bytes([0,255,128,10,61,0]));os.utime(payload+'/new',ns=(1700000000123456789,1700000000987654321))
        acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,permission,uid) for tag,permission,uid in
            [(1,7,0xffffffff),(2,4,1000),(4,0,0xffffffff),(16,4,0xffffffff),(32,0,0xffffffff)])
        os.setxattr(payload,'system.posix_acl_default',acl)
        os.chown(payload,12345,23456);os.chmod(payload,0o751);os.setxattr(payload,'user.new',b'new-root')
        os.utime(payload,ns=(1700000000000000000,1700000000234567890))
        if case.get('collision'): open(payload+'/.agentor-restore-stage-'+nonce,'w').write('payload collision')
        result['expectedRoot']=metadata(payload);result['expectedFile']=metadata(payload+'/new')
    if case.get('killedCommit'):
        child='import os,signal,subprocess,sys\n'
        child+='subprocess.run=lambda args,**kwargs:subprocess.CompletedProcess(args,0,b"LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\n",b"")\n'
        child+='def kill(event,args):\n    if event=="os.rename" and args[0]=="new":os.kill(os.getpid(),signal.SIGKILL)\n'
        child+='sys.addaudithook(kill)\nsys.argv=["guest-script","commit",'+repr(nonce)+']\n'
        child+='exec(compile('+repr(script)+',"<fixed-guest-script>","exec"),{})\n'
        killed=original_run([sys.executable,'-c',child],capture_output=True,check=False)
        result['killedCode']=killed.returncode;result['commitOutput']=killed.stdout.decode();result['committed']=False
        result['rollbackOld']=open(rollback+'/old','rb').read().hex()
    else: result['committed']=execute('commit')
    if result['committed']:
        result['rollbackOld']=open(rollback+'/old','rb').read().hex();result['rollbackMeta']=metadata(rollback)
        result['root']=metadata(target);result['file']=metadata(target+'/new')
        result['bytes']=open(target+'/new','rb').read().hex();result['hardlinked']=os.stat(target+'/new').st_ino==os.stat(target+'/hard').st_ino
        result['links']=[os.readlink(target+'/absolute'),os.readlink(target+'/relative')]
        result['deleted']=not os.path.lexists(target+'/deleted')
        if not case.get('retainCommit'): result['finished']=execute('finish');result['rootAfterFinish']=metadata(target)
result['before']=before;result['oldTree']=old_tree();result['after']=metadata(target)
result['stageExists']=os.path.lexists(stage);result['rollbackExists']=os.path.lexists(rollback)
result['outside']=open(outside+'/untouched','rb').read().decode();result['steps']=steps
print('RESULT='+json.dumps(result))
`;

async function run(caseOptions: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'incus-workspace-script-'));
  try {
    const output = execFileSync('sudo', ['-n', 'python3', '-c', HARNESS], {
      input: JSON.stringify({ root, script: INCUS_WORKSPACE_REPLACE_SCRIPT, case: caseOptions }),
      encoding: 'utf8', timeout: 10_000,
    });
    return JSON.parse(output.split('\n').find(line => line.startsWith('RESULT='))!.slice(7));
  } finally {
    // Numeric-owner cases are deliberately unreadable to the test user. Exact
    // private fixture only; no repo, guest or shared storage path is removed.
    execFileSync('sudo', ['-n', 'python3', '-c', 'import shutil,sys;shutil.rmtree(sys.argv[1])', root]);
  }
}

test('same-FS workspace replacement retains binary metadata, hardlinks, inert links and directory ACLs', async () => {
  const result = await run();
  expect(result.committed).toBe(true); expect(result.finished).toBe(true); expect(result.deleted).toBe(true);
  expect(result.bytes).toBe('00ff800a3d00'); expect(result.hardlinked).toBe(true);
  expect(result.links).toEqual(['/external/inert', '../relative-inert']);
  expect(result.file).toEqual(result.expectedFile); expect(result.root).toEqual(result.expectedRoot);
  expect(result.rootAfterFinish).toEqual(result.expectedRoot); expect(result.rollbackMeta).toEqual(result.before);
  expect(result.rollbackOld).toBe(Buffer.from('original').toString('hex'));
  expect(result.stageExists).toBe(false); expect(result.rollbackExists).toBe(false); expect(result.outside).toBe('outside');
});

test('commit retains old data until a separate known-success finish and no automatic unknown recovery exists', async () => {
  const result = await run({ retainCommit: true });
  expect(result.committed).toBe(true); expect(result.stageExists).toBe(true); expect(result.rollbackExists).toBe(true);
  expect(result.rollbackOld).toBe(Buffer.from('original').toString('hex'));
  expect(result.steps.map((step: { mode: string }) => step.mode)).toEqual(['prepare', 'commit']);
});

test('ordinary promotion exception restores original entries and root metadata without claiming unknown rollback', async () => {
  const result = await run({ failure: 'promote' });
  expect(result.committed).toBe(false); expect(result.oldTree).toEqual({ old: '6f726967696e616c', deleted: Buffer.from('delete on success').toString('hex') });
  expect(result.after).toEqual(result.before); expect(result.stageExists).toBe(false); expect(result.rollbackExists).toBe(false);
  expect(result.steps.at(-1).error).toContain('Synthetic ordinary promotion error');
});

test('actual killed partial commit retains both nonce trees and emits no rollback or commit acknowledgement', async () => {
  const result = await run({ killedCommit: true });
  expect(result.killedCode).toBe(-9); expect(result.commitOutput).toBe('');
  expect(result.stageExists).toBe(true); expect(result.rollbackExists).toBe(true);
  expect(result.rollbackOld).toBe(Buffer.from('original').toString('hex'));
  expect(result.oldTree).toEqual({}); expect(result.outside).toBe('outside');
});

test('directory sync failures never acknowledge prepare, commit or finish settlement', async () => {
  for (const mode of ['prepare', 'commit', 'finish']) {
    const result = await run({ syncFailure: mode });
    expect(result.steps.find((step: { mode: string }) => step.mode === mode).ok).toBe(false);
    expect(result.steps.find((step: { mode: string }) => step.mode === mode).error).toContain('Synthetic directory sync error');
    if (mode === 'prepare') { expect(result.stageExists).toBe(true); expect(result.oldTree.old).toBe('6f726967696e616c'); }
    if (mode === 'commit') { expect(result.oldTree.old).toBe('6f726967696e616c'); expect(result.rollbackExists).toBe(false); expect(result.after).toEqual(result.before); }
    if (mode === 'finish') { expect(result.committed).toBe(true); expect(result.finished).toBe(false); expect(result.bytes).toBe('00ff800a3d00'); }
  }
});

test('prepare rejects existing markers, malformed nonce and target symlinks without modifying original data', async () => {
  for (const fixture of [{ existing: true }, { nonce: '../../foreign' }, { targetSymlink: true }]) {
    const result = await run(fixture); expect(result.prepared).toBe(false); expect(result.committed).toBeUndefined();
    expect(result.outside).toBe('outside');
    if (!fixture.targetSymlink) expect(result.oldTree.old).toBe('6f726967696e616c');
  }
});

test('commit rejects symlink wrapper and payload marker collision before moving original entries', async () => {
  for (const fixture of [{ payloadSymlink: true }, { collision: true }]) {
    const result = await run(fixture); expect(result.prepared).toBe(true); expect(result.committed).toBe(false);
    expect(result.oldTree.old).toBe('6f726967696e616c'); expect(result.rollbackExists).toBe(false); expect(result.outside).toBe('outside');
  }
});

test('unprovisioned inactive guest and exact RW nonoverlaid mount are mandatory before prepare', async () => {
  for (const fixture of [{ provisioned: true }, { configured: true }, { serviceExit: 1 },
    ...['ro', 'stacked', 'overlay', 'foreignfs', 'missing'].map(mount => ({ mount }))]) {
    const result = await run(fixture); expect(result.prepared).toBe(false); expect(result.stageExists).toBe(false);
    expect(result.oldTree.old).toBe('6f726967696e616c'); expect(result.outside).toBe('outside');
  }
});

test('workspace service gate rejects active, transitional, failed, unknown and malformed observations', async () => {
  for (const service of [
    { LoadState: 'loaded', ActiveState: 'active', SubState: 'listening' },
    ...['failed', 'activating', 'deactivating', 'reloading', 'unknown'].map(ActiveState =>
      ({ LoadState: 'loaded', ActiveState, SubState: 'dead' })),
    { LoadState: 'error', ActiveState: 'inactive', SubState: 'dead' },
    { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'running' },
  ]) {
    const result = await run({ service }); expect(result.prepared).toBe(false); expect(result.stageExists).toBe(false);
    expect(result.oldTree.old).toBe('6f726967696e616c');
  }
  for (const serviceOutput of ['', 'LoadState=loaded\nActiveState=inactive\n',
    'LoadState=loaded\nActiveState=inactive\nSubState=dead\nSubState=dead\n', 'D-Bus unavailable']) {
    const result = await run({ serviceOutput }); expect(result.prepared).toBe(false); expect(result.stageExists).toBe(false);
  }
  for (const LoadState of ['masked', 'not-found']) {
    const result = await run({ prepareOnly: true, service: { LoadState, ActiveState: 'inactive', SubState: 'dead' } });
    expect(result.prepared).toBe(true);
  }
});
