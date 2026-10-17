import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HardwareDeviceCandidate, ResolvedHardwareDevice } from '../../shared/types';
import type { IncusDevice, IncusInstance } from './incus-client';
import type { Config } from './config';
import type { IncusWorkerOptions } from './incus-worker-runtime';
import { HardwareDeviceStore } from './hardware-device-store';
import { WorkerStore } from './worker-store';
import { WorkerGroupStore } from './worker-group-store';
import { WorkerGroupHierarchy } from './worker-group-hierarchy';

export type IncusHardwareOptions = Pick<IncusWorkerOptions, 'id' | 'userId' | 'containerName' | 'hardwareDevices' | 'hostMountGroupId' | 'recreationNonce'>;

function fail(message: string): never { throw Object.assign(new Error(message), { statusCode: 409, statusMessage: message }); }

/** The public API accepts opaque catalog IDs only. Even internal resolved paths
 * are insufficient authority to assign a host device to a VM. */
export function incusHardwareDevices(resolved: ResolvedHardwareDevice[]): Record<string, IncusDevice> {
  const devices: Record<string, IncusDevice> = {};
  for (const value of resolved) {
    const candidate = value.candidate;
    if (!candidate?.incus?.supported || candidate.incus.mode !== 'usb-exclusive' || candidate.kind !== 'usb')
      fail(candidate?.incus?.reason || 'Incus hardware capability is unavailable; device assignment is blocked');
    if (!/^[0-9a-f]{4}$/.test(candidate.vendor ?? '') || !/^[0-9a-f]{4}$/.test(candidate.product ?? '') ||
        !candidate.serial || !/^[\x20-\x7e]{1,128}$/.test(candidate.serial) || candidate.serial.startsWith('port:') ||
        candidate.selector !== `usb:${candidate.vendor}:${candidate.product}:${candidate.serial}` ||
        candidate.deviceNodes.length !== 1 || !/^\/dev\/bus\/usb\/\d{3}\/\d{3}$/.test(candidate.deviceNodes[0]!))
      fail('USB passthrough requires an exact, stable serial-numbered device');
    const key = 'hw' + createHash('sha256').update(value.deviceId).digest('hex').slice(0, 12);
    if (devices[key]) fail('Duplicate hardware device identity');
    devices[key] = { type: 'usb', vendorid: candidate.vendor!, productid: candidate.product!, serial: candidate.serial, required: 'true' };
  }
  return devices;
}

export async function resolveIncusHardware(config: Config, opts: IncusHardwareOptions,
  discover: () => Promise<HardwareDeviceCandidate[]>, operation: 'preflight' | 'attach', instance?: IncusInstance,
): Promise<Record<string, IncusDevice>> {
  const requested = (opts.hardwareDevices ?? []).map(device => device.deviceId).sort();
  if (!requested.length) return {};
  if (!config.incusUsbEnabled) fail('Incus USB passthrough is disabled; operator host setup and INCUS_USB_ENABLED=true are required. GPU assignment remains unsupported');
  // Probe first: slow host discovery must not precede a stale authorization snapshot.
  const inventory = await discover();
  const workers = new WorkerStore(config.dataDir), groups = new WorkerGroupStore(config.dataDir);
  await Promise.all([workers.init(), groups.init()]);
  const record = workers.get(opts.userId, opts.id);
  const reconstruction = !!opts.recreationNonce && record?.incusRecreation?.nonce === opts.recreationNonce;
  const migration = record?.incusMigration;
  const migrating = record?.runtimeKind === 'legacy-docker' && !record.hardwareDevicesRevoked &&
    (operation === 'preflight' && !migration || !!opts.recreationNonce && migration?.nonce === opts.recreationNonce &&
      migration.phase === 'validating' && instance?.config['volatile.uuid'] === migration.destinationIncarnation &&
      instance?.config['user.agentor.recreation'] === migration.nonce);
  if (!record || (record.runtimeKind !== 'incus-vm' && !migrating) || record.deletionPending ||
      record.hardwareDevicesRevoked && operation !== 'preflight' && !reconstruction ||
      !isDeepStrictEqual([...(record.hardwareDeviceIds ?? [])].sort(), requested) ||
      operation === 'attach' && record.status !== 'active')
    fail('Incus hardware requires matching durable worker identity and current device intent');
  if (record.hardwareDevicesRevoked && operation === 'attach' && instance &&
      record.incusRecreation?.replacementIncarnation !== instance.config['volatile.uuid'])
    fail('Revoked hardware requires the captured replacement incarnation');
  if (new WorkerGroupHierarchy(groups).hierarchyErrors(opts.userId).length)
    fail('Hardware group authority is ambiguous');
  const memberships = groups.listForUser(opts.userId).filter(group => group.workerIds.includes(opts.id));
  if (memberships.length > 1) fail('Hardware direct group authority is ambiguous');
  let groupId = memberships[0]?.id;
  if (opts.hostMountGroupId && groupId !== opts.hostMountGroupId) {
    if (groupId || !record.incusRecreation?.initialCreate || !groups.get(opts.userId, opts.hostMountGroupId))
      fail('Hardware initial group authority changed');
    groupId = opts.hostMountGroupId;
  }
  const store = new HardwareDeviceStore(config.dataDir, async () => inventory, groups, workers); await store.init();
  const resolved = await store.resolveAuthorizedDevices(opts.userId, opts.id, requested, groupId);
  // Active stopped workers retain their reservation. Archive releases it, and
  // unarchive rechecks before allocating compute. This also covers legacy Docker.
  for (const peer of workers.list()) {
    if (peer.id === opts.id && peer.userId === opts.userId || peer.status === 'archived') continue;
    if ((peer.hardwareDeviceIds ?? []).some(id => requested.includes(id)))
      fail('Hardware device is exclusively reserved by another active worker; archive or remove its device selection first');
  }
  return incusHardwareDevices(resolved ?? []);
}

/** Local + expanded maps both matter: profiles may otherwise add broad devices.
 * Keep stop/remove available after revocation; this guard gates activation only. */
export function assertIncusHardwareLayout(instance: IncusInstance, expected: Record<string, IncusDevice>): void {
  for (const map of [instance.devices, instance.expanded_devices ?? instance.devices]) {
    const actual = Object.fromEntries(Object.entries(map).filter(([key, device]) => key.startsWith('hw') ||
      ['usb', 'gpu', 'pci', 'unix-char', 'unix-block', 'unix-hotplug'].includes(device.type ?? '')));
    if (!isDeepStrictEqual(actual, expected)) fail('Incus hardware layout differs from current grants; rebuild is required');
  }
  if (instance.profiles.length || Object.keys(instance.expanded_config ?? instance.config).some(key => key.startsWith('raw.')))
    fail('Incus hardware assignment requires an exact profile-free worker configuration');
}

/** An instance outside the registry can still hold an assignment. A broad USB
 * selector conflicts conservatively; never stop or edit the conflicting peer. */
export function assertIncusHardwareExclusive(name: string, expected: Record<string, IncusDevice>, peers: IncusInstance[]): void {
  for (const peer of peers) {
    if (peer.name === name) continue;
    for (const device of Object.values(peer.expanded_devices ?? peer.devices)) {
      if (device.type !== 'usb') continue;
      if (Object.values(expected).some(usb => ['vendorid', 'productid', 'serial'].every(key => !device[key] || device[key] === usb[key])))
        fail('USB device is assigned to another Incus instance; release that assignment first');
    }
  }
}
