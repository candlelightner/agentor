import { expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { privateTestDocker } from './private-test-docker';

const DATA = 'agentor-test_agentor-data';
export function validateLegacyGroupFixtureSource(source: any) {
  const env = new Map((source?.Config?.Env ?? []).map((value: string) => {
    const at = value.indexOf('='); return [value.slice(0, at), value.slice(at + 1)];
  }));
  const mounts = source?.Mounts?.filter((mount: any) => mount.Destination === '/data');
  if (!/^[a-f0-9]{64}$/.test(source?.Id ?? '') || !/^sha256:[a-f0-9]{64}$/.test(source?.Image ?? '') ||
      source.Name !== '/agentor-orchestrator' || source.Config?.Labels?.['com.docker.compose.project'] !== 'agentor-test' ||
      source.Config?.Labels?.['com.docker.compose.service'] !== 'agentor-orchestrator' ||
      env.get('DATA_DIR') !== '/data' || env.get('ALLOW_ADMIN_DIAGNOSTICS') !== 'true' || env.get('INCUS_ENABLED') === 'true' ||
      source.HostConfig?.Devices?.length || source.HostConfig?.Privileged || source.HostConfig?.NetworkMode === 'host' || source.HostConfig?.PidMode === 'host' ||
      mounts?.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== DATA || mounts[0].RW !== true)
    throw Error('Legacy MCP principal requires the exact private Docker CI fixture');
}

// Only a diagnostic principal is seeded; no administrative runtime is created.
export const LEGACY_GROUP_PRINCIPAL_CAS = String.raw`
const fs=require('node:fs'),assert=require('node:assert/strict'),{isDeepStrictEqual}=require('node:util'),{randomUUID}=require('node:crypto');
const root='/fixture-data';
const [action,owner,groupId,raw]=process.argv.slice(1),record=JSON.parse(raw);
assert(['insert','remove'].includes(action));assert(/^[A-Za-z0-9_-]{1,128}$/.test(owner));assert(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(groupId));
assert(record.schemaVersion===1&&record.kind==='group-administrative'&&record.trusted===true&&record.runtimeKind==='legacy-docker');
assert(record.ownerId===owner&&record.groupId===groupId&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id)&&record.status==='stopped'&&!record.nativeRuntime);
const directory=root+'/users/'+owner,path=directory+'/worker-groups.json';
assert(fs.realpathSync(directory)===directory);
const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
let before,groups;
try{before=fs.fstatSync(fd);assert(before.isFile()&&before.uid===process.getuid()&&before.nlink===1&&!(before.mode&0o022)&&before.size>0&&before.size<=1048576);groups=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
assert(Array.isArray(groups)&&groups.length<=1000);
const matches=groups.filter(group=>group.id===groupId);assert(matches.length===1&&matches[0].userId===owner);
const group=matches[0];
if(action==='insert'){if(Object.hasOwn(group,'adminWorkspace'))throw Error('Fixture binding already exists');group.adminWorkspace=record;}
else{if(!isDeepStrictEqual(group.adminWorkspace,record))throw Error('Fixture binding changed');delete group.adminWorkspace;}
const temporary=path+'.mcp-fixture-'+randomUUID();let out;
try{out=fs.openSync(temporary,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,before.mode&0o777);fs.fchmodSync(out,before.mode&0o777);fs.writeFileSync(out,JSON.stringify(groups,null,2));fs.fsyncSync(out);fs.closeSync(out);out=undefined;
 const current=fs.lstatSync(path);assert(['dev','ino','size','mtimeMs','ctimeMs'].every(key=>current[key]===before[key]));
 fs.renameSync(temporary,path);const parent=fs.openSync(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(parent);}finally{fs.closeSync(parent);}
}finally{if(out!==undefined)fs.closeSync(out);if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
console.log(action);
`;

export async function legacyGroupMcpPrincipal(request: APIRequestContext, ownerId: string, groupId: string) {
  const base = new URL(process.env.BASE_URL || 'http://localhost:3000');
  if (!['localhost', '127.0.0.1'].includes(base.hostname) || base.port !== '3000') throw Error('Private CI loopback required');
  const docker = await privateTestDocker(); // Marker/cgroup/daemon proof before Docker access.
  const source = JSON.parse(await docker('inspect', 'agentor-orchestrator'))[0];
  validateLegacyGroupFixtureSource(source);
  const record = { schemaVersion: 1, id: randomUUID(), kind: 'group-administrative', trusted: true,
    runtimeKind: 'legacy-docker', ownerId, groupId, services: ['terminal', 'editor', 'desktop'], status: 'stopped',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  let submitted = false, inserted = false;
  const change = async (action: 'insert' | 'remove') => {
    const currentDocker = await privateTestDocker();
    const current = JSON.parse(await currentDocker('inspect', source.Id))[0];
    validateLegacyGroupFixtureSource(current);
    if (current.Id !== source.Id || current.Image !== source.Image || !current.State.Running) throw Error('Fixture application identity changed');
    const volume = JSON.parse(await currentDocker('volume', 'inspect', DATA))[0];
    if (volume.Driver !== 'local' || Object.keys(volume.Options ?? {}).length ||
        volume.Labels?.['com.docker.compose.project'] !== 'agentor-test' || volume.Labels?.['com.docker.compose.volume'] !== 'agentor-data')
      throw Error('Fixture DATA ownership changed');
    if (await currentDocker('ps', '-aq', '--no-trunc', '--filter', 'volume=' + DATA) !== source.Id) throw Error('Fixture DATA has another consumer');
    await currentDocker('stop', '--time', '10', source.Id);
    const stopped = JSON.parse(await currentDocker('inspect', source.Id))[0];
    validateLegacyGroupFixtureSource(stopped);
    if (stopped.Id !== source.Id || stopped.State.Running || stopped.State.Pid !== 0 || stopped.State.Paused || stopped.State.Restarting) throw Error('Fixture application did not stop');
    // Any uncertain write leaves the fixture stopped for diagnosis, not repair.
    if (action === 'insert') submitted = true;
    const result = await currentDocker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--user', '0:0', '--pids-limit', '16', '--memory', '128m', '--cpus', '0.5',
      '--log-driver', 'none', '--mount', 'type=volume,src=' + DATA + ',dst=/fixture-data,volume-nocopy',
      '--entrypoint', 'node', source.Image, '-e', LEGACY_GROUP_PRINCIPAL_CAS, action, ownerId, groupId, JSON.stringify(record));
    if (result !== action) throw Error('Fixture binding acknowledgement is unavailable');
    inserted = action === 'insert';
    await currentDocker('start', source.Id);
    await expect.poll(async () => {
      try {
        const response = await request.get('/api/worker-groups/' + groupId, { timeout: 3000 });
        if (response.status() !== 200) return false;
        const group = await response.json();
        return action === 'insert' ? group.adminWorkspace?.id === record.id && group.adminWorkspace?.runtimeKind === 'legacy-docker'
          : !Object.hasOwn(group, 'adminWorkspace');
      } catch { return false; }
    }, { timeout: 60_000 }).toBe(true);
  };
  return { workspaceId: record.id, insert: () => change('insert'), remove: async () => {
    if (!submitted) return;
    if (!inserted) throw Error('Fixture binding outcome is uncertain; preserve the stopped fixture');
    await change('remove');
  } };
}
