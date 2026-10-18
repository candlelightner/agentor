import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

const run = promisify(execFile);
export const PRIVATE_DOCKER_MARKER = '/run/agentor-isolated-docker.json';
export interface PrivateDockerMarker { kind: string; daemonId: string; hostname: string; dockerRootDir: string }

export function validatePrivateDockerMarker(marker: PrivateDockerMarker): void {
  if (!marker || marker.kind !== 'agentor-isolated-test-dind' || typeof marker.daemonId !== 'string' ||
      !/^[A-Za-z0-9:_-]{8,256}$/.test(marker.daemonId) || typeof marker.hostname !== 'string' ||
      !/^[A-Za-z0-9._-]{1,253}$/.test(marker.hostname) || marker.dockerRootDir !== '/var/lib/docker')
    throw new Error('Whole-instance acceptance requires its exact private nested Docker daemon');
}

export function validatePrivateDocker(marker: PrivateDockerMarker, info: { ID: string; DockerRootDir: string; Name: string }, currentHostname: string) {
  validatePrivateDockerMarker(marker);
  if (marker.daemonId !== info.ID ||
      marker.hostname !== currentHostname || marker.hostname !== info.Name ||
      marker.dockerRootDir !== '/var/lib/docker' || info.DockerRootDir !== marker.dockerRootDir)
    throw new Error('Whole-instance acceptance requires its exact private nested Docker daemon');
}

export function validatePrivateDockerCgroup(cgroup: string): void {
  // Phase 0 proves the private namespace root, then delegates its processes
  // into init before dockerd and Playwright inherit this exact child cgroup.
  if (cgroup.trim() !== '0::/init')
    throw new Error('Whole-instance acceptance requires the runner delegated private cgroup');
}

/** No Docker access occurs until the fresh runner's private regular marker is
 * proven. Every subsequent CLI call pins the local socket and drops overrides. */
export async function privateTestDocker() {
  const markerFile = await open(PRIVATE_DOCKER_MARKER, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let marker: PrivateDockerMarker;
  try {
    const s = await markerFile.stat();
    if (!s.isFile() || s.uid !== process.getuid?.() || (s.mode & 0o077) || s.size < 1 || s.size > 4096)
      throw new Error('Private nested Docker marker is unavailable');
    marker = JSON.parse(await markerFile.readFile('utf8'));
  } finally { await markerFile.close(); }
  validatePrivateDockerMarker(marker!);
  validatePrivateDockerCgroup(await readFile('/proc/self/cgroup', 'utf8'));
  const environment = { ...process.env };
  for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete environment[key];
  const docker = async (...args: string[]) => (await run('docker', ['--host', 'unix:///var/run/docker.sock', ...args],
    { env: environment, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 })).stdout.trim();
  const info = JSON.parse(await docker('info', '--format', '{{json .}}'));
  validatePrivateDocker(marker!, info, hostname());
  return docker;
}
