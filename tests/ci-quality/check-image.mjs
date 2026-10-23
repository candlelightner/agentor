#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };

export function compare(actual, expected) {
  for (const key of ['schema', 'nodeMajor', 'nodeABI', 'architecture', 'os', 'playwright', 'testLockSHA256', 'recipeSHA256', 'guardSHA256'])
    requireValue(actual[key] === expected[key], `Image contract mismatch (${key}); rebuild the candidate from the checked-out recipe and test lockfile`);
}

function expected(tests, recipe) {
  const lock = JSON.parse(readFileSync(resolve(tests, 'package-lock.json')));
  const playwright = lock.packages['node_modules/@playwright/test'].version;
  requireValue(lock.packages['node_modules/playwright-core'].version === playwright, 'Locked Playwright packages disagree');
  return { schema: 1, nodeMajor: 22, nodeABI: '127', architecture: 'x64', os: 'ubuntu:24.04', playwright,
    testLockSHA256: hash(resolve(tests, 'package-lock.json')), recipeSHA256: hash(recipe), guardSHA256: hash(fileURLToPath(import.meta.url)) };
}

function compareBrowser(actual, expected) {
  requireValue(actual?.revision === expected.revision && actual?.version === expected.version, 'Preinstalled Chromium revision/version differs from the image contract');
}

function browser(tests, contract) {
  const require = createRequire(resolve(tests, 'package.json'));
  const core = dirname(require.resolve('playwright-core/package.json'));
  const chromium = JSON.parse(readFileSync(resolve(core, 'browsers.json'))).browsers.find(item => item.name === 'chromium');
  requireValue(require('@playwright/test/package.json').version === contract.playwright, 'Installed test package differs from its checked-out lockfile');
  const executable = require('playwright-core').chromium.executablePath();
  requireValue(existsSync(executable), 'Locked Chromium executable is absent; rebuild the image instead of downloading a browser during validation');
  const version = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  requireValue(version.includes(chromium.browserVersion), 'Preinstalled Chromium binary differs from the locked browser version');
  return { revision: chromium.revision, version: chromium.browserVersion };
}

function toolVersions() {
  return Object.fromEntries([['npm', ['--version']], ['jq', ['--version']], ['tmux', ['-V']], ['pigz', ['--version']], ['python3', ['--version']], ['qemu-img', ['--version']],
    ['systemd-analyze', ['--version']], ['openssl', ['version']], ['tar', ['--version']], ['g++', ['--version']],
    ['docker', ['--version']], ['docker-compose', []]].map(([command, args]) => {
      try {
        const output = command === 'docker-compose'
          ? execFileSync('docker', ['compose', 'version'], { encoding: 'utf8', timeout: 10_000 })
          : execFileSync(command, args, { encoding: 'utf8', timeout: 10_000 });
        return [command, output.trim().split('\n')[0]];
      } catch { throw new Error(`Quality tool observation failed (${command}); rebuild the candidate with its required tools`); }
    }));
}

function selfTest() {
  const good = { schema: 1, nodeMajor: 22, nodeABI: '127', architecture: 'x64', os: 'ubuntu:24.04', playwright: '1.59.1', testLockSHA256: 'a', recipeSHA256: 'b', guardSHA256: 'c' };
  compare(good, { ...good });
  for (const key of Object.keys(good)) {
    assert.throws(() => compare({ ...good, [key]: 'stale' }, good), /Image contract mismatch/);
    const missing = { ...good }; delete missing[key];
    assert.throws(() => compare(missing, good), /Image contract mismatch/);
  }
  const chromium = { revision: '1217', version: '147.0.7727.15' };
  compareBrowser(chromium, { ...chromium });
  for (const key of Object.keys(chromium)) {
    assert.throws(() => compareBrowser({ ...chromium, [key]: 'stale' }, chromium), /Chromium revision/);
    const missing = { ...chromium }; delete missing[key];
    assert.throws(() => compareBrowser(missing, chromium), /Chromium revision/);
  }
  console.log('[ci-quality] Compatibility self-check passed: stale and missing toolchain/recipe/lock contracts are rejected.');
}

try {
  if (process.argv[2] === '--self-test') selfTest();
  else {
    const building = process.argv[2] === '--write';
    const tests = building ? here : resolve(here, '..');
    const contract = expected(tests, resolve(here, 'Dockerfile'));
    requireValue(process.platform === 'linux' && process.arch === contract.architecture, 'Quality image supports Linux amd64 only');
    requireValue(Number(process.versions.node.split('.')[0]) === 22 && process.versions.modules === contract.nodeABI, 'Quality validation requires Node 22 and its supported ABI');
    const os = readFileSync('/etc/os-release', 'utf8');
    requireValue(/^ID=ubuntu$/m.test(os) && /^VERSION_ID="24\.04"$/m.test(os), 'Quality validation requires Ubuntu 24.04 userspace');
    if (building) {
      requireValue(process.getuid() === 0, 'Image contract creation requires the image build context');
      writeFileSync(process.argv[3], JSON.stringify({ ...contract, nodeVersion: process.version, chromium: browser(tests, contract), tools: toolVersions() }, null, 2) + '\n');
    } else {
      requireValue(process.getuid() === 1001, 'Ordinary quality checks require nonroot UID 1001; sudo is reserved for the existing privileged fixture split');
      const actual = JSON.parse(readFileSync('/etc/agentor-ci-quality.json'));
      compare(actual, contract);
      if (process.argv[2] !== '--preflight') {
        compareBrowser(browser(tests, contract), actual.chromium);
        requireValue(actual.nodeVersion === process.version, 'Preinstalled Node patch version differs from the image contract');
        requireValue(JSON.stringify(toolVersions()) === JSON.stringify(actual.tools), 'Preinstalled tool versions differ from the image contract');
        execFileSync('sudo', ['-n', 'true'], { stdio: 'pipe', timeout: 10_000 });
      }
      console.log('[ci-quality] Checked-out image contract matches; supported tools are ready and validation may proceed.');
    }
  }
} catch (error) {
  // Do not emit raw subprocess diagnostics or runner paths from a failed guard.
  const reason = error instanceof Error && /^(Image contract mismatch|Locked |Installed test |Preinstalled Chromium |Quality |Ordinary quality |Image contract creation)/.test(error.message)
    ? error.message : 'Image compatibility/tool observation failed';
  console.error(`[ci-quality] ${reason}; candidate validation stopped. No browser/tool installation fallback was attempted.`);
  process.exitCode = 1;
}
