#!/usr/bin/env python3
"""Private administrative VM networks, derived exclusively from platform records.

The serialized mTLS service owns these operations. No arbitrary host command,
network, address, device, Docker container, or Incus path crosses its API.
"""
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import posixpath
import re
import shlex
import subprocess
from urllib.parse import quote

SPEC = importlib.util.spec_from_file_location("admin_managed_policy", Path(__file__).with_name("incus-managed-network-policy.py"))
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
PolicyError = BASE.PolicyError
SAFE_ID = r"[A-Za-z0-9_-]{1,128}"
UUID = r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}"


def native_name(workspace):
    literal = "agentor-admin-" + workspace
    if len(literal) <= 44 and re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*[A-Za-z0-9]", literal):
        return literal
    return "agentor-admin-" + hashlib.sha256(workspace.encode()).hexdigest()[:30]


def require(condition, message):
    if not condition:
        raise PolicyError(message)


def matches_incus_config(actual, expected):
    # Incus removes empty config values; only the global group label is optional.
    return all(actual.get(key) == value or key == "user.agentor.admin-group" and value == "" and key not in actual
               for key, value in expected.items())


def command(*args, data=None):
    try:
        result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
    except subprocess.TimeoutExpired:
        raise PolicyError("Private network host operation timed out; retain owned resources") from None
    require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024,
            "Private network host operation failed; retain owned resources")
    return result.stdout


def directory_names(root, parts):
    flags = os.O_RDONLY | os.O_CLOEXEC | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open(root, flags)
    try:
        for part in parts:
            try:
                following = os.open(part, flags, dir_fd=descriptor)
            except FileNotFoundError:
                # Fresh global administration precedes the first account directory.
                if parts == ["users"]:
                    return []
                raise
            os.close(descriptor)
            descriptor = following
        names = []
        with os.scandir(descriptor) as entries:
            for entry in entries:
                require(len(names) < 4096, "Administrative authority directory exceeds its bound")
                names.append(entry.name)
        return sorted(names)
    finally:
        os.close(descriptor)


class AdminNetworkPolicy:
    def __init__(self, managed, pool, orchestrator, docker_request, run=command):
        self.managed = managed
        self.request = managed.request
        self.data_dir = managed.data_dir
        self.installation = managed.installation
        self.project = managed.project
        self.pool = pool
        self.orchestrator = orchestrator
        self.docker = docker_request
        self.run = run
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,63}", pool or "") is not None, "Pinned storage pool required")
        require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", orchestrator or "") is not None,
                "Pinned orchestrator container required")

    def authority(self, payload):
        require(isinstance(payload, dict) and set(payload) == {"workspaceId"}, "Only workspace identity is accepted")
        workspace = payload["workspaceId"]
        require(isinstance(workspace, str) and re.fullmatch(SAFE_ID, workspace) is not None, "Invalid workspace identity")
        require(BASE.read_bounded(self.data_dir, ["backup-installation-id"], 128).strip() == self.installation,
                "Installation identity changed")
        records = []
        try:
            platform = json.loads(BASE.read_bounded(self.data_dir, ["admin", "workspace.v1.json"]))
        except FileNotFoundError:
            platform = None
        else:
            require(platform is not None, "Global administrative authority is corrupt")
        if platform is not None:
            self.validate_record(platform, "administrative")
            records.append((platform, "__agentor_admin__", ""))
        remaining = 16 * 1024 * 1024
        for owner in directory_names(self.data_dir, ["users"]):
            require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", owner) is not None, "Invalid authority owner directory")
            try:
                raw = BASE.read_bounded(self.data_dir, ["users", owner, "worker-groups.json"])
            except FileNotFoundError:
                continue
            remaining -= len(raw.encode())
            require(remaining >= 0, "Administrative authority exceeds its total read bound")
            groups = json.loads(raw)
            require(isinstance(groups, list), "Group authority is corrupt")
            for group in groups:
                require(isinstance(group, dict) and isinstance(group.get("id"), str)
                        and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", group["id"]) is not None
                        and group.get("userId") == owner, "Group authority is corrupt")
                record = group.get("adminWorkspace")
                if record is None:
                    continue
                self.validate_record(record, "group-administrative")
                require(record.get("groupId") == group["id"] and record.get("ownerId") == owner,
                        "Group administrative identity differs from its authority")
                records.append((record, owner, group["id"]))
        matches = [entry for entry in records if entry[0]["id"] == workspace]
        require(len(matches) == 1, "Administrative identity is missing or ambiguous")
        record, owner, group = matches[0]
        native = record.get("nativeRuntime")
        require(record.get("runtimeKind") == "incus-vm" and isinstance(native, dict)
                and type(native.get("version")) is int and native["version"] == 1
                and ("incarnation" not in native or isinstance(native["incarnation"], str)
                     and re.fullmatch(UUID, native["incarnation"]) is not None)
                and native.get("name") == native_name(workspace)
                and native.get("installationId") == self.installation
                and isinstance(native.get("nonce"), str) and re.fullmatch(UUID, native["nonce"]) is not None
                and isinstance(native.get("overlaySha256"), str)
                and re.fullmatch(r"[0-9a-f]{64}", native["overlaySha256"]) is not None
                and native.get("overlayVersion") == "6", "Durable native administrative intent is unavailable")
        require(len(f"/var/lib/incus/devices/{self.project}_{native['name']}/virtio-fs.workspace.sock".encode()) <= 107,
                "Administrative virtiofs socket path exceeds 107 bytes; use a shorter Incus project")
        key = hashlib.sha256(f"{self.installation}:{owner}:{group}:{workspace}".encode()).hexdigest()[:12]
        return {"record": record, "owner": owner, "group": group, "name": "aa" + key,
                "dockerName": "agentor-admin-network-" + key, "key": key,
                "selected": self.selected_records(record, owner)}

    def selected_records(self, record, owner):
        native = record["nativeRuntime"]
        ids = native.get("selectedVolumeIds", [])
        require(isinstance(ids, list) and len(ids) <= 32
                and all(isinstance(value, str) and re.fullmatch(UUID, value) for value in ids)
                and len(set(ids)) == len(ids), "Administrative selected volume identities are invalid")
        require("deleting" not in native or native["deleting"] is True, "Administrative deletion intent is invalid")
        operation = native.get("selectedOperation")
        if "selectedOperation" in native:
            require(isinstance(operation, dict) and set(operation) <= {"volumeId", "operationId", "incarnation", "kind", "device", "canonical"}
                    and operation.get("volumeId") in ids and operation.get("kind") in ("snapshot", "seed")
                    and isinstance(operation.get("operationId"), str) and re.fullmatch(UUID, operation["operationId"])
                    and isinstance(operation.get("incarnation"), str) and re.fullmatch(UUID, operation["incarnation"])
                    and operation["incarnation"] == native.get("incarnation"),
                    "Administrative selected operation identity is invalid")
            require("canonical" not in operation or operation["canonical"] is True and operation["kind"] == "seed",
                    "Selected canonical transition is invalid")
            if "device" in operation:
                device = operation["device"]
                require(isinstance(device, dict) and set(device) <= {"state", "operation"}
                        and device.get("state") in ("unknown", "accepted", "settled")
                        and (isinstance(device.get("operation"), str)
                             and re.fullmatch(r"/1\.0/operations/" + UUID, device["operation"])
                             if device.get("state") == "accepted" else "operation" not in device),
                        "Selected device acknowledgement is invalid")
        try:
            records = json.loads(BASE.read_bounded(self.data_dir, ["users", owner, "managed-volumes.v1.json"]))
        except FileNotFoundError:
            require(not ids, "Selected volume authority is missing")
            return []
        require(isinstance(records, list) and len(records) <= 4096
                and all(isinstance(value, dict) and isinstance(value.get("id"), str) for value in records)
                and len({value["id"] for value in records}) == len(records), "Selected volume authority is corrupt")
        require(all(value["id"] in ids for value in records if value.get("userId") == owner
                    and value.get("workerId") == record["id"] and value.get("storageRuntimeKind") == "incus-vm"
                    and value.get("attached") is True), "Attached native storage is missing from administrative authority")
        selected, targets, keys = [], [], set()
        protected = ("/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/root",
                     "/bin", "/sbin", "/lib", "/lib64", "/usr", "/var/lib/docker", "/var/lib/containerd",
                     "/home/agent/.agent-data", "/home/agent/.ssh", "/home/agent/.claude", "/home/agent/.codex",
                     "/home/agent/.gemini", "/home/agent/.agents", "/home/agent/.config/kilo", "/home/agent/.local/share/kilo",
                     "/workspace")
        def overlap(left, right):
            return left == right or left.startswith(right + "/") or right.startswith(left + "/")
        for identity in ids:
            matches = [value for value in records if value["id"] == identity]
            require(len(matches) == 1, "Selected volume record is missing")
            value = matches[0]
            require(value.get("userId") == owner and value.get("workerId") == record["id"]
                    and value.get("storageRuntimeKind") == "incus-vm" and value.get("purpose") == "persistent-path"
                    and value.get("dockerName") == "agentor-persist-" + identity and value.get("attached") is True
                    and type(value.get("seeded")) is bool
                    and not any(field in value for field in ("incusLive", "liveContainerId", "previousRestartPolicy", "retainedAfterAccountDeletion")),
                    "Selected volume ownership or backend differs")
            target = value.get("target")
            require(isinstance(target, str) and 1 < len(target) <= 4096 and target.startswith("/")
                    and not target.endswith("/") and not re.search(r"[\x00-\x1f\x7f\\:]", target)
                    and posixpath.normpath(target) == target and not target.startswith("//")
                    and (target == "/home/agent/.local/share" or not any(overlap(target, path) for path in protected))
                    and not any(overlap(target, previous) for previous in targets),
                    "Selected volume target is protected, overlapping or noncanonical")
            key = "m" + identity.replace("-", "")[:6]
            require(key not in keys, "Selected volume device identities collide")
            keys.add(key)
            targets.append(target)
            receipt = value.get("operation")
            if "operation" in value:
                require(isinstance(receipt, dict) and set(receipt) <= {"id", "mode", "stage", "error"}
                        and isinstance(receipt.get("id"), str) and re.fullmatch(UUID, receipt["id"])
                        and receipt.get("mode") == "recreate", "Selected volume operation is invalid")
            if operation is not None and operation["volumeId"] == identity:
                require(isinstance(receipt, dict) and receipt.get("id") == operation["operationId"]
                        and receipt.get("mode") == "recreate" and receipt.get("stage") in ("copying", "failed", "complete")
                        and value.get("state") in ("preparing", "failed", "ready")
                        and (operation["kind"] != "snapshot" or value["seeded"] is False)
                        and (value["state"] != "ready" or value["seeded"] is True
                             and (receipt["stage"] == "complete" or operation["kind"] == "seed" and receipt["stage"] == "copying"))
                        and (not operation.get("canonical") or value["seeded"] is True),
                        "Selected volume copy receipt differs")
            else:
                require((receipt is None or isinstance(receipt, dict) and receipt.get("stage") == "complete")
                        and ((value["seeded"] is True and value.get("state") == "ready")
                             or (value["seeded"] is False and value.get("state") == "pending")),
                        "Selected volume copy is unsettled")
            selected.append(value)
        return selected

    @staticmethod
    def validate_record(record, kind):
        require(isinstance(record, dict) and type(record.get("schemaVersion")) is int
                and record["schemaVersion"] == 1 and record.get("kind") == kind
                and (kind != "administrative" or "groupId" not in record)
                and record.get("trusted") is True and isinstance(record.get("id"), str)
                and re.fullmatch(SAFE_ID, record["id"]) is not None,
                "Administrative authority is corrupt")

    def unchanged(self, payload, identity):
        require(self.authority(payload) == identity, "Administrative authority changed during network admission")

    def labels(self, identity):
        return {"user.agentor.installation": self.installation, "user.agentor.id": identity["record"]["id"],
                "user.agentor.owner": identity["owner"], "user.agentor.administrative": identity["record"]["kind"],
                "user.agentor.admin-group": identity["group"]}

    def network(self, identity):
        network, etag = self.request("GET", "/1.0/networks/" + identity["name"])
        require(isinstance(network, dict) and isinstance(network.get("config"), dict), "Private bridge metadata is unavailable")
        config = network["config"]
        allowed = {"ipv4.address", "ipv4.nat", "ipv4.dhcp", "ipv4.dhcp.ranges", "ipv6.address", *self.labels(identity)}
        require(network.get("name") == identity["name"] and network.get("managed") is True
                and network.get("type") == "bridge" and etag and not set(config) - allowed
                and matches_incus_config(config, self.labels(identity))
                and config.get("ipv4.nat") == "true" and config.get("ipv4.dhcp") in (None, "true")
                and config.get("ipv6.address") == "none", "Private bridge ownership or configuration differs")
        interface = ipaddress.IPv4Interface(config.get("ipv4.address", ""))
        require(interface.network.prefixlen == 24 and interface.ip == interface.network.network_address + 1
                and any(interface.network.subnet_of(ipaddress.IPv4Network(prefix))
                        for prefix in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")),
                "Private bridge must have an RFC1918 /24 gateway")
        references = network.get("used_by")
        expected = "/1.0/instances/" + quote(identity["record"]["nativeRuntime"]["name"]) + "?project=" + quote(self.project)
        require(isinstance(references, list) and len(references) <= 1 and all(ref == expected for ref in references),
                "Private bridge has unexpected instance/profile references")
        return network, interface, etag

    def result(self, identity, interface):
        subnet = interface.network
        mac = "02:" + ":".join(identity["key"][index:index + 2] for index in range(0, 10, 2))
        peer = str(subnet.network_address + 2)
        result = {"installation": self.installation, "workspaceId": identity["record"]["id"],
                  "ownerId": identity["owner"], "kind": identity["record"]["kind"],
                  "network": identity["name"], "subnet": str(subnet), "gateway": str(interface.ip),
                  "managementAddress": peer, "guestAddress": str(subnet.network_address + 3), "guestMac": mac,
                  "gatewayUrl": f"http://{peer}:3000", "mcpUrl": f"http://{peer}:3099/mcp"}
        if identity["group"]:
            result["groupId"] = identity["group"]
        return result

    def inspect_instance(self, identity, result):
        native = identity["record"]["nativeRuntime"]
        try:
            instance, _ = self.request("GET", "/1.0/instances/" + quote(native["name"]) + "?project=" + quote(self.project))
        except Exception as error:
            if getattr(error, "status_code", None) == 404:
                return
            raise
        require(isinstance(instance, dict) and isinstance(instance.get("config"), dict), "Native admin metadata is unavailable")
        config = instance["config"]
        labels = {**self.labels(identity), "user.agentor.admin-nonce": native["nonce"],
                  "user.agentor.admin-overlay-sha256": native["overlaySha256"],
                  "boot.autostart": "false", "security.secureboot": "false",
                  "limits.memory": "4GiB", "limits.cpu": "2"}
        require(instance.get("name") == native["name"] and instance.get("type") == "virtual-machine"
                and instance.get("profiles") == [] and matches_incus_config(config, labels)
                and all(key in labels or key.startswith(("volatile.", "image.")) for key in config),
                "Native admin identity, profiles or configuration differs")
        devices = {"root": {"type": "disk", "path": "/", "pool": self.pool},
                   "workspace": {"type": "disk", "path": "/workspace", "pool": self.pool,
                                 "source": native["name"] + "-workspace"},
                   "agents": {"type": "disk", "path": "/home/agent/.agent-data", "pool": self.pool,
                              "source": native["name"] + "-agents"},
                   "eth0": {"type": "nic", "name": "eth0", "network": result["network"],
                            "ipv4.address": result["guestAddress"], "hwaddr": result["guestMac"],
                            "security.mac_filtering": "true", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true"}}
        for value in identity["selected"]:
            key = "m" + value["id"].replace("-", "")[:6]
            operation = native.get("selectedOperation")
            staging = operation is not None and operation["volumeId"] == value["id"]
            canonical = staging and operation.get("canonical") is True
            if canonical:
                require(instance.get("status") == "Stopped" and value["seeded"] is True,
                        "Selected canonical transition requires stopped seeded storage")
            if staging and key not in instance.get("devices", {}) and not canonical:
                continue
            if staging or value["seeded"]:
                target = "/run/agentor-volume-seed/" + value["id"] if staging else value["target"]
                if canonical and instance.get("devices", {}).get(key, {}).get("path") == value["target"]:
                    target = value["target"]
                devices[key] = {"type": "disk", "pool": self.pool, "source": value["dockerName"], "path": target}
        def same_devices(actual):
            if not isinstance(actual, dict) or actual.keys() != devices.keys():
                return False
            for key, expected in devices.items():
                if not isinstance(actual[key], dict):
                    return False
                observed = dict(actual[key])
                if key in ("workspace", "agents"):
                    if "io.cache" in observed and observed.pop("io.cache") != "unsafe":
                        return False
                if observed != expected:
                    return False
            return True
        require(same_devices(instance.get("devices")) and same_devices(instance.get("expanded_devices")),
                "Native admin devices differ from its private canonical layout")
        if native.get("incarnation"):
            require(config.get("volatile.uuid") == native["incarnation"], "Native admin incarnation changed")
        return instance

    def controller(self):
        container = self.docker("GET", "/containers/" + quote(self.orchestrator) + "/json")
        require(isinstance(container, dict) and re.fullmatch(r"[0-9a-f]{64}", container.get("Id", "")) is not None
                and isinstance(container.get("Name"), str) and re.fullmatch(r"/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", container["Name"]) is not None
                and (container["Name"] == "/" + self.orchestrator or container["Id"] == self.orchestrator)
                and container.get("State", {}).get("Running") is True,
                "Pinned orchestrator container is unavailable")
        mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data"]
        require(len(mounts) == 1 and mounts[0].get("Type") in ("bind", "volume") and mounts[0].get("RW") is True
                and mounts[0].get("Source") == self.data_dir, "Pinned orchestrator data authority differs")
        return container

    def docker_body(self, identity, result):
        subnet = ipaddress.IPv4Network(result["subnet"])
        return {"Name": identity["dockerName"], "Driver": "bridge", "Internal": True, "EnableIPv6": False,
                "CheckDuplicate": True, "Labels": self.labels(identity),
                "Options": {"com.docker.network.bridge.name": result["network"], "com.docker.network.bridge.inhibit_ipv4": "true"},
                "IPAM": {"Driver": "default", "Config": [{"Subnet": result["subnet"], "Gateway": result["gateway"],
                         "IPRange": str(ipaddress.IPv4Network((int(subnet.network_address), 29))),
                         "AuxiliaryAddresses": {"guest": result["guestAddress"]}}]}}

    def peer(self, identity, result, controller, create=False):
        desired = self.docker_body(identity, result)
        try:
            network = self.docker("GET", "/networks/" + identity["dockerName"])
        except Exception as error:
            if getattr(error, "status_code", None) != 404 or not create:
                raise
            self.docker("POST", "/networks/create", desired)
            network = self.docker("GET", "/networks/" + identity["dockerName"])
        require(isinstance(network, dict) and re.fullmatch(r"[0-9a-f]{64}", network.get("Id", "")) is not None
                and all(network.get(key) == desired[key] for key in ("Name", "Driver", "Internal", "EnableIPv6", "Labels", "Options"))
                and network.get("IPAM", {}).get("Driver") == "default"
                and network.get("IPAM", {}).get("Options") in (None, {})
                and network.get("IPAM", {}).get("Config") == desired["IPAM"]["Config"]
                and network.get("Scope") == "local" and network.get("ConfigOnly") is False
                and network.get("Ingress") is False and network.get("Attachable") is False,
                "Orchestrator private bridge wrapper differs")
        endpoints = network.get("Containers")
        require(isinstance(endpoints, dict) and set(endpoints) <= {controller["Id"]},
                "Private management bridge has foreign Docker members")
        if not endpoints and create:
            require(self.controller()["Id"] == controller["Id"], "Orchestrator changed before private peer attachment")
            self.docker("POST", "/networks/" + network["Id"] + "/connect", {
                "Container": controller["Id"], "EndpointConfig": {"MacAddress": "06" + result["guestMac"][2:],
                    "IPAMConfig": {"IPv4Address": result["managementAddress"]}}})
            return self.peer(identity, result, controller)
        endpoint = endpoints.get(controller["Id"], {})
        require(endpoint.get("Name") == controller["Name"][1:] and endpoint.get("IPv4Address") == result["managementAddress"] + "/24"
                and endpoint.get("MacAddress") == "06" + result["guestMac"][2:]
                and not endpoint.get("IPv6Address") and re.fullmatch(r"[0-9a-f]{64}", endpoint.get("EndpointID", "")) is not None,
                "Orchestrator private address is unsettled")
        current = self.controller()
        require(current["Id"] == controller["Id"], "Orchestrator changed during private admission")
        membership = current.get("NetworkSettings", {}).get("Networks", {}).get(identity["dockerName"], {})
        require(membership.get("NetworkID") == network["Id"] and membership.get("EndpointID") == endpoint["EndpointID"]
                and membership.get("IPAddress") == result["managementAddress"], "Private peer membership differs")

    def admit(self, payload, create):
        identity = self.authority(payload)
        require(not create or not any(identity["record"]["nativeRuntime"].get(field)
                                      for field in ("pending", "selectedOperation", "deleting")),
                "Native administrative operation is pending")
        self.managed.project_policy()
        controller = self.controller()
        try:
            network, interface, etag = self.network(identity)
        except Exception as error:
            if getattr(error, "status_code", None) != 404:
                raise
            if not create:
                return None
            self.unchanged(payload, identity)
            self.request("POST", "/1.0/networks", {"name": identity["name"], "type": "bridge", "config": {
                **self.labels(identity), "ipv4.address": "auto", "ipv4.nat": "true", "ipv6.address": "none"}})
            network, interface, etag = self.network(identity)
        result = self.result(identity, interface)
        self.inspect_instance(identity, result)
        expected_range = result["guestAddress"] + "-" + result["guestAddress"]
        if network["config"].get("ipv4.dhcp.ranges") != expected_range:
            require(create and not network["used_by"] and not self.managed.bridge_ports(identity["name"]),
                    "In-use private bridge DHCP geometry differs")
            self.unchanged(payload, identity)
            self.request("PUT", "/1.0/networks/" + identity["name"], {
                "config": {**network["config"], "ipv4.dhcp.ranges": expected_range},
                "description": network.get("description", "")}, etag)
        # Filtering settles before Docker attachment or restricted-project publication.
        self.unchanged(payload, identity)
        self.firewall(identity, result, create)
        self.unchanged(payload, identity)
        self.peer(identity, result, controller, create)
        self.unchanged(payload, identity)
        instance = self.inspect_instance(identity, result)
        ports = self.managed.bridge_ports(identity["name"])
        require(isinstance(ports, list) and len(ports) == len(set(ports)), "Private bridge port authority is unavailable")
        tap = instance.get("config", {}).get("volatile.eth0.host_name") if instance else None
        require(len(ports) == 1 + int(tap is not None and tap in ports),
                "Private bridge has unexpected kernel members")
        if create:
            self.managed.allow(identity["name"], True)
        else:
            require(identity["name"] in self.managed.project_policy()[2], "Private bridge is not allowlisted")
        return result

    def ensure(self, payload):
        return self.admit(payload, True)

    def inspect(self, payload):
        return self.admit(payload, False)

    def firewall(self, identity, result, create):
        routes = json.loads(self.run("ip", "-j", "-4", "route", "show", "table", "main"))
        require(isinstance(routes, list) and len(routes) <= 4096, "Host route authority is unavailable")
        uplinks = {route.get("dev") for route in routes if route.get("dst") == "default"}
        require(len(uplinks) == 1, "One explicit default uplink is required")
        uplink = next(iter(uplinks))
        require(isinstance(uplink, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", uplink) is not None
                and uplink != result["network"], "Invalid private network uplink")
        blocked = {"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
                   "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
                   "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4"}
        # Even a public LAN prefix is host-local, not general internet egress.
        for route in routes:
            if route.get("scope") == "link" and route.get("dst") not in (None, "default"):
                connected = ipaddress.IPv4Network(route["dst"])
                if not any(connected.subnet_of(ipaddress.IPv4Network(prefix)) for prefix in blocked):
                    blocked.add(str(connected))
        expected = firewall_objects(identity, result, uplink, sorted(blocked))
        table = "agentor_admin_" + identity["key"]
        tables = json.loads(self.run("nft", "-j", "list", "tables"))["nftables"]
        additions = []
        for family in ("inet", "bridge"):
            desired = [entry for entry in expected if next(iter(entry.values()))["family"] == family]
            present = any(entry.get("table", {}).get("family") == family
                          and entry["table"].get("name") == table for entry in tables)
            if present:
                observed = json.loads(self.run("nft", "-j", "list", "table", family, table))["nftables"]
                require(without_handles(observed) == desired, "Private firewall differs; preserve foreign or changed policy")
            else:
                require(create, "Private firewall is missing")
                additions.extend({"add": entry} for entry in desired)
        if additions:
            batch = json.dumps({"nftables": additions}).encode()
            self.run("nft", "--check", "-j", "-f", "-", data=batch)
            self.run("nft", "-j", "-f", "-", data=batch)
            for family in ("inet", "bridge"):
                desired = [entry for entry in expected if next(iter(entry.values()))["family"] == family]
                observed = json.loads(self.run("nft", "-j", "list", "table", family, table))["nftables"]
                require(without_handles(observed) == desired, "Private firewall did not settle exactly")
        # Docker's later default DROP must not override the private filters.
        # These exact accepts are useful only after both nft families settle.
        chain = "AGADMIN_" + identity["key"]
        marker = "agentor-admin-" + self.installation + "-" + identity["key"]
        rules = [shlex.split(line) for line in self.run("iptables", "-w", "-S").decode().splitlines()]
        require(["-N", "DOCKER-USER"] in rules and ["-A", "FORWARD", "-j", "DOCKER-USER"] in rules,
                "Docker's supported forwarding chain is unavailable")
        prepared = [["-A", chain, *direction, "-m", "comment", "--comment", marker, "-j", "ACCEPT"]
                    for direction in (["-i", result["network"]], ["-o", result["network"]])]
        prepared.append(["-A", chain, "-m", "comment", "--comment", marker, "-j", "RETURN"])
        jump = ["-A", "DOCKER-USER", "-m", "comment", "--comment", marker, "-j", chain]
        existing = [rule for rule in rules if rule[:2] == ["-A", chain]]
        if ["-N", chain] in rules:
            require(existing == prepared, "Private Docker forwarding chain differs")
        else:
            require(create, "Private Docker forwarding chain is missing")
            self.run("iptables", "-w", "-N", chain)
            batch = "*filter\n" + "\n".join(shlex.join(rule) for rule in prepared) + "\nCOMMIT\n"
            self.run("iptables-restore", "--wait", "--noflush", data=batch.encode())
        references = [rule for rule in rules if "-j" in rule and rule[rule.index("-j") + 1] == chain]
        require(references in ([], [jump]), "Private forwarding chain has unexpected references")
        if not references:
            require(create, "Private Docker forwarding jump is missing")
            self.run("iptables", "-w", "-I", "DOCKER-USER", "1", *jump[2:])


def without_handles(entries):
    result = []
    for entry in entries:
        if "metainfo" in entry:
            continue
        require(len(entry) == 1 and next(iter(entry)) in ("table", "chain", "rule"), "Unexpected private firewall object")
        kind, value = next(iter(entry.items()))
        result.append({kind: {key: item for key, item in value.items() if key != "handle"}})
    return result


def firewall_objects(identity, result, uplink, blocked):
    """Emit nft's readback form: payloads imply their protocol dependencies."""
    table = "agentor_admin_" + identity["key"]
    marker = "agentor-admin-" + result["installation"] + "-" + identity["key"]
    objects = []
    def match(left, right, op="=="):
        return {"match": {"op": op, "left": left, "right": right}}
    def meta(key, value):
        return match({"meta": {"key": key}}, value)
    def payload(protocol, field, value):
        return match({"payload": {"protocol": protocol, "field": field}}, value)
    def state(value):
        return match({"ct": {"key": "state"}}, value, "in")
    def rule(family, chain, expressions, verdict):
        objects.append({"rule": {"family": family, "table": table, "chain": chain,
                                 "expr": [*expressions, {verdict: None}], "comment": marker}})
    def chains(family, names):
        objects.append({"table": {"family": family, "name": table, "comment": marker}})
        for name in names:
            objects.append({"chain": {"family": family, "table": table, "name": name,
                                      "type": "filter", "hook": name, "prio": -10, "policy": "accept"}})
    bridge, guest, peer, gateway = (result[key] for key in ("network", "guestAddress", "managementAddress", "gateway"))
    incoming, outgoing = meta("iifname", bridge), meta("oifname", bridge)
    source, destination = payload("ip", "saddr", guest), payload("ip", "daddr", guest)
    chains("inet", ("input", "forward"))
    for protocol in ("udp", "tcp"):
        rule("inet", "input", [incoming, source, payload("ip", "daddr", gateway),
                               payload(protocol, "dport", 53)], "accept")
    for address in ("0.0.0.0", guest):
        for destination_ip in ("255.255.255.255", gateway):
            rule("inet", "input", [incoming, payload("ip", "saddr", address), payload("ip", "daddr", destination_ip),
                                   payload("udp", "sport", 68), payload("udp", "dport", 67)], "accept")
    rule("inet", "input", [incoming], "drop")
    # Same-bridge packets may also traverse inet when br_netfilter is enabled.
    for state_name in ("established", "related"):
        rule("inet", "forward", [incoming, outgoing, source, payload("ip", "daddr", peer), state(state_name)], "accept")
    for port in (3000, 3099):
        rule("inet", "forward", [incoming, outgoing, source, payload("ip", "daddr", peer),
                                 payload("tcp", "dport", port)], "accept")
    rule("inet", "forward", [incoming, outgoing, payload("ip", "saddr", peer), destination], "accept")
    for cidr in blocked:
        network = ipaddress.IPv4Network(cidr)
        rule("inet", "forward", [incoming, payload("ip", "daddr", {"prefix": {"addr": str(network.network_address), "len": network.prefixlen}})], "drop")
    rule("inet", "forward", [incoming, match({"fib": {"result": "type", "flags": ["daddr"]}}, "local")], "drop")
    rule("inet", "forward", [incoming, meta("oifname", uplink), source], "accept")
    rule("inet", "forward", [incoming], "drop")
    for state_name in ("established", "related"):
        rule("inet", "forward", [meta("iifname", uplink), outgoing, destination, state(state_name)], "accept")
    rule("inet", "forward", [outgoing], "drop")
    chains("bridge", ("forward",))
    inside = [meta("ibrname", bridge), meta("obrname", bridge)]
    for address, mac in ((guest, result["guestMac"]), (peer, "06" + result["guestMac"][2:])):
        rule("bridge", "forward", [*inside, payload("ether", "saddr", mac),
                                   payload("arp", "saddr ip", address)], "accept")
    guest_flow = [*inside, payload("ether", "saddr", result["guestMac"]),
                  source, payload("ip", "daddr", peer)]
    for state_name in ("established", "related"):
        rule("bridge", "forward", [*guest_flow, state(state_name)], "accept")
    for port in (3000, 3099):
        rule("bridge", "forward", [*guest_flow, payload("tcp", "dport", port)], "accept")
    rule("bridge", "forward", [*inside, payload("ether", "saddr", "06" + result["guestMac"][2:]),
                               payload("ip", "saddr", peer), destination], "accept")
    rule("bridge", "forward", [meta("ibrname", bridge)], "drop")
    rule("bridge", "forward", [meta("obrname", bridge)], "drop")
    # nft lists each table's chain declarations before its ordered rules.
    return objects
