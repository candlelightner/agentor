import { createHash } from 'node:crypto';
import type { IncusDevice } from './incus-client';
import type { ManagedNetwork } from './managed-network-store';
import { ManagedNetworkStore } from './managed-network-store';
import { WorkerGroupStore } from './worker-group-store';
import { WorkerGroupHierarchy } from './worker-group-hierarchy';
import { readBackupInstallationId } from './backup-installation';

/** Same derivation as the narrow operator-installed bridge service. Neither
 * the worker nor an API payload can choose the host bridge or NIC identity. */
export function incusManagedBridgeIdentity(installation: string, network: ManagedNetwork) {
  if (typeof network.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(network.userId) ||
      typeof network.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(network.id) ||
      network.dockerName !== `agentor-managed-${network.id}`)
    throw new Error('Invalid managed network authority');
  const key = createHash('sha256').update(`${installation}:${network.userId}:${network.id}`).digest('hex').slice(0, 12);
  return { installation, name: `am${key}`, key: `net${key}` };
}

export function incusManagedNetworkDevice(installation: string, workerId: string, network: ManagedNetwork): IncusDevice {
  const identity = incusManagedBridgeIdentity(installation, network);
  const mac = createHash('sha256').update(`${installation}:${network.userId}:${workerId}:${network.id}`).digest('hex').slice(0, 10);
  return { type: 'nic', network: identity.name, name: `agn${identity.key.slice(3, 11)}`,
    hwaddr: `02:${mac.match(/../g)!.join(':')}`, 'security.mac_filtering': 'true',
    'security.ipv4_filtering': 'true', 'security.ipv6_filtering': 'true' };
}

/** Nonsensitive networkd configuration, readable by systemd-network. Secondary
 * networks never supply default routes, resolver settings or IPv6 RA policy. */
export function incusManagedNetworkRule(device: IncusDevice): string {
  if (!/^02:(?:[0-9a-f]{2}:){4}[0-9a-f]{2}$/.test(device.hwaddr ?? ''))
    throw new Error('Invalid managed network MAC authority');
  return `[Match]\nMACAddress=${device.hwaddr}\n[Network]\nDHCP=ipv4\nIPv6AcceptRA=no\n[DHCPv4]\nClientIdentifier=mac\nUseRoutes=no\nUseDNS=no\nUseDomains=no\n`;
}

/** Load the durable owner partition rather than trusting instance metadata to
 * authorize its own extra NICs. Missing/revoked records never bless a device;
 * corrupt owner/group authority rejects the whole read. No writes or adoption. */
export async function incusManagedNetworkAuthority(dataDir: string, owner: { id: string; userId: string }) {
  const installation = await readBackupInstallationId(dataDir);
  const networks = new ManagedNetworkStore(dataDir);
  await networks.loadUser(owner.userId);
  const records = networks.listForUser(owner.userId);
  const groups = new WorkerGroupStore(dataDir);
  if (records.some(network => network.scope === 'group')) {
    await groups.loadUser(owner.userId);
    for (const group of groups.listForUser(owner.userId)) {
      if (group.userId !== owner.userId || typeof group.id !== 'string' || !group.id ||
          !Array.isArray(group.workerIds) || group.workerIds.some(id => typeof id !== 'string') ||
          (group.parentId !== undefined && (typeof group.parentId !== 'string' || !group.parentId)))
        throw new Error('Invalid managed network group authority');
    }
    if (new WorkerGroupHierarchy(groups).hierarchyErrors(owner.userId).length)
      throw new Error('Invalid managed network group hierarchy');
  }
  const allowed: Record<string, IncusDevice> = {};
  for (const network of records) {
    if (network.userId !== owner.userId) throw new Error('Invalid managed network owner authority');
    const identity = incusManagedBridgeIdentity(installation, network);
    if (!Array.isArray(network.workerIds) || network.workerIds.some(id => typeof id !== 'string') ||
        !['all', 'selected', 'group'].includes(network.scope)) throw new Error('Invalid managed network membership authority');
    const member = network.scope === 'all' || (network.scope === 'selected' && network.workerIds.includes(owner.id)) ||
      (network.scope === 'group' && !!network.groupId && !!groups.get(owner.userId, network.groupId) &&
        new WorkerGroupHierarchy(groups).subtreeWorkerIds(owner.userId, network.groupId).includes(owner.id));
    if (member) {
      if (allowed[identity.key]) throw new Error('Ambiguous managed network device identity');
      allowed[identity.key] = incusManagedNetworkDevice(installation, owner.id, network);
    }
  }
  return allowed;
}
