import { isIP } from "node:net";
import type { IncusInstance, IncusNetwork, IncusNetworkLease } from "./incus-client";

const macPattern = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
}

/** Host-controlled inputs only. Guest state.network and lease hostnames are
 * deliberately irrelevant, even when supplied by an otherwise owned VM. */
export function resolveIncusPrimaryLease(instance: IncusInstance, peers: IncusInstance[],
  network: IncusNetwork, leases: IncusNetworkLease[], networkName: string): { address: string; incarnation: string } {
  const fail: () => never = () => { throw new Error("Incus worker primary network identity is missing, unsafe or ambiguous"); };
  const config = instance.expanded_config ?? instance.config;
  const devices = instance.expanded_devices ?? instance.devices;
  const nics = Object.entries(devices).filter(([, device]) => device.type === "nic");
  const nic = devices.eth0;
  const incarnation = config["volatile.uuid"];
  if (!nic || !incarnation) fail();
  if (instance.status !== "Running" || !uuidPattern.test(incarnation) || nics.length !== 1 ||
      nics[0]![0] !== "eth0" || nic.name !== "eth0" || nic.network !== networkName ||
      nic["security.mac_filtering"] !== "true" || nic["security.ipv4_filtering"] !== "true" ||
      Object.keys(nic).some((key) => /^(ipv4|ipv6)\.routes/.test(key)) ||
      Object.keys(config).some((key) => key.startsWith("raw."))) fail();
  if (network.name !== networkName || !network.managed || network.type !== "bridge" || network.config["ipv4.dhcp"] === "false") fail();
  // Restricted projects can use a host-shared bridge and read its leases,
  // while Incus intentionally redacts that bridge's config. Unknown IPv6
  // configuration must therefore keep filtering, not assume IPv6 is disabled.
  if (network.config["ipv6.address"] !== "none" && nic["security.ipv6_filtering"] !== "true") fail();
  const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(network.config["ipv4.address"] ?? "");
  if (network.config["ipv4.address"] && (!cidr || isIP(cidr[1]!) !== 4 || Number(cidr[2]) < 1 || Number(cidr[2]) > 30)) fail();
  const mac = (nic.hwaddr || config["volatile.eth0.hwaddr"] || "").toLowerCase();
  if (!macPattern.test(mac) || (parseInt(mac.slice(0, 2), 16) & 1) !== 0 ||
      (nic.hwaddr && config["volatile.eth0.hwaddr"] && nic.hwaddr.toLowerCase() !== config["volatile.eth0.hwaddr"]!.toLowerCase())) fail();
  for (const peer of peers) {
    if (peer.name === instance.name) continue;
    const pc = peer.expanded_config ?? peer.config;
    for (const [key, device] of Object.entries(peer.expanded_devices ?? peer.devices)) {
      if (device.type !== "nic" || device.network !== networkName) continue;
      if ((device.hwaddr || pc[`volatile.${key}.hwaddr`] || "").toLowerCase() === mac) fail();
    }
  }
  const ipv4 = leases.filter((lease) => isIP(lease.address) === 4);
  const matching = ipv4.filter((lease) => lease.hwaddr.toLowerCase() === mac && ["dynamic", "static"].includes(lease.type));
  const addresses = new Set(matching.map((lease) => lease.address));
  if (addresses.size !== 1) fail();
  const address = [...addresses][0]!;
  const number = ipv4Number(address);
  const first = Number(address.split(".")[0]);
  if (first === 0 || first === 127 || first >= 224 || address.startsWith("169.254.")) fail();
  // When exposed, also check subnet/gateway. With native config redaction the
  // daemon's filtered DHCP lease/MAC pair remains the authoritative assignment.
  if (cidr) {
    const mask = (0xffffffff << (32 - Number(cidr[2]))) >>> 0;
    const subnet = (ipv4Number(cidr[1]!) & mask) >>> 0;
    if (((number & mask) >>> 0) !== subnet || number === subnet || number === ((subnet | ~mask) >>> 0) || address === cidr[1]) fail();
  }
  if ((nic["ipv4.address"] && nic["ipv4.address"] !== address) ||
      ipv4.some((lease) => lease.address === address && lease.hwaddr.toLowerCase() !== mac)) fail();
  if (peers.some((peer) => peer.name !== instance.name && Object.values(peer.expanded_devices ?? peer.devices)
    .some((device) => device.type === "nic" && device.network === networkName && device["ipv4.address"] === address))) fail();
  return { address, incarnation };
}
