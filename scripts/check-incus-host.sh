#!/usr/bin/env bash
# Read-only operator diagnostics. No installs, resource allocation or repair.
set -euo pipefail
exec python3 - "$0" "$@" <<'PY'
import argparse, hashlib, http.client, importlib.util, ipaddress, json, os, re, shutil, socket, ssl, stat, subprocess, sys
from pathlib import Path
from urllib.parse import quote, urlsplit
__file__ = sys.argv.pop(1)
spec = importlib.util.spec_from_file_location("host_sources", Path(__file__).resolve().with_name("incus-host-mount-sources.py"))
SOURCES = importlib.util.module_from_spec(spec)
spec.loader.exec_module(SOURCES)
CONNECT_ADDRESS = ""


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(*argv):
    result = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
    require(len(result.stdout) <= 4 * 1024 * 1024, "Command response exceeded its bound")
    return result.stdout.decode()


def endpoint(value):
    parsed = urlsplit(value)
    require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
            and parsed.path in ("", "/") and not parsed.query and not parsed.fragment, "Explicit HTTPS endpoint required")
    try:
        require(not ipaddress.ip_address(parsed.hostname).is_unspecified, "Wildcard endpoint is forbidden")
    except ValueError as error:
        if str(error) == "Wildcard endpoint is forbidden":
            raise
    require(0 < (parsed.port or 443) < 65536, "Invalid HTTPS port")
    return parsed


def credential(path, private=False):
    require(path and os.path.isabs(path), "Absolute credential file required")
    info = os.lstat(path)
    require(stat.S_ISREG(info.st_mode) and info.st_uid in (0, os.getuid()) and info.st_size <= 1024 * 1024
            and not info.st_mode & (0o077 if private else 0o022), "Credential file must be regular, owned and appropriately protected")


def native(path):
    return json.loads(command("incus", "query", "--force-local", path))


def https(base, path, cert, key, ca):
    parsed = endpoint(base)
    context = ssl.create_default_context(cafile=ca)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(cert, key)
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port or 443, context=context, timeout=10)
    if CONNECT_ADDRESS:  # Host diagnostic equivalent of curl --resolve; TLS hostname/CA verification stays enabled.
        connection._create_connection = lambda target, timeout, source_address=None: socket.create_connection((CONNECT_ADDRESS, target[1]), timeout, source_address)
    try:
        connection.request("GET", path)
        response = connection.getresponse()
        data = response.read(4 * 1024 * 1024 + 1)
        require(response.status == 200 and len(data) <= 4 * 1024 * 1024, "Verified mTLS read failed")
        body = json.loads(data)
        require(body.get("type") == "sync" and body.get("status_code") == 200, "Unexpected native response")
        return body["metadata"]
    finally:
        connection.close()


def supported(version):
    match = re.fullmatch(r"(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][A-Za-z0-9._+-]+)?", version)
    require(match, "Unrecognized Incus version")
    major, minor, patch = (int(part or 0) for part in match.groups())
    require(major > 6 or major == 6 and (minor >= 10 or minor == 0 and patch >= 6),
            "Use signed Incus 6.0 LTS >=6.0.6 or >=6.10; early rolling releases lack required share fixes")


def project_policy(project, name, network, account_paths=()):
    require(project.get("name") == name and name != "default", "Dedicated nondefault project required")
    config = project.get("config", {})
    for field, expected in {"restricted": "true", "features.images": "true", "features.storage.volumes": "true",
                            "features.networks": "false", "restricted.devices.nic": "managed", "restricted.devices.disk": "allow"}.items():
        require(config.get(field) == expected, "Project setting requires setup: " + field)
    require(network in config.get("restricted.networks.access", "").split(","), "Primary network is not allowlisted")
    for field in ("restricted.devices.pci", "restricted.devices.usb", "restricted.devices.gpu", "restricted.devices.infiniband",
                  "restricted.devices.proxy", "restricted.devices.unix-char", "restricted.devices.unix-block"):
        require(config.get(field, "block") == "block", "Unneeded host device authority must remain blocked: " + field)
    paths = config.get("restricted.devices.disk.paths", "").split(",")
    require(all(SOURCES.canonical(path) == path for path in paths),
            "Exact approved account/host-share paths must be configured; generic host access is forbidden")
    require(not any(SOURCES.overlaps(path, protected) for path in paths if path not in account_paths for protected in SOURCES.SYSTEM_PATHS),
            "Protected system/daemon trees must never be allowed guest shares")


def account_paths(container_name):
    if not container_name: return []
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", container_name), "Explicit Orchestrator container required")
    container = json.loads(command("docker", "inspect", container_name))[0]
    mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data" and mount.get("RW") is True]
    require(len(mounts) == 1, "Exact Orchestrator DATA source required")
    data = SOURCES.canonical(mounts[0]["Source"]); SOURCES.directory_identity(data); users = Path(data) / "users"
    if not users.exists(): return []
    SOURCES.directory_identity(str(users)); paths = []
    for user in users.iterdir():
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", user.name), "Account identity is invalid")
        for role in ("credentials", "kilo/config", "kilo/data"):
            path = user / role
            if os.path.lexists(path): SOURCES.directory_identity(str(path)); paths.append(str(path))
    return paths


def restricted_certificate(record, project):
    require(record.get("type") == "client" and record.get("restricted") is True and record.get("projects") == [project],
            "Client certificate must be restricted to exactly the Agentor project")


def internal_publication(published, address, port):
    expected = {"HostIp": address, "HostPort": str(port)}
    require(published.count(expected) == 1 and all(entry == expected or entry.get("HostIp") in ("127.0.0.1", "::1") for entry in published),
            "Internal endpoint must be bridge-only; existing loopback GUI publications may coexist")


def network_policy(network, name):
    require(network.get("name") == name and network.get("managed") is True and network.get("type") == "bridge",
            "Configured primary network must be a native managed bridge")
    config = network.get("config", {})
    interface = ipaddress.IPv4Interface(config.get("ipv4.address", ""))
    require(not interface.ip.is_unspecified and config.get("ipv4.dhcp", "true") == "true", "Primary IPv4 DHCP is required")
    require(config.get("ipv4.nat") == "true", "Native worker egress NAT is not configured")
    return interface


def nft_source_rule(document, table, network, bridge, cidr, address, installation):
    entries = document.get("nftables", [])
    chains = [entry["chain"] for entry in entries if "chain" in entry]
    require(any(chain.get("table") == table and chain.get("name") == "postrouting" and chain.get("type") == "nat"
                and chain.get("hook") == "postrouting" and chain.get("prio") == 99 for chain in chains), "Owned source-preserving chain is missing")
    matches = [
        {"match": {"op": "==", "left": {"meta": {"key": "iifname"}}, "right": network}},
        {"match": {"op": "==", "left": {"meta": {"key": "oifname"}}, "right": bridge}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "saddr"}},
                   "right": {"prefix": {"addr": str(cidr.network_address), "len": cidr.prefixlen}}}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "ip", "field": "daddr"}}, "right": address}},
        {"match": {"op": "==", "left": {"payload": {"protocol": "tcp", "field": "dport"}}, "right": 3000}},
        {"snat": {"addr": {"payload": {"protocol": "ip", "field": "saddr"}}}},
    ]
    rules = [entry["rule"] for entry in entries if "rule" in entry]
    require(any(rule.get("family") == "ip" and rule.get("table") == table and rule.get("chain") == "postrouting"
                and rule.get("comment") == "agentor-source-" + installation
                and [part for part in rule.get("expr", []) if "counter" not in part] == matches for rule in rules),
            "Exact owned narrow source-preservation rule is missing; other implementations require setup/check integration")


def main():
    parser = argparse.ArgumentParser(description="Read-only Agentor Incus host checks; never installs, repairs or allocates resources.")
    inputs = {"endpoint": "INCUS_ENDPOINT", "project": "INCUS_PROJECT", "network": "INCUS_NETWORK", "storage-pool": "INCUS_STORAGE_POOL",
              "client-cert-path": "INCUS_CLIENT_CERT_PATH", "client-key-path": "INCUS_CLIENT_KEY_PATH", "server-cert-path": "INCUS_SERVER_CERT_PATH",
              "network-host-endpoint": "INCUS_NETWORK_HOST_ENDPOINT", "network-host-server-cert-path": "INCUS_NETWORK_HOST_SERVER_CERT_PATH",
              "installation-id": "AGENTOR_INSTALLATION_ID", "docker-network": "INCUS_DOCKER_NETWORK",
              "orchestrator-container": "INCUS_ORCHESTRATOR_CONTAINER", "internal-gateway-url": "INCUS_INTERNAL_GATEWAY_URL",
              "source-nat-table": "INCUS_SOURCE_NAT_TABLE", "connect-address": "INCUS_HOST_CHECK_CONNECT_ADDRESS"}
    for argument, variable in inputs.items():
        parser.add_argument("--" + argument, default=os.environ.get(variable, ""), help=variable + " (operator configuration)")
    args = parser.parse_args(); failures = []; unknown = []
    global CONNECT_ADDRESS
    CONNECT_ADDRESS = ""

    def check(label, action, advice):
        try:
            value = action(); print("PASS " + label); return value
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ssl.SSLError, http.client.HTTPException):
            failures.append(label); print("FAIL " + label + ": " + advice); return None

    def host():
        release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
        require(release.get("ID", "").strip('"') == "ubuntu" and release.get("VERSION_ID", "").strip('"') == "24.04", "Supported Ubuntu 24.04 host required")
        require(stat.S_ISCHR(os.stat("/dev/kvm").st_mode) and os.access("/dev/kvm", os.R_OK | os.W_OK), "KVM must be available to Incus")
        command("qemu-system-x86_64", "--version")
        virtiofs = shutil.which("virtiofsd") or next((path for path in ("/usr/libexec/virtiofsd", "/usr/lib/qemu/virtiofsd") if os.access(path, os.X_OK)), "")
        require(virtiofs, "Install compatible Rust virtiofsd")
        require(re.match(r"^virtiofsd \d+\.\d+", command(virtiofs, "--version")), "Compatible Rust virtiofsd required")
    check("Ubuntu/KVM/QEMU/virtiofs", host, "Use supported Ubuntu 24.04 with accessible KVM, QEMU and compatible Rust virtiofsd; run as the host operator.")

    def configuration():
        global CONNECT_ADDRESS
        CONNECT_ADDRESS = str(ipaddress.IPv4Address(args.connect_address)) if args.connect_address else ""
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,63}", args.project) and args.project != "default", "Dedicated project required")
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,15}", args.network) and re.fullmatch(r"[A-Za-z0-9_.-]{1,63}", args.storage_pool), "Explicit network/storage required")
        require(re.fullmatch(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}", args.installation_id), "Pinned installation UUID required")
        endpoint(args.endpoint); endpoint(args.network_host_endpoint)
        for path in (args.client_cert_path, args.server_cert_path, args.network_host_server_cert_path or args.server_cert_path): credential(path)
        credential(args.client_key_path, True)
    check("operator configuration/credential files", configuration, "Provide explicit endpoints, project/network/pool, installation UUID and protected certificate/key paths (see --help).")
    if "operator configuration/credential files" in failures:
        return 1
    query = "?project=" + quote(args.project)
    check("restricted project", lambda: project_policy(native("/1.0/projects/" + quote(args.project)), args.project, args.network, account_paths(args.orchestrator_container)), "Configure project features, managed NICs, exact disk/network allowlists and blocked unnecessary host devices.")
    def client_auth():
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(Path(args.client_cert_path).read_text())).hexdigest()
        restricted_certificate(native("/1.0/certificates/" + fingerprint), args.project)
        server = https(args.endpoint, "/1.0" + query, args.client_cert_path, args.client_key_path, args.server_cert_path)
        require(server.get("auth") == "trusted", "Client mTLS is not trusted")
        supported(server["environment"]["server_version"])
        extensions = set(server.get("api_extensions", []))
        require({"projects", "projects_restrictions", "virtual-machines", "network_firewall_filtering"} <= extensions, "Required VM/project/NIC-filtering capabilities unavailable")
        listener = native("/1.0").get("config", {}).get("core.https_address", "")
        endpoint("https://" + listener)
        return server
    check("restricted verified HTTPS/mTLS/version/capabilities", client_auth, "Check server trust/SAN, exact project-restricted client, narrow listener and supported Incus >=6.0.6 LTS or >=6.10.")
    def resources():
        bridge = native("/1.0/networks/" + quote(args.network))
        interface = network_policy(bridge, args.network)
        for path, name in (("/1.0/networks/", args.network), ("/1.0/storage-pools/", args.storage_pool)):
            resource = https(args.endpoint, path + quote(name) + query, args.client_cert_path, args.client_key_path, args.server_cert_path)
            require(resource.get("name") == name and resource.get("status") in (None, "Created"), "Configured resource is unavailable")
        return interface
    interface = check("managed primary network/storage", resources, "Create/select the managed DHCP/NAT bridge and ready storage pool visible to this project.")
    def policy():
        value = https(args.network_host_endpoint, "/v1/managed-networks/readiness" + query, args.client_cert_path, args.client_key_path,
                      args.network_host_server_cert_path or args.server_cert_path)
        require(value == {"ready": True, "installation": args.installation_id, "project": args.project, "primary": args.network}, "Policy identity/readiness mismatch")
    check("owned narrow host-policy readiness", policy, "Install/restart the pinned mTLS host policy service; verify installation/project/primary match.")

    def routing():
        require(interface is not None and Path("/proc/sys/net/ipv4/ip_forward").read_text().strip() == "1", "IPv4 forwarding unavailable")
        require(re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", args.docker_network) and re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", args.orchestrator_container)
                and re.fullmatch(r"[A-Za-z0-9_]{1,63}", args.source_nat_table), "Explicit operator topology required")
        network = json.loads(command("docker", "network", "inspect", args.docker_network))[0]
        container = json.loads(command("docker", "inspect", args.orchestrator_container))[0]
        bridge = network.get("Options", {}).get("com.docker.network.bridge.name") or "br-" + network["Id"][:12]
        require(re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge), "Docker bridge observation invalid")
        address = str(ipaddress.IPv4Address(container["NetworkSettings"]["Networks"][args.docker_network]["IPAddress"]))
        gateway = urlsplit(args.internal_gateway_url)
        require(gateway.scheme == "http" and gateway.hostname == str(interface.ip) and gateway.port and not gateway.username
                and not gateway.password and gateway.path in ("", "/") and not gateway.query and not gateway.fragment, "Stable bridge-only internal URL required")
        published = container["NetworkSettings"]["Ports"].get("3000/tcp") or []
        internal_publication(published, str(interface.ip), gateway.port)
        require(not any(mount.get("Source", "").startswith("/var/lib/incus") or mount.get("Destination", "").startswith("/var/lib/incus")
                        for mount in container.get("Mounts", [])), "Orchestrator must not receive the Incus Unix socket/storage")
        nft_source_rule(json.loads(command("nft", "-j", "list", "table", "ip", args.source_nat_table)),
                        args.source_nat_table, args.network, bridge, interface.network, address, args.installation_id)
    if not all((args.docker_network, args.orchestrator_container, args.source_nat_table, args.internal_gateway_url)):
        unknown.append("routing"); print("UNKNOWN routing: supply discovered Docker network/container, bridge-only internal URL and owned source-NAT table; equivalent rules need setup/check integration.")
    else:
        check("configured narrow source-preserving topology", routing, "Restore the exact owned source-preservation rule and bridge-only published internal listener; no blanket firewall ACCEPT is suggested.")
        unknown.append("forwarding"); print("UNKNOWN forwarding: this preparatory checker does not yet prove setup-owned forwarding rules; complete setup integration and the real source-IP canary.")
    if failures or unknown:
        print("NOT READY: correct failed checks and resolve unknown prerequisites; no host state was changed."); return 1 if failures else 2
    print("Read-only prerequisites checked; real VM anti-spoofing/source-identity canary is still required."); return 0


if __name__ == "__main__":
    sys.exit(main())
PY
