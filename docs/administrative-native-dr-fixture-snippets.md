# One-off native DR receipts and samples

Run these snippets **only inside the disposable VM**, after the [bootstrap](administrative-native-dr-bootstrap-20261018.md). They do not install/start daemons, create accounts, select/detach volumes or migrate production. Parent/operator owns those steps. The source marker must be root-private `/etc/agentor-native-dr-vm.json`, with exactly `kind: "agentor-disposable-native-dr-vm"`, `phase: "source"` and the launcher's UUID `nonce`; the separate destination uses `phase: "destination"` and a new nonce. DMI UUID and the sole `agentor.native_dr_fixture=` kernel argument must agree. No historical nonce is hardcoded here.

First retain the two setup/sign-in results privately as `/run/agentor-native-dr/accounts.json`, root `0600`. Its shape is exactly the `source` and `recovery` login objects below. Obtain container IDs from the two exact fixture containers; keep passwords out of shell arguments, environment variables, terminal output and Git. For destination, copy the old **descriptive** source login/container ID from the source receipt and replace only the recovery login/container ID with the new fixture's account. Destination never contacts that source container/API.

```json
{"source":{"containerId":"<64 lowercase hex>","ownerId":"<source account ID>","email":"source@example.test","password":"<disposable password>"},"recovery":{"containerId":"<different 64 lowercase hex>","ownerId":"<different recovery account ID>","email":"recovery@example.test","password":"<different disposable password>"}}
```

## 1. Write the two exact private receipts

Run as root with the source global/group workspaces already created, or with `admin-dr-source.json` copied into the new destination root. Both TLS directories and empty `control`/`recovery` roots must already exist. This snippet reads dedicated metadata, not ordinary shadow rows. It refuses existing receipts; a partial write leaves evidence for inspection, not an automatic retry. It prints no account values. Run Python normally (no `-O`, which disables assertions).

```bash
python3 - <<'PY'
import json, os, re, stat
from pathlib import Path
uuid = re.compile(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}')
def private_dir(path):
    path = Path(path); s = path.lstat()
    assert stat.S_ISDIR(s.st_mode) and s.st_uid == 0 and not s.st_mode & 0o077
    assert str(path.resolve()) == str(path)
def private_read(path, maximum, secret=True):
    path = Path(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        assert stat.S_ISREG(s.st_mode) and s.st_uid == 0 and not s.st_mode & (0o077 if secret else 0o022)
        assert 0 < s.st_size <= maximum and str(path.resolve()) == str(path)
        raw = os.read(fd, maximum + 1)
        assert len(raw) == s.st_size
        return raw
    finally: os.close(fd)
def read_json(path, maximum=1048576, secret=True):
    try: return json.loads(private_read(path, maximum, secret))
    except Exception: raise RuntimeError('Private fixture input invalid; contents withheld') from None
assert os.geteuid() == 0
marker = read_json('/etc/agentor-native-dr-vm.json', 1024)
assert set(marker) == {'kind','phase','nonce'} and marker['kind'] == 'agentor-disposable-native-dr-vm'
nonce, phase = marker['nonce'], marker['phase']
assert isinstance(nonce, str) and uuid.fullmatch(nonce) and phase in ('source','destination')
assert Path('/sys/class/dmi/id/product_uuid').read_text().strip().lower() == nonce
assert [x for x in Path('/proc/cmdline').read_text().split() if x.startswith('agentor.native_dr_fixture=')] == ['agentor.native_dr_fixture=' + nonce]
boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
machine = Path('/etc/machine-id').read_text().strip()
assert uuid.fullmatch(boot) and re.fullmatch('[a-f0-9]{32}', machine)
root = Path('/var/lib/agentor-native-dr') / nonce; base = 'agdr' + nonce[:8]
private_dir('/run/agentor-native-dr')
for path in (root, root/'control', root/'recovery', root/'tls'): private_dir(path)
for name in ('client.crt','client.key','server.crt'): private_read(root/'tls'/name, 65536)
accounts = read_json('/run/agentor-native-dr/accounts.json', 8192)
assert set(accounts) == {'source','recovery'}
for login in accounts.values():
    assert set(login) == {'containerId','ownerId','email','password'}
    assert all(isinstance(v, str) for v in login.values())
    assert re.fullmatch('[a-f0-9]{64}', login['containerId'])
    assert re.fullmatch('[A-Za-z0-9_-]{1,128}', login['ownerId'])
    assert len(login['email']) <= 254 and re.fullmatch(r'[^\s@]+@[^\s@]+', login['email'])
    assert 12 <= len(login['password']) <= 256
assert accounts['source']['ownerId'] != accounts['recovery']['ownerId']
assert accounts['source']['containerId'] != accounts['recovery']['containerId']
owner = accounts['source']['ownerId']
if phase == 'source':
    global_record = read_json(root/'control/admin/workspace.v1.json')
    groups = read_json(root/'control/users'/owner/'worker-groups.json', secret=False)
    assert isinstance(groups, list) and len(groups) == 1 and groups[0]['userId'] == owner
    group_record = groups[0]['adminWorkspace']
    assert group_record['groupId'] == groups[0]['id']
else:
    evidence = read_json(root/'admin-dr-source.json', 2*1024*1024)
    assert evidence['version'] == 1 and len(evidence['state']['records']) == 2
    global_record, = [r for r in evidence['state']['records'] if r['kind'] == 'administrative']
    group_record, = [r for r in evidence['state']['records'] if r['kind'] == 'group-administrative']
assert global_record['kind'] == 'administrative' and global_record.get('ownerId') in (None, owner)
assert group_record['kind'] == 'group-administrative' and group_record['ownerId'] == owner
worker = 'sha256:58fd7a3811dca2ee58fd066024df0857c541ac14fa0b1f9dccab665153ba7b3c'
fingerprint = '6e9bd852e1a6490c091ea56027baa44bd33140a5cba04a5cac9dcbac43535296'
for record in (global_record, group_record):
    assert record['trusted'] is True and record['runtimeKind'] == 'incus-vm'
    assert record['nativeRuntime']['image']['fingerprint'] == fingerprint
ids = (global_record['id'], group_record['groupId'], group_record['id'])
assert len(set(ids)) == 3 and all(isinstance(v, str) and uuid.fullmatch(v) for v in ids)
config = dict(dataDir=str(root/'control'), containerPrefix='agentor-worker', incusEnabled=True,
    incusEndpoint='https://127.0.0.1:18443', incusProject=base, incusNetwork=base+'n',
    incusStoragePool=base+'p', incusWorkerImage=base+'-worker',
    incusInternalGatewayUrl='http://10.231.0.1:38000', incusNetworkHostEndpoint='',
    incusNetworkHostServerCertPath='', incusConverterStoragePool='', incusConverterSeedFingerprint='',
    incusClientCertPath=str(root/'tls/client.crt'), incusClientKeyPath=str(root/'tls/client.key'),
    incusServerCertPath=str(root/'tls/server.crt'))
receipts = {
    'fixture.json': dict(version=1, kind='agentor-private-native-dr-vm', nonce=nonce, bootId=boot,
                         machineId=machine, root=str(root), config=config),
    'administrative.json': dict(version=1, nonce=nonce, globalId=ids[0], groupId=ids[1],
        groupAdminId=ids[2], workerImage=worker, nativeFingerprint=fingerprint, **accounts)}
for name in receipts: assert not os.path.lexists('/run/agentor-native-dr/' + name)
for name, value in receipts.items():
    fd = os.open('/run/agentor-native-dr/' + name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f: json.dump(value, f); f.flush(); os.fsync(f.fileno())
print('Two private fixture receipts written; package preflight remains required')
PY
```

## 2. Package preflight, then source-only sample seeding

In the trusted guest checkout, save this one-off spec as `tests/api/admin-native-fixture-prepare.spec.ts` (refuse an existing file). It uses the actual receipt/container/package validators before any native call. With no extra seed variable it only checks packages. Source seeding must happen **before selecting the two paths/rebuilding**, while both dedicated admins are running and have no selected-volume refs. Do not run concurrent lifecycle/settings actions. Each exact existing sample directory makes seeding fail rather than overwrite; retain a partial fixture for diagnosis.

```typescript
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { requireAdminDrFixture, assertAdminDrPackage, adminDrConfig } from '../helpers/private-admin-native-dr-fixture';
import { readPrivateNativeDrFile } from '../helpers/private-native-dr-fixture';

const seed = String.raw`import os, re, sys
assert re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}', sys.argv[1])
for role, path in [('workspace','/workspace'),('agents','/home/agent/.agent-data'),('attached','/srv/native-dr-attached'),('detached','/srv/native-dr-detached')]:
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 try:
  for part in path.strip('/').split('/'):
   if part in ('native-dr-attached','native-dr-detached'):
    try: os.mkdir(part,0o755,dir_fd=fd)
    except FileExistsError: pass
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=child
  os.mkdir('native-dr-fixture',0o700,dir_fd=fd)
  sample=os.open('native-dr-fixture',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  try:
   out=os.open('data.bin',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=sample)
   try:
    data=('agentor-native-dr/'+sys.argv[1]+'/'+role+'\n').encode()+bytes([0,255,128,10,61,0])
    assert os.write(out,data)==len(data)
    os.fchown(out,12345,23456);os.fchmod(out,0o640)
    os.setxattr(out,'user.native-dr',bytes([0,255,128,10,61,0]))
    os.utime(out,ns=(1234567890000000000,)*2);os.fsync(out)
   finally: os.close(out)
   os.link('data.bin','hard',src_dir_fd=sample,dst_dir_fd=sample,follow_symlinks=False)
   os.symlink('data.bin','link',dir_fd=sample)
   os.fchown(sample,12343,23454);os.fchmod(sample,0o751)
   os.utime(sample,ns=(1234567891000000000,)*2);os.fsync(sample)
  finally: os.close(sample)
 finally: os.close(fd)
`;

test('one-off private administrative fixture preparation', async () => {
  test.skip(process.env.INCUS_ADMIN_INSTANCE_DR_TEST !== 'true');
  test.setTimeout(5*60_000);
  const f = await requireAdminDrFixture();
  const marker = JSON.parse(await readPrivateNativeDrFile('/etc/agentor-native-dr-vm.json',1024));
  expect(Object.keys(marker).sort()).toEqual(['kind','nonce','phase']);
  expect(marker.kind).toBe('agentor-disposable-native-dr-vm'); expect(marker.nonce).toBe(f.vm.nonce);
  expect((await readFile('/sys/class/dmi/id/product_uuid','utf8')).trim().toLowerCase()).toBe(f.vm.nonce);
  expect(['source','destination']).toContain(marker.phase);
  if (marker.phase === 'source') await assertAdminDrPackage(f,'source',false);
  await assertAdminDrPackage(f,'recovery',f.phase !== 'lifecycle');
  const action = process.env.INCUS_ADMIN_INSTANCE_DR_PREPARE;
  if (action === undefined) return;
  expect(action).toBe('seed'); expect(marker.phase).toBe('source'); expect(f.phase).toBe('capture');
  const { readInstanceAdministrativeRecords } = await import('../../orchestrator/server/utils/instance-restore-administrative');
  const { IncusAdminWorkspaceRuntime } = await import('../../orchestrator/server/utils/incus-admin-workspace-runtime');
  const { ManagedVolumeStore } = await import('../../orchestrator/server/utils/managed-volume-store');
  const config = {...adminDrConfig(f,'source'),incusNetworkHostEndpoint:'https://127.0.0.1:18445',incusNetworkHostServerCertPath:f.vm.config.incusServerCertPath};
  const records = () => readInstanceAdministrativeRecords(config.dataDir);
  const before = await records();
  expect(before.map(r=>r.id).sort()).toEqual([f.receipt.globalId,f.receipt.groupAdminId].sort());
  const runtime = new IncusAdminWorkspaceRuntime(config,undefined,undefined,{
    readRecord: async id => {const found=(await records()).find(r=>r.id===id);if(!found)throw Error('Fixture authority missing');return found;},
    managedStore: async () => {const store=new ManagedVolumeStore(config.dataDir);await store.init();return store;}
  });
  for (const record of before) {
    expect(record.status).toBe('running'); expect(record.nativeRuntime?.incarnation).toMatch(/^[a-f0-9-]{36}$/);
    expect(record.nativeRuntime?.selectedVolumeIds ?? []).toEqual([]);
    const vm = await runtime.assertOwned(record); expect(vm.status).toBe('Running');
    expect(Object.keys(vm.devices).sort()).toEqual(['agents','eth0','root','workspace']);
    const result = await runtime.client.exec(vm.name,['timeout','60','python3','-c',seed,record.id],{command:[],user:0,group:0});
    expect(result.returnCode).toBe(0);
    expect((await runtime.assertOwned(record)).config['volatile.uuid']).toBe(vm.config['volatile.uuid']);
  }
  expect(await records()).toEqual(before);
});
```

From `tests`, first run the read-only package check with `capture` on source or `restore` on destination:

```bash
INCUS_ADMIN_INSTANCE_DR_TEST=true INCUS_ADMIN_INSTANCE_DR_PHASE=capture \
  npx playwright test --config=playwright.modules.config.ts api/admin-native-fixture-prepare.spec.ts
```

Only on the source, explicitly seed the new sample subdirectories:

```bash
INCUS_ADMIN_INSTANCE_DR_TEST=true INCUS_ADMIN_INSTANCE_DR_PHASE=capture INCUS_ADMIN_INSTANCE_DR_PREPARE=seed \
  npx playwright test --config=playwright.modules.config.ts api/admin-native-fixture-prepare.spec.ts
```

Then continue the bootstrap's supported selected-path settings/rebuild, stopped detached-history edit and archived-shadow fixture setup. The actual encrypted acceptance test checks all eight files' hashes, ownership, mode, nanosecond mtime, binary xattr, hardlink identity and literal symlink after capture/restore. Keep source receipt/accounts and three transfer artifacts private when moving to the separate destination. Leave `INCUS_ADMIN_INSTANCE_DR_PREPARE` unset for every acceptance phase.

Preparation checks: all shell/Python blocks parse; the extracted TypeScript spec passes the Nuxt-aware fixture typecheck and skips with the opt-in unset. Owned-temp executions cover source/destination receipt generation, existing-receipt refusal, wrong marker/DMI, broad credential mode and symlink rejection. The actual acceptance sample reader verifies all four seeded roles and duplicate/symlink refusal. These checks do not prove live package readiness, networking, native execution or encrypted restore; retain the real gate's separate phase results. Do not interpret receipt creation or successful sample writing as acceptance.
