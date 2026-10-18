// Test-only Phase 2 alternative; every later real-stack/test phase is unchanged.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SOCKET = 'unix:///var/run/docker.sock';
const fail = (message) => { throw new Error(`Prebuilt fixture refused: ${message}`); };
export function pins(env) {
  if (env.AGENTOR_TEST_PREBUILT_IMAGES !== 'true') fail('explicit opt-in required');
  return ['WORKER', 'ORCHESTRATOR'].map((role) => {
    const id = env[`AGENTOR_TEST_PREBUILT_${role}_ID`];
    const sha256 = env[`AGENTOR_TEST_PREBUILT_${role}_SHA256`];
    if (!/^sha256:[a-f0-9]{64}$/.test(id ?? '') || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) fail('full image ID and archive SHA256 required');
    return { role, id, sha256, path: `/run/agentor-prebuilt-${role.toLowerCase()}.tar`, tag: `agentor-${role.toLowerCase()}:latest` };
  });
}
export function privateFile(stat, limit) {
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077) !== 0 || stat.size <= 0 || stat.size > limit) fail('expected bounded root-private regular file');
}
export function readonlyBind(mountinfo, path) {
  const mounts = mountinfo.trim().split('\n').map((line) => line.split(' ')).filter((fields) => fields[4] === path);
  if (mounts.length !== 1 || !mounts[0][5]?.split(',').includes('ro')) fail('fixed archive must be a distinct read-only file bind');
}
export function daemonIdentity(marker, info, hostname) {
  if (marker.kind !== 'agentor-isolated-test-dind' || marker.hostname !== hostname || !marker.daemonId
      || marker.dockerRootDir !== '/var/lib/docker' || info.ID !== marker.daemonId
      || info.Name !== hostname || info.DockerRootDir !== '/var/lib/docker' || info.Driver !== 'overlay2') fail('private daemon marker mismatch');
}
function unchanged(fd, before) {
  const after = fs.fstatSync(fd);
  for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) if (after[key] !== before[key]) fail('archive changed during verification/load');
}
export function checkedArchive(path, expectedHash, limit = 32 * 1024 ** 3) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    privateFile(before, limit);
    const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let offset = 0, length;
    while ((length = fs.readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
      hash.update(buffer.subarray(0, length)); offset += length;
    }
    unchanged(fd, before);
    if (hash.digest('hex') !== expectedHash) fail('archive SHA256 mismatch');
    return { fd, before };
  } catch (error) { fs.closeSync(fd); throw error; }
}
function docker(args, fd) {
  try {
    return childProcess.execFileSync('docker', ['--host', SOCKET, ...args], {
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', DOCKER_HOST: SOCKET },
      encoding: 'utf8', timeout: 15 * 60_000, maxBuffer: 1024 * 1024,
      stdio: [fd ?? 'ignore', 'pipe', 'pipe'],
    }).trim();
  } catch { fail('local Docker command failed; do not reuse this attempt'); }
}
export function main() {
  const images = pins(process.env), opened = [];
  if (process.getuid() !== 0 || fs.readFileSync('/proc/self/cgroup', 'utf8').trim() !== '0::/init') fail('private delegated runner required');
  const markerFd = fs.openSync('/run/agentor-isolated-docker.json', fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let marker;
  try {
    privateFile(fs.fstatSync(markerFd), 4096);
    marker = JSON.parse(fs.readFileSync(markerFd, 'utf8'));
  } finally { fs.closeSync(markerFd); }
  const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
  try {
    // Hash both inputs before the first load; keep their verified descriptors open.
    for (const image of images) {
      readonlyBind(mounts, image.path);
      opened.push(checkedArchive(image.path, image.sha256));
    }
    daemonIdentity(marker, JSON.parse(docker(['info', '--format', '{{json .}}'])), os.hostname());
    for (const args of [['image', 'ls', '-aq'], ['container', 'ls', '-aq'], ['volume', 'ls', '-q']]) {
      if (docker(args)) fail('prebuilt mode requires a fresh empty private daemon');
    }
    for (const [index, image] of images.entries()) {
      docker(['load'], opened[index].fd);
      unchanged(opened[index].fd, opened[index].before);
      const actual = JSON.parse(docker(['image', 'inspect', image.id]));
      if (actual.length !== 1 || actual[0].Id !== image.id || actual[0].Os !== 'linux' || actual[0].Architecture !== 'amd64') fail('loaded image does not match pinned Linux/amd64 config ID');
    }
    const loaded = new Set(docker(['image', 'ls', '-aq', '--no-trunc']).split('\n'));
    if (loaded.size !== 2 || images.some(({ id }) => !loaded.has(id))) fail('archives must contain exactly the two pinned images');
    for (const image of images) docker(['tag', image.id, image.tag]);
    console.log('[test-runner] Verified and loaded both pinned prebuilt images; continuing full suite.');
  } finally { for (const { fd } of opened) fs.closeSync(fd); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
