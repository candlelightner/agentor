import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, chmod, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const orchestratorRoot = fileURLToPath(new URL('./', import.meta.url));
const allowedVmAssets = new Set(['99-incus-agent.rules', 'Dockerfile.vm',
  'agentor-dnsmasq.service', 'agentor-docker-storage.service', 'agentor-docker-storage.sh',
  'agentor-network.sh', 'agentor-private-storage.sh', 'agentor-worker.service',
  'incus-agent-setup', 'incus-agent.service']);

/** Package the canonical bootstrap, not a second VM OS definition. The
 * parent computes conversion inputs from these bytes; guest output never
 * supplies metadata, recipe identity, or authorization. */
export async function buildIncusWorkerAssets(destination = join(orchestratorRoot,
  '.output/server/incus-bootstrap')) {
  const vm = join(sourceRoot, 'worker/vm');
  for (const directory of ['scripts', 'worker', 'worker/vm']) {
    const stat = await lstat(join(sourceRoot, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Canonical VM bootstrap requires real source directories');
  }
  const entries = await readdir(vm, { withFileTypes: true });
  if (entries.length !== allowedVmAssets.size || entries.some(entry =>
    !entry.isFile() || !allowedVmAssets.has(entry.name)))
    throw new Error('Canonical VM bootstrap contains unsupported assets');
  const names = ['scripts/build-incus-worker-image.sh', 'worker/entrypoint.sh',
    ...entries.map(entry => 'worker/vm/' + entry.name).sort()];
  const files = [];
  for (const name of names) {
    const path = join(sourceRoot, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
      throw new Error('Canonical VM bootstrap asset must be a bounded regular file');
    const bytes = await readFile(path);
    files.push({ name, size: bytes.length, mode: stat.mode & 0o777,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // Build destinations are exclusive. Never overwrite another generation.
  await mkdir(destination, { mode: 0o700 });
  for (const file of files) {
    const target = join(destination, file.name);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(sourceRoot, file.name), target);
    await chmod(target, file.mode);
    if (createHash('sha256').update(await readFile(target)).digest('hex') !== file.sha256)
      throw new Error('Canonical VM bootstrap asset changed during packaging');
  }
  await writeFile(join(destination, 'manifest.json'), JSON.stringify({ version: 1, files }) + '\n',
    { flag: 'wx', mode: 0o600 });
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const files = await buildIncusWorkerAssets(process.argv[2]);
  console.log(`Canonical Incus bootstrap: ${files.length} hashed source assets`);
}
