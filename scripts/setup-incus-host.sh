#!/usr/bin/env bash
# Operator-root only. Never migrates workers or writes canonical Agentor DATA.
set -euo pipefail
exec python3 - "$0" "$@" <<'PY'
import argparse, hashlib, importlib.util, ipaddress, json, os, re, shlex, shutil, socket, ssl, stat, subprocess, sys, tempfile
from pathlib import Path
from urllib.parse import quote
from urllib.request import urlopen

__file__ = sys.argv.pop(1)
ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("sources", ROOT / "incus-host-mount-sources.py")
SOURCES = importlib.util.module_from_spec(spec); spec.loader.exec_module(SOURCES)
UUID = re.compile(r"[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}")
NAME = re.compile(r"[A-Za-z0-9_.-]{1,63}")
MARKER = "user.agentor.installation"
ZABBLY_FINGERPRINT = "4EFC590696CB15B87C73A3AD82CC8797C838DCFD"
ZABBLY_URL = "https://pkgs.zabbly.com/incus/lts-6.0"
EMPTY_SHARE_ROOT = Path("/var/lib/agentor-incus")


class SetupFailure(ValueError):
    pass


def require(value, message):
    if not value: raise SetupFailure(message)


def command(*argv, data=None):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)
    require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024,
            Path(argv[0]).name + " failed; inspect operator diagnostics without printing credentials")
    return result.stdout


def incus(*argv):
    return command("incus", "--force-local", "--project", "default", *argv)


def native(path):
    return json.loads(incus("query", path))


def owned(record, installation, name):
    require(record.get("name") == name and record.get("config", {}).get(MARKER) == installation,
            "Existing resource is foreign/ambiguous; preserve it and choose a dedicated name")


def resource(path, name):
    records = native(path + "?recursion=1")
    require(isinstance(records, list), "Native inventory is unavailable")
    matches = [record for record in records if record.get("name") == name]
    require(len(matches) <= 1, "Native resource identity is ambiguous")
    return matches[0] if matches else None


def private_directory(path):
    # Fixed operator namespaces only. Walk with no-follow before each mkdir.
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        info = os.fstat(fd)
        require(info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Operator directory must be owned, private and real")
    finally: os.close(fd)


def write_file(path, body, mode=0o600, replace=False):
    if isinstance(body, str): body = body.encode()
    try:
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o022,
                "Existing operator file is not owned/regular/protected")
        if path.read_bytes() == body:
            require(stat.S_IMODE(info.st_mode) == mode, "Existing operator file permissions disagree"); return
        require(replace, "Existing operator file differs; preserve and resolve it manually")
    except FileNotFoundError: pass
    fd = os.open(path.with_name(path.name + ".new"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)  # Public certificates/unit files stay readable despite the private process umask.
        with os.fdopen(fd, "wb", closefd=False) as output: output.write(body); output.flush(); os.fsync(fd)
    finally: os.close(fd)
    os.replace(path.with_name(path.name + ".new"), path)


def namespace(path, installation):
    if path.exists():
        info = path.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid() and not info.st_mode & 0o077, "Operator namespace is not owned/private/real")
        if list(path.iterdir()):
            owner = (path / "owner").lstat()
            require(stat.S_ISREG(owner.st_mode) and owner.st_uid == os.geteuid() and stat.S_IMODE(owner.st_mode) == 0o600
                    and owner.st_size <= 128 and (path / "owner").read_text().strip() == installation, "Existing namespace is foreign; preserve it")
    private_directory(path); write_file(path / "owner", installation + "\n")


def docker_context(container_name, network_name, data_dir):
    require(NAME.fullmatch(container_name), "Explicit Orchestrator container name required")
    container = json.loads(command("docker", "inspect", container_name))[0]
    mounts = [mount for mount in container.get("Mounts", []) if mount.get("Destination") == "/data"]
    require(len(mounts) == 1 and mounts[0].get("RW") is True and mounts[0].get("Type") in ("bind", "volume"), "Exact writable Orchestrator /data mount required")
    observed_data = SOURCES.canonical(mounts[0]["Source"])
    require(not data_dir or SOURCES.canonical(data_dir) == observed_data, "Explicit DATA path differs from the actual /data mount")
    SOURCES.directory_identity(observed_data)
    names = list(container["NetworkSettings"]["Networks"])
    require(network_name in names if network_name else len(names) == 1, "Choose the exact existing Orchestrator Docker network")
    name = network_name or names[0]; require(NAME.fullmatch(name), "Invalid Docker network name")
    network = json.loads(command("docker", "network", "inspect", name))[0]
    require(network.get("Driver") == "bridge" and not network.get("Internal"), "Existing routed Docker bridge required")
    ipv4 = [entry for entry in network["IPAM"]["Config"] if ":" not in entry.get("Subnet", ":")]
    require(len(ipv4) == 1, "Docker IPv4 topology is ambiguous")
    subnet = ipaddress.IPv4Network(ipv4[0]["Subnet"]); gateway = ipaddress.IPv4Address(ipv4[0]["Gateway"])
    bridge = network.get("Options", {}).get("com.docker.network.bridge.name") or "br-" + network["Id"][:12]
    require(re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", bridge), "Docker bridge interface is invalid")
    address = ipaddress.IPv4Address(container["NetworkSettings"]["Networks"][name]["IPAddress"])
    require(address in subnet and gateway in subnet, "Docker address/gateway differs from its subnet")
    return observed_data, name, bridge, subnet, str(gateway), str(address)


def installation_id(data_dir):
    SOURCES.directory_identity(data_dir)
    try: fd = os.open(Path(data_dir) / "backup-installation-id", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError: raise SetupFailure("Canonical installation ID is unavailable; create a current-instance backup first") from None
    try:
        info = os.fstat(fd); require(stat.S_ISREG(info.st_mode) and info.st_size <= 128, "Canonical installation ID is unavailable; create a current-instance backup first")
        value = os.read(fd, 129).decode().strip(); require(UUID.fullmatch(value), "Canonical installation ID is invalid; create a current-instance backup first")
        return value
    finally: os.close(fd)


def initial_account_paths(data_dir):
    users = Path(data_dir) / "users"; paths = []
    if not users.exists(): return paths
    SOURCES.directory_identity(str(users))
    for user in users.iterdir():
        require(re.fullmatch(r"[A-Za-z0-9_-]{1,128}", user.name), "Canonical account directory identity is invalid")
        for relative in ("credentials", "kilo/config", "kilo/data"):
            candidate = user / relative
            if os.path.lexists(candidate): SOURCES.directory_identity(str(candidate)); paths.append(str(candidate))
    return sorted(paths)


def initial_share_paths(data_dir, installation):
    require(UUID.fullmatch(installation), "Owned empty-share installation identity is invalid")
    dummy = EMPTY_SHARE_ROOT / installation / "empty-share"
    namespace(dummy, installation)
    return sorted([str(dummy), *initial_account_paths(data_dir)])


def verify_package_key(shown):
    records = [line.split(":") for line in shown.splitlines() if line]
    primary = [index for index, row in enumerate(records) if row[0] == "pub"]
    subkeys = [index for index, row in enumerate(records) if row[0] == "sub"]
    require(len(records) <= 256 and len(primary) == 1 and len(subkeys) <= 16 and not any(row[0] in ("sec", "ssb") for row in records),
            "Official package signing-key fingerprint changed or bundle has additional primary keys; manual trust review required")
    for index in [*primary, *subkeys]:
        require(index + 1 < len(records) and len(records[index + 1]) > 9 and records[index + 1][0] == "fpr"
                and re.fullmatch(r"[A-F0-9]{40,64}", records[index + 1][9]), "Package public key fingerprint record is malformed")
    require(records[primary[0] + 1][9] == ZABBLY_FINGERPRINT, "Official package signing-key fingerprint changed; manual trust review required")


def install_packages(opt_in_lts, work):
    required = ["ca-certificates", "curl", "gnupg", "openssl", "python3", "qemu-system-x86", "qemu-utils", "virtiofsd", "iptables", "nftables", "kmod"]
    missing = []
    for package in required:
        result = subprocess.run(["dpkg-query", "-W", "-f=${db:Status-Abbrev}", package], capture_output=True)
        if result.returncode or result.stdout != b"ii ": missing.append(package)
    if missing:
        command("apt-get", "update"); command("apt-get", "install", "-y", "--no-remove", "--no-install-recommends", *missing)
    if shutil.which("incus"): command("systemctl", "start", "incus")
    version = native("/1.0")["environment"]["server_version"] if shutil.which("incus") else ""
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", version)
    adequate = match and (int(match[1]) > 6 or int(match[1]) == 6 and (int(match[2]) >= 10 or int(match[2]) == 0 and int(match[3] or 0) >= 6))
    if adequate: return
    require(opt_in_lts, "Incus >=6.0.6 LTS/>=6.10 required. Rerun --install-lts to explicitly enable the signed Zabbly 6.0 LTS source")
    with urlopen("https://pkgs.zabbly.com/key.asc", timeout=15) as response:
        require(response.url.startswith("https://pkgs.zabbly.com/"), "Public package key redirected away from its official HTTPS origin")
        key = response.read(65537); require(len(key) <= 65536, "Public package key exceeded its bound")
    with tempfile.TemporaryDirectory(prefix="public-key-", dir=work) as temporary:
        shown = command("gpg", "--batch", "--no-options", "--homedir", temporary, "--show-keys", "--with-colons", data=key).decode()
        verify_package_key(shown)
    keyrings = Path("/etc/apt/keyrings")
    if not keyrings.exists(): keyrings.mkdir(mode=0o755); keyrings.chmod(0o755)
    SOURCES.directory_identity(str(keyrings))
    write_file(Path("/etc/apt/keyrings/agentor-zabbly.asc"), key, 0o644)
    write_file(Path("/etc/apt/sources.list.d/agentor-incus-lts.sources"), "Types: deb\nURIs: " + ZABBLY_URL + "\nSuites: noble\nComponents: main\nArchitectures: amd64\nSigned-By: /etc/apt/keyrings/agentor-zabbly.asc\n", 0o644)
    command("apt-get", "update"); command("apt-get", "install", "-y", "--no-remove", "--no-install-recommends", "incus", "incus-client")
    command("systemctl", "enable", "--now", "incus")
    version = native("/1.0")["environment"]["server_version"]
    match = re.match(r"^(\d+)\.(\d+)(?:\.(\d+))?", version)
    require(match and (int(match[1]) > 6 or int(match[1]) == 6 and (int(match[2]) >= 10 or int(match[2]) == 0 and int(match[3] or 0) >= 6)),
            "Installed Incus daemon still lacks the required fixed version; resolve package/service state before creating resources")


def resource_setup(config, paths):
    installation, project, network, pool = (config[field] for field in ("installation", "project", "network", "pool"))
    existing = resource("/1.0/storage-pools", pool)
    if existing is None: incus("storage", "create", pool, "dir", MARKER + "=" + installation)
    existing = resource("/1.0/storage-pools", pool); owned(existing, installation, pool)
    require(existing.get("driver") == "dir" and existing.get("status") == "Created", "Owned storage pool differs or is unavailable; preserve it")
    existing = resource("/1.0/networks", network)
    if existing is None: incus("network", "create", network, "--type=bridge", "ipv4.address=auto", "ipv4.nat=true", "ipv6.address=none", MARKER + "=" + installation)
    existing = resource("/1.0/networks", network); owned(existing, installation, network)
    require(existing.get("managed") is True and existing.get("type") == "bridge" and existing["config"].get("ipv4.nat") == "true"
            and existing["config"].get("ipv6.address") == "none" and existing["config"].get("ipv4.dhcp", "true") == "true", "Owned primary bridge differs; preserve it")
    interface = ipaddress.IPv4Interface(existing["config"]["ipv4.address"])
    require(interface.ip.is_private and not interface.ip.is_unspecified, "Managed primary gateway must be private and concrete")
    config["internalUrl"] = "http://" + str(interface.ip) + ":" + str(config["internalPort"])
    desired = {MARKER: installation, "features.images": "true", "features.storage.volumes": "true", "features.networks": "false",
               "restricted": "true", "restricted.devices.nic": "managed", "restricted.devices.disk": "allow",
               **{"restricted.devices." + device: "block" for device in ("pci", "usb", "gpu", "infiniband", "proxy", "unix-char", "unix-block")}}
    existing = resource("/1.0/projects", project)
    if existing is None:
        settings = {**desired, "restricted.networks.access": network, "restricted.devices.disk.paths": ",".join(paths)}
        incus("project", "create", project, *[argument for key, value in settings.items() for argument in ("-c", key + "=" + value)])
    existing = resource("/1.0/projects", project); owned(existing, installation, project)
    require(all(existing["config"].get(key, "block" if key.startswith("restricted.devices.") and key not in ("restricted.devices.nic", "restricted.devices.disk") else None) == value
                for key, value in desired.items()), "Owned project restrictions differ; preserve and resolve manually")
    require(network in existing["config"].get("restricted.networks.access", "").split(","), "Owned project's primary allowlist differs")
    old = [SOURCES.canonical(path) for path in existing["config"].get("restricted.devices.disk.paths", "").split(",") if path]
    roots = json.loads(existing["config"].get("user.agentor.host-mount-roots", '{"installation":"' + installation + '","sources":[]}'))
    require(roots.get("installation") == installation and isinstance(roots.get("sources"), list), "Owned export policy identity is ambiguous")
    require(set(old) <= set(paths) | set(roots["sources"]), "Unexpected project host exports; preserve and inspect their authority")
    updated = sorted(set(old) | set(paths))
    if updated != sorted(old): incus("project", "set", project, "restricted.devices.disk.paths=" + ",".join(updated))
    return interface


def bridge_netfilter(installation):
    require(UUID.fullmatch(installation), "Bridge-netfilter installation identity is invalid")
    command("modprobe", "br_netfilter")
    require(Path("/sys/module/br_netfilter").is_dir(), "br_netfilter is unavailable; install matching host kernel modules before enabling NIC filtering")
    prefix = "agentor-incus-" + installation.replace("-", "")[:8]
    header = "# Agentor installation " + installation + "\n"
    write_file(Path("/etc/modules-load.d") / ("90-" + prefix + ".conf"), header + "br_netfilter\n", 0o644)
    sysctl = Path("/etc/sysctl.d") / ("90-" + prefix + ".conf")
    body = header + "net.ipv4.ip_forward=1\nnet.bridge.bridge-nf-call-iptables=1\nnet.bridge.bridge-nf-call-ip6tables=1\n"
    if sysctl.exists():
        require(sysctl.read_text() in (header + "net.ipv4.ip_forward=1\n", body), "Existing sysctl file has unrelated configuration; preserve and reconcile it manually")
    write_file(sysctl, body, 0o644, True)
    for protocol in ("iptables", "ip6tables"):
        command("sysctl", "-w", "net.bridge.bridge-nf-call-" + protocol + "=1")
        require(Path("/proc/sys/net/bridge/bridge-nf-call-" + protocol).read_text().strip() == "1", "Required bridge netfilter sysctl is unavailable")


def certificates(config, directory, gateway):
    server = native("/1.0"); public = server["environment"]["certificate"]
    write_file(directory / "server.crt", public, 0o644)
    ssl.match_hostname(ssl._ssl._test_decode_cert(str(directory / "server.crt")), config["tlsName"])
    listener = gateway + ":" + str(config["httpsPort"])
    current = server.get("config", {}).get("core.https_address", "")
    require(not current or current == listener, "Existing Incus HTTPS listener differs; preserve unrelated configuration and resolve manually")
    if not current: incus("config", "set", "core.https_address", listener)
    for purpose in ("client", "policy"):
        key, cert = directory / (purpose + ".key"), directory / (purpose + ".crt")
        require(key.exists() == cert.exists(), "Partial certificate creation is ambiguous; inspect exact owned files manually")
        if not key.exists():
            argv = ["openssl", "req", "-x509", "-newkey", "ed25519", "-nodes", "-days", "3650", "-subj", "/CN=Agentor-" + purpose + "-" + config["installation"], "-keyout", str(key), "-out", str(cert)]
            if purpose == "policy": argv += ["-addext", "subjectAltName=DNS:" + config["tlsName"] + ",IP:" + gateway]
            command(*argv); key.chmod(0o600); cert.chmod(0o644)
        for path, mode in ((key, 0o600), (cert, 0o644)):
            info = path.lstat(); require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == mode, "Owned certificate files are unsafe")
        ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT).load_cert_chain(str(cert), str(key))
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert((directory / "client.crt").read_text())).hexdigest()
    records = native("/1.0/certificates?recursion=1"); matches = [record for record in records if record.get("fingerprint") == fingerprint]
    if not matches:
        incus("config", "trust", "add", str(directory / "client.crt"), "--name=agentor-" + config["installation"], "--restricted", "--projects=" + config["project"])
        records = native("/1.0/certificates?recursion=1"); matches = [record for record in records if record.get("fingerprint") == fingerprint]
    require(len(matches) == 1 and matches[0].get("restricted") is True and matches[0].get("projects") == [config["project"]]
            and matches[0].get("type") == "client", "Client certificate is not restricted to exactly the owned project")


def route_rules(network, bridge, docker_subnet, primary, address, uplink, marker):
    comment = ["-m", "comment", "--comment", marker]
    return [
        ["-i", bridge, "-o", network, "-s", str(docker_subnet), "-d", str(primary), *comment, "-j", "ACCEPT"],
        ["-i", network, "-o", bridge, "-s", str(primary), "-d", str(docker_subnet), "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", *comment, "-j", "ACCEPT"],
        ["-i", network, "-o", bridge, "-s", str(primary), "-d", address, "-p", "tcp", "--dport", "3000", *comment, "-j", "ACCEPT"],
        ["-i", network, "-o", uplink, "-s", str(primary), *comment, "-j", "ACCEPT"],
        ["-i", uplink, "-o", network, "-d", str(primary), "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", *comment, "-j", "ACCEPT"],
        [*comment, "-j", "RETURN"],
    ]


def routing(config):
    require(installation_id(config["dataDir"]) == config["installation"], "Installation identity changed; preserve routing and reconfigure explicitly")
    _, _, bridge, docker_subnet, _, address = docker_context(config["container"], config["dockerNetwork"], config["dataDir"])
    network = native("/1.0/networks/" + quote(config["network"])); owned(network, config["installation"], config["network"])
    primary = ipaddress.IPv4Interface(network["config"]["ipv4.address"]).network
    routes = json.loads(command("ip", "-j", "-4", "route", "show", "default")); uplinks = {route["dev"] for route in routes}
    require(len(uplinks) == 1, "Default uplink is ambiguous; preserve routing and resolve manually")
    uplink = uplinks.pop(); require(re.fullmatch(r"[A-Za-z0-9_.-]{1,15}", uplink), "Invalid uplink")
    chain = "AGINCUS_" + config["installation"].replace("-", "")[:8]; marker = "agentor-forward-" + config["installation"]
    rules = command("iptables", "-w", "-S").decode().splitlines()
    require("-N DOCKER-USER" in rules, "Docker's supported forwarding chain is unavailable; do not install blanket ACCEPT rules")
    if "-N " + chain in rules:
        own_rules = [shlex.split(rule) for rule in rules if rule.startswith("-A " + chain + " ")]
        require(own_rules and all("--comment" in rule and rule[rule.index("--comment") + 1] == marker for rule in own_rules), "Existing forwarding chain is foreign/ambiguous; preserve it")
    else: command("iptables", "-w", "-N", chain)
    prepared = route_rules(config["network"], bridge, docker_subnet, primary, address, uplink, marker)
    batch = "*filter\n-F " + chain + "\n" + "".join("-A " + chain + " " + shlex.join(rule) + "\n" for rule in prepared) + "COMMIT\n"
    command("iptables-restore", "--wait", "--noflush", data=batch.encode())
    jump = ["-m", "comment", "--comment", marker, "-j", chain]
    if not any(shlex.split(rule) == ["-A", "DOCKER-USER", *jump] for rule in rules):
        command("iptables", "-w", "-I", "DOCKER-USER", "1", *jump)
    table = config["sourceTable"]; tables = json.loads(command("nft", "-j", "list", "tables"))["nftables"]
    present = any(entry.get("table", {}).get("family") == "ip" and entry["table"].get("name") == table for entry in tables)
    if present:
        entries = json.loads(command("nft", "-j", "list", "table", "ip", table))["nftables"]
        require(all(entry["rule"].get("comment") == "agentor-source-" + config["installation"] for entry in entries if "rule" in entry)
                and len([entry for entry in entries if "rule" in entry]) == 1
                and len([entry for entry in entries if "chain" in entry]) == 1
                and all(entry["chain"].get("name") == "postrouting" and entry["chain"].get("hook") == "postrouting" and entry["chain"].get("type") == "nat"
                        and entry["chain"].get("prio") == 99 for entry in entries if "chain" in entry), "Existing source-NAT table is foreign/ambiguous; preserve it")
    definition = ("delete table ip " + table + "\n" if present else "") + "table ip " + table + " { chain postrouting { type nat hook postrouting priority 99; policy accept; "
    definition += "iifname " + json.dumps(config["network"]) + " oifname " + json.dumps(bridge) + " ip saddr " + str(primary) + " ip daddr " + address
    definition += " tcp dport 3000 counter snat to ip saddr comment " + json.dumps("agentor-source-" + config["installation"]) + ";\n }\n}\n"
    command("nft", "--check", "-f", "-", data=definition.encode()); command("nft", "-f", "-", data=definition.encode())
    command("sysctl", "-w", "net.ipv4.ip_forward=1")


def unit_argument(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$") + '"'


def install_units(config, directory, library):
    short = config["installation"].replace("-", "")[:8]; prefix = "agentor-incus-" + short
    scripts = ("setup-incus-host.sh", "check-incus-host.sh", "agentor-incus-network-service.py", "incus-managed-network-policy.py", "incus-host-mount-policy.py", "incus-host-mount-sources.py")
    namespace(library, config["installation"])
    for script in scripts: write_file(library / script, (ROOT / script).read_bytes(), 0o700 if script.endswith(".sh") else 0o600, True)
    policy = ["/usr/bin/python3", str(library / "agentor-incus-network-service.py"), "--data-dir", config["dataDir"], "--installation", config["installation"],
              "--project", config["project"], "--primary", config["network"], "--bind", config["listen"], "--port", str(config["policyPort"]),
              "--server-cert", str(directory / "policy.crt"), "--server-key", str(directory / "policy.key"), "--client-cert", str(directory / "client.crt"), "--host-mounts"]
    route = [str(library / "setup-incus-host.sh"), "--routing", "--config", str(directory / "config.json")]
    header = "# Agentor installation " + config["installation"] + "\n"
    units = {
        prefix + "-policy.service": header + "[Unit]\nAfter=network-online.target incus.service docker.service\n[Service]\nType=simple\nUser=root\nExecStart=" + " ".join(map(unit_argument, policy))
            + "\nRestart=on-failure\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\n[Install]\nWantedBy=multi-user.target\n",
        prefix + "-routing.service": header + "[Unit]\nAfter=docker.service incus.service\n[Service]\nType=oneshot\nExecStart=" + " ".join(map(unit_argument, route)) + "\n",
        prefix + "-routing.timer": header + "[Unit]\nAfter=docker.service incus.service\n[Timer]\nOnBootSec=15s\nOnUnitActiveSec=30s\nUnit=" + prefix + "-routing.service\n[Install]\nWantedBy=timers.target\n",
    }
    for name, body in units.items():
        path = Path("/etc/systemd/system") / name
        if path.exists(): require(path.read_text().startswith(header), "Existing systemd unit is foreign; preserve it")
        write_file(path, body, 0o644, True)
    command("systemctl", "daemon-reload"); command("systemctl", "enable", "--now", prefix + "-policy.service", prefix + "-routing.timer")
    command("systemctl", "restart", prefix + "-policy.service")


def main():
    parser = argparse.ArgumentParser(description="Operator-root Ubuntu24/amd64 Incus setup. Preserves canonical DATA/legacy workers; never migrates or resets unrelated resources.")
    parser.add_argument("--install-lts", action="store_true", help="Explicitly offer fingerprint-pinned signed Zabbly Incus 6.0 LTS packages")
    parser.add_argument("--routing", action="store_true", help="Installed systemd use only: refresh this installation's exact routing")
    parser.add_argument("--config", help="Installed root-owned /etc/agentor/incus/<installationUUID>/config.json")
    for argument, variable, default in (("orchestrator-container", "INCUS_ORCHESTRATOR_CONTAINER", "agentor-orchestrator"), ("docker-network", "INCUS_DOCKER_NETWORK", ""),
                                      ("data-host-path", "AGENTOR_DATA_HOST_PATH", ""), ("project", "INCUS_PROJECT", "agentor"), ("network", "INCUS_NETWORK", ""),
                                      ("storage-pool", "INCUS_STORAGE_POOL", ""), ("tls-name", "INCUS_TLS_NAME", socket.gethostname())):
        parser.add_argument("--" + argument, default=os.environ.get(variable, default), help=variable)
    for argument, default in (("https-port", 8443), ("policy-port", 8444), ("internal-port", 3079)): parser.add_argument("--" + argument, type=int, default=default)
    args = parser.parse_args(); require(os.geteuid() == 0, "Run this operator installer with sudo")
    os.umask(0o077)
    if args.routing:
        require(args.config and re.fullmatch(r"/etc/agentor/incus/[a-f0-9-]{36}/config.json", args.config), "Routing requires its exact installed operator config")
        path = Path(args.config); SOURCES.directory_identity(str(path.parent))
        info = path.lstat(); require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size <= 16384, "Routing config is not private/owned/regular")
        config = json.loads(path.read_text()); require(UUID.fullmatch(config["installation"]) and path.parent.name == config["installation"], "Routing installation identity differs")
        require(config["sourceTable"] == "agentor_source_" + config["installation"].replace("-", "")[:8]
                and re.fullmatch(r"[A-Za-z0-9_-]{1,15}", config["network"]), "Installed routing namespace is invalid")
        routing(config); print("Owned routing refreshed; no worker/data changes."); return
    require(not args.config, "--config is only for the installed bounded --routing mode")
    release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    require(release.get("ID", "").strip('"') == "ubuntu" and release.get("VERSION_ID", "").strip('"') == "24.04" and os.uname().machine == "x86_64", "Supported Ubuntu24 amd64 host required")
    require(stat.S_ISCHR(os.stat("/dev/kvm").st_mode), "KVM is unavailable; enable host virtualization before setup")
    data, docker_network, _, _, gateway, _ = docker_context(args.orchestrator_container, args.docker_network, args.data_host_path)
    installation = installation_id(data); short = installation.replace("-", "")[:8]
    network, pool = args.network or "ag" + short, args.storage_pool or "ag" + short
    require(re.fullmatch(r"[A-Za-z0-9_-]{1,63}", args.project) and args.project != "default" and re.fullmatch(r"[A-Za-z0-9_-]{1,15}", network)
            and re.fullmatch(r"[A-Za-z0-9_-]{1,63}", pool), "Dedicated safe project/network/pool names required")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,252}", args.tls_name) and all(1 <= port <= 65535 for port in (args.https_port, args.policy_port, args.internal_port)), "Explicit certificate hostname and valid ports required")
    directory = Path("/etc/agentor/incus") / installation; namespace(directory, installation)
    config = {"installation": installation, "dataDir": data, "project": args.project, "network": network, "pool": pool, "container": args.orchestrator_container,
              "dockerNetwork": docker_network, "tlsName": args.tls_name, "httpsPort": args.https_port, "policyPort": args.policy_port, "internalPort": args.internal_port,
              "listen": gateway, "sourceTable": "agentor_source_" + short}
    if (directory / "config.json").exists():
        prior = json.loads((directory / "config.json").read_text()); require(all(prior.get(key) == value for key, value in config.items()), "Installed operator configuration differs; preserve and reconcile manually")
    install_packages(args.install_lts, directory)
    bridge_netfilter(installation)
    paths = initial_share_paths(data, installation)
    interface = resource_setup(config, paths); certificates(config, directory, gateway)
    write_file(directory / "config.json", json.dumps(config, sort_keys=True) + "\n")
    library = Path("/usr/local/lib/agentor-incus") / installation
    install_units(config, directory, library); routing(config)
    policy = json.loads(command("curl", "--fail", "--silent", "--show-error", "--max-time", "15", "--noproxy", "*", "--resolve", args.tls_name + ":" + str(args.policy_port) + ":" + gateway,
                    "--cert", str(directory / "client.crt"), "--key", str(directory / "client.key"), "--cacert", str(directory / "policy.crt"),
                    "https://" + args.tls_name + ":" + str(args.policy_port) + "/v1/managed-networks/readiness?project=" + quote(args.project)))
    require(policy.get("metadata") == {"ready": True, "installation": installation, "project": args.project, "primary": network}, "Owned policy readiness is incomplete")
    print("Owned host setup installed; NOT a completed readiness/acceptance claim. Update Portainer, then run check-incus-host.sh and the real canary.")
    for key, value in {"INCUS_ENABLED": "true", "INCUS_ENDPOINT": "https://" + args.tls_name + ":" + str(args.https_port), "INCUS_PROJECT": args.project,
                       "INCUS_NETWORK": network, "INCUS_STORAGE_POOL": pool, "INCUS_CONVERTER_STORAGE_POOL": pool,
                       "INCUS_NETWORK_HOST_ENDPOINT": "https://" + args.tls_name + ":" + str(args.policy_port), "INCUS_INTERNAL_GATEWAY_URL": config["internalUrl"]}.items(): print(key + "=" + value)
    print("Read-only TLS file mounts (do NOT mount the whole credential directory or any Incus Unix socket):")
    for file, variable in (("client.crt", "INCUS_CLIENT_CERT_PATH"), ("client.key", "INCUS_CLIENT_KEY_PATH"), ("server.crt", "INCUS_SERVER_CERT_PATH"), ("policy.crt", "INCUS_NETWORK_HOST_SERVER_CERT_PATH")):
        print(str(directory / file) + ":/run/agentor-incus/" + file + ":ro; " + variable + "=/run/agentor-incus/" + file)
    print("extra_hosts: " + args.tls_name + ":" + gateway)
    print("Keep existing loopback GUI publication; ADD internal TCP publish: " + str(interface.ip) + ":" + str(args.internal_port) + ":3000")
    print("Checker host inputs: AGENTOR_INSTALLATION_ID=" + installation + "; INCUS_DOCKER_NETWORK=" + docker_network
          + "; INCUS_ORCHESTRATOR_CONTAINER=" + args.orchestrator_container + "; INCUS_SOURCE_NAT_TABLE=" + config["sourceTable"]
          + "; INCUS_HOST_CHECK_CONNECT_ADDRESS=" + gateway + ". Use HOST certificate file paths, not container paths, when running the checker.")
    print("Configure an operator-trusted converter seed fingerprint separately; no image is silently adopted.")
    print("PENDING rollout integration: existing policy service/runtime must ensure the three exact directories for newly created account/owned-worker identities; no DATA/users parent grant is installed.")


if __name__ == "__main__":
    try: main()
    except SetupFailure as error:
        print("Setup stopped safely: " + str(error), file=sys.stderr); sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ssl.CertificateError):
        print("Setup stopped safely: inspect the failing operator prerequisite/owned configuration; canonical DATA and unrelated resources were not reset.", file=sys.stderr)
        sys.exit(1)
PY
