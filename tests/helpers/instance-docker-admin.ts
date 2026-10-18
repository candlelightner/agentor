import { strict as assert } from 'node:assert';

export const HISTORICAL_ADMIN_VOLUMES = ['agentor-admin-workspace-data', 'agentor-admin-agent-data'] as const;
/** This gate covers the historical Docker baseline, never native provisioning. */
export function historicalDockerAdmin(containers: any, record: any, info: any) {
  assert(Array.isArray(containers) && containers.length === 1, 'Fresh Docker fixture must contain only its existing platform admin, with no ordinary workers');
  const admin = containers[0];
  assert(record?.schemaVersion === 1 && record.trusted === true && record.kind === 'administrative' &&
    typeof record.id === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.id) &&
    ['running', 'stopped'].includes(record.status) && record.groupId === undefined && record.nativeRuntime === undefined &&
    (record.ownerId === undefined || typeof record.ownerId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(record.ownerId)) &&
    (record.runtimeKind === undefined || record.runtimeKind === 'legacy-docker'),
    'This historical Docker gate requires existing dedicated legacy authority; native defaults require the separate private native DR gate');
  assert(admin.id === record.id && admin.administrativeKind === 'platform' && admin.runtimeKind === 'legacy-docker' &&
    admin.userId === (record.ownerId || '__agentor_admin__') && admin.containerName === 'agentor-admin-workspace' &&
    typeof admin.containerId === 'string' && /^[a-f0-9]{64}$/.test(admin.containerId) && admin.status === record.status, 'Unexpected administrative projection');
  assert(info?.Id === admin.containerId && info.Name === '/agentor-admin-workspace' &&
    info.Config?.Labels?.['agentor.administrative'] === 'true' && info.Config.Labels['agentor.admin.workspace-id'] === record.id &&
    info.Config.Labels['agentor.managed'] === 'false' && info.State?.Running === (record.status === 'running'), 'Untrusted administrative Docker compute');
  for (const [index, path] of ['/workspace', '/home/agent/.agent-data'].entries()) {
    const mounts = (info.Mounts ?? []).filter((mount: any) => mount.Destination === path);
    assert(mounts.length === 1 && mounts[0].Type === 'volume' && mounts[0].Name === HISTORICAL_ADMIN_VOLUMES[index] && mounts[0].RW === true,
      'Administrative canonical storage differs from the historical fixture');
  }
  return { id: record.id as string, containerId: admin.containerId as string, containerName: admin.containerName as string };
}

/** Snapshot all bytes/metadata in the two fresh fixture admin volumes, including
 * pre-existing control data. Historical TAR timestamps use whole seconds. */
export const INSPECT_ADMIN_VOLUME = String.raw`import hashlib,json,os,stat,sys
root=sys.argv[1];rows=[];inodes={};total=0
if os.path.realpath(root)!=root or not stat.S_ISDIR(os.lstat(root).st_mode): raise ValueError('Unsafe fixture volume root')
def inspect(relative):
 global total
 path=root+('/'+relative if relative else '');s=os.lstat(path);kind=stat.S_IFMT(s.st_mode)
 if kind not in (stat.S_IFDIR,stat.S_IFREG,stat.S_IFLNK): raise ValueError('Special fixture entry')
 row=dict(path=relative,mode=stat.S_IMODE(s.st_mode),uid=s.st_uid,gid=s.st_gid,mtime=int(s.st_mtime),kind=kind)
 if stat.S_ISLNK(s.st_mode): row['link']=os.readlink(path)
 if stat.S_ISREG(s.st_mode):
  total+=s.st_size
  if total>512*1024*1024: raise ValueError('Fixture byte bound exceeded')
  digest=hashlib.sha256()
  with open(path,'rb') as f:
   for chunk in iter(lambda:f.read(1024*1024),b''): digest.update(chunk)
  row.update(size=s.st_size,hash=digest.hexdigest(),hardlink=inodes.setdefault((s.st_dev,s.st_ino),relative))
 rows.append(row)
 if len(rows)>20000: raise ValueError('Fixture entry bound exceeded')
 if stat.S_ISDIR(s.st_mode):
  for name in sorted(os.listdir(path)): inspect(relative+'/'+name if relative else name)
inspect('');print(json.dumps(rows,sort_keys=True))
`;
