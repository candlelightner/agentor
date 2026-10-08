#!/usr/bin/env bash
# Operator-root only. Never migrates workers or writes canonical Agentor DATA.
set -euo pipefail
exec python3 - "$0" "$@" <<'PY'
import argparse, hashlib, importlib.util, io, ipaddress, json, os, re, shlex, shutil, socket, ssl, stat, subprocess, sys, tarfile, tempfile
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
D2VM_URL = "https://github.com/linka-cloud/d2vm/releases/download/v0.4.0/d2vm_v0.4.0_linux_amd64.tar.gz"
D2VM_ARCHIVE_SHA = "9f2096bc7850367d063cbcf2da8ded6c5a23e70a9b0ecfdde150b2fbc9b8bd2f"
D2VM_BINARY_SHA = "12a749cb96cada5a00bed759c120364ed92d1f38de67b557bb85ac67abd96ed8"
VM_ASSETS = ["99-incus-agent.rules", "Dockerfile.vm", "agentor-dnsmasq.service", "agentor-docker-storage.service",
             "agentor-docker-storage.sh", "agentor-network.sh", "agentor-private-storage.sh", "agentor-worker.service", "incus-agent-setup", "incus-agent.service"]


class SetupFailure(ValueError):
    pass


def require(value, message):
    if not value: raise SetupFailure(message)


def command(*argv, data=None, timeout=300, env=None):
    result = subprocess.run(argv, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, env=env)
    if result.returncode and (b"No space left on device" in result.stderr or b"ENOSPC" in result.stderr):
        raise SetupFailure("Operator command reached ENOSPC; preserve incomplete bootstrap artifacts/record and settle manually before retrying")
    require(result.returncode == 0 and len(result.stdout) <= 4 * 1024 * 1024,
            Path(argv[0]).name + " failed; inspect operator diagnostics without printing credentials")
    return result.stdout


def incus(*argv):
    return command("incus", "--force-local", "--project", "default", *argv)


def native(path):
    # Raw query uses its explicit URL/project; Incus rejects --project here.
    return json.loads(command("incus", "--force-local", "query", path))


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
    required = ["ca-certificates", "curl", "gnupg", "openssl", "python3", "qemu-system-x86", "qemu-utils", "virtiofsd", "iptables", "nftables", "kmod",
                "gdisk", "parted", "kpartx", "cryptsetup", "grub-efi-amd64-bin", "dosfstools", "e2fsprogs", "util-linux", "coreutils"]
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
    hostname = command("openssl", "x509", "-in", str(directory / "server.crt"), "-noout", "-checkhost", config["tlsName"]).decode().strip()
    require(hostname == "Hostname " + config["tlsName"] + " does match certificate", "Existing Incus certificate does not match the configured TLS hostname; preserve it and choose its verified hostname")
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
        incus("config", "trust", "add-certificate", str(directory / "client.crt"), "--name=agentor-" + config["installation"], "--restricted", "--projects=" + config["project"])
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


def configured_default_source(container, explicit=""):
    # Operator configuration only; never a WorkerRecord/catalog/bundle choice.
    observed = json.loads(command("docker", "inspect", container))[0]
    values = dict(entry.split("=", 1) for entry in observed.get("Config", {}).get("Env", []) if "=" in entry)
    reference = values.get("WORKER_IMAGE_PREFIX", "") + values.get("WORKER_IMAGE", "agentor-worker:latest")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9./:@_+-]{0,254}", reference) and (not explicit or explicit == reference),
            "Trusted default must match the current operator-configured default, never a catalog/user OCI image")
    try: image = json.loads(command("docker", "image", "inspect", reference))[0]
    except SetupFailure: raise SetupFailure("Configured trusted default OCI is missing locally; build/pull the operator-authored default image before rerunning setup") from None
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", image.get("Id", "")) and image.get("Architecture") == "amd64"
            and type(image.get("Size")) is int and 0 < image["Size"] <= 2**53 - 1, "Trusted default needs an immutable amd64 image and valid size")
    return reference, image["Id"], image["Size"]


def default_recipe(source):
    root = ROOT.parent
    for relative in ("scripts", "worker", "worker/vm"):
        info = (root / relative).lstat(); require(stat.S_ISDIR(info.st_mode), "Run bootstrap from the real trusted repository directories")
    require(sorted(path.name for path in (root / "worker/vm").iterdir()) == sorted(VM_ASSETS), "Canonical VM bootstrap asset set differs")
    names = ["scripts/build-incus-worker-image.sh", "worker/entrypoint.sh", *["worker/vm/" + name for name in sorted(VM_ASSETS)]]
    lines = [source, "amd64", "3", "v0.4.0", "10G"]
    for name in names:
        fd = os.open(root / name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd); require(stat.S_ISREG(info.st_mode) and info.st_size <= 1024**2, "Canonical bootstrap needs bounded regular assets")
            body = os.read(fd, 1024**2 + 1); require(len(body) == info.st_size, "Canonical bootstrap changed during inspection")
        finally: os.close(fd)
        lines.append(hashlib.sha256(body).hexdigest() + "  " + name)
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def pinned_d2vm(directory):
    tools = directory / "converter-tools"; namespace(tools, directory.name)
    binary = tools / "d2vm"
    if not binary.exists():
        with urlopen(D2VM_URL, timeout=30) as response:
            require(response.url.startswith("https://"), "Pinned converter download must remain HTTPS")
            archive = response.read(64 * 1024**2 + 1)
        require(len(archive) <= 64 * 1024**2 and hashlib.sha256(archive).hexdigest() == D2VM_ARCHIVE_SHA, "Pinned converter archive hash changed")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as packed:
            entries = [entry for entry in packed.getmembers() if entry.name == "d2vm"]
            require(len(entries) == 1 and entries[0].isfile() and entries[0].size <= 64 * 1024**2, "Pinned converter executable is missing or ambiguous")
            body = packed.extractfile(entries[0]).read(64 * 1024**2 + 1)
        require(hashlib.sha256(body).hexdigest() == D2VM_BINARY_SHA, "Pinned converter executable hash changed")
        write_file(binary, body, 0o700)
    info = binary.lstat(); require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o700
                                   and info.st_size <= 64 * 1024**2 and hashlib.sha256(binary.read_bytes()).hexdigest() == D2VM_BINARY_SHA, "Pinned converter executable is unsafe or changed")
    require(command(str(binary), "--version").decode().strip() == "d2vm version v0.4.0", "Pinned converter version changed")
    return tools


def bootstrap_default_image(config, directory, explicit=""):
    reference, source, size = configured_default_source(config["container"], explicit)
    recipe = default_recipe(source); alias = "agentor-" + config["installation"].replace("-", "")[:8] + "-" + recipe[:16]
    context = {"sourceImageId": source, "recipeId": recipe, "alias": alias, "architecture": "amd64", "bootstrapGeneration": "3", "converterVersion": "v0.4.0"}
    query = "?project=" + quote(config["project"])
    def image_proof(fingerprint):
        require(isinstance(fingerprint, str) and re.fullmatch(r"[a-f0-9]{64}", fingerprint), "Import fingerprint acknowledgement is missing or ambiguous")
        image = native("/1.0/images/" + fingerprint + query)
        require(image.get("fingerprint") == fingerprint and image.get("type") == "virtual-machine" and image.get("architecture") in ("x86_64", "amd64"), "Acknowledged default image is not the expected VM")
        props = image.get("properties", {})
        require(all(props.get(key) == value for key, value in {"source_image_id": source, "recipe_id": recipe, "source_architecture": "amd64",
                    "bootstrap_generation": "3", "converter_version": "v0.4.0"}.items()), "Acknowledged default image immutable metadata differs")
    prior = config.get("defaultImage")
    aliases = native("/1.0/images/aliases" + query + "&recursion=1")
    require(isinstance(aliases, list) and all(isinstance(item, dict) for item in aliases), "Default alias inventory is unavailable")
    matches = [item for item in aliases if item.get("name") == alias]
    if "defaultImage" in config:
        require(isinstance(prior, dict) and all(prior.get(key) == value for key, value in context.items()), "Recorded default source/bootstrap differs; preserve it for explicit operator review")
        require(prior.get("phase") == "ready", "Default bootstrap has an uncertain/incomplete dispatch; preserve artifacts and settle manually, never replay")
        image_proof(prior.get("fingerprint", ""))
        require(len(matches) == 1 and matches[0].get("target") == prior["fingerprint"] and matches[0].get("type") == "virtual-machine", "Recorded owned default alias changed or disappeared")
        require(configured_default_source(config["container"], reference)[1] == source and default_recipe(source) == recipe, "Trusted default source/bootstrap changed before reuse")
        return prior
    require(not matches, "Default alias collides with an unrecorded image; no adoption or replacement is permitted")
    work = Path(config["imageWorkDir"]); namespace(work, config["installation"])
    required = max(32 * 1024**3, 3 * size + 24 * 1024**3)
    require(shutil.disk_usage(work).free >= required, "Insufficient trusted conversion scratch space; provide an owned --image-work-dir with at least " + str(required // 1024**3 + 1) + " GiB free")
    for tool in ("docker", "sgdisk", "qemu-img", "parted", "kpartx", "cryptsetup", "losetup", "mount", "umount", "grub-install", "mkfs.ext4", "mkfs.fat", "flock"):
        require(shutil.which(tool), "Trusted default conversion prerequisite is missing: " + tool)
    tools = pinned_d2vm(directory); output = work / ("image-" + recipe)
    require(not os.path.lexists(output), "Unrecorded conversion scratch already exists; preserve it and review manually")
    namespace(output, config["installation"])
    def save(phase, **fields):
        config["defaultImage"] = {**context, "phase": phase, **fields}
        write_file(directory / "config.json", json.dumps(config, sort_keys=True) + "\n", replace=True)
    save("converting")
    env = {**os.environ, "PATH": str(tools) + ":" + os.environ.get("PATH", "/usr/sbin:/usr/bin:/sbin:/bin"), "LC_ALL": "C"}
    command("bash", str(ROOT / "build-incus-worker-image.sh"), "--source-image", source, "--expected-source-id", source,
            "--expected-recipe-id", recipe, "--size", "10G", "--no-import", "--output-dir", str(output), timeout=45 * 60, env=env)
    require(configured_default_source(config["container"], reference)[1] == source and default_recipe(source) == recipe, "Trusted default source/bootstrap changed during conversion")
    save("import-pending")
    result = command("incus", "--force-local", "--project", config["project"], "image", "import", str(output / "metadata.tar.gz"), str(output / "disk.qcow2"))
    fingerprints = re.findall(r"(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])", result.decode())
    require(len(fingerprints) == 1, "Import did not provide exactly one fingerprint acknowledgement; preserve artifacts/record, never replay")
    fingerprint = fingerprints[0]; image_proof(fingerprint); save("alias-pending", fingerprint=fingerprint)
    require(not any(item.get("name") == alias for item in native("/1.0/images/aliases" + query + "&recursion=1")), "Alias appeared before publication; do not replace it")
    command("incus", "--force-local", "--project", config["project"], "image", "alias", "create", alias, fingerprint)
    acknowledged = native("/1.0/images/aliases/" + quote(alias) + query)
    require(acknowledged.get("target") == fingerprint and acknowledged.get("type") == "virtual-machine", "Default alias acknowledgement changed; preserve exact pending authority")
    image_proof(fingerprint)
    require(configured_default_source(config["container"], reference)[1] == source and default_recipe(source) == recipe, "Trusted default source/bootstrap changed before publication")
    save("ready", fingerprint=fingerprint)
    return config["defaultImage"]


def portainer_environment(config, directory, interface, default_image):
    return {"INCUS_ENABLED": "true", "INCUS_ENDPOINT": "https://" + config["tlsName"] + ":" + str(config["httpsPort"]),
            "INCUS_PROJECT": config["project"], "INCUS_NETWORK": config["network"], "INCUS_STORAGE_POOL": config["pool"],
            "INCUS_CONVERTER_STORAGE_POOL": config["pool"], "INCUS_NETWORK_HOST_ENDPOINT": "https://" + config["tlsName"] + ":" + str(config["policyPort"]),
            "INCUS_INTERNAL_GATEWAY_URL": config["internalUrl"], "INCUS_WORKER_IMAGE": default_image["alias"],
            "INCUS_CONVERTER_SEED_FINGERPRINT": default_image["fingerprint"], "INCUS_TLS_NAME": config["tlsName"],
            "INCUS_API_HOST_ADDRESS": config["listen"], "INCUS_WORKER_GATEWAY": str(interface.ip), "INCUS_INTERNAL_PORT": str(config["internalPort"]),
            **{"INCUS_" + name + "_SOURCE": str(directory / file) for name, file in
               (("CLIENT_CERT", "client.crt"), ("CLIENT_KEY", "client.key"), ("SERVER_CERT", "server.crt"), ("POLICY_CERT", "policy.crt"))}}


def main():
    parser = argparse.ArgumentParser(description="Operator-root Ubuntu24/amd64 Incus setup. Preserves canonical DATA/legacy workers; never migrates or resets unrelated resources.")
    parser.add_argument("--install-lts", action="store_true", help="Explicitly offer fingerprint-pinned signed Zabbly Incus 6.0 LTS packages")
    parser.add_argument("--routing", action="store_true", help="Installed systemd use only: refresh this installation's exact routing")
    parser.add_argument("--config", help="Installed root-owned /etc/agentor/incus/<installationUUID>/config.json")
    parser.add_argument("--trusted-worker-image", default=os.environ.get("AGENTOR_TRUSTED_WORKER_IMAGE", ""),
                        help="Explicit matching current DEFAULT OCI reference. Running setup trusts that operator-authored default; NEVER choose user/catalog OCI for host-mounted conversion")
    parser.add_argument("--image-work-dir", default=os.environ.get("AGENTOR_INCUS_IMAGE_WORK_DIR", ""),
                        help="Optional absolute private operator-owned scratch outside canonical DATA; supports a large HDD without granting it to workers")
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
    prior = json.loads((directory / "config.json").read_text()) if (directory / "config.json").exists() else {}
    work = SOURCES.canonical(args.image_work_dir or prior.get("imageWorkDir") or str(directory / "image-work"))
    require(not SOURCES.overlaps(work, data), "Image conversion scratch must not modify canonical DATA or its ancestors")
    config = {"installation": installation, "dataDir": data, "project": args.project, "network": network, "pool": pool, "container": args.orchestrator_container,
              "dockerNetwork": docker_network, "tlsName": args.tls_name, "httpsPort": args.https_port, "policyPort": args.policy_port, "internalPort": args.internal_port,
              "listen": gateway, "sourceTable": "agentor_source_" + short, "imageWorkDir": work}
    if (directory / "config.json").exists():
        require(all(prior.get(key, value if key == "imageWorkDir" else None) == value for key, value in config.items()), "Installed operator configuration differs; preserve and reconcile manually")
        if "defaultImage" in prior: config["defaultImage"] = prior["defaultImage"]
    install_packages(args.install_lts, directory)
    bridge_netfilter(installation)
    paths = initial_share_paths(data, installation)
    interface = resource_setup(config, paths); certificates(config, directory, gateway)
    write_file(directory / "config.json", json.dumps(config, sort_keys=True) + "\n", replace=True)
    library = Path("/usr/local/lib/agentor-incus") / installation
    install_units(config, directory, library); routing(config)
    policy = json.loads(command("curl", "--fail", "--silent", "--show-error", "--max-time", "15", "--noproxy", "*", "--resolve", args.tls_name + ":" + str(args.policy_port) + ":" + gateway,
                    "--cert", str(directory / "client.crt"), "--key", str(directory / "client.key"), "--cacert", str(directory / "policy.crt"),
                    "https://" + args.tls_name + ":" + str(args.policy_port) + "/v1/managed-networks/readiness?project=" + quote(args.project)))
    require(policy.get("metadata") == {"ready": True, "installation": installation, "project": args.project, "primary": network}, "Owned policy readiness is incomplete")
    default_image = bootstrap_default_image(config, directory, args.trusted_worker_image)
    print("Owned host setup installed; NOT a completed readiness/acceptance claim. Update Portainer, then run check-incus-host.sh and the real canary.")
    for key, value in portainer_environment(config, directory, interface, default_image).items(): print(key + "=" + value)
    print("Set AGENTOR_INCUS_ORCHESTRATOR_IMAGE separately to the operator-approved updated control-plane image.")
    print("Read-only TLS file mounts (do NOT mount the whole credential directory or any Incus Unix socket):")
    for file, variable in (("client.crt", "INCUS_CLIENT_CERT_PATH"), ("client.key", "INCUS_CLIENT_KEY_PATH"), ("server.crt", "INCUS_SERVER_CERT_PATH"), ("policy.crt", "INCUS_NETWORK_HOST_SERVER_CERT_PATH")):
        print(str(directory / file) + ":/run/agentor-incus/" + file + ":ro; " + variable + "=/run/agentor-incus/" + file)
    print("extra_hosts: " + args.tls_name + ":" + gateway)
    print("Keep existing loopback GUI publication; ADD internal TCP publish: " + str(interface.ip) + ":" + str(args.internal_port) + ":3000")
    print("Checker host inputs: AGENTOR_INSTALLATION_ID=" + installation + "; INCUS_DOCKER_NETWORK=" + docker_network
          + "; INCUS_ORCHESTRATOR_CONTAINER=" + args.orchestrator_container + "; INCUS_SOURCE_NAT_TABLE=" + config["sourceTable"]
          + "; INCUS_HOST_CHECK_CONNECT_ADDRESS=" + gateway + ". Use HOST certificate file paths, not container paths, when running the checker.")
    print("Default worker alias and isolated-converter seed are the same acknowledged trusted VM image; custom/user OCI conversion remains isolated.")


if __name__ == "__main__":
    try: main()
    except SetupFailure as error:
        print("Setup stopped safely: " + str(error), file=sys.stderr); sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, ssl.CertificateError):
        print("Setup stopped safely: inspect the failing operator prerequisite/owned configuration; canonical DATA and unrelated resources were not reset.", file=sys.stderr)
        sys.exit(1)
PY
