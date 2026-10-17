// Run: node tests/benchmarks/instance-backup-verification.mjs [entries=24000] [fileBytes=4096]
// Uses one generated archive for both implementations; never reads installation data.
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repo, 'orchestrator/package.json'));
const { build } = require('esbuild');
const tar = require('tar-stream');
const count = Number(process.argv[2] || 24000), fileBytes = Number(process.argv[3] || 4096);
if (!Number.isSafeInteger(count) || count < 1 || count > 2000000 || !Number.isSafeInteger(fileBytes) || fileBytes < 1 || fileBytes > 1048576)
  throw new Error('Invalid entry count or file byte size');
const scratch = await mkdtemp(join(tmpdir(), 'agentor-verify-benchmark-'));
const sourcePath = join(repo, 'orchestrator/server/utils/instance-backup-bundle.ts');
const source = await readFile(sourcePath, 'utf8');
const legacy = `function assertTreeEntry(tree, parents, name, kind) {
  if (tree.has(name)) throw new Error("Instance backup archive has a duplicate entry");
  const parts = name.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = tree.get(parts.slice(0, index).join("/"));
    if (ancestor && ancestor !== "directory") throw new Error("Instance backup archive traverses a non-directory");
  }
  for (const existing of tree.keys())
    if (existing.startsWith(name + "/") && kind !== "directory") throw new Error("Instance backup archive replaces an existing parent");
}`;
try {
  const archive = join(scratch, 'files.tar.gz');
  const pack = tar.pack(), writing = pipeline(pack, createGzip({ level: 6 }), createWriteStream(archive));
  const body = randomBytes(fileBytes);
  for (let index = 0; index < count; index++) {
    await new Promise((ok, fail) => pack.entry({ name: `files/group-${index % 128}/file-${index}`, size: body.length }, body, error => error ? fail(error) : ok()));
  }
  pack.finalize(); await writing;
  const results = [];
  for (const [implementation, input] of [['before', source.replace(/function assertTreeEntry\([\s\S]*?\n}\n/, legacy + '\n')], ['after', source]]) {
    const output = join(scratch, implementation + '.cjs');
    const compiled = await build({ stdin: { contents: input + '\nexport { validateTarGzip };', loader: 'ts', resolveDir: dirname(sourcePath) }, bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent' });
    await writeFile(output, compiled.outputFiles[0].contents);
    const { validateTarGzip } = require(output);
    const cpu = process.cpuUsage(), started = performance.now();
    await validateTarGzip(archive, false);
    const elapsedSeconds = (performance.now() - started) / 1000;
    const expandedBytes = count * (512 + Math.ceil(fileBytes / 512) * 512) + 1024;
    results.push({ implementation, entries: count, fileBytes: count * fileBytes, expandedBytes,
      compressedBytes: (await stat(archive)).size, elapsedSeconds,
      expandedMiBPerSecond: expandedBytes / 1048576 / elapsedSeconds, cpuMicros: process.cpuUsage(cpu) });
  }
  console.log(JSON.stringify({ results, speedup: results[0].elapsedSeconds / results[1].elapsedSeconds }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
