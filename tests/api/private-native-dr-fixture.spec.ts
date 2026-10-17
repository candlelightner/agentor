import { expect, test, request as playwrightRequest, type FullConfig } from '@playwright/test';
import globalSetup from '../global-setup';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePrivateNativeDrFixture, validatePrivateNativeDrFile, readPrivateNativeDrFile, rejectNativeDrSshTransport, NATIVE_DR_LIVE_FLAGS,
  type PrivateNativeDrFixture } from '../helpers/private-native-dr-fixture';

function fixture() {
  const nonce = '11111111-1111-4111-8111-111111111111', root = '/var/lib/agentor-native-dr/' + nonce;
  const context: PrivateNativeDrFixture = { version: 1, kind: 'agentor-private-native-dr-vm', nonce,
    bootId: '22222222-2222-4222-8222-222222222222', machineId: 'a'.repeat(32), root,
    config: { dataDir: root + '/control', containerPrefix: 'agentor-worker', incusEnabled: true,
      incusEndpoint: 'https://127.0.0.1:18443', incusProject: 'agdr11111111', incusNetwork: 'agdr11111111n',
      incusStoragePool: 'agdr11111111p', incusWorkerImage: 'agdr11111111-worker',
      incusInternalGatewayUrl: 'http://10.231.0.1:38000', incusNetworkHostEndpoint: '', incusNetworkHostServerCertPath: '',
      incusConverterStoragePool: '', incusConverterSeedFingerprint: '',
      incusClientCertPath: root + '/tls/client.crt', incusClientKeyPath: root + '/tls/client.key', incusServerCertPath: root + '/tls/server.crt' } };
  const current = { uid: 0, bootId: context.bootId, machineId: context.machineId,
    commandLine: 'console=ttyS0 agentor.native_dr_fixture=' + nonce };
  return { context, current };
}

test('a bounded fresh guest context has only local native endpoints and exact private paths', () => {
  const { context, current } = fixture();
  expect(() => validatePrivateNativeDrFixture(context, current)).not.toThrow();
  expect(context.config.incusNetworkHostEndpoint).toBe('');
});

test('foreign boot, machine, root, uid, missing or duplicate kernel nonce reject before any transport', () => {
  const { context, current } = fixture();
  for (const change of [{ uid: 1000 }, { bootId: 'other' }, { machineId: 'b'.repeat(32) }, { commandLine: '' },
    { commandLine: current.commandLine + ' agentor.native_dr_fixture=' + context.nonce },
    { commandLine: 'agentor.native_dr_fixture=33333333-3333-4333-8333-333333333333' }])
    expect(() => validatePrivateNativeDrFixture(context, { ...current, ...change })).toThrow(/fresh private/);
  for (const change of [{ version: 2 }, { root: '/data' }, { kind: 'production' }, { nonce: [context.nonce] }, { unknownEndpoint: 'https://host' }])
    expect(() => validatePrivateNativeDrFixture({ ...context, ...change } as any, current)).toThrow(/fresh private/);
});

test('historical project, endpoint, certificate, image and host-helper fallbacks cannot enter the fixture', () => {
  const { context, current } = fixture();
  for (const [key, value] of Object.entries(context.config)) {
    const changed = { ...context, config: { ...context.config, [key]: typeof value === 'boolean' ? !value : 'historical-or-production' } };
    expect(() => validatePrivateNativeDrFixture(changed as any, current)).toThrow(/fresh private/);
  }
  expect(() => validatePrivateNativeDrFixture({ ...context, config: { ...context.config, unknownEndpoint: 'https://host' } } as any, current)).toThrow();
});

test('receipt and certificate files require private root ownership, regular type and bounded positive size', () => {
  const valid = { isFile: () => true, uid: 0, mode: 0o100600, size: 1024 };
  expect(() => validatePrivateNativeDrFile(valid, 0, 16384)).not.toThrow();
  for (const change of [{ isFile: () => false }, { uid: 1000 }, { mode: 0o100644 }, { size: 0 }, { size: 16385 }])
    expect(() => validatePrivateNativeDrFile({ ...valid, ...change }, 0, 16384)).toThrow();
  expect(() => validatePrivateNativeDrFile(valid, 1000, 16384)).toThrow();
});

test('the actual receipt reader refuses symlinks, broad permissions and oversized files without any daemon call', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agentor-native-receipt-'));
  try {
    const path = join(directory, 'receipt'); await writeFile(path, 'private', { mode: 0o600 });
    if (process.getuid?.() === 0) expect(await readPrivateNativeDrFile(path, 16)).toBe('private');
    else await expect(readPrivateNativeDrFile(path, 16)).rejects.toThrow();
    await symlink(path, join(directory, 'link'));
    await expect(readPrivateNativeDrFile(join(directory, 'link'), 16)).rejects.toThrow();
    await writeFile(join(directory, 'public'), 'private', { mode: 0o644 });
    await expect(readPrivateNativeDrFile(join(directory, 'public'), 16)).rejects.toThrow();
    await writeFile(path, 'x'.repeat(17));
    await expect(readPrivateNativeDrFile(path, 16)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy remote SSH/SCP remains unsupported even after a valid private context is supplied', () => {
  const { context, current } = fixture(); validatePrivateNativeDrFixture(context, current);
  expect(() => rejectNativeDrSshTransport()).toThrow(/remote SSH\/SCP transport is unsupported/);
});

test('every existing whole-instance native live gate checks context before its first API/build/SSH operation', async () => {
  const capture = await readFile(new URL('./instance-backup-native-live.spec.ts', import.meta.url), 'utf8');
  expect(capture.indexOf('await requirePrivateNativeDrFixture()')).toBeLessThan(capture.indexOf('const config = useConfig()'));
  expect(capture).not.toContain('/workspace/agentor-incus-tls');
  const detached = await readFile(new URL('./instance-backup-detached-live.spec.ts', import.meta.url), 'utf8');
  for (const body of detached.split("test.skip(process.env.INCUS_INSTANCE_").slice(1)) {
    expect(body.indexOf('await requirePrivateNativeDrFixture()')).toBeGreaterThan(0);
    expect(body.indexOf('await requirePrivateNativeDrFixture()')).toBeLessThan(body.indexOf('await mkdtemp('));
  }
  expect(detached).not.toContain('/workspace/agentor-incus-tls');
  const helper = await readFile(new URL('./instance-native-helper-process.spec.ts', import.meta.url), 'utf8');
  expect(helper.indexOf('await rejectHistoricalNativeDrSshTransport()')).toBeLessThan(helper.indexOf("const isolatedPath = process.env.INCUS_HISTORICAL_ISOLATED_JSON"));
  const guard = await readFile(new URL('../helpers/private-native-dr-fixture.ts', import.meta.url), 'utf8');
  expect(guard).toContain('constants.O_NOFOLLOW | constants.O_NONBLOCK');
  expect(guard).toContain('Buffer.alloc(maxBytes + 1)');
});


test('default global setup rejects every native DR opt-in before creating any request context', async () => {
  const originalFactory = playwrightRequest.newContext;
  const originalFlags = Object.fromEntries(NATIVE_DR_LIVE_FLAGS.map(flag => [flag, process.env[flag]]));
  let factoryCalls = 0;
  playwrightRequest.newContext = async () => { factoryCalls++; throw new Error('BLOCKED_FIXTURE_REQUEST_FACTORY'); };
  try {
    for (const flag of NATIVE_DR_LIVE_FLAGS) delete process.env[flag];
    for (const flag of NATIVE_DR_LIVE_FLAGS) {
      process.env[flag] = 'true';
      await expect(globalSetup({} as FullConfig)).rejects.toMatchObject({ code: 'NATIVE_DR_REQUIRES_MODULES_CONFIG',
        message: expect.stringContaining('--config=playwright.modules.config.ts') });
      expect(factoryCalls).toBe(0);
      delete process.env[flag];
    }
  } finally {
    playwrightRequest.newContext = originalFactory;
    for (const flag of NATIVE_DR_LIVE_FLAGS) {
      if (originalFlags[flag] === undefined) delete process.env[flag]; else process.env[flag] = originalFlags[flag];
    }
  }
});

test('ordinary global setup still reaches its request factory when native gates are not enabled', async () => {
  const originalFactory = playwrightRequest.newContext;
  const originalFlags = Object.fromEntries(NATIVE_DR_LIVE_FLAGS.map(flag => [flag, process.env[flag]]));
  let factoryCalls = 0;
  playwrightRequest.newContext = async () => { factoryCalls++; throw new Error('BLOCKED_FIXTURE_REQUEST_FACTORY'); };
  try {
    for (const value of [undefined, 'false']) {
      for (const flag of NATIVE_DR_LIVE_FLAGS) {
        if (value === undefined) delete process.env[flag]; else process.env[flag] = value;
      }
      await expect(globalSetup({} as FullConfig)).rejects.toThrow('BLOCKED_FIXTURE_REQUEST_FACTORY');
    }
    expect(factoryCalls).toBe(2); // The stub throws before any network request.
  } finally {
    playwrightRequest.newContext = originalFactory;
    for (const flag of NATIVE_DR_LIVE_FLAGS) {
      if (originalFlags[flag] === undefined) delete process.env[flag]; else process.env[flag] = originalFlags[flag];
    }
  }
});
