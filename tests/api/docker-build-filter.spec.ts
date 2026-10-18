import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { matchesGlob } from 'node:path';
import { createRequire } from 'node:module';

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
  expect(config.worker).toEqual(['worker/**', '.github/workflows/docker-build.yml']);
});
