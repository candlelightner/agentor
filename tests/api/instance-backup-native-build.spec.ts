import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const buildScript = fileURLToPath(new URL('../../orchestrator/build-instance-restore-native.mjs', import.meta.url));
const run = promisify(execFile);

test('standalone native helper adapter imports isolated locked dependencies without Nitro/network/operator environment', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'agentor-instance-native-build-'));
  const output = join(root, 'adapter');
  try {
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
      const {buildInstanceRestoreNative} = await import(process.argv[1]);
      console.log(JSON.stringify(await buildInstanceRestoreNative(process.argv[2])));
    `, pathToFileURL(buildScript).href, output], { env: {}, timeout: 45_000 });
    const result = JSON.parse(stdout.trim());
    expect(result.externalPackages).toEqual(['dockerode', 'h3', 'tar-stream', 'ws']);
    expect(result.dependencyFiles).toBeGreaterThan(0); expect(result.dependencyFiles).toBeLessThan(2000);
    // The shared catalog/converter leaf adds ~178KiB, not a second store or
    // application bootstrap. Keep a bounded budget and exact graph checks.
    expect(result.bundleBytes).toBeLessThan(800_000);
    expect(result.bundledInputs).toContain('server/utils/incus-worker-runtime.ts');
    expect(result.bundledInputs).toContain('server/utils/worker-config-store-core.ts');
    expect(result.bundledInputs).toContain('server/utils/image-catalog-core.ts');
    expect(result.bundledInputs).toContain('server/utils/incus-worker-image-manager.ts');
    expect(result.bundledInputs).not.toContain('server/utils/services.ts');
    expect(result.bundledInputs).not.toContain('server/utils/container.ts');
    expect(result.bundledInputs.some((path: string) => /server\/(api|plugins|routes|middleware)\//.test(path))).toBe(false);
    expect((await lstat(join(output, 'index.mjs'))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(output, 'node_modules/h3/dist/index.mjs'))).isSymbolicLink()).toBe(false);

    // All resolution must remain below the private output. No NODE_PATH or
    // symlink back to the checkout can mask missing production dependencies.
    const probe = await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {mkdir, writeFile, readdir, lstat, realpath} from 'node:fs/promises';
      import {join} from 'node:path';
      const root=process.argv[1], output=join(root,'adapter');
      assert.equal(process.env.DATA_DIR,undefined); assert.equal(process.env.INCUS_ENDPOINT,undefined);
      assert.equal(process.env.NODE_PATH,undefined); assert.equal(globalThis.useLogger,undefined);
      assert.equal(globalThis.useRuntimeConfig,undefined); assert.equal(globalThis.defineNitroPlugin,undefined);
      const queue=[output];
      for (let index=0;index<queue.length;index++) for (const name of await readdir(queue[index])) {
        const path=join(queue[index],name), info=await lstat(path);
        assert.equal(info.isSymbolicLink(),false); assert.ok((await realpath(path)).startsWith(output+'/'));
        if(info.isDirectory()) queue.push(path);
      }
      const adapter=await import(process.argv[2]);
      const methods={IncusWorkerRuntime:['preflightCanonicalRestore','createCanonicalRestore','restoreCanonicalArchives','finishCanonicalRestore'],
        IncusWorkerStorage:['freshRestoreDevices'],IncusManagedVolumeRuntime:['freshRestoreVolume']};
      for(const [type,names] of Object.entries(methods)) for(const name of names)
        assert.equal(typeof adapter[type].prototype[name],'function');
      assert.equal(typeof adapter.prepareInstanceNativeVolumeArchive,'function');
      assert.equal(typeof adapter.IncusWorkerImageManager,'function');
      const catalog=new adapter.ImageCatalogCore(join(root,'catalog'));
      await catalog.init();
      await assert.rejects(catalog.authorizeNativeImageSource('fixture-owner',
        {definitionId:'absent-definition',version:'v1'},async()=>{}));
      const data=join(root,'store'); await mkdir(join(data,'users','fixture-owner'),{recursive:true});
      await writeFile(join(data,'users','fixture-owner','workers.json'),'{invalid-json');
      const store=new adapter.WorkerStore(data);
      await assert.rejects(store.loadUser('fixture-owner'), error => error instanceof SyntaxError && !(error instanceof ReferenceError));
      assert.throws(()=>store.listForUser('fixture-owner'),/unavailable|corrupt/);
      // The same encrypted applied store is usable cold, without importing the
      // app singleton or introducing a helper-specific configuration format.
      const config={...adapter.loadConfig(),dataDir:data};
      const bootstrap={version:1,dockerEnabled:false,cpuLimit:2,memoryLimit:'2GiB',
        userEnv:{userId:'fixture-owner',createdAt:'2026-10-05',updatedAt:'2026-10-05',envVars:[]},
        environmentJson:{dockerEnabled:false,networkMode:'full',allowedDomains:[],setupScript:'',envVars:'',exposeApis:{}},
        workerJson:{id:'fixture-worker',displayName:'Restored',repos:[],initScript:'',gitName:'',gitEmail:''},
        capabilitiesJson:[],instructionsJson:[],excludedGlobalEnvVarKeys:[],excludedGroupEnvVarKeys:[]};
      await new adapter.WorkerConfigStore(config).markApplied('fixture-owner','fixture-worker',bootstrap);
      assert.deepEqual(await new adapter.WorkerConfigStore(config).resolveAppliedBootstrap('fixture-owner','fixture-worker'),bootstrap);
      await mkdir(join(data,'users','corrupt-owner'),{recursive:true});
      await writeFile(join(data,'users','corrupt-owner','worker-configurations.json'),'{invalid-json');
      const corrupt=new adapter.WorkerConfigStore(config);
      await assert.rejects(corrupt.get('corrupt-owner','fixture-worker'),/unavailable|corrupt|quarantin/i);
      console.log('isolated-adapter-and-corrupt-owner-proof-passed');
    `, root, pathToFileURL(join(output, 'index.mjs')).href], { env: {}, cwd: root, timeout: 10_000 });
    expect(probe.stdout).toContain('isolated-adapter-and-corrupt-owner-proof-passed');
    expect(probe.stderr).not.toContain('ReferenceError');
    // An existing output belongs to its caller, even after a build failure.
    await writeFile(join(output, 'sentinel'), 'existing-output-retained');
    await expect(run(process.execPath, [buildScript, output], { env: {}, timeout: 45_000 })).rejects.toThrow(/EEXIST/);
    expect(await readFile(join(output, 'sentinel'), 'utf8')).toBe('existing-output-retained');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production build invokes adapter only after Nuxt, copying no builder dependency tree', async () => {
  const packageJson = JSON.parse(await readFile(join(dirname(buildScript), 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(dirname(buildScript), 'package-lock.json'), 'utf8'));
  expect(packageJson.scripts.build).toBe('nuxt build && node build-instance-restore-native.mjs && node build-incus-worker-assets.mjs');
  for (const [dependency, version] of Object.entries({ esbuild: '0.25.12', '@vercel/nft': '1.5.0' })) {
    expect(packageJson.devDependencies[dependency]).toBe(version);
    expect(lock.packages[''].devDependencies[dependency]).toBe(version);
    expect(lock.packages['node_modules/' + dependency].version).toBe(version);
  }
  const dockerfile = await readFile(join(dirname(buildScript), 'Dockerfile'), 'utf8');
  expect(dockerfile).toContain('RUN npm run build');
  expect(dockerfile).toContain('COPY --from=builder /app/orchestrator/.output/ .output/');
  expect(dockerfile).not.toMatch(/COPY[^\n]*\/app\/(?:orchestrator\/)?node_modules/);
  const helper = await readFile(join(dirname(buildScript), 'instance-restore-helper.mjs'), 'utf8');
  // Cold CLI starts during module evaluation, unlike imported helper tests.
  // Its fixed settings must exist before the top-level await invokes it.
  const settings = helper.indexOf('const NATIVE_OPERATOR_FIELDS =');
  const entrypoint = helper.indexOf('process.argv[1] &&');
  expect(settings).toBeGreaterThanOrEqual(0); expect(entrypoint).toBeGreaterThan(settings);
});
