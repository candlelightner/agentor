import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
const require = createRequire(new URL('../../orchestrator/package.json', import.meta.url));
const { ref, computed, reactive, watch, effectScope } = require('vue');
async function fixture() {
  const source = await readFile(new URL('../../orchestrator/app/composables/useInstanceBackups.ts', import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const state = { locked: false, status: 'running', denied: false, mismatch: false };
  const controls: { list?: () => Promise<any>; preflight?: () => Promise<any>; status?: (path: string) => Promise<any>; action?: (path: string, options: any) => Promise<any> } = {};
  const calls: string[] = [], timers = new Map<number, () => void>(); let id = 0;
  const job = () => ({ id: state.mismatch ? 'wrong' : 'job', operation: 'create', status: state.status, phase: 'snapshotting' });
  const exports: any = {};
  runInNewContext(code, { exports, ref, computed, setTimeout: (fn: () => void) => { timers.set(++id, fn); return id; },
    clearTimeout: (timer: number) => timers.delete(timer),
    $fetch: async (path: string, options: any) => {
      calls.push(path + ':' + (options?.method ?? 'GET'));
      if (path.endsWith('/preflight') && controls.preflight) return controls.preflight();
      if (options?.method === 'POST' || options?.method === 'DELETE') {
        if (controls.action) return controls.action(path, options);
        return { accepted: true, job: job(), jobId: 'job' };
      }
      if (path.includes('/jobs/')) {
        if (controls.status) return controls.status(path);
        if (state.denied) throw { statusCode: 401, message: 'Session expired' };
        return job();
      }
      if (path === '/api/admin/instance-backups' && controls.list) return controls.list();
      if (state.locked) throw { statusCode: 423 };
      if (path === '/api/admin/instance-backups') return { jobs: [job()], artifacts: [], remoteBackups: [], options: {} };
      return [];
    } });
  return { api: exports.useInstanceBackups(), state, calls, timers, controls };
}
test('accepted job continues exact status polling through a control-plane 423 and reloads full state afterward', async () => {
  const f = await fixture();
  await f.api.refresh();
  await f.api.create('local', {}, 'request');
  f.state.locked = true; await f.api.refresh();
  expect(f.api.controlPlaneLocked.value).toBe(true); expect(f.api.error.value).toBe('');
  expect(f.calls).toContain('/api/admin/instance-backups/jobs/job:GET');
  expect(f.api.jobs.value[0].status).toBe('running'); expect(f.timers.size).toBe(1);
  f.state.status = 'cancelled'; await f.api.refresh();
  expect(f.api.jobs.value[0].status).toBe('cancelled');
  expect(f.timers.size).toBe(1); // Continue until the task actually releases the cut.
  f.state.locked = false; await f.api.refresh();
  expect(f.api.controlPlaneLocked.value).toBe(false); expect(f.timers.size).toBe(0);
});
test('authentication failure is visible without rewriting accepted job state', async () => {
  const f = await fixture(); await f.api.refresh(); f.state.locked = true; f.state.denied = true;
  await f.api.refresh(); expect(f.api.error.value).toContain('Session expired');
  expect(f.api.jobs.value[0].status).toBe('running'); f.api.stop(); expect(f.timers.size).toBe(0);
});
test('mismatched status cannot replace a different job identity', async () => {
  const f = await fixture(); await f.api.refresh(); f.state.locked = true; f.state.mismatch = true;
  await f.api.refresh(); expect(f.api.error.value).toContain('identity mismatch');
  expect(f.api.jobs.value[0].id).toBe('job'); f.api.stop();
});
function deferred() {
  let resolve!: (value: any) => void, reject!: (error: any) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
test('pre-acceptance list cannot erase the accepted job or retire polling', async () => {
  const f = await fixture(), list = deferred(); f.controls.list = () => list.promise;
  const loading = f.api.refresh();
  await f.api.create('local', {}, 'request');
  list.resolve({ jobs: [], artifacts: [], remoteBackups: [], options: {} }); await loading;
  expect(f.api.jobs.value.map((job: any) => job.id)).toEqual(['job']);
  expect(f.api.loading.value).toBe(false); expect(f.timers.size).toBe(1); f.api.stop();
});
test('older exact status cannot overwrite a newer terminal result', async () => {
  const f = await fixture(), oldStatus = deferred(), entered = deferred();
  await f.api.refresh(); f.state.locked = true;
  f.controls.status = () => { entered.resolve(null); return oldStatus.promise; };
  const first = f.api.refresh(); await entered.promise;
  f.controls.status = undefined; f.state.status = 'cancelled'; await f.api.refresh();
  oldStatus.resolve({ id: 'job', operation: 'create', status: 'running' }); await first;
  expect(f.api.jobs.value[0].status).toBe('cancelled'); f.api.stop();
});
test('stop invalidates pending 423 without new status work and reopen admits a fresh refresh', async () => {
  const f = await fixture(), list = deferred(); await f.api.refresh();
  f.controls.list = () => list.promise; const loading = f.api.refresh();
  f.api.stop(); const calls = f.calls.length;
  list.reject({ statusCode: 423 }); await loading;
  expect(f.calls).toHaveLength(calls); expect(f.api.controlPlaneLocked.value).toBe(false);
  expect(f.api.loading.value).toBe(false); expect(f.timers.size).toBe(0);
  f.controls.list = undefined; f.state.locked = true; await f.api.refresh();
  expect(f.api.controlPlaneLocked.value).toBe(true); expect(f.timers.size).toBe(1); f.api.stop();
});

for (const reopen of [false, true]) test(`late cancellation cannot refresh stopped or reopened view (reopen=${reopen})`, async () => {
  const f = await fixture(), action = deferred(); await f.api.refresh();
  f.controls.action = () => action.promise;
  const cancel = f.api.cancel('job'); f.api.stop();
  if (reopen) await f.api.refresh();
  const calls = f.calls.length, timers = [...f.timers.keys()];
  action.resolve({ id: 'job', status: 'cancelled' }); await cancel;
  expect(f.calls).toHaveLength(calls); expect([...f.timers.keys()]).toEqual(timers);
  expect(f.api.jobs.value[0].status).toBe('running'); f.api.stop();
});

const acceptAction = (api: any, kind: string) => {
  if (kind === 'create') return api.create('local', {}, 'late-request');
  if (kind === 'restore') return api.restore('artifact', {}, 'late-request');
  if (kind === 'discover') return api.discover('local', 'late-request');
  if (kind === 'adopt') return api.adopt('remote', 'late-request');
  return api.upload({ name: 'synthetic-file' }, 'late-request');
};
for (const kind of ['create', 'restore', 'discover', 'adopt', 'upload'])
  for (const reopen of [false, true]) test(`late ${kind} retains receipt without mutating old/new view (reopen=${reopen})`, async () => {
    const f = await fixture(), action = deferred(); await f.api.refresh();
    f.controls.action = () => action.promise;
    const accepting = acceptAction(f.api, kind); f.api.stop();
    if (reopen) await f.api.refresh();
    const calls = f.calls.length, timers = [...f.timers.keys()];
    const operation = kind === 'restore' ? 'restore' : kind === 'create' ? 'create' : kind === 'discover' ? 'discovery' : 'adoption';
    const lateJob = { id: 'late-job', operation, status: 'running' };
    action.resolve({ accepted: true, jobId: lateJob.id, job: lateJob }); await accepting;
    expect(f.api.jobs.value.map((job: any) => job.id)).toEqual(['job']);
    expect(f.calls).toHaveLength(calls); expect([...f.timers.keys()]).toEqual(timers);
    // Only a fresh refresh adopts the receipt. Even with lists unavailable,
    // the exact accepted identity is sufficient for the barrier-safe route.
    f.state.locked = true;
    f.controls.status = async path => path.endsWith('/late-job') ? lateJob : { id: 'job', operation: 'create', status: 'running' };
    await f.api.refresh();
    expect(f.api.jobs.value.some((job: any) => job.id === 'late-job')).toBe(true);
    if (operation === 'create' || operation === 'restore')
      expect(f.calls).toContain('/api/admin/instance-backups/jobs/late-job:GET');
    else expect(f.timers.size).toBe(1); // Ordinary jobs await full-state polling.
    f.api.stop();
  });

test('late accepted receipt never replaces newer authoritative terminal state on reopen', async () => {
  const f = await fixture(), action = deferred(); await f.api.refresh();
  f.controls.action = () => action.promise;
  const creating = f.api.create('local', {}, 'late-request'); f.api.stop();
  f.state.status = 'cancelled'; await f.api.refresh();
  action.resolve({ accepted: true, jobId: 'job', job: { id: 'job', operation: 'create', status: 'queued' } }); await creating;
  expect(f.api.jobs.value[0].status).toBe('cancelled');
  f.state.locked = true; await f.api.refresh();
  expect(f.api.jobs.value[0].status).toBe('cancelled'); f.api.stop();
});

test('acceptance from an old view does not invalidate a newer view refresh in flight', async () => {
  const f = await fixture(), action = deferred(), list = deferred(); await f.api.refresh();
  f.controls.action = () => action.promise;
  const creating = f.api.create('local', {}, 'late-request'); f.api.stop();
  f.controls.list = () => list.promise;
  const currentRefresh = f.api.refresh();
  action.resolve({ accepted: true, jobId: 'late-job', job: { id: 'late-job', operation: 'create', status: 'queued' } }); await creating;
  expect(f.api.loading.value).toBe(true);
  list.resolve({ jobs: [], artifacts: [], remoteBackups: [], options: {} }); await currentRefresh;
  expect(f.api.loading.value).toBe(false);
  expect(f.api.jobs.value.map((job: any) => job.id)).toEqual(['late-job']);
  expect(f.timers.size).toBe(1); f.api.stop();
});

for (const stopAgain of [false, true]) test(`late receipt wakes an idle reopened view without reviving a stopped view (stopAgain=${stopAgain})`, async () => {
  const f = await fixture(), action = deferred(), statusEntered = deferred();
  f.controls.list = async () => ({ jobs: [], artifacts: [], remoteBackups: [], options: {} });
  await f.api.refresh(); f.controls.action = () => action.promise;
  const creating = f.api.create('local', {}, 'late-request'); f.api.stop();
  await f.api.refresh(); expect(f.timers.size).toBe(0);
  const lateJob = { id: 'late-job', operation: 'create', status: 'running' };
  const calls = f.calls.length;
  action.resolve({ accepted: true, job: lateJob }); await creating;
  expect(f.api.jobs.value).toEqual([]); expect(f.calls).toHaveLength(calls);
  expect(f.timers.size).toBe(1);
  const [timerId, poll] = [...f.timers.entries()][0]!;
  if (stopAgain) {
    f.api.stop(); poll();
    expect(f.calls).toHaveLength(calls); expect(f.timers.size).toBe(0);
  } else {
    f.controls.list = undefined; f.state.locked = true;
    f.controls.status = async () => { statusEntered.resolve(null); return lateJob; };
    f.timers.delete(timerId); poll(); await statusEntered.promise;
    expect(f.api.jobs.value.map((job: any) => job.id)).toEqual(['late-job']);
    expect(f.calls).toContain('/api/admin/instance-backups/jobs/late-job:GET');
    f.api.stop();
  }
});

async function modalFixture() {
  const f = await fixture(), open = ref(true), scope = effectScope(), teardown: (() => void)[] = [];
  const source = await readFile(new URL('../../orchestrator/app/components/InstanceBackupManagementModal.vue', import.meta.url), 'utf8');
  const script = source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1];
  const exports: any = {};
  // Execute the actual SFC script with Vue reactivity. Model/lifecycle macros
  // are harness-owned; no DOM rendering or browser acceptance is asserted.
  const code = ts.transpileModule(script + '\nexports.review = { run, busy, actionError, notice, loadPreflight, selectedArtifact, restorePreflight, preflightLoading, restoreDockerVolumes };', {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  scope.run(() => runInNewContext(code, { exports, ref, computed, reactive, watch,
    defineModel: () => open, defineEmits: () => () => {}, useInstanceBackups: () => f.api,
    onBeforeUnmount: (fn: () => void) => teardown.push(fn),
  }));
  return { ...f, open, view: exports.review, close: () => { for (const fn of teardown) fn(); scope.stop(); } };
}
for (const fails of [false, true]) test(`closed modal action cannot overwrite reopened action state (failure=${fails})`, async () => {
  const f = await modalFixture(), old = deferred(), newer = deferred();
  try {
    const prior = f.view.run('create', () => old.promise);
    f.open.value = false; f.open.value = true;
    const current = f.view.run('restore', () => newer.promise);
    expect(f.view.busy.value).toBe('restore');
    if (fails) old.reject(new Error('obsolete failure'));
    else old.resolve({ accepted: true });
    expect(await prior).toBeUndefined();
    expect(f.view.actionError.value).toBe(''); expect(f.view.busy.value).toBe('restore');
    newer.resolve({ accepted: true }); expect(await current).toEqual({ accepted: true });
    expect(f.view.busy.value).toBe('');
  } finally { old.resolve({}); newer.resolve({}); f.close(); }
});

for (const fails of [false, true]) test(`late preflight cannot mutate a reopened view (failure=${fails})`, async () => {
  const f = await modalFixture(), old = deferred(), current = deferred(), entered = deferred();
  try {
    f.view.selectedArtifact.value = { id: 'artifact' };
    f.controls.preflight = () => old.promise;
    const prior = f.view.loadPreflight();
    f.open.value = false;
    expect(f.view.restorePreflight.value).toBeNull(); expect(f.view.preflightLoading.value).toBe(false);
    f.controls.preflight = () => { entered.resolve(null); return current.promise; };
    f.open.value = true; await entered.promise;
    expect(f.view.preflightLoading.value).toBe(true);
    if (fails) old.reject(new Error('obsolete preflight failure'));
    else old.resolve({ ready: true, sourceInstallationId: 'obsolete' });
    await prior;
    expect(f.view.restorePreflight.value).toBeNull();
    expect(f.view.actionError.value).toBe(''); expect(f.view.preflightLoading.value).toBe(true);
    current.resolve({ ready: false, sourceInstallationId: 'current' });
    await expect.poll(() => f.view.restorePreflight.value?.sourceInstallationId).toBe('current');
    expect(f.view.preflightLoading.value).toBe(false);
  } finally { old.resolve({}); current.resolve({}); f.close(); }
});

for (const change of ['close', 'unmount', 'artifact', 'reselect', 'scope'])
  for (const fails of [false, true]) test(`late preflight ignores ${change} (failure=${fails})`, async () => {
    const f = await modalFixture(), old = deferred();
    try {
      f.view.selectedArtifact.value = { id: 'artifact' };
      f.controls.preflight = () => old.promise;
      const prior = f.view.loadPreflight();
      if (change === 'close') f.open.value = false;
      if (change === 'unmount') f.close();
      // Same ID, different artifact observation must also invalidate results.
      if (change === 'artifact') f.view.selectedArtifact.value = { id: 'artifact' };
      if (change === 'reselect') {
        const artifact = f.view.selectedArtifact.value;
        f.view.selectedArtifact.value = null;
        f.view.selectedArtifact.value = artifact;
      }
      if (change === 'scope') {
        f.controls.preflight = async () => ({ ready: false, sourceInstallationId: 'current' });
        f.view.restoreDockerVolumes.value = false;
      }
      f.view.actionError.value = 'current error';
      if (fails) old.reject(new Error('obsolete preflight failure'));
      else old.resolve({ ready: true, sourceInstallationId: 'obsolete' });
      await prior;
      expect(f.view.restorePreflight.value?.sourceInstallationId).not.toBe('obsolete');
      if (change !== 'scope') expect(f.view.actionError.value).toBe('current error');
    } finally { old.resolve({}); f.close(); }
  });
