import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { privateTestDocker } from '../helpers/private-test-docker';
import { historicalDockerAdmin, HISTORICAL_ADMIN_VOLUMES, INSPECT_ADMIN_VOLUME } from '../helpers/instance-docker-admin';
import { createWorker } from '../helpers/worker-lifecycle';
import { TEST_ADMIN_EMAIL, TEST_ADMIN_NAME, TEST_ADMIN_PASSWORD } from '../global-setup';

const sourceURL = process.env.BASE_URL || 'http://localhost:3000';
// This fixture reveals/imports its generated recovery key; never persist API bodies in traces.
test.use({ trace: 'off', video: 'off' });
test.skip(process.env.INSTANCE_DOCKER_BACKUP_TEST !== 'true', 'Run alone through scripts/test-backup-integration.py --suite instance');
async function terminal(request: APIRequestContext, id: string) {
  let job: any;
  await expect.poll(async () => {
    const response = await request.get(`/api/admin/instance-backups/jobs/${id}`);
    expect(response.status()).toBe(200); job = await response.json();
    return job.status;
  }, { timeout: 180_000, intervals: [250, 1000] }).toMatch(/succeeded|failed|cancelled/);
  expect(job.status, JSON.stringify({ error: job.error, errorCode: job.errorCode })).toBe('succeeded');
  return job;
}
async function cookies(request: APIRequestContext) {
  return (await request.storageState()).cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

const seedScript = String.raw`
import hashlib,os,sys
root,marker=sys.argv[1:];os.makedirs(root,exist_ok=True)
for i in range(2000):
 p=root+'/file-'+str(i);open(p,'wb').write(hashlib.sha256((marker+str(i)).encode()).digest()*128)
 os.chown(p,12345,23456);os.chmod(p,0o640);os.utime(p,ns=(1690000000000000000,1690000000000000000))
os.link(root+'/file-0',root+'/hard');os.symlink('file-0',root+'/link')
`;
const inspectScript = String.raw`
import hashlib,json,os,stat,sys
p=sys.argv[1];rows=[]
for name in sorted(os.listdir(p)):
 f=p+'/'+name;s=os.lstat(f)
 rows.append(dict(name=name,mode=stat.S_IMODE(s.st_mode),uid=s.st_uid,gid=s.st_gid,
  mtime=int(s.st_mtime),link=os.readlink(f) if stat.S_ISLNK(s.st_mode) else None,
  hash=hashlib.sha256(open(f,'rb').read()).hexdigest() if stat.S_ISREG(s.st_mode) else None))
print(json.dumps(dict(entries=rows,hard=os.stat(p+'/file-0').st_ino==os.stat(p+'/hard').st_ino),sort_keys=True))
`;

test('private Docker whole-instance UI backup produces an encrypted multi-volume artifact and restores an empty recovery installation', async ({ page, request, browser }) => {
  test.setTimeout(900_000);
  const docker = await privateTestDocker(); // Fails before Docker access without the runner marker.
  expect(new URL(sourceURL).hostname).toMatch(/^(localhost|127\.0\.0\.1)$/);
  expect(new URL(sourceURL).port).toBe('3000');
  const source = JSON.parse(await docker('inspect', 'agentor-orchestrator'))[0];
  expect(source.Config.Labels['com.docker.compose.project']).toBe('agentor-test');
  expect(source.Mounts.find((mount: any) => mount.Destination === '/data')).toMatchObject({ Type: 'volume', Name: 'agentor-test_agentor-data' });
  const readAdmin = async (containerId: string) => JSON.parse(await docker('exec', containerId, 'node', '-e',
    "const f=require('node:fs'),p='/data/admin/workspace.v1.json';try{const d=f.openSync(p,f.constants.O_RDONLY|f.constants.O_NOFOLLOW);try{const s=f.fstatSync(d);if(!s.isFile()||s.size>65536)throw Error('Invalid fixture admin');console.log(f.readFileSync(d,'utf8'))}finally{f.closeSync(d)}}catch(e){if(e.code!=='ENOENT')throw e;console.log('null')}"));
  const containers = await request.get('/api/containers'); expect(containers.status()).toBe(200);
  const sourceAdmin = historicalDockerAdmin(await containers.json(), await readAdmin(source.Id),
    JSON.parse(await docker('inspect', 'agentor-admin-workspace'))[0]);
  expect(await (await request.get('/api/archived')).json()).toEqual([]);

  const nonce = randomUUID(), destinationName = 'agentor-backup-recovery-' + nonce;
  const destinationData = destinationName + '-data', destinationNetwork = destinationName + '-net';
  const destinationURL = 'http://localhost:3401'; // Published only inside the private runner's network namespace.
  const scratch = await mkdtemp(join(tmpdir(), 'agentor-instance-docker-'));
  const encrypted = join(scratch, 'instance.backup');
  let destinationCreated = false, destinationVolumeCreated = false, destinationNetworkCreated = false;
  let destinationRequest: APIRequestContext | undefined;
  let sourceStopped = false;
  let capturedVolumes: string[] = [];
  const sourceWorkers: Array<{ id: string; containerId: string; containerName: string }> = [];
  const expected = new Map<string, string>(), expectedAdmin = new Map<string, string>();
  let stoppedAdmin: any;
  const inspectAdmin = async (name: string) => docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
    '--security-opt', 'no-new-privileges:true', '--user', '0:0', '--mount', 'type=volume,src=' + name + ',dst=/volume,readonly',
    '--entrypoint', 'python3', source.Image, '-c', INSPECT_ADMIN_VOLUME, '/volume');
  try {
    // This historical baseline bootstraps a dedicated admin automatically. Its
    // existing data is part of the snapshot, never an ordinary worker exemption.
    for (const [role, root] of [['workspace', '/workspace'], ['agents', '/home/agent/.agent-data']])
      await docker('exec', '--user', '0:0', sourceAdmin.containerId, 'python3', '-c', seedScript, root + '/whole-instance-fixture', 'admin-' + role);
    const stoppingAdmin = await request.post('/api/admin/workspace/stop'); expect(stoppingAdmin.status()).toBe(200);
    expect(await stoppingAdmin.json()).toMatchObject({ id: sourceAdmin.id, status: 'stopped', trusted: true });
    stoppedAdmin = await readAdmin(source.Id);
    const stoppedProjection = (await (await request.get('/api/containers')).json()).filter((value: any) => value.administrativeKind);
    historicalDockerAdmin(stoppedProjection, stoppedAdmin, JSON.parse(await docker('inspect', sourceAdmin.containerId))[0]);
    for (const name of HISTORICAL_ADMIN_VOLUMES) expectedAdmin.set(name, await inspectAdmin(name));
    const environment = await request.post('/api/environments', { data: { name: 'Whole-instance fixture ' + nonce,
      dockerEnabled: false, networkMode: 'full', enabledCapabilityIds: [], enabledInstructionIds: [], setupScript: '' } });
    expect(environment.status()).toBe(201);
    const environmentId = (await environment.json()).id;
    for (const label of ['stopped', 'archived']) {
      const worker = await createWorker(request, { displayName: 'Whole-instance ' + label, environmentId });
      sourceWorkers.push(worker);
      for (const [role, root] of [['workspace', '/workspace'], ['agents', '/home/agent/.agent-data']]) {
        const path = root + '/whole-instance-fixture';
        await docker('exec', '--user', '0:0', worker.containerId, 'python3', '-c', seedScript, path, label + '-' + role);
        expected.set(worker.containerName + '-' + role,
          await docker('exec', '--user', '0:0', worker.containerId, 'python3', '-c', inspectScript, path));
      }
    }
    const paths = Object.fromEntries(sourceWorkers.map(worker => [worker.id, ['/workspace', '/home/agent/.agent-data']]));
    const initial = await request.put('/api/backup-settings', { data: { enabled: false, selection: 'selected',
      workspaceIds: sourceWorkers.map(worker => worker.id), selectedPathsByWorkspace: paths,
      persistSelectedDirectories: true, intervalMinutes: 53, retentionCount: 9 } });
    expect(initial.status()).toBe(200);
    expect((await request.post(`/api/containers/${sourceWorkers[0]!.id}/stop`)).status()).toBe(200);
    expect((await request.post(`/api/containers/${sourceWorkers[1]!.id}/archive`)).status()).toBe(200);
    const deselected = await request.put('/api/backup-settings', { data: { selection: 'selected',
      workspaceIds: [sourceWorkers[0]!.id], selectedPathsByWorkspace: paths, retentionCount: 11 } });
    expect(deselected.status(), await deselected.text()).toBe(200);

    // Actual production UI/API, without route interception.
    await page.goto(sourceURL);
    await page.getByTestId('open-instance-backups').click();
    const modal = page.getByTestId('instance-backup-management');
    await modal.getByLabel('Instance backup destination').selectOption('local');
    const starting = page.waitForResponse(response => response.url().endsWith('/api/admin/instance-backups') && response.request().method() === 'POST');
    await modal.getByRole('button', { name: 'Start instance backup' }).click();
    const accepted = await starting; expect(accepted.status()).toBe(202);
    const capture = await accepted.json(); await terminal(request, capture.jobId);
    const sourceArtifact = await (await request.get(`/api/admin/instance-backups/artifacts/${capture.jobId}`)).json();
    expect(sourceArtifact.integrityStatus).toBe('verified');
    expect(sourceArtifact.manifest.formatVersion).toBe(1);
    capturedVolumes = sourceArtifact.manifest.volumes.map((volume: any) => volume.name);
    for (const name of expected.keys()) expect(capturedVolumes).toContain(name);
    for (const [index, name] of HISTORICAL_ADMIN_VOLUMES.entries())
      expect(sourceArtifact.manifest.volumes.find((volume: any) => volume.name === name)).toMatchObject({ kind: index ? 'admin-agent-data' : 'admin-workspace' });
    expect(await readAdmin(source.Id)).toEqual(stoppedAdmin);
    expect(JSON.parse(await docker('inspect', sourceAdmin.containerId))[0].State.Running).toBe(false);
    for (const [name, baseline] of expectedAdmin) expect(JSON.parse(await inspectAdmin(name)), name).toEqual(JSON.parse(baseline));
    const allowedNames = new Set([...expected.keys(), ...expectedAdmin.keys(), 'agentor-traefik-certs']);
    expect(capturedVolumes.every(name => allowedNames.has(name))).toBe(true);
    const download = await fetch(`${sourceURL}/api/admin/instance-backups/artifacts/${capture.jobId}/download`, { headers: { Cookie: await cookies(request) } });
    expect(download.status).toBe(200);
    await pipeline(Readable.fromWeb(download.body as any), createWriteStream(encrypted, { mode: 0o600 }));
    expect((await readFile(encrypted)).subarray(0, 26).toString()).toBe('AGENTOR-INSTANCE-BACKUP-1\n');
    const revealed = await request.post('/api/backups/recovery-key/reveal', { data: { password: TEST_ADMIN_PASSWORD } });
    expect(revealed.status()).toBe(200);
    const { keyMaterial } = await revealed.json(); // Generated fixture key remains in memory only.

    // A shared test daemon cannot restore same-name source volumes. Retire
    // only this fixture's stopped compute/Traefik after preserving its artifact.
    await docker('stop', source.Id); sourceStopped = true;
    for (const worker of sourceWorkers) {
      const ids = (await docker('ps', '-aq', '--filter', 'label=agentor.id=' + worker.id)).split(/\s+/).filter(Boolean);
      for (const id of ids) {
        const info = JSON.parse(await docker('inspect', id))[0];
        expect(info.Config.Labels['agentor.id']).toBe(worker.id);
        await docker('rm', '-f', id);
      }
    }
    const retiringAdmin = JSON.parse(await docker('inspect', sourceAdmin.containerId))[0];
    historicalDockerAdmin(stoppedProjection, stoppedAdmin, retiringAdmin);
    await docker('rm', sourceAdmin.containerId); // Exact stopped fixture compute; data remains in the verified artifact.
    for (const id of (await docker('ps', '-aq', '--filter', 'label=agentor.managed=traefik')).split(/\s+/).filter(Boolean)) {
      const info = JSON.parse(await docker('inspect', id))[0];
      expect(info.Mounts.some((mount: any) => mount.Name === 'agentor-traefik-certs')).toBe(true);
      await docker('rm', '-f', id);
    }
    for (const name of capturedVolumes) {
      expect(await docker('ps', '-aq', '--filter', 'volume=' + name)).toBe('');
      await docker('volume', 'rm', name);
    }

    await docker('volume', 'create', '--label', 'agentor.backup-acceptance=' + nonce, destinationData); destinationVolumeCreated = true;
    await docker('network', 'create', '--label', 'agentor.backup-acceptance=' + nonce, destinationNetwork); destinationNetworkCreated = true;
    await docker('run', '-d', '--name', destinationName, '--label', 'agentor.backup-acceptance=' + nonce,
      '--network', destinationNetwork, '-p', '127.0.0.1:3401:3000',
      '-v', '/var/run/docker.sock:/var/run/docker.sock', '-v', destinationData + ':/data',
      '-e', 'BETTER_AUTH_URL=' + destinationURL, '-e', 'DATA_DIR=/data',
      '-e', 'DOCKER_NETWORK=' + destinationNetwork, '-e', 'WORKER_IMAGE=agentor-worker:latest',
      '-e', 'ORCHESTRATOR_IMAGE=' + source.Image, '-e', 'ALLOW_FAKE_BACKUP_PROVIDER=true',
      '-e', 'AGENTOR_INSTANCE_RECOVERY_MODE=true', source.Image); destinationCreated = true;
    await expect.poll(async () => fetch(destinationURL + '/api/health').then(response => response.status, () => 0), { timeout: 90_000 }).toBe(200);
    destinationRequest = await playwrightRequest.newContext({ baseURL: destinationURL, extraHTTPHeaders: { Origin: destinationURL } });
    expect((await destinationRequest.post('/api/setup/create-admin', { data: { email: TEST_ADMIN_EMAIL,
      password: TEST_ADMIN_PASSWORD, name: TEST_ADMIN_NAME } })).ok()).toBe(true);
    expect((await destinationRequest.post('/api/auth/sign-in/email', { data: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD } })).ok()).toBe(true);
    // Recovery mode must suppress automatic admin provisioning even after setup.
    expect(await (await destinationRequest.get('/api/containers')).json()).toEqual([]);
    expect(await (await destinationRequest.get('/api/archived')).json()).toEqual([]);
    expect(await readAdmin(JSON.parse(await docker('inspect', destinationName))[0].Id)).toBeNull();
    expect((await destinationRequest.post('/api/backups/recovery-key/import', { data: { kit: keyMaterial } })).ok()).toBe(true);
    const uploaded = await fetch(destinationURL + '/api/admin/instance-backups/import', { method: 'POST',
      headers: { Cookie: await cookies(destinationRequest), Origin: destinationURL, 'Content-Type': 'application/octet-stream',
        'Content-Length': String((await stat(encrypted)).size), 'Idempotency-Key': 'fixture-import-' + nonce },
      body: createReadStream(encrypted) as any, duplex: 'half' } as any);
    expect(uploaded.status).toBe(202);
    const imported = await terminal(destinationRequest, (await uploaded.json() as any).jobId);
    const targetArtifacts = await (await destinationRequest.get('/api/admin/instance-backups')).json();
    const targetArtifact = targetArtifacts.artifacts.find((artifact: any) => artifact.id === imported.artifactId);
    expect(targetArtifact).toBeTruthy();
    const beforeStart = JSON.parse(await docker('inspect', destinationName))[0].State.StartedAt;
    const context = await browser.newContext({ storageState: await destinationRequest.storageState() });
    try {
      const recovery = await context.newPage(); await recovery.goto(destinationURL);
      await recovery.getByTestId('open-instance-backups').click();
      const targetModal = recovery.getByTestId('instance-backup-management');
      await targetModal.getByTestId('instance-artifact-' + targetArtifact.id).getByRole('button', { name: 'Inspect & restore' }).click();
      const panel = targetModal.getByTestId('instance-restore-panel');
      await expect(panel.getByTestId('instance-restore-preflight')).toContainText('Destination is ready', { timeout: 60_000 });
      await panel.getByLabel(/current Agentor database and control-plane data/).check();
      await panel.getByLabel(/separately supplied or recorded required external configuration/).check();
      const restoring = recovery.waitForResponse(response => response.url().endsWith('/restore') && response.request().method() === 'POST');
      await panel.getByRole('button', { name: 'Apply verified snapshot and restart Agentor' }).click();
      const applying = await restoring; expect(applying.status()).toBe(202);
      const restoreId = (await applying.json()).jobId;
      await expect.poll(async () => JSON.parse(await docker('inspect', destinationName))[0].State.StartedAt, { timeout: 180_000 }).not.toBe(beforeStart);
      await expect.poll(async () => fetch(destinationURL + '/api/health').then(response => response.status, () => 0), { timeout: 90_000 }).toBe(200);
      await destinationRequest.dispose();
      destinationRequest = await playwrightRequest.newContext({ baseURL: destinationURL, extraHTTPHeaders: { Origin: destinationURL } });
      expect((await destinationRequest.post('/api/auth/sign-in/email', { data: { email: TEST_ADMIN_EMAIL, password: TEST_ADMIN_PASSWORD } })).ok()).toBe(true);
      await terminal(destinationRequest, restoreId);
    } finally { await context.close(); }
    expect(await (await destinationRequest.get('/api/backup-settings')).json()).toMatchObject({ intervalMinutes: 53,
      retentionCount: 11, workspaceIds: [sourceWorkers[0]!.id], selectedPathsByWorkspace: paths });
    const records = JSON.parse(await docker('exec', destinationName, 'node', '-e',
      "const f=require('node:fs'),p='/data/users';const all=f.readdirSync(p).flatMap(u=>{try{return JSON.parse(f.readFileSync(p+'/'+u+'/workers.json','utf8'))}catch{return[]}});console.log(JSON.stringify(all.filter(w=>JSON.parse(process.argv[1]).includes(w.id))))",
      JSON.stringify(sourceWorkers.map(worker => worker.id))));
    expect(records.find((worker: any) => worker.id === sourceWorkers[0]!.id)).toMatchObject({ status: 'active', desiredRuntimeStatus: 'stopped' });
    expect(records.find((worker: any) => worker.id === sourceWorkers[1]!.id)).toMatchObject({ status: 'archived', desiredRuntimeStatus: 'stopped' });
    for (const worker of sourceWorkers) expect(await docker('ps', '-q', '--filter', 'label=agentor.id=' + worker.id)).toBe('');
    const archived = await (await destinationRequest.get('/api/archived')).json();
    expect(archived.some((worker: any) => worker.id === sourceWorkers[1]!.id)).toBe(true);
    expect(await readAdmin(JSON.parse(await docker('inspect', destinationName))[0].Id)).toEqual(stoppedAdmin);
    expect(await (await destinationRequest.get('/api/containers')).json()).toEqual([]);
    expect(await docker('ps', '-aq', '--filter', 'label=agentor.admin.workspace-id=' + sourceAdmin.id)).toBe('');
    for (const [name, baseline] of expectedAdmin) expect(JSON.parse(await inspectAdmin(name)), name).toEqual(JSON.parse(baseline));
    for (const [name, baseline] of expected) {
      expect(JSON.parse(await docker('volume', 'inspect', name))[0].Name).toBe(name);
      const actual = await docker('run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--cap-add', 'DAC_READ_SEARCH',
        '--security-opt', 'no-new-privileges:true', '--user', '0:0', '--mount', 'type=volume,src=' + name + ',dst=/volume,readonly',
        '--entrypoint', 'python3', source.Image, '-c', inspectScript, '/volume/whole-instance-fixture');
      expect(JSON.parse(actual), name).toEqual(JSON.parse(baseline));
    }
  } finally {
    await destinationRequest?.dispose();
    if (destinationCreated) {
      for (const id of (await docker('ps', '-aq', '--filter', 'label=agentor.instance-restore-helper=true')).split(/\s+/).filter(Boolean)) {
        const info = JSON.parse(await docker('inspect', id))[0];
        if (info.Mounts.some((mount: any) => mount.Name === destinationData)) await docker('rm', '-f', id);
      }
      await docker('rm', '-f', destinationName);
    }
    if (destinationVolumeCreated) await docker('volume', 'rm', destinationData);
    if (destinationNetworkCreated) await docker('network', 'rm', destinationNetwork);
    // Source app remains stopped after handoff; the private runner removes its
    // own compose project/data. Before handoff, ordinary API fixture cleanup applies.
    if (!sourceStopped) for (const worker of sourceWorkers) await request.delete('/api/containers/' + worker.id).catch(() => {});
    await rm(scratch, { recursive: true, force: true });
  }
});
