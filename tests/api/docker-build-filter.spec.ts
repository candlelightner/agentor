import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const { parse } = createRequire(new URL('../../orchestrator/package.json', import.meta.url))('yaml');
async function filters(): Promise<Record<string, string[]>> {
  const workflow = parse(await readFile(new URL('../../.github/workflows/docker-build.yml', import.meta.url), 'utf8'));
  return parse(workflow.jobs.changes.steps.find((step: any) => step.uses === 'dorny/paths-filter@v3').with.filters);
}

test('every orchestrator Dockerfile context input triggers its image and required validation', async () => {
  const config = await filters();
  const dockerfile = await readFile(new URL('../../orchestrator/Dockerfile', import.meta.url), 'utf8');
  const inputs = ['.dockerignore'];
  for (const line of dockerfile.split('\n').filter(value => value.startsWith('COPY ') && !value.includes('--from='))) {
    expect(line).not.toContain('['); // A future JSON COPY needs an explicit parser update.
    for (const source of line.split(/\s+/).slice(1, -1).filter(value => !value.startsWith('--')))
      inputs.push(source.endsWith('/') ? source + 'ci-dependency-probe' : source.replaceAll('*', ''));
  }
  expect(inputs.length).toBeGreaterThan(5);
  for (const path of inputs) for (const scope of ['orchestrator', 'validation'])
    expect(config[scope]!.some(pattern => matchesGlob(path, pattern)), `${scope} misses Dockerfile/context input ${path}`).toBe(true);
});

test('dependency detection stays narrow and preserves independent worker builds', async () => {
  const config = await filters();
  for (const path of ['docs/testing.md', 'scripts/unrelated-helper.sh'])
    for (const scope of ['orchestrator', 'validation']) expect(config[scope]!.some(pattern => matchesGlob(path, pattern))).toBe(false);
  expect(config.worker).toEqual(['worker/**', '.github/workflows/docker-build.yml', 'scripts/promote-main-image.sh']);
  for (const scope of ['orchestrator', 'worker', 'validation'])
    expect(config[scope]!.includes('scripts/promote-main-image.sh')).toBe(true);
  for (const path of ['scripts/incus-admin-network-policy.py', 'scripts/setup-incus-host.sh', 'scripts/profile-ci-workflow.py']) {
    expect(config.validation!.some(pattern => matchesGlob(path, pattern))).toBe(true);
    expect(config.orchestrator!.some(pattern => matchesGlob(path, pattern))).toBe(false);
  }
});

test('regression runner uses current source and publication still requires validation', async () => {
  const workflow = parse(await readFile(new URL('../../.github/workflows/docker-build.yml', import.meta.url), 'utf8'));
  const compose = parse(await readFile(new URL('../../docker-compose.tests.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.docker_regression.steps;
  expect(compose.services['test-runner'].build).toBe('./tests/docker');
  expect(steps.some((step: any) => step.name === 'Build cached isolated test runner')).toBe(false);
  const credentials = steps.find((step: any) => step.name === 'Export masked runtime cache credentials');
  expect(credentials.with.script).toContain('core.setSecret(value)');
  expect(credentials.with.script).not.toContain('GITHUB_TOKEN');
  const regression = steps.find((step: any) => step.name === 'Run bounded isolated regression suite');
  expect(regression.run).toBe('npm run test:docker:ci');
  expect(regression.env.AGENTOR_TEST_GHA_CACHE).toBe('true');
  expect(workflow.jobs.test_gate.needs).toEqual(['changes', 'quality', 'docker_regression']);
  for (const image of ['orchestrator', 'worker']) {
    expect(workflow.jobs[`build-${image}`].needs).toEqual(['changes', 'test_gate']);
    expect(workflow.jobs[`build-${image}`].if).toContain("needs.test_gate.result == 'success'");
  }
});

test('main promotion rejects stale runs for both images and retains publication boundaries', () => {
  execFileSync('python3', [new URL('../helpers/test_main_image_promotion.py', import.meta.url).pathname], { timeout: 30_000 });
});
