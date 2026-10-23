import { createHash } from 'node:crypto';
import type { IncusInstance, IncusDevice } from './incus-client';
import { isDeepStrictEqual } from 'node:util';

/** Legacy shares omit io.cache. Permit only the SQLite-capable replacement,
 * keeping every source, path, access mode and other device field exact. */
export function sameIncusDevice(actual: Record<string, string> | undefined, expected: Record<string, string>): boolean {
  if (!actual) return false;
  if (expected.type === 'disk' && expected.path && expected.path !== '/' && expected['io.cache'] === 'unsafe') {
    if (actual['io.cache'] !== undefined && actual['io.cache'] !== 'unsafe') return false;
    const actualFields = { ...actual }, expectedFields = { ...expected };
    delete actualFields['io.cache']; delete expectedFields['io.cache'];
    return isDeepStrictEqual(actualFields, expectedFields);
  }
  return isDeepStrictEqual(actual, expected);
}

export function sameIncusDevices(actual: Record<string, Record<string, string>>, expected: Record<string, Record<string, string>>): boolean {
  return Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, device]) => sameIncusDevice(actual[key], device));
}

/** A restart may revoke existing exports without recreating the guest root. */
export function assertIncusHostMountRemoval(instance: IncusInstance,
  devices: Record<string, IncusDevice>, metadata: string): void {
  const reject = () => { throw new Error('Host mount removal requires the same stopped VM and unchanged retained devices; no update submitted'); };
  if (instance.type !== 'virtual-machine' || instance.status !== 'Stopped' || instance.profiles.length ||
      !instance.config['volatile.uuid'] || instance.config['user.agentor.administrative'] ||
      !isDeepStrictEqual(instance.devices, instance.expanded_devices ?? instance.devices)) reject();
  let identities: Array<{ key: string; pathId: string; sourceIdentity: string }>;
  try { identities = JSON.parse(instance.config['user.agentor.host-mounts'] ?? '[]'); }
  catch { return reject(); }
  if (!Array.isArray(identities) || !identities.length || identities.length > 4096) return reject();
  const oldKeys = Object.keys(instance.devices).filter(key => key.startsWith('hm'));
  if (oldKeys.length !== identities.length || new Set(identities.map(row => row?.key)).size !== identities.length ||
      identities.some(row => !row || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(row.pathId) ||
        !/^[0-9a-f]{64}$/.test(row.sourceIdentity) || !oldKeys.includes(row.key) ||
        instance.devices[row.key]?.type !== 'disk' || row.key !== 'hm' + createHash('sha256')
          .update(`${row.pathId}:${instance.devices[row.key]!.path}`).digest('hex').slice(0, 6))) reject();
  const removed = oldKeys.filter(key => !devices[key]);
  if (!removed.length || Object.entries(devices).some(([key, device]) => !isDeepStrictEqual(device, instance.devices[key])) ||
      Object.keys(instance.devices).some(key => !devices[key] && !removed.includes(key)) ||
      metadata !== JSON.stringify(identities.filter(row => !removed.includes(row.key)))) reject();
}
