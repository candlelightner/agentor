import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { ApiClient } from '../helpers/api-client';
import { createTestUser, deleteTestUser } from '../helpers/test-users';

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8', timeout: 45_000 }).trim();
const inspect = (name: string) => JSON.parse(docker('inspect', name))[0];
async function finished(request: APIRequestContext, id: string) {
  let value: any;
  await expect.poll(async () => {
    value = await (await request.get(`/api/volumes/${id}`)).json();
    return value.operation?.stage;
  }, { timeout: 120_000, intervals: [500, 1000, 2000] }).toMatch(/complete|failed/);
  expect(value.operation, JSON.stringify(value)).toMatchObject({ stage: 'complete' });
  return value;
}

test.describe.serial('Managed local persistence', () => {
  test.skip(!existsSync('/src/orchestrator'), 'Requires the isolated Docker test runner');
  let worker: Awaited<ReturnType<typeof createWorker>>, environmentId: string;
  const volumeIds: string[] = [];
  let sizeJobId = '';
  test.beforeAll(async ({ request }) => {
    const env = await new ApiClient(request).createEnvironment({ name: `Persistence-${Date.now()}`, dockerEnabled: false });
    expect(env.status, JSON.stringify(env.body)).toBe(201); environmentId = env.body.id;
    worker = await createWorker(request, { displayName: `Persistence-${Date.now()}`, environmentId });
  });
  test.afterAll(async ({ request }) => {
    if (worker) await cleanupWorker(request, worker.id);
    for (const id of volumeIds) await request.post(`/api/volumes/${id}`, { data: { action: 'delete', confirmed: true } });
    if (environmentId) await request.delete(`/api/environments/${environmentId}`);
  });

  test('live persistence copies files and survives restart as a declared mount without enabling privilege', async ({ request }) => {
    docker('exec', worker.containerName, 'python3', '-c', 'from pathlib import Path; p=Path("/home/agent/models"); p.mkdir(); (p/"before").write_text("original")');
    const before = inspect(worker.containerName);
    expect(before.HostConfig.Privileged).toBe(false);
    const noAck = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/models', mode: 'live' } });
    expect(noAck.status()).toBe(409);
    const response = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/models', mode: 'live', acknowledgePrivileged: true } });
    expect(response.status(), await response.text()).toBe(200);
    const volume = await response.json(); volumeIds.push(volume.id);
    await finished(request, volume.id);
    expect(inspect(worker.containerName).Id).toBe(before.Id);
    expect(inspect(worker.containerName).HostConfig.Privileged).toBe(false);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/models/before')).toBe('original');
    docker('exec', worker.containerName, 'python3', '-c', 'from pathlib import Path; Path("/home/agent/models/after").write_text("live-write")');
    const restart = await new ApiClient(request).restartContainer(worker.id);
    expect(restart.status, JSON.stringify(restart.body)).toBe(200);
    const after = inspect(worker.containerName);
    expect(after.Id).not.toBe(before.Id); expect(after.Image).toBe(before.Image); expect(after.HostConfig.Privileged).toBe(false);
    expect(after.Mounts.some((m: any) => m.Type === 'volume' && m.Destination === '/home/agent/models')).toBe(true);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/models/after')).toBe('live-write');
  });

  test('recreation initializes a missing directory; paths already persistent and protected paths are rejected', async ({ request }) => {
    const response = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/new-cache', mode: 'recreate' } });
    expect(response.status(), await response.text()).toBe(200);
    const volume = await response.json(); volumeIds.push(volume.id); await finished(request, volume.id);
    expect(docker('exec', '-u', 'agent', worker.containerName, 'test', '-w', '/home/agent/new-cache')).toBe('');
    for (const path of ['/etc', '/home/agent/.codex', '/workspace/cache', '/home/agent/models/nested']) {
      const response = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: path } });
      expect([400, 409]).toContain(response.status());
    }
    const inventory = await (await request.get('/api/volumes')).json();
    expect(inventory.volumes.some((v: any) => v.id === volume.id && v.backupCoverage === 'not-configured')).toBe(true);
    expect(JSON.stringify(inventory)).not.toMatch(/Mountpoint|dockerName|\/var\/lib\/docker\/volumes/);
  });

  test('on-demand sizing reports allocated and hardlink-deduplicated logical bytes without exposing Docker identity', async ({ request }) => {
    docker('exec', worker.containerName, 'python3', '-c', 'from pathlib import Path; p=Path("/home/agent/new-cache/size-source"); p.write_bytes(b"sizing-payload"); q=Path("/home/agent/new-cache/size-hardlink"); q.unlink(missing_ok=True); q.hardlink_to(p)');
    const id = volumeIds[1]!;
    const start = await request.post(`/api/volumes/${id}/size-jobs`, { data: { force: true } });
    expect(start.status(), await start.text()).toBe(202);
    sizeJobId = (await start.json()).id;
    let job: any;
    await expect.poll(async () => {
      const response = await request.get(`/api/volume-size-jobs/${sizeJobId}`);
      job = await response.json(); return job.status;
    }, { timeout: 90_000, intervals: [500, 1000, 2000] }).toMatch(/succeeded|failed|cancelled/);
    expect(job.status, job.error).toBe('succeeded');
    expect(job.measurement).toMatchObject({ state: 'known', source: 'bounded-read-only-scan', consistency: 'live-approximate' });
    expect(job.measurement.allocatedBytes).toBeGreaterThan(0);
    expect(job.measurement.logicalBytes).toBe('sizing-payload'.length);
    const inventory = await (await request.get('/api/volumes')).json();
    const item = inventory.volumes.find((candidate: any) => candidate.id === id);
    expect(item).toMatchObject({ sizeBytes: job.measurement.allocatedBytes, logicalSizeBytes: job.measurement.logicalBytes,
      size: { state: 'known' }, canMeasureSize: true });
    expect(JSON.stringify({ job, item })).not.toMatch(/dockerName|Mountpoint|private-|\/var\/lib\/docker\/volumes/);
  });

  test('self-service defaults off, allows only additive requests and does not authorize disruption', async ({ request }) => {
    const self = (body: any) => {
      const raw = docker('exec', worker.containerName, 'curl', '-sS', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json', '-d', JSON.stringify(body), 'http://agentor-orchestrator:3000/api/worker-self/storage');
      const lines = raw.split('\n'); return { status: Number(lines.pop()), body: JSON.parse(lines.join('\n')) };
    };
    const disabled = self({ target: '/home/agent/self-cache' });
    expect(disabled.status, JSON.stringify(disabled)).toBe(403);
    expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'policy', policy: { selfService: true } } })).status()).toBe(200);
    const before = inspect(worker.containerName).Id;
    const added = self({ target: '/home/agent/self-cache' }); expect(added.status, JSON.stringify(added)).toBe(200);
    volumeIds.push(added.body.id);
    expect(added.body.operation).toMatchObject({ mode: 'deferred', stage: 'queued' });
    expect(self({ target: '/home/agent/self-cache' }).body.id).toBe(added.body.id);
    expect(inspect(worker.containerName).Id).toBe(before);
    for (const forbidden of [{ action: 'delete' }, { workerId: 'other' }, { mode: 'live', acknowledgePrivileged: true }])
      expect(self({ target: '/home/agent/forbidden', ...forbidden }).status).toBe(400);
  });

  test('detach retains data, deletion is blocked while attached, and reattach restores it', async ({ request }) => {
    const id = volumeIds[0]!;
    expect((await request.post(`/api/volumes/${id}`, { data: { action: 'delete', confirmed: true } })).status()).toBe(409);
    const detach = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'detach', volumeId: id, confirmed: true, applyNow: true } });
    expect(detach.status(), await detach.text()).toBe(200); await finished(request, id);
    expect(inspect(worker.containerName).Mounts.some((m: any) => m.Destination === '/home/agent/models')).toBe(false);
    const reattach = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'reattach', volumeId: id, mode: 'recreate' } });
    expect(reattach.status(), await reattach.text()).toBe(200); await finished(request, id);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/models/after')).toBe('live-write');
  });

  test('concurrent adds are idempotent and another account cannot inspect or mutate storage', async ({ request }) => {
    const responses = await Promise.all(Array.from({ length: 4 }, () => request.post(`/api/containers/${worker.id}/storage`, {
      data: { action: 'add', target: '/home/agent/concurrent-cache' },
    })));
    for (const response of responses) expect(response.status(), await response.text()).toBe(200);
    const ids = await Promise.all(responses.map(async (r) => (await r.json()).id));
    expect(new Set(ids).size).toBe(1); volumeIds.push(ids[0]);
    const stranger = await createTestUser('Storage isolation');
    const strangerRequest = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000', storageState: { cookies: [], origins: [] } });
    try {
      expect((await new ApiClient(strangerRequest).signInEmail(stranger.email, stranger.password)).status).toBe(200);
      expect((await strangerRequest.get(`/api/containers/${worker.id}/storage`)).status()).toBe(404);
      expect((await strangerRequest.get(`/api/volumes/${ids[0]}`)).status()).toBe(404);
      expect((await strangerRequest.post(`/api/volumes/${ids[0]}`, { data: { action: 'delete', confirmed: true } })).status()).toBe(404);
      expect((await strangerRequest.post(`/api/volumes/${volumeIds[0]}/size-jobs`, { data: { force: true } })).status()).toBe(404);
      expect((await strangerRequest.get(`/api/volume-size-jobs/${sizeJobId}`)).status()).toBe(404);
      expect((await (await strangerRequest.get('/api/volumes')).json()).volumes.some((v: any) => volumeIds.includes(v.id))).toBe(false);
    } finally { await strangerRequest.dispose(); await deleteTestUser(stranger.id); }
  });

  test('worker MCP exposes only additive storage capabilities and revocation applies immediately', async ({ request }) => {
    const mcp = (method: string, params?: any) => JSON.parse(docker('exec', worker.containerName, 'curl', '-sS', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'http://agentor-orchestrator:3000/api/worker-self/mcp'));
    const listing = mcp('tools/list');
    expect(listing.result, JSON.stringify(listing)).toBeTruthy();
    const tools = listing.result.tools.map((t: any) => t.name).filter((n: string) => n.startsWith('storage.'));
    expect(tools.sort()).toEqual(['storage.add', 'storage.inspect']);
    expect(mcp('tools/call', { name: 'storage.delete', arguments: { volumeId: volumeIds[0] } }).result.isError).toBe(true);
    expect(mcp('tools/call', { name: 'storage.add', arguments: { target: '/home/agent/invalid-mcp', mode: 'live' } }).result.isError).toBe(true);
    expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'policy', policy: { selfService: false } } })).status()).toBe(200);
    expect(mcp('tools/list').result.tools.some((t: any) => t.name.startsWith('storage.'))).toBe(false);
    expect(mcp('tools/call', { name: 'storage.add', arguments: { target: '/home/agent/revoked' } }).result.isError).toBe(true);
  });

  test('busy live mount fails safely and requires explicit recreation', async ({ request }) => {
    docker('exec', '-d', worker.containerName, 'python3', '-c', 'import pathlib,time; p=pathlib.Path("/home/agent/busy-cache"); p.mkdir(); f=open(p/"open-file","w"); f.write("busy-data"); f.flush(); time.sleep(600)');
    await expect.poll(() => docker('exec', worker.containerName, 'test', '-f', '/home/agent/busy-cache/open-file')).toBe('');
    const before = inspect(worker.containerName).Id;
    const response = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/busy-cache', mode: 'live', acknowledgePrivileged: true } });
    expect(response.status(), await response.text()).toBe(200);
    const volume = await response.json(); volumeIds.push(volume.id);
    await expect.poll(async () => (await (await request.get(`/api/volumes/${volume.id}`)).json()).operation?.stage, { timeout: 30_000 }).toBe('failed');
    const failed = await (await request.get(`/api/volumes/${volume.id}`)).json();
    expect(failed.operation.error).toContain('busy');
    expect(inspect(worker.containerName).Id).toBe(before);
    expect(inspect(worker.containerName).State.Paused).toBe(false);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/busy-cache/open-file')).toBe('busy-data');
    expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'apply', volumeId: volume.id, mode: 'recreate' } })).status()).toBe(200);
    await finished(request, volume.id);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/busy-cache/open-file')).toBe('busy-data');
  });

  test('protection locks cover storage mutations and self-service never supplies a lock password', async ({ request }) => {
    const password = `storage-lock-${Date.now()}-strong`;
    expect((await request.put(`/api/containers/${worker.id}/protection`, { data: { password } })).status()).toBe(200);
    try {
      expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/locked-cache' } })).status()).toBe(423);
      expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'policy', policy: { selfService: true } } })).status()).toBe(423);
      expect((await request.post(`/api/volumes/${volumeIds[0]}`, { data: { action: 'rename', name: 'Blocked rename' } })).status()).toBe(423);
      expect((await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'policy', policy: { selfService: true }, lockPassword: password } })).status()).toBe(200);
      const raw = docker('exec', worker.containerName, 'curl', '-sS', '-w', '\n%{http_code}', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ target: '/home/agent/locked-self' }), 'http://agentor-orchestrator:3000/api/worker-self/storage');
      const code = raw.split('\n').pop();
      const runtime = (await (await request.get('/api/containers')).json()).find((v: any) => v.id === worker.id);
      expect(code, JSON.stringify({ raw, status: runtime?.status, diagnostic: runtime?.runtimeDiagnostic, docker: inspect(worker.containerName).State })).toBe('423');
    } finally { expect((await request.delete(`/api/containers/${worker.id}/protection`, { data: { password } })).status()).toBe(200); }
  });

  test('orchestrator restart recovers a committed live mount and stopped worker restart declares it', async ({ request }) => {
    test.setTimeout(120_000);
    const response = await request.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/recovery-cache', mode: 'live', acknowledgePrivileged: true } });
    expect(response.status(), await response.text()).toBe(200);
    const volume = await response.json(); volumeIds.push(volume.id); await finished(request, volume.id);
    docker('exec', worker.containerName, 'python3', '-c', 'from pathlib import Path; Path("/home/agent/recovery-cache/kept").write_text("recover-me")');
    expect(inspect(worker.containerName).HostConfig.RestartPolicy.Name).toBe('no');
    docker('restart', 'agentor-orchestrator');
    await expect.poll(async () => { try { return (await request.get('/api/health')).status(); } catch { return 0; } }, { timeout: 60_000 }).toBe(200);
    await waitForWorkerRunning(request, worker.id);
    // Recovery briefly pauses the worker.
    await expect.poll(() => {
      try { return docker('exec', worker.containerName, 'cat', '/home/agent/recovery-cache/kept'); } catch { return ''; }
    }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBe('recover-me');
    // Stopping discards the namespace mount, just as daemon/task loss does.
    expect((await new ApiClient(request).stopContainer(worker.id)).status).toBe(200);
    expect((await new ApiClient(request).restartContainer(worker.id)).status).toBe(200);
    expect(inspect(worker.containerName).Mounts.some((m: any) => m.Destination === '/home/agent/recovery-cache')).toBe(true);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/recovery-cache/kept')).toBe('recover-me');
  });

  test('archive/unarchive retains custom storage and worker deletion leaves explicit volume deletion to the owner', async ({ request }) => {
    test.setTimeout(120_000);
    expect((await new ApiClient(request).archiveContainer(worker.id)).status).toBe(200);
    expect((await new ApiClient(request).unarchiveWorker(worker.id)).status).toBe(200);
    await waitForWorkerRunning(request, worker.id);
    expect(docker('exec', worker.containerName, 'cat', '/home/agent/models/after')).toBe('live-write');
    await cleanupWorker(request, worker.id);
    const retained = await (await request.get(`/api/volumes/${volumeIds[0]}`)).json();
    expect(retained).toMatchObject({ attached: false, state: 'detached' });
    expect((await request.post(`/api/volumes/${volumeIds[0]}`, { data: { action: 'delete' } })).status()).toBe(409);
    expect((await request.post(`/api/volumes/${volumeIds[0]}`, { data: { action: 'delete', confirmed: true } })).status()).toBe(200);
    expect((await request.get(`/api/volumes/${volumeIds[0]}`)).status()).toBe(404);
  });
});

test('account deletion retains custom data and restart-persistent administrator deletion handles', async ({ request }) => {
  test.skip(!existsSync('/src/orchestrator'), 'Requires the isolated Docker test runner');
  test.setTimeout(120_000);
  const owner = await createTestUser('Retained account volume');
  const ownerRequest = await playwrightRequest.newContext({ baseURL: process.env.BASE_URL || 'http://localhost:3000', storageState: { cookies: [], origins: [] } });
  let workerId = '', volumeId = '';
  try {
    expect((await new ApiClient(ownerRequest).signInEmail(owner.email, owner.password)).status).toBe(200);
    const worker = await createWorker(ownerRequest, { displayName: `Retain account ${Date.now()}` }); workerId = worker.id;
    const response = await ownerRequest.post(`/api/containers/${worker.id}/storage`, { data: { action: 'add', target: '/home/agent/retained-cache', mode: 'recreate' } });
    expect(response.status(), await response.text()).toBe(200); volumeId = (await response.json()).id;
    await finished(ownerRequest, volumeId);
    const physical = inspect(worker.containerName).Mounts.find((m: any) => m.Destination === '/home/agent/retained-cache').Name;
    docker('exec', worker.containerName, 'python3', '-c', 'from pathlib import Path; Path("/home/agent/retained-cache/marker").write_text("retain-account-data")');
    await cleanupWorker(ownerRequest, workerId); workerId = '';
    await deleteTestUser(owner.id);
    docker('restart', 'agentor-orchestrator');
    await expect.poll(async () => { try { return (await (await request.get(`/api/volumes/${volumeId}`)).json()).retainedAfterAccountDeletion; } catch { return false; } }, { timeout: 60_000 }).toBe(true);
    docker('restart', 'agentor-orchestrator');
    await expect.poll(async () => { try { return (await (await request.get(`/api/volumes/${volumeId}`)).json()).retainedAfterAccountDeletion; } catch { return false; } }, { timeout: 60_000 }).toBe(true);
    expect(docker('run', '--rm', '--network', 'none', '--mount', `type=volume,src=${physical},dst=/volume,readonly`, '--entrypoint', 'cat', 'agentor-orchestrator:latest', '/volume/marker')).toBe('retain-account-data');
    expect((await request.post(`/api/volumes/${volumeId}`, { data: { action: 'delete' } })).status()).toBe(409);
    expect((await request.post(`/api/volumes/${volumeId}`, { data: { action: 'delete', confirmed: true } })).status()).toBe(200);
    expect((await request.get(`/api/volumes/${volumeId}`)).status()).toBe(404); volumeId = '';
  } finally {
    if (workerId) await cleanupWorker(request, workerId);
    if (volumeId) await request.post(`/api/volumes/${volumeId}`, { data: { action: 'delete', confirmed: true } });
    await ownerRequest.dispose(); await deleteTestUser(owner.id);
  }
});
