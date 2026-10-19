import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../docker/test-entrypoint.sh', import.meta.url), 'utf8');
const phase = source.slice(source.indexOf('cleanup_build_cache() {'), source.indexOf('# Exercise the exact production sizing-helper'));
const cacheEnvironment = { CI: 'true', AGENTOR_TEST_GHA_CACHE: 'true', ACTIONS_RUNTIME_TOKEN: 'fixture-token', ACTIONS_RESULTS_URL: 'https://cache.invalid/' };

// Run the actual build control flow with Docker, Node and sleep replaced before
// sourcing it. No daemon, image, network request or privileged fixture is used.
function run(environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentor-build-cache-'));
  const callsPath = join(directory, 'calls');
  const harness = String.raw`
set -euo pipefail
attempts=0
record() { printf '%s\0' "$@" >> "$CALLS"; printf '\0' >> "$CALLS"; }
log() { echo "$*"; }
err() { echo "$*" >&2; }
sleep() { record sleep "$@"; }
timeout() {
    record timeout "$@"
    shift 3
    "$@"
}
node() { record node "$@"; }
docker() {
    record docker "$@"
    if [[ "$*" == "buildx create "* ]]; then return "$FAIL_CREATE"; fi
    if [[ "$*" == "buildx prune "* ]]; then return "$FAIL_CLEANUP"; fi
    if [[ "$1" == build || "$*" == "buildx build "* ]]; then
        ((attempts += 1))
        if (( attempts <= FAIL_BUILDS )); then return 1; fi
    fi
}
`;
  try {
    const result = spawnSync('bash', ['-c', harness + '\n' + phase], {
      env: { PATH: process.env.PATH, CALLS: callsPath, FAIL_CREATE: '0', FAIL_BUILDS: '0', FAIL_CLEANUP: '0', ...environment }, encoding: 'utf8', timeout: 10_000,
    });
    let calls: string[][] = [];
    try { calls = readFileSync(callsPath, 'utf8').split('\0\0').filter(Boolean).map(call => call.split('\0')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return { ...result, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('local builds use the exact original sources without Buildx or Actions credentials', () => {
  const result = run();
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toEqual([
    ['docker', 'build', '-t', 'agentor-worker:latest', '/src/worker'],
    ['docker', 'build', '-t', 'agentor-orchestrator:latest', '-f', '/src/orchestrator/Dockerfile', '/src'],
  ]);
});

test('CI caches source builds with distinct bounded v2 scopes and loads into the same daemon', () => {
  const result = run(cacheEnvironment);
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls[0]).toEqual(['docker', 'buildx', 'create', '--name', 'agentor-test-builder', '--driver', 'docker-container', '--driver-opt', 'image=moby/buildkit:buildx-stable-1', '--use']);
  const builds = result.calls.filter(call => call[1] === 'buildx' && call[2] === 'build');
  for (const [index, role] of ['worker', 'orchestrator'].entries()) {
    const call = builds[index]!;
    expect(call.slice(0, 9)).toEqual(['docker', 'buildx', 'build', '--builder', 'agentor-test-builder', '--load', '-t', `agentor-${role}:latest`, '--cache-from']);
    expect(call[9]).toBe(`type=gha,version=2,scope=agentor-test-${role}-amd64,timeout=2m`);
    expect(call.slice(10, 12)).toEqual(['--cache-from', `type=gha,version=2,scope=${role}-amd64,timeout=2m`]);
    expect(call.slice(12, 14)).toEqual(['--cache-to', `type=gha,version=2,scope=agentor-test-${role}-amd64,mode=max,timeout=2m,ignore-error=true`]);
    expect(call.slice(14)).toEqual(role === 'worker' ? ['/src/worker'] : ['-f', '/src/orchestrator/Dockerfile', '/src']);
  }
  expect(result.calls.filter(call => call[0] === 'timeout')).toEqual(Array(2).fill([
    'timeout', '--signal=TERM', '--kill-after=10s', '60s', 'docker', 'buildx', 'prune', '--builder', 'agentor-test-builder', '--all', '--force',
  ]));
  expect(result.stdout + result.stderr).not.toContain('fixture-token');
});

test('cache opt-in requires the CI context and both runtime credentials before any Docker call', () => {
  for (const key of ['CI', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_RESULTS_URL']) {
    const result = run({ ...cacheEnvironment, [key]: '' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires CI=true and GitHub Actions runtime credentials');
    expect(result.calls).toEqual([]);
  }
});

test('builder setup failure does not fall through to image builds', () => {
  const result = run({ ...cacheEnvironment, FAIL_CREATE: '12' });
  expect(result.status).toBe(12);
  expect(result.calls).toHaveLength(1);
});

test('failed bounded builder cleanup refuses further builds and tests', () => {
  const result = run({ ...cacheEnvironment, FAIL_CLEANUP: '124' });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('CI builder cache cleanup failed');
  expect(result.calls.flat()).not.toContain('agentor-orchestrator:latest');
  expect(result.calls.filter(call => call[0] === 'sleep')).toEqual([]);
});

for (const cached of [false, true]) test(`${cached ? 'cached' : 'local'} builds retry genuine build failures and preserve final failure`, () => {
  const environment = cached ? cacheEnvironment : {};
  const recovered = run({ ...environment, FAIL_BUILDS: '2' });
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(recovered.calls.filter(call => call[0] === 'sleep')).toHaveLength(2);
  if (cached) {
    const builds = recovered.calls.filter(call => call[1] === 'buildx' && call[2] === 'build');
    expect(builds[0]).toContain('--cache-from');
    for (const retry of builds.slice(1, 3)) expect(retry).toEqual([
      'docker', 'buildx', 'build', '--builder', 'agentor-test-builder', '--load', '-t', 'agentor-worker:latest', '/src/worker',
    ]);
    expect(builds[3]).toContain('--cache-from'); // The other image still attempts its independent cache.
  }
  const failed = run({ ...environment, FAIL_BUILDS: '4' });
  expect(failed.status).toBe(1);
  expect(failed.stderr).toContain('agentor-worker:latest failed after 4 attempts');
  expect(failed.calls.filter(call => call[0] === 'sleep')).toHaveLength(3);
  expect(failed.calls.flat()).not.toContain('agentor-orchestrator:latest');
  expect(failed.calls.filter(call => call[0] === 'timeout')).toHaveLength(cached ? 1 : 0);
  if (cached) expect(failed.calls.filter(call => call.includes('--cache-from'))).toHaveLength(1);
});

test('prebuilt fixture validation remains independent of the optional CI cache', () => {
  const result = run({ AGENTOR_TEST_PREBUILT_IMAGES: 'true', AGENTOR_TEST_GHA_CACHE: 'true' });
  expect(result.status, result.stderr).toBe(0);
  expect(result.calls).toEqual([['node', '/usr/local/lib/agentor-load-prebuilt-images.mjs']]);
});
