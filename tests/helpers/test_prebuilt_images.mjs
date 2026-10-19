import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { pins, privateFile, readonlyBind, daemonIdentity, checkedArchive, main } from '../docker/load-prebuilt-images.mjs';

const id = `sha256:${'a'.repeat(64)}`, sha256 = 'b'.repeat(64);
const env = { AGENTOR_TEST_PREBUILT_IMAGES: 'true' };
for (const role of ['WORKER', 'ORCHESTRATOR']) {
  env[`AGENTOR_TEST_PREBUILT_${role}_ID`] = id;
  env[`AGENTOR_TEST_PREBUILT_${role}_SHA256`] = sha256;
}
test('explicit mode and full pins; archive paths and tags cannot be supplied', () => {
  assert.deepEqual(pins(env).map(({ path, tag }) => [path, tag]), [
    ['/run/agentor-prebuilt-worker.tar', 'agentor-worker:latest'],
    ['/run/agentor-prebuilt-orchestrator.tar', 'agentor-orchestrator:latest'],
  ]);
  for (const key of Object.keys(env)) assert.throws(() => pins({ ...env, [key]: '' }));
  assert.throws(() => pins({ ...env, AGENTOR_TEST_PREBUILT_WORKER_ID: 'sha256:abc' }));
  assert.throws(() => pins({ ...env, AGENTOR_TEST_PREBUILT_ORCHESTRATOR_SHA256: 'F'.repeat(64) }));
});
test('root-private bounded regular files only', () => {
  const stat = { isFile: () => true, uid: 0, mode: 0o100600, size: 10 };
  privateFile(stat, 20);
  for (const patch of [{ isFile: () => false }, { uid: 1000 }, { mode: 0o100640 }, { size: 0 }, { size: 21 }]) {
    assert.throws(() => privateFile({ ...stat, ...patch }, 20));
  }
});
test('distinct exact read-only archive mounts only', () => {
  const target = '/run/agentor-prebuilt-worker.tar';
  const line = `1 2 0:1 /file ${target} ro,relatime - ext4 /dev/vda rw`;
  readonlyBind(line, target);
  for (const invalid of ['', line.replace('ro,', 'rw,'), `${line}\n${line}`, line.replace(target, '/run')]) assert.throws(() => readonlyBind(invalid, target));
});
test('exact private marker and overlay2 daemon identity required', () => {
  const marker = { kind: 'agentor-isolated-test-dind', daemonId: 'private-id', hostname: 'runner', dockerRootDir: '/var/lib/docker' };
  const info = { ID: 'private-id', Name: 'runner', DockerRootDir: '/var/lib/docker', Driver: 'overlay2' };
  daemonIdentity(marker, info, 'runner');
  for (const key of Object.keys(marker)) assert.throws(() => daemonIdentity({ ...marker, [key]: 'foreign' }, info, 'runner'));
  for (const key of Object.keys(info)) assert.throws(() => daemonIdentity(marker, { ...info, [key]: 'foreign' }, 'runner'));
});
test('actual verified descriptor retains bytes and detects changed digest/symlink/special file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-images-'));
  const file = path.join(dir, 'archive.tar'), bytes = Buffer.from('fixed fixture bytes');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  try {
    // The production validator requires root-owned export files.
    if (process.getuid() !== 0) fs.chownSync(file, 0, 0);
    const opened = checkedArchive(file, crypto.createHash('sha256').update(bytes).digest('hex'));
    try { assert.deepEqual(fs.readFileSync(opened.fd), bytes); } finally { fs.closeSync(opened.fd); }
    assert.throws(() => checkedArchive(file, sha256), /SHA256 mismatch/);
    fs.symlinkSync(file, path.join(dir, 'link'));
    assert.throws(() => checkedArchive(path.join(dir, 'link'), sha256));
    assert.throws(() => checkedArchive(dir, sha256));
    assert.throws(() => checkedArchive(file, sha256, bytes.length - 1), /bounded/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('missing pins refuse before any Docker invocation', () => {
  const original = childProcess.execFileSync, mode = process.env.AGENTOR_TEST_PREBUILT_IMAGES;
  let calls = 0;
  childProcess.execFileSync = () => { calls++; throw Error('NO LIVE COMMAND'); };
  delete process.env.AGENTOR_TEST_PREBUILT_IMAGES;
  try { assert.throws(() => main(), /explicit opt-in/); assert.equal(calls, 0); }
  finally {
    childProcess.execFileSync = original;
    if (mode === undefined) delete process.env.AGENTOR_TEST_PREBUILT_IMAGES; else process.env.AGENTOR_TEST_PREBUILT_IMAGES = mode;
  }
});
test('default builds and every downstream phase remain after the opt-in branch', () => {
  const source = fs.readFileSync(new URL('../docker/test-entrypoint.sh', import.meta.url), 'utf8');
  const branch = source.indexOf('if [[ "${AGENTOR_TEST_PREBUILT_IMAGES:-false}"');
  const end = source.indexOf('\nfi', branch);
  assert.match(source.slice(branch, end), /else\n    log[^]*build_with_retry agentor-worker:latest \/src\/worker\n    log "Worker image built\."\n    build_with_retry agentor-orchestrator:latest \/src -f \/src\/orchestrator\/Dockerfile/);
  let previous = end;
  for (const phase of ['Validating constrained volume-size helper', '# Phase 3:', '# Phase 4:', '# Phase 5:', '# Phase 6:']) {
    const at = source.indexOf(phase); assert.ok(at > previous, phase); previous = at;
  }
  assert.match(fs.readFileSync(new URL('../docker/Dockerfile', import.meta.url), 'utf8'), /COPY load-prebuilt-images.mjs \/usr\/local\/lib\/agentor-load-prebuilt-images.mjs/);
});
test('complete pinned load/tag flow; corrupt second archive prevents every Docker command', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prebuilt-flow-'));
  const fixtureEnv = { ...env, AGENTOR_TEST_PREBUILT_ORCHESTRATOR_ID: `sha256:${'c'.repeat(64)}` };
  const marker = path.join(dir, 'marker');
  fs.writeFileSync(marker, JSON.stringify({ kind: 'agentor-isolated-test-dind', hostname: os.hostname(), daemonId: 'fresh', dockerRootDir: '/var/lib/docker' }), { mode: 0o600 });
  const originals = { open: fs.openSync, read: fs.readFileSync, exec: childProcess.execFileSync };
  const saved = Object.fromEntries(Object.keys(fixtureEnv).map((key) => [key, process.env[key]]));
  const paths = new Map([['/run/agentor-isolated-docker.json', marker]]);
  for (const image of pins(fixtureEnv)) {
    const file = path.join(dir, image.role), bytes = Buffer.from(image.role);
    fs.writeFileSync(file, bytes, { mode: 0o600 }); paths.set(image.path, file);
    fixtureEnv[`AGENTOR_TEST_PREBUILT_${image.role}_SHA256`] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  const commands = []; let failLoad = false;
  fs.openSync = (file, ...args) => originals.open(paths.get(file) ?? file, ...args);
  fs.readFileSync = (file, ...args) => file === '/proc/self/cgroup' ? '0::/init\n'
    : file === '/proc/self/mountinfo' ? pins(fixtureEnv).map(({ path }) => `1 2 0:1 /file ${path} ro - ext4 /dev/vda rw`).join('\n')
    : originals.read(file, ...args);
  childProcess.execFileSync = (command, args, options) => {
    assert.equal(command, 'docker'); assert.deepEqual(args.slice(0, 2), ['--host', 'unix:///var/run/docker.sock']);
    assert.equal(options.env.DOCKER_CONTEXT, undefined);
    const operation = args.slice(2); commands.push(operation);
    if (operation[0] === 'info') return JSON.stringify({ ID: 'fresh', Name: os.hostname(), DockerRootDir: '/var/lib/docker', Driver: 'overlay2' });
    if (operation[0] === 'load') {
      if (failLoad) throw Object.assign(new Error('unreported generic error'), {
        status: 23, code: 'ERR_TEST_LOAD', stderr: Buffer.from('known load reason\n' + 'x'.repeat(10_000)) });
      assert.ok(fs.readFileSync(options.stdio[0]).length); return 'Loaded';
    }
    if (operation[1] === 'inspect') return JSON.stringify([{ Id: operation[2], Os: 'linux', Architecture: 'amd64' }]);
    if (operation.includes('--no-trunc')) return pins(fixtureEnv).map(({ id }) => id).join('\n');
    return '';
  };
  try {
    Object.assign(process.env, fixtureEnv);
    process.env.AGENTOR_TEST_PREBUILT_ORCHESTRATOR_SHA256 = sha256;
    assert.throws(() => main(), /SHA256 mismatch/); assert.equal(commands.length, 0);
    Object.assign(process.env, fixtureEnv);
    failLoad = true;
    assert.throws(() => main(), (error) => {
      assert.match(error.message, /local Docker command.*"load"/);
      assert.match(error.message, /status=23/); assert.match(error.message, /ERR_TEST_LOAD/);
      assert.match(error.message, /known load reason/); assert.match(error.message, /truncated/);
      assert.match(error.message, /do not reuse this attempt/);
      assert.ok(error.message.length < 5000); assert.ok(!error.message.includes('unreported generic error'));
      return true;
    });
    assert.equal(commands.filter(([op]) => op === 'load').length, 1);
    commands.length = 0; failLoad = false;
    main();
    assert.equal(commands.filter(([op]) => op === 'load').length, 2);
    assert.deepEqual(commands.filter(([op]) => op === 'tag'), pins(fixtureEnv).map(({ id, tag }) => ['tag', id, tag]));
  } finally {
    fs.openSync = originals.open; fs.readFileSync = originals.read; childProcess.execFileSync = originals.exec;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true });
  }
});
