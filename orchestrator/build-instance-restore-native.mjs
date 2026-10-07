import { build } from 'esbuild';
import { nodeFileTrace } from '@vercel/nft';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const sourceRoot = fileURLToPath(new URL('./', import.meta.url));
const externalPackages = new Set(['ws', 'h3', 'dockerode', 'tar-stream']);

/** Compile accepted adapters, not Nitro/services. Trace third-party files into
 * a separate tree: Nitro's node_modules can contain incomplete packages. */
export async function buildInstanceRestoreNative(outputDirectory = join(sourceRoot, '.output/server/instance-restore-native')) {
  const result = await build({
    absWorkingDir: sourceRoot, entryPoints: ['instance-restore-native.ts'],
    bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    write: false, metafile: true, treeShaking: true,
    // Do not inherit generated Nitro aliases for otherwise external packages.
    tsconfigRaw: { compilerOptions: {} },
  });
  const output = Object.values(result.metafile.outputs)[0];
  const bundledInputs = Object.entries(output.inputs).filter(([, value]) => value.bytesInOutput > 0).map(([path]) => path);
  if (bundledInputs.some(path => /(?:^|\/)node_modules\//.test(path) ||
      /(?:^|\/)server\/(?:api|routes|middleware|plugins)\//.test(path) ||
      /(?:^|\/)server\/utils\/(?:services|container|auth|instance-backup-manager)\.ts$/.test(path)))
    throw new Error('Standalone native restore adapter includes application/bootstrap code');
  const packages = [...new Set(output.imports.filter(item => !item.path.startsWith('node:')).map(item => item.path))];
  if (packages.some(name => !externalPackages.has(name)))
    throw new Error('Standalone native restore adapter has an unexpected external dependency');
  const code = result.outputFiles[0].text;
  const virtualEntry = join(sourceRoot, 'instance-restore-native.build.mjs');
  // Trace packages only. The accepted runtime also observes caller-selected
  // data/guest paths; tracing those FS calls would copy unrelated app fixtures.
  const traceEntry = packages.map(name => `import ${JSON.stringify(name)};`).join('\n');
  const traced = await nodeFileTrace([virtualEntry], { base: sourceRoot, processCwd: sourceRoot,
    readFile: async path => path === virtualEntry ? traceEntry : readFile(path).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
      throw error;
    }),
  });
  const files = [...traced.fileList].filter(path => path.startsWith('node_modules/')).sort();
  const outside = [...traced.fileList].filter(path => path !== relative(sourceRoot, virtualEntry) &&
    path !== 'package.json' && !path.startsWith('node_modules/'));
  if (files.length > 2000 || outside.length)
    throw new Error('Standalone dependency trace escaped its bounded package graph: ' +
      JSON.stringify({ dependencyFiles: files.length, outside: outside.slice(0, 8) }));
  const destination = resolve(outputDirectory);
  // Never overwrite or delete a pre-existing directory, including test output.
  await mkdir(destination, { mode: 0o700 });
  try {
    await writeFile(join(destination, 'index.mjs'), code, { flag: 'wx', mode: 0o600 });
    const packageRoot = await realpath(join(sourceRoot, 'node_modules'));
    let dependencyBytes = 0;
    for (const file of files) {
      const source = await realpath(join(sourceRoot, file));
      if (!source.startsWith(packageRoot + '/')) throw new Error('Standalone dependency source escapes installed packages');
      const bytes = await readFile(source);
      dependencyBytes += bytes.length;
      if (dependencyBytes > 100 * 1024 * 1024) throw new Error('Standalone dependency graph exceeds byte limit');
      const target = join(destination, file);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    // No operator environment, NODE_PATH, Nitro globals or network setup.
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      const adapter = await import(process.argv[1]);
      for (const name of ['IncusWorkerRuntime', 'IncusWorkerStorage', 'IncusManagedVolumeRuntime',
        'prepareInstanceNativeVolumeArchive', 'WorkerStore', 'ManagedVolumeStore',
        'ImageCatalogCore', 'IncusWorkerImageManager']) assert.equal(typeof adapter[name], 'function');
      for (const method of ['createCanonicalRestore', 'restoreCanonicalArchives', 'finishCanonicalRestore'])
        assert.equal(typeof adapter.IncusWorkerRuntime.prototype[method], 'function');
      assert.equal(typeof adapter.IncusWorkerStorage.prototype.freshRestoreDevices, 'function');
      assert.equal(typeof adapter.IncusManagedVolumeRuntime.prototype.freshRestoreVolume, 'function');
      assert.equal(typeof globalThis.useLogger, 'undefined');
      assert.equal(typeof globalThis.useRuntimeConfig, 'undefined');
    `, pathToFileURL(join(destination, 'index.mjs')).href], { env: {}, cwd: destination, timeout: 10_000 });
    return { bundledInputs, externalPackages: packages.sort(), dependencyFiles: files.length,
      bundleBytes: Buffer.byteLength(code), dependencyBytes };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length > 3) throw new Error('Usage: node build-instance-restore-native.mjs [new-output-directory]');
  const result = await buildInstanceRestoreNative(process.argv[2]);
  console.log(`Native restore adapter: ${result.bundleBytes} bytes, ${result.dependencyFiles} dependency files`);
}
