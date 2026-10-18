// Run: node tests/benchmarks/instance-backup-compression.mjs [volumeMiB=64] [volumes=3]
// Generated mixed random/repeated file trees only. No installation/Docker access.
import { createRequire } from 'node:module';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, availableParallelism } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'orchestrator/package.json'));
const { build } = require('esbuild'), tar = require('tar-stream');
const volumeMiB = Number(process.argv[2] || 64), volumeCount = Number(process.argv[3] || 3);
if (!Number.isSafeInteger(volumeMiB) || volumeMiB < 1 || volumeMiB > 1024 || !Number.isSafeInteger(volumeCount) || volumeCount < 1 || volumeCount > 16)
  throw new Error('Invalid dataset size');
const root = await mkdtemp(join(tmpdir(), 'agentor-compression-benchmark-'));
try {
  await symlink(join(repo, 'orchestrator/node_modules'), join(root, 'node_modules'));
  const compiled = await build({ stdin: { contents: `export { sanitizeBackupPathTarPayload, sanitizeBackupPathTarGzip, validateGzipTarPayload } from '${repo}/orchestrator/server/utils/worker-export.ts';\nexport { sha256File } from '${repo}/orchestrator/server/utils/instance-backup-bundle.ts';`, loader: 'ts', resolveDir: repo }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
  const entry = join(root, 'benchmark.cjs'); await writeFile(entry, compiled.outputFiles[0].contents);
  const { sanitizeBackupPathTarPayload, sanitizeBackupPathTarGzip, validateGzipTarPayload, sha256File } = require(entry);
  const dataset = join(root, 'source'); await mkdir(dataset);
  const sources = [];
  for (let volume = 0; volume < volumeCount; volume++) {
    const path = join(dataset, `volume-${volume}.tar`), pack = tar.pack();
    const writing = pipeline(pack, createWriteStream(path));
    const fileBytes = 16384, files = volumeMiB * 1048576 / fileBytes;
    for (let index = 0; index < files; index++) {
      const body = Buffer.alloc(fileBytes, 65 + index % 26);
      randomBytes(fileBytes / 2).copy(body);
      await new Promise((ok, fail) => pack.entry({ name: `source/group-${index % 32}/file-${index}`, size: body.length, mode: 0o640 }, body, error => error ? fail(error) : ok()));
    }
    pack.finalize(); await writing;
    sources.push({ path, entries: files, fileBytes: files * fileBytes, tarBytes: (await stat(path)).size });
  }
  const results = [];
  for (const implementation of ['before', 'after']) {
    const scratch = join(root, implementation); await mkdir(scratch);
    let peakTarScratch = 0, peakTransientWithPartial = 0, peakCompressionCores = 0;
    const childTicks = new Map();
    let sampling = false;
    const sample = async () => {
      if (sampling) return; sampling = true;
      try {
        let tarBytes = 0, partialBytes = 0;
        for (const name of await readdir(scratch)) {
          const bytes = await stat(join(scratch, name)).then(s => s.size, () => 0);
          if (name.endsWith('.raw') || name.endsWith('.tar')) tarBytes += bytes;
          if (name.endsWith('.partial')) partialBytes += bytes;
        }
        peakTarScratch = Math.max(peakTarScratch, tarBytes);
        peakTransientWithPartial = Math.max(peakTransientWithPartial, tarBytes + partialBytes);
        const children = await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8').catch(() => '');
        for (const pid of children.trim().split(/\s+/).filter(Boolean)) {
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
          if (!raw || raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')) !== 'pigz') continue;
          const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
          childTicks.set(pid, Math.max(childTicks.get(pid) || 0, Number(fields[11]) + Number(fields[12])));
          peakCompressionCores = Math.max(peakCompressionCores, Number(fields[17]));
        }
      } finally { sampling = false; }
    };
    const timer = setInterval(() => void sample(), 10);
    const started = performance.now(), cpu = process.cpuUsage(), volumes = [];
    try {
      for (let index = 0; index < sources.length; index++) {
        const source = sources[index], raw = join(scratch, 'volume.raw'), safe = join(scratch, 'volume.tar');
        const output = join(scratch, `volume-${index}.partial`), volumeStarted = performance.now();
        if (implementation === 'before') {
          await copyFile(source.path, raw);
          await sanitizeBackupPathTarPayload(raw, safe, '/');
          await sample();
          await pipeline(createReadStream(safe), createGzip({ level: 6 }), createWriteStream(output));
        } else {
          await sanitizeBackupPathTarGzip({ source: createReadStream(source.path), destination: output, selectedPath: '/' });
        }
        await sample();
        await validateGzipTarPayload(output);
        const digest = await sha256File(output), outputBytes = (await stat(output)).size;
        const elapsedSeconds = (performance.now() - volumeStarted) / 1000;
        volumes.push({ ...source, path: undefined, outputBytes, sha256: digest, elapsedSeconds,
          inputMiBPerSecond: source.tarBytes / 1048576 / elapsedSeconds });
        await Promise.all([rm(raw, { force: true }), rm(safe, { force: true }), rm(output)]);
      }
    } finally { clearInterval(timer); while (sampling) await new Promise(ok => setTimeout(ok, 1)); }
    const elapsedSeconds = (performance.now() - started) / 1000, ownCpu = process.cpuUsage(cpu);
    // Linux USER_HZ is 100. Short-lived child final ticks may be missed by sampling.
    const childCpuSecondsEstimate = [...childTicks.values()].reduce((sum, ticks) => sum + ticks / 100, 0);
    const cpuSecondsEstimate = (ownCpu.user + ownCpu.system) / 1000000 + childCpuSecondsEstimate;
    results.push({ implementation, elapsedSeconds, inputMiBPerSecond: sources.reduce((sum, source) => sum + source.tarBytes, 0) / 1048576 / elapsedSeconds,
      ownCpuMicros: ownCpu, childCpuSecondsEstimate, averageBusyCoresEstimate: cpuSecondsEstimate / elapsedSeconds,
      peakChildThreadCount: peakCompressionCores, peakTarScratchBytes: peakTarScratch,
      peakTransientBytesIncludingCurrentPartial: peakTransientWithPartial, volumes });
  }
  console.log(JSON.stringify({ node: process.version, availableParallelism: availableParallelism(), cpuQuota: await readFile('/sys/fs/cgroup/cpu.max', 'utf8').catch(() => 'unavailable'),
    dataset: { volumeMiB, volumeCount, totalFileBytes: sources.reduce((sum, source) => sum + source.fileBytes, 0) },
    results, speedup: results[0].elapsedSeconds / results[1].elapsedSeconds }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
