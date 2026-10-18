import { createHash } from 'node:crypto';
import type { Config } from './config';
import type { IncusDevice, IncusInstance } from './incus-client';
import type { IncusWorkerOptions } from './incus-worker-runtime';
import { IncusHostMountClient } from './incus-host-mount-client';
import { HostMountStore } from './host-mount-store';
import { WorkerGroupStore } from './worker-group-store';
import { WorkerGroupHierarchy } from './worker-group-hierarchy';
import { WorkerStore } from './worker-store';
import { pathsOverlap, validatePersistenceTarget } from './managed-volume-store';
import { readBackupInstallationId } from './backup-installation';

const METADATA = 'user.agentor.host-mounts';
export interface IncusHostMountLayout {
  devices: Record<string, IncusDevice>;
  identities: Array<{ key: string; pathId: string; sourceIdentity: string }>;
}

/** Re-read existing platform grant semantics, never authorize from VM labels
 * or a caller's raw source. The host service authorizes sources, not workers. */
export async function incusHostMountLayout(config: Config, opts: Pick<IncusWorkerOptions,
  'id' | 'userId' | 'containerName' | 'mounts' | 'storageManager' | 'managedVolumes' | 'recreationNonce' | 'hostMountGroupId'>,
  operation: 'ensure' | 'inspect' | 'reconstruct-preflight', host?: Pick<IncusHostMountClient, 'ensure' | 'inspect'>,
  instance?: IncusInstance,
): Promise<IncusHostMountLayout> {
  if (!opts.mounts?.length) return { devices: {}, identities: [] };
  if (!opts.storageManager?.dataHostPath)
    throw new Error('Incus host mounts require authoritative platform storage');
  const groups = new WorkerGroupStore(config.dataDir), workers = new WorkerStore(config.dataDir);
  await Promise.all([groups.loadUser(opts.userId), workers.loadUser(opts.userId)]);
  if (new WorkerGroupHierarchy(groups).hierarchyErrors(opts.userId).length)
    throw new Error('Host mount group authority is ambiguous');
  const record = workers.get(opts.userId, opts.id);
  const reconstruction = !!opts.recreationNonce && record?.incusRecreation?.nonce === opts.recreationNonce;
  const migration = record?.incusMigration;
  // A fresh, captured destination may receive existing grants during staged
  // validation without publishing native runtime authority early. Neither a
  // legacy worker nor a caller nonce alone grants this exception.
  const stagedMigration = record?.runtimeKind === 'legacy-docker' && record.status === 'active' &&
    !record.hostMountsRevoked && !record.incusRecreation && migration?.phase === 'validating' &&
    !!opts.recreationNonce && migration.nonce === opts.recreationNonce && !!migration.destinationIncarnation &&
    operation !== 'reconstruct-preflight' && instance?.type === 'virtual-machine' &&
    instance.name === opts.containerName && instance.name === `${config.containerPrefix}-${opts.id}` &&
    instance.config['volatile.uuid'] === migration.destinationIncarnation &&
    instance.config['user.agentor.recreation'] === migration.nonce &&
    instance.config['user.agentor.id'] === opts.id && instance.config['user.agentor.owner'] === opts.userId &&
    instance.config['user.agentor.installation'] === await readBackupInstallationId(config.dataDir);
  if (!record || (record.runtimeKind !== 'incus-vm' && !stagedMigration) || record.deletionPending ||
      (record.hostMountsRevoked && operation !== 'reconstruct-preflight' && !reconstruction) ||
      (operation === 'inspect' && record.status !== 'active'))
    throw new Error('Host mounts require an authorized Incus WorkerRecord; start requires active compute');
  if (record.hostMountsRevoked && operation === 'inspect' && reconstruction &&
      (!instance || !record.incusRecreation?.replacementIncarnation ||
       record.incusRecreation.replacementIncarnation !== instance.config['volatile.uuid'] ||
       instance.config['user.agentor.recreation'] !== opts.recreationNonce))
    throw new Error('Revoked host access requires the captured replacement incarnation and native reconstruction nonce');
  const memberships = groups.listForUser(opts.userId).filter(group => group.workerIds.includes(opts.id));
  if (memberships.length > 1) throw new Error('Host mount direct group authority is ambiguous');
  let groupId = memberships[0]?.id;
  // Initial creates have a durable provisional worker but membership is
  // committed only after validation. This internal hint is not runtime state.
  if (opts.hostMountGroupId && opts.hostMountGroupId !== groupId) {
    if (groupId || !record.incusRecreation?.initialCreate || !groups.get(opts.userId, opts.hostMountGroupId))
      throw new Error('Host mount creation group authority changed');
    groupId = opts.hostMountGroupId;
  }
  const store = new HostMountStore(config.dataDir, () => opts.storageManager!.dataHostPath, groups, workers);
  await store.loadAuthority(opts.userId);
  const mounts = store.resolveMounts(opts.userId, opts.id, opts.mounts, groupId)!;
  const devices: Record<string, IncusDevice> = {}, identities: IncusHostMountLayout['identities'] = [];
  // Validate every target before any host policy change. Nested /workspace
  // shares retain existing semantics; exact workspace replacement is forbidden.
  for (const mount of mounts) {
    validatePersistenceTarget(mount.target);
    if (mount.target === '/workspace' || pathsOverlap(mount.target, '/tmp/worker-events') ||
        (opts.managedVolumes ?? []).some(volume => pathsOverlap(mount.target, volume.target)) ||
        mounts.some(other => other !== mount && pathsOverlap(other.target, mount.target)))
      throw new Error('Incus host mount targets overlap canonical storage or another mount');
  }
  host ??= new IncusHostMountClient(config);
  for (const mount of mounts) {
    const resolved = await host[operation === 'inspect' ? 'inspect' : 'ensure'](mount);
    // Incus places this key in a QEMU Unix socket pathname (107-byte limit).
    // Keep stable worker UUID names; short keyed exports still fail on collision.
    const key = 'hm' + createHash('sha256').update(`${mount.pathId}:${mount.target}`).digest('hex').slice(0, 6);
    if (devices[key]) throw new Error('Incus host mount device identity collision');
    devices[key] = { type: 'disk', source: mount.source, path: mount.target,
      readonly: String(mount.readOnly !== false) };
    identities.push({ key, pathId: mount.pathId!, sourceIdentity: resolved.sourceIdentity });
  }
  identities.sort((left, right) => left.key.localeCompare(right.key));
  return { devices, identities };
}

export function incusHostMountMetadata(layout: IncusHostMountLayout): Record<string, string> {
  return layout.identities.length ? { [METADATA]: JSON.stringify(layout.identities) } : {};
}

/** Pin native source/mode/target and immediate host inode to the captured VM.
 * These labels are compute fences, never portable WorkerRecord authority. */
export function assertIncusHostMountLayout(instance: IncusInstance, expected: IncusHostMountLayout): void {
  const marker = instance.config[METADATA];
  if ((marker ?? '[]') !== JSON.stringify(expected.identities))
    throw new Error('Incus host export source identity changed; stop and explicitly rebuild the worker');
  const actual = instance.expanded_devices ?? instance.devices;
  const keys = Object.keys(actual).filter(key => key.startsWith('hm'));
  if (keys.length !== Object.keys(expected.devices).length || keys.some(key => !expected.devices[key]))
    throw new Error('Incus host export layout is foreign or revoked; explicit recreation required');
  for (const [key, device] of Object.entries(expected.devices)) {
    if (!actual[key] || Object.keys(actual[key]).length !== Object.keys(device).length ||
        Object.entries(device).some(([field, value]) => actual[key]![field] !== value))
      throw new Error('Incus host export source, target or read-only policy changed');
  }
}
