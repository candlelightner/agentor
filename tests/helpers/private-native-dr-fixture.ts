import { constants } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import type { Config } from '../../orchestrator/server/utils/config';

export const PRIVATE_NATIVE_DR_RECEIPT = '/run/agentor-native-dr/fixture.json';
export const NATIVE_DR_LIVE_FLAGS = ['INCUS_INSTANCE_BACKUP_TEST', 'INCUS_INSTANCE_PREFLIGHT_TEST',
  'INCUS_INSTANCE_DETACHED_RESTORE_TEST', 'INCUS_INSTANCE_HELPER_PROCESS_TEST'] as const;

/** Default setup authenticates against BASE_URL before test bodies execute.
 * Native gates must use the module config, which has no HTTP global setup. */
export function assertNativeDrUsesModulesConfig(environment: NodeJS.ProcessEnv = process.env): void {
  if (NATIVE_DR_LIVE_FLAGS.some(flag => environment[flag] === 'true'))
    throw Object.assign(new Error('Native DR live flags cannot use the default Playwright setup; use --config=playwright.modules.config.ts with a fresh private fixture.'),
      { code: 'NATIVE_DR_REQUIRES_MODULES_CONFIG' });
}

export interface PrivateNativeDrFixture {
  version: 1;
  kind: 'agentor-private-native-dr-vm';
  nonce: string;
  bootId: string;
  machineId: string;
  root: string;
  config: Pick<Config, 'dataDir' | 'containerPrefix' | 'incusEnabled' | 'incusEndpoint' | 'incusProject' |
    'incusNetwork' | 'incusStoragePool' | 'incusWorkerImage' | 'incusInternalGatewayUrl' |
    'incusClientCertPath' | 'incusClientKeyPath' | 'incusServerCertPath' | 'incusNetworkHostEndpoint' |
    'incusNetworkHostServerCertPath' | 'incusConverterStoragePool' | 'incusConverterSeedFingerprint'>;
}
const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const blocked = () => new Error('Native DR live gate requires a fresh private system-VM fixture receipt tied to this guest boot; historical endpoints, credentials and host fallbacks are not authorized');

/** A receipt describes a future independently bootstrapped test guest. It is
 * not permission to create a VM/daemon or reuse a production installation. */
export function validatePrivateNativeDrFixture(value: PrivateNativeDrFixture,
  current: { uid: number; bootId: string; machineId: string; commandLine: string }): void {
  if (!value || Object.keys(value).sort().join(',') !== 'bootId,config,kind,machineId,nonce,root,version' || value.version !== 1 || value.kind !== 'agentor-private-native-dr-vm' || current.uid !== 0 ||
      typeof value.nonce !== 'string' || typeof value.bootId !== 'string' || typeof value.machineId !== 'string' ||
      !uuid.test(value.nonce) || !uuid.test(value.bootId) || !/^[a-f0-9]{32}$/.test(value.machineId) ||
      value.bootId !== current.bootId || value.machineId !== current.machineId ||
      current.commandLine.trim().split(/\s+/).filter(token => token.startsWith('agentor.native_dr_fixture='))
        .join(' ') !== 'agentor.native_dr_fixture=' + value.nonce ||
      value.root !== '/var/lib/agentor-native-dr/' + value.nonce)
    throw blocked();
  const base = 'agdr' + value.nonce.slice(0, 8), root = value.root;
  const expected: PrivateNativeDrFixture['config'] = {
    dataDir: root + '/control', containerPrefix: 'agentor-worker', incusEnabled: true,
    incusEndpoint: 'https://127.0.0.1:18443', incusProject: base, incusNetwork: base + 'n',
    incusStoragePool: base + 'p', incusWorkerImage: base + '-worker',
    incusInternalGatewayUrl: 'http://10.231.0.1:38000',
    incusNetworkHostEndpoint: '', incusNetworkHostServerCertPath: '',
    incusConverterStoragePool: '', incusConverterSeedFingerprint: '',
    incusClientCertPath: root + '/tls/client.crt', incusClientKeyPath: root + '/tls/client.key',
    incusServerCertPath: root + '/tls/server.crt',
  };
  if (!value.config || Object.keys(value.config).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, entry]) => value.config[key as keyof typeof expected] !== entry))
    throw blocked();
}

/** Pure ownership/type bounds are shared by the actual nofollow reader and
 * tests. Never accept a symlink, broad mode, foreign owner or unbounded JSON. */
export function validatePrivateNativeDrFile(info: { isFile(): boolean; uid: number; mode: number; size: number },
  uid: number, maxBytes: number): void {
  if (uid !== 0 || !info.isFile() || info.uid !== uid || (info.mode & 0o077) || info.size < 1 || info.size > maxBytes)
    throw blocked();
}
export async function readPrivateNativeDrFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    validatePrivateNativeDrFile(info, process.getuid!(), maxBytes);
    if (await realpath(path) !== path) throw blocked();
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== info.size || bytesRead > maxBytes) throw blocked();
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
async function privateDirectory(path: string) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077) || await realpath(path) !== path)
    throw blocked();
}

export async function requirePrivateNativeDrFixture(): Promise<PrivateNativeDrFixture> {
  try {
    await privateDirectory('/run/agentor-native-dr');
    const fixture = JSON.parse(await readPrivateNativeDrFile(PRIVATE_NATIVE_DR_RECEIPT, 16_384));
    validatePrivateNativeDrFixture(fixture, { uid: process.getuid!(),
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      machineId: (await readFile('/etc/machine-id', 'utf8')).trim(),
      commandLine: await readFile('/proc/cmdline', 'utf8') });
    await privateDirectory(fixture.root); await privateDirectory(fixture.root + '/control'); await privateDirectory(fixture.root + '/tls');
    for (const path of [fixture.config.incusClientCertPath, fixture.config.incusClientKeyPath, fixture.config.incusServerCertPath])
      await readPrivateNativeDrFile(path, 65_536);
    return fixture;
  } catch { throw blocked(); }
}

export function rejectNativeDrSshTransport(): never {
  throw new Error('Historical native DR remote SSH/SCP transport is unsupported in the fresh private fixture; no host command or native API has been issued. Refactor transport before enabling this gate.');
}

export async function rejectHistoricalNativeDrSshTransport(): Promise<never> {
  await requirePrivateNativeDrFixture();
  return rejectNativeDrSshTransport();
}
