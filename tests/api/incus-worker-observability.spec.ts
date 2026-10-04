import { test, expect } from '@playwright/test';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ResourceMonitor } from '../../orchestrator/server/utils/resource-monitor';
import { IncusWorkerRuntime, type IncusWorkerOptions } from '../../orchestrator/server/utils/incus-worker-runtime';
import { ContainerManager } from '../../orchestrator/server/utils/container';
import { LogCollector } from '../../orchestrator/server/utils/log-collector';
import { WorkerStore } from '../../orchestrator/server/utils/worker-store';
import { backupInstallationId } from '../../orchestrator/server/utils/backup-installation';
import { zeroUserEnvVars } from '../../orchestrator/server/utils/user-env-store';
import { withWorkerLifecycleMutation, isWorkerLifecycleMutationActive } from '../../orchestrator/server/utils/worker-lifecycle-coordinator';
import type { Config } from '../../orchestrator/server/utils/config';

(globalThis as any).useLogger ??= () => ({ warn() {}, info() {}, debug() {}, error() {} });
(globalThis as any).useLogCollector ??= () => ({ attach: async () => {}, detach() {} });

const mac = '10:66:6a:11:22:33';
function worker() {
  return { id: randomUUID(), userId: 'fixture-owner', runtimeKind: 'incus-vm', status: 'running',
    containerName: 'agentor-worker-observability', containerId: 'incus:fixture-incarnation', displayName: 'Observability' };
}
function sample() {
  return { cpuCount: 2, primaryMac: mac, state: { status: 'Running', processes: 4, cpu: { usage: 1e9 },
    memory: { usage: 128, total: 512 }, network: {
      eth0: { hwaddr: mac, counters: { bytes_received: 100, bytes_sent: 200 } },
      docker0: { hwaddr: '10:00:00:00:00:01', counters: { bytes_received: 99999, bytes_sent: 99999 } },
    }, disk: { root: { usage: 999999 } } } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function journal() {
  const done = deferred<number>();
  let closed = 0, current = true;
  return { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), result: done.promise,
    close: () => { closed++; }, isCurrent: () => current, done, closed: () => closed, invalidate: () => { current = false; } };
}
function monitorFixture(read = async () => sample()) {
  const c = worker();
  const manager = { list: () => [c], get: () => c, incusWorkerMetrics: read, incusWorkerDiskUsageBytes: async () => 8192 };
  const forbidden = () => { throw new Error('Docker fallback'); };
  const monitor = new ResourceMonitor({ getContainerStats: forbidden, getWorkerDiskUsageBytes: forbidden } as any, manager as any);
  return { c, manager, monitor };
}

test('Incus metrics use allocated CPU, primary NIC and guest RAM rather than Docker or disposable disk', async () => {
  const data = sample(), f = monitorFixture(async () => data);
  await f.monitor.refresh();
  expect(f.monitor.getWorkerMetric(f.c.id)).toMatchObject({ cpuCapacity: 'worker', cpuUtilization: 0,
    memoryUsedBytes: 128, memoryLimitBytes: 512, memoryUtilization: 25, diskUsedBytes: 8192,
    netRxBytesPerSec: 0, blkReadBytesPerSec: 0 });
  (f.monitor as any).prevWorker.get(f.c.containerName).t = Date.now() - 1000;
  data.state.cpu.usage += 1e9; data.state.network.eth0.counters.bytes_received += 1000;
  await (f.monitor as any).pollWorkers();
  expect(f.monitor.getWorkerMetric(f.c.id)!.cpuUtilization).toBeGreaterThan(45);
  expect(f.monitor.getWorkerMetric(f.c.id)!.cpuUtilization).toBeLessThanOrEqual(50);
  expect(f.monitor.getWorkerMetric(f.c.id)!.netRxBytesPerSec).toBeGreaterThan(900);
});

for (const failure of ['agent-absent', 'negative-cpu', 'missing-cpu', 'zero-allocation', 'zero-memory', 'missing-nic']) {
  test('Incus ' + failure + ' makes only telemetry unavailable', async () => {
    const data: any = sample(), f = monitorFixture(async () => data);
    if (failure === 'agent-absent') data.state.processes = -1;
    if (failure === 'negative-cpu') data.state.cpu.usage = -1;
    if (failure === 'missing-cpu') delete data.state.cpu;
    if (failure === 'zero-allocation') data.cpuCount = 0;
    if (failure === 'zero-memory') data.state.memory.total = 0;
    if (failure === 'missing-nic') data.primaryMac = 'foreign';
    await f.monitor.refresh();
    expect(f.c.status).toBe('running');
    expect(f.monitor.getWorkerMetric(f.c.id)?.status).toBe('unknown');
  });
}

test('guest reboot counter reset and runtime replacement discard rate and durable disk baselines', async () => {
  const data = sample(), f = monitorFixture(async () => data);
  await f.monitor.refresh();
  (f.monitor as any).prevWorker.get(f.c.containerName).t -= 1000;
  data.state.cpu.usage = 1; data.state.network.eth0.counters.bytes_received = 1;
  await (f.monitor as any).pollWorkers();
  expect(f.monitor.getWorkerMetric(f.c.id)).toMatchObject({ cpuUtilization: 0, netRxBytesPerSec: 0 });
  await withWorkerLifecycleMutation(f.c.id, async () => { f.c.containerId = 'incus:replacement'; });
  await expect.poll(() => isWorkerLifecycleMutationActive(f.c.id)).toBe(false);
  expect(f.monitor.getWorkerMetric(f.c.id)).toBeUndefined();
  await (f.monitor as any).pollWorkers();
  expect(f.monitor.getWorkerMetric(f.c.id)).toMatchObject({ cpuUtilization: 0, diskUsedBytes: 0 });
});

test('late and out-of-order stats/disk samples cannot overwrite replacement or newer readings', async () => {
  const stats = deferred<any>(), f = monitorFixture(() => stats.promise);
  const first = (f.monitor as any).pollWorkers();
  f.manager.incusWorkerMetrics = async () => ({ ...sample(), state: { ...sample().state, memory: { usage: 256, total: 512 } } });
  await (f.monitor as any).pollWorkers();
  stats.resolve(sample()); await first;
  expect(f.monitor.getWorkerMetric(f.c.id)?.memoryUsedBytes).toBe(256);
  const disk = deferred<number>();
  f.manager.incusWorkerDiskUsageBytes = () => disk.promise;
  const oldDisk = (f.monitor as any).sampleWorkerDisk();
  f.manager.incusWorkerDiskUsageBytes = async () => 16384;
  await (f.monitor as any).sampleWorkerDisk();
  disk.resolve(1); await oldDisk;
  expect(f.monitor.getWorkerMetric(f.c.id)?.diskUsedBytes).toBe(16384);
  const delayed = deferred<number>();
  f.manager.incusWorkerDiskUsageBytes = () => delayed.promise;
  const lateDisk = (f.monitor as any).sampleWorkerDisk();
  await withWorkerLifecycleMutation(f.c.id, async () => { f.c.containerId = 'incus:new'; });
  delayed.resolve(99999); await lateDisk;
  await (f.monitor as any).pollWorkers();
  expect(f.monitor.getWorkerMetric(f.c.id)?.diskUsedBytes).toBe(0);
  f.manager.incusWorkerDiskUsageBytes = async () => { throw new Error('Unavailable'); };
  await (f.monitor as any).sampleWorkerDisk();
  expect(f.c.status).toBe('running');
});

test('journal collector preserves UTF8/timestamps, fences stale data and cleans EOF without lifecycle failures', async () => {
  const c = worker(), session = journal(), entries: any[] = [];
  const manager = { findByContainerName: () => c, get: () => c, openWorkerJournal: async () => session,
    reportRuntimeFailure: () => { throw new Error('Telemetry affected lifecycle'); } };
  const collector = new LogCollector({ logLevel: 'debug' } as Config, { append: (entry: any) => entries.push(entry) } as any,
    { broadcast() {} } as any, () => manager as any);
  (collector as any).docker = { getContainer: () => { throw new Error('Docker fallback'); } };
  await collector.attach(c.containerName, c.containerId, 'worker', c.displayName);
  const bytes = Buffer.from('2026-10-04T01:02:03.123456+0000 fixture café\n');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  session.stdout.write(bytes.subarray(0, split)); session.stdout.write(bytes.subarray(split));
  expect(entries).toEqual([expect.objectContaining({ message: 'fixture café', timestamp: '2026-10-04T01:02:03.123Z', sourceName: 'Observability' })]);
  session.stdout.write(Buffer.alloc(256 * 1024, 65)); session.stdout.write('\n');
  expect(entries[1].message.length).toBeLessThanOrEqual(64 * 1024);
  session.invalidate(); session.stdout.write('stale\n');
  expect(entries).toHaveLength(2); expect(session.closed()).toBe(1);
  session.done.resolve(0); await Promise.resolve();
  expect((collector as any).attached.size).toBe(0);
  expect(c.status).toBe('running');
});

test('same-UUID guest shutdown suppresses delayed metrics and disk without requiring a lifecycle mutation', async () => {
  const delayed = deferred<any>(), f = monitorFixture(() => delayed.promise), disk = deferred<number>();
  f.manager.incusWorkerDiskUsageBytes = () => disk.promise;
  const sampling = f.monitor.refresh();
  f.c.status = 'stopped';
  delayed.resolve(sample()); disk.resolve(1000); await sampling;
  expect(f.monitor.getWorkerMetric(f.c.id)).toBeUndefined();
  expect((f.monitor as any).workerDisk.size).toBe(0);
});

test('journal EOF retries through reconciliation without replay and same-object owner mutation fences ingestion', async () => {
  const c = worker(), first = journal(), second = journal(), entries: any[] = [], calls: any[] = [];
  const manager = { list: () => [c], get: () => c, findByContainerName: () => c,
    openWorkerJournal: async (_id: string, options: any) => { calls.push(options); return calls.length === 1 ? first : second; } };
  const collector = new LogCollector({ logLevel: 'info' } as Config, { append: (entry: any) => entries.push(entry) } as any,
    { broadcast() {} } as any, () => manager as any);
  await collector.attach(c.containerName, c.containerId, 'worker');
  first.stdout.end(); first.done.resolve(0); await new Promise((done) => setImmediate(done));
  await collector.reconcileIncus();
  expect(calls).toHaveLength(2); expect(calls[1].sinceNow).toBe(true);
  c.userId = 'new-owner'; second.stdout.write('wrong-owner\n');
  expect(entries).toHaveLength(0); expect(second.closed()).toBe(1);
  second.done.resolve(0); collector.detachAll();
});

test('failed/pending journal setup never touches Docker or worker lifecycle and cancellation closes late session', async () => {
  const c = worker(), pending = deferred<any>(), session = journal();
  const manager = { findByContainerName: () => c, get: () => c, openWorkerJournal: () => pending.promise };
  const collector = new LogCollector({ logLevel: 'info' } as Config, { append() {} } as any, { broadcast() {} } as any, () => manager as any);
  const setup = collector.attach(c.containerName, c.containerId, 'worker');
  collector.detach(c.containerId); pending.resolve(session); await setup;
  expect(session.closed()).toBe(1); expect((collector as any).attached.size).toBe(0);
  manager.openWorkerJournal = async () => { throw new Error('Agent unavailable'); };
  await collector.attach(c.containerName, c.containerId, 'worker');
  expect(c.status).toBe('running'); expect((collector as any).pendingIncus.size).toBe(0);
});

test('runtime observations/journal enforce owner, incarnation and record authority without provisioning dependencies', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-observability-'));
  try {
    const owner = { id: 'fixture', userId: 'owner', containerName: 'agentor-worker-fixture' };
    const instance = { name: owner.containerName, type: 'virtual-machine', status: 'Running', config: {
      'user.agentor.id': owner.id, 'user.agentor.owner': owner.userId, 'user.agentor.installation': await backupInstallationId(dir),
      'volatile.uuid': 'fixture-uuid', 'limits.cpu': '2', 'volatile.eth0.hwaddr': mac,
    }, devices: { eth0: { type: 'nic' } } };
    const calls: any[] = [], session = journal();
    let reads = 0, replaced = false, authority = true;
    const client = { getInstance: async () => {
      reads++; return structuredClone({ ...instance, config: { ...instance.config, ...(replaced && reads > 1 ? { 'volatile.uuid': 'other' } : {}) } });
    }, getInstanceState: async () => sample().state,
      execStream: async (...args: any[]) => { calls.push(args); return session; } };
    const runtime = new IncusWorkerRuntime({ dataDir: dir, containerPrefix: 'agentor-worker' } as Config, client as any);
    expect(await runtime.inspectState(owner, 'fixture-uuid')).toMatchObject({ cpuCount: 2, primaryMac: mac });
    reads = 0; replaced = true;
    await expect(runtime.inspectState(owner, 'fixture-uuid')).rejects.toThrow('incarnation');
    replaced = false;
    await expect(runtime.openJournal({ ...owner, userId: 'foreign' }, 'fixture-uuid', () => {})).rejects.toThrow('ownership');
    expect(calls).toHaveLength(0);
    const opened = await runtime.openJournal(owner, 'fixture-uuid', () => { if (!authority) throw new Error('Record changed'); },
      { tail: 999999, follow: true, sinceNow: true });
    expect(calls[0][1]).toEqual(['journalctl', '--boot', '--no-pager', '--output=short-iso-precise',
      '_SYSTEMD_UNIT=agentor-worker.service', '+', 'SYSLOG_IDENTIFIER=agentor-app', '--lines=10000', '--follow', '--since=now']);
    expect(calls[0][2]).toMatchObject({ user: 0, group: 0 });
    expect(JSON.stringify(calls)).not.toContain('/run');
    authority = false; expect(opened.isCurrent()).toBe(false); opened.close(); session.done.resolve(0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('manager journal validator captures primitive owner even when the existing info is mutated in place', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-journal-owner-'));
  try {
    const c = worker(), manager = new ContainerManager({} as any, { dataDir: dir } as Config), store = new WorkerStore(dir);
    await store.init(); manager.setWorkerStore(store); (manager as any).containers.set(c.id, c);
    await store.upsert({ ...c, status: 'active' } as any);
    let validate!: () => void;
    manager.setIncusRuntime({ openJournal: async (_owner: any, _uuid: any, check: () => void) => {
      validate = check; return journal();
    } } as any);
    const session = await manager.openWorkerJournal(c.id);
    c.userId = 'changed-owner';
    await store.upsert({ ...c, status: 'active' } as any);
    expect(validate).toThrow('authority changed'); session.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real accepted guest exposes bounded metrics/journal even when ephemeral worker configuration is missing', async () => {
  test.skip(process.env.INCUS_OBSERVABILITY_TEST !== 'true', 'Explicit isolated disposable guest telemetry gate');
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), 'agentor-incus-observability-live-'));
  const cfg = { dataDir: dir, incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agentor',
    incusClientCertPath: '/workspace/agentor-incus-tls/client.crt', incusClientKeyPath: '/workspace/agentor-incus-tls/client.key',
    incusServerCertPath: '/workspace/agentor-incus-tls/server.crt', incusWorkerImage: process.env.INCUS_TEST_IMAGE || 'agentor-worker-phase6-candidate',
    incusNetwork: 'incusbr0', incusStoragePool: 'default', incusDockerVolumeSize: '4GiB',
    incusInternalGatewayUrl: 'http://10.159.68.1:38000', containerPrefix: 'agentor-worker' } as Config;
  const id = randomUUID(), owner = { id, userId: 'observability-fixture', containerName: cfg.containerPrefix + '-' + id };
  const runtime = new IncusWorkerRuntime(cfg), manager = new ContainerManager({} as any, cfg);
  const store = new WorkerStore(dir); await store.init(); manager.setWorkerStore(store); manager.setIncusRuntime(runtime);
  const opts: IncusWorkerOptions = { ...owner, memoryLimit: '2GiB', cpuLimit: 2, dockerEnabled: false, userEnv: zeroUserEnvVars(owner.userId),
    environmentJson: { networkMode: 'full', allowedDomains: [], dockerEnabled: false, setupScript: '', envVars: '',
      exposeApis: { portMappings: true, domainMappings: true, usage: true } }, capabilitiesJson: [], instructionsJson: [],
    workerJson: { id, displayName: 'Observability fixture', repos: [], initScript: '', gitName: '', gitEmail: '' } };
  try {
    await store.upsert({ ...owner, runtimeKind: 'incus-vm', status: 'active' } as any);
    await runtime.create(opts);
    const instance = await runtime.client.getInstance(owner.containerName);
    const c = { ...owner, runtimeKind: 'incus-vm', status: 'running', containerId: 'incus:' + instance.config['volatile.uuid'], displayName: 'Observability fixture' };
    (manager as any).containers.set(id, c);
    const result = await runtime.client.exec(owner.containerName, ['bash', '-ec',
      'logger -t agentor-app fixture-journal-marker; systemctl stop agentor-worker; rm -f /run/agentor/worker.env /run/agentor/provisioned']);
    expect(result.returnCode).toBe(0);
    expect(await manager.logs(id)).toContain('fixture-journal-marker');
    const observed = await manager.incusWorkerMetrics(id);
    expect(observed).toMatchObject({ cpuCount: 2, state: { status: 'Running' } });
    expect(observed.state.cpu!.usage).toBeGreaterThanOrEqual(0);
    expect(observed.state.memory!.total).toBeGreaterThan(1e9);
    const monitor = new ResourceMonitor({} as any, manager);
    await (monitor as any).pollWorkers();
    expect(monitor.getWorkerMetric(id)).toMatchObject({ status: 'running', cpuCapacity: 'worker' });
    const code = await runtime.client.exec(owner.containerName, ['test', '-f', '/run/agentor/provisioned']);
    expect(code.returnCode).not.toBe(0); expect(c.status).toBe('running');
    const stream = await manager.openWorkerJournal(id, { follow: true, sinceNow: true });
    stream.stdout.resume(); stream.stderr.resume();
    await expect.poll(async () => (await runtime.client.exec(owner.containerName,
      ['pgrep', '-f', '^journalctl --boot --no-pager --output=short-iso-precise'])).returnCode).toBe(0);
    stream.close();
    await expect(stream.result).rejects.toThrow();
    await expect.poll(async () => (await runtime.client.exec(owner.containerName,
      ['pgrep', '-f', '^journalctl --boot --no-pager --output=short-iso-precise'])).returnCode).toBe(1);
  } finally {
    await runtime.remove(owner.containerName);
    await runtime.removeStorage(owner);
    await rm(dir, { recursive: true, force: true });
  }
});
