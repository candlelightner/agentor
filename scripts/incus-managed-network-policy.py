#!/usr/bin/env python3
"""Narrow host-side managed bridge policy; no caller-selected Incus paths.

Only bridge lifecycle and exact project network allowlisting require host
authority. Worker lifecycle remains on restricted Incus mTLS. HTTP deployment
is installed by the operator workflow, not by an Orchestrator startup hook.
"""
import hashlib
import ipaddress
import json
import os
import re
import stat
from urllib.parse import quote


class PolicyError(Exception):
    pass


def read_bounded(root, parts, limit=1024 * 1024):
    """Pin each directory, refuse symlink components, bound regular-file reads."""
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = os.open(root, flags | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_descriptor = os.open(part, flags | os.O_DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        file_descriptor = os.open(parts[-1], flags | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            info = os.fstat(file_descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                raise PolicyError("Platform authority file is not a bounded regular file")
            with os.fdopen(file_descriptor, "rb", closefd=False) as stream:
                result = stream.read(limit + 1)
            if len(result) > limit:
                raise PolicyError("Platform authority file exceeded its bound")
            return result.decode("utf-8")
        finally:
            os.close(file_descriptor)
    finally:
        os.close(descriptor)


class ManagedNetworkPolicy:
    """Serialized service caller supplies request(method,path,body,etag).

    The request function returns (Incus metadata, ETag), raising for daemon
    rejection. Root-owned startup arguments pin installation/project/primary.
    This class never executes commands or accepts raw config/paths/subnets.
    """
    def __init__(self, data_dir, installation, project, primary, request,
                 bridge_ports=lambda name: os.listdir(f"/sys/class/net/{name}/brif")):
        self.data_dir = data_dir
        self.installation = installation
        self.project = project
        self.primary = primary
        self.request = request
        self.bridge_ports = bridge_ports
        if not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", installation):
            raise PolicyError("Invalid pinned installation")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,63}", project) or project == "default":
            raise PolicyError("Dedicated project required")
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,15}", primary):
            raise PolicyError("Explicit primary bridge required")

    def identity(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"userId", "networkId"}:
            raise PolicyError("Only owner and managed network identity are accepted")
        owner, network_id = payload["userId"], payload["networkId"]
        if not isinstance(owner, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", owner):
            raise PolicyError("Invalid owner identity")
        if not isinstance(network_id, str) or not re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", network_id):
            raise PolicyError("Invalid network identity")
        if read_bounded(self.data_dir, ["backup-installation-id"], 128).strip() != self.installation:
            raise PolicyError("Installation identity changed")
        key = hashlib.sha256(f"{self.installation}:{owner}:{network_id}".encode()).hexdigest()[:12]
        return owner, network_id, f"am{key}"

    def desired(self, owner, network_id):
        records = json.loads(read_bounded(self.data_dir, ["users", owner, "managed-networks.json"]))
        if not isinstance(records, list):
            raise PolicyError("Managed network authority is corrupt")
        matches = [record for record in records if isinstance(record, dict) and record.get("id") == network_id]
        if len(matches) != 1 or matches[0].get("userId") != owner or matches[0].get("dockerName") != f"agentor-managed-{network_id}":
            raise PolicyError("Managed network authority is missing or ambiguous")

    def project_policy(self):
        project, etag = self.request("GET", f"/1.0/projects/{quote(self.project)}")
        config = project.get("config", {})
        allowed = config.get("restricted.networks.access", "").split(",")
        if project.get("name") != self.project or config.get("restricted") != "true" or \
                config.get("features.networks") != "false" or config.get("restricted.devices.nic") != "managed" or \
                self.primary not in allowed or not etag or any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,15}", name) for name in allowed):
            raise PolicyError("Restricted managed-NIC project and exact primary allowlist required")
        return project, etag, set(allowed)

    def allow(self, name, present):
        project, etag, allowed = self.project_policy()
        if present:
            allowed.add(name)
        else:
            allowed.discard(name)
        config = dict(project["config"])
        config["restricted.networks.access"] = ",".join(sorted(allowed))
        if config != project["config"]:
            self.request("PUT", f"/1.0/projects/{quote(self.project)}",
                         {"config": config, "description": project.get("description", "")}, etag)

    def metadata(self, owner, network_id):
        return {"user.agentor.installation": self.installation,
                "user.agentor.owner": owner, "user.agentor.network-id": network_id}

    def inspect_owned(self, name, owner, network_id):
        network, etag = self.request("GET", f"/1.0/networks/{name}")
        config = network.get("config", {})
        allowed_keys = {"ipv4.address", "ipv4.nat", "ipv4.dhcp", "ipv4.dhcp.ranges", "ipv6.address",
                        *self.metadata(owner, network_id)}
        if network.get("name") != name or network.get("type") != "bridge" or network.get("managed") is not True or \
                any(config.get(key) != value for key, value in self.metadata(owner, network_id).items()) or \
                config.get("ipv6.address") != "none" or config.get("ipv4.nat") != "true" or \
                config.get("ipv4.dhcp") not in (None, "true") or set(config) - allowed_keys or not etag:
            raise PolicyError("Native managed bridge ownership or policy changed")
        interface = ipaddress.IPv4Interface(config.get("ipv4.address", ""))
        if interface.network.prefixlen != 24 or interface.ip != interface.network.network_address + 1 or \
                not interface.ip.is_private:
            raise PolicyError("Native bridge subnet is not the expected bounded /24")
        return network, interface, etag

    def ensure(self, payload):
        owner, network_id, name = self.identity(payload)
        self.desired(owner, network_id)
        self.project_policy()
        try:
            network, interface, _ = self.inspect_owned(name, owner, network_id)
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
            self.request("POST", "/1.0/networks", {"name": name, "type": "bridge", "config": {
                **self.metadata(owner, network_id), "ipv4.address": "auto", "ipv4.nat": "true", "ipv6.address": "none"}})
            network, interface, _ = self.inspect_owned(name, owner, network_id)
        subnet = interface.network
        expected_range = f"{subnet.network_address + 128}-{subnet.network_address + 254}"
        if network["config"].get("ipv4.dhcp.ranges") != expected_range:
            current, current_interface, etag = self.inspect_owned(name, owner, network_id)
            if current_interface != interface or current.get("used_by") or self.bridge_ports(name):
                raise PolicyError("In-use bridge has incompatible DHCP authority; data retained")
            config = dict(current["config"])
            config["ipv4.dhcp.ranges"] = expected_range
            self.request("PUT", f"/1.0/networks/{name}", {"config": config, "description": current.get("description", "")}, etag)
        self.desired(owner, network_id)
        self.allow(name, True)
        return self.bridge_result(name, owner, network_id, interface)

    def bridge_result(self, name, owner, network_id, interface):
        return {"name": name, "subnet": str(interface.network), "gateway": str(interface.ip),
                "dockerRange": str(ipaddress.IPv4Network((int(interface.network.network_address), 26))),
                "installation": self.installation, "networkId": network_id, "userId": owner}

    def inspect(self, payload):
        """Read-only topology/preflight; never create, repair or allowlist."""
        owner, network_id, name = self.identity(payload)
        self.desired(owner, network_id)
        _, _, allowed = self.project_policy()
        try:
            network, interface, _ = self.inspect_owned(name, owner, network_id)
        except Exception as error:
            if getattr(error, "status_code", None) == 404:
                return None
            raise
        expected_range = f"{interface.network.network_address + 128}-{interface.network.network_address + 254}"
        if name not in allowed or network["config"].get("ipv4.dhcp.ranges") != expected_range:
            raise PolicyError("Native bridge DHCP or project allowlist authority is unsettled")
        references = network.get("used_by")
        if not isinstance(references, list) or len(references) > 4096 or \
                any(not isinstance(reference, str) or not 0 < len(reference) <= 1024 for reference in references):
            raise PolicyError("Native bridge reference authority is unavailable")
        return {**self.bridge_result(name, owner, network_id, interface), "references": references}

    def remove(self, payload):
        owner, network_id, name = self.identity(payload)
        # Deletion may settle a failed create after its desired record is gone;
        # exact native installation/owner/id authority is still mandatory.
        self.project_policy()
        try:
            network, _, etag = self.inspect_owned(name, owner, network_id)
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
        else:
            if network.get("used_by") or self.bridge_ports(name):
                raise PolicyError("Native bridge still has references or Docker/kernel ports")
            self.request("DELETE", f"/1.0/networks/{name}", None, etag)
        self.allow(name, False)
