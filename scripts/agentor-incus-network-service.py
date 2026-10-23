#!/usr/bin/env python3
"""Operator-installed mTLS service for owned bridge lifecycle/allowlisting only.

Unrestricted Incus Unix access and fixed firewall commands stay on the host.
No caller-selected commands, raw Incus proxy, project/path/config, or worker
provisioning API.
"""
import argparse
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, HTTPServer
import importlib.util
import ipaddress
import json
import logging
from pathlib import Path
import socket
import ssl
from urllib.parse import parse_qs, urlsplit

SPEC = importlib.util.spec_from_file_location("incus_network_policy", Path(__file__).with_name("incus-managed-network-policy.py"))
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class IncusRejected(Exception):
    def __init__(self, status):
        self.status_code = status


class TlsPolicyServer(HTTPServer):
    """Bound TLS handshakes and HTTP reads as well as native Incus requests.

    Wrap accepted sockets, not the listener: otherwise a stalled handshake
    blocks the serialized service before a request timeout can be applied.
    """
    def __init__(self, address, request_handler, context, request_timeout=10):
        self.context = context
        self.request_timeout = request_timeout
        super().__init__(address, request_handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(self.request_timeout)
        try:
            return self.context.wrap_socket(connection, server_side=True), address
        except Exception:
            connection.close()
            raise


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=30)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def incus_request(socket_path):
    def request(method, path, body=None, etag=None):
        connection = UnixConnection(socket_path)
        try:
            headers = {"Content-Type": "application/json"}
            if etag:
                headers["If-Match"] = etag
            connection.request(method, path, None if body is None else json.dumps(body).encode(), headers)
            response = connection.getresponse()
            content = response.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise POLICY.PolicyError("Incus response exceeded its bound")
            if response.status >= 400:
                raise IncusRejected(response.status)
            envelope = json.loads(content)
            if envelope.get("type") != "sync":
                raise POLICY.PolicyError("Bridge operation returned an uncertain result; reconcile exact owned state")
            return envelope.get("metadata"), response.getheader("ETag")
        finally:
            connection.close()
    return request


def docker_inventory(socket_path):
    def get(path):
        connection = UnixConnection(socket_path)
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            content = response.read(4 * 1024 * 1024 + 1)
            if response.status != 200 or len(content) > 4 * 1024 * 1024:
                raise POLICY.PolicyError("Legacy host export authority is unavailable")
            return json.loads(content)
        finally:
            connection.close()
    def inventory():
        # Three fixed reads only. Never accept an endpoint/method from HTTP.
        info = get("/info")
        volumes = get("/volumes")
        if not isinstance(info, dict) or not isinstance(volumes, dict):
            raise POLICY.PolicyError("Legacy host export authority is unavailable")
        return {"root": info.get("DockerRootDir"), "containers": get("/containers/json?all=1"),
                "volumes": volumes.get("Volumes")}
    return inventory


def docker_request(socket_path):
    def request(method, path, body=None):
        connection = UnixConnection(socket_path)
        try:
            # Before API 1.54, network connect silently ignored the requested endpoint MAC.
            connection.request(method, "/v1.54" + path, None if body is None else json.dumps(body).encode(),
                               {"Content-Type": "application/json"})
            response = connection.getresponse()
            content = response.read(4 * 1024 * 1024 + 1)
            if len(content) > 4 * 1024 * 1024:
                raise POLICY.PolicyError("Private network Docker response exceeded its bound")
            if response.status >= 400:
                raise IncusRejected(response.status)
            return json.loads(content) if content else None
        finally:
            connection.close()
    return request


def handler(policy, client_fingerprint, host_mounts=None, admin_networks=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AgentorNetwork/1"

        def log_message(self, *_args):
            pass  # Never log request body, certificate or platform-file values.

        def reply(self, status, metadata=None):
            body = json.dumps({"type": "sync" if status < 400 else "error", "status_code": status,
                               "metadata": metadata, "error": "Managed network host policy rejected the operation" if status >= 400 else "",
                               "error_code": status if status >= 400 else 0}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def validate(self):
            peer = self.connection.getpeercert(binary_form=True)
            if not peer or hashlib.sha256(peer).hexdigest() != client_fingerprint:
                raise POLICY.PolicyError("Client certificate does not match pinned platform identity")
            parsed = urlsplit(self.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            if query not in ({}, {"project": [policy.project]}):
                raise POLICY.PolicyError("Unexpected project or request query")
            return parsed.path

        def do_GET(self):
            try:
                if self.validate() != "/v1/managed-networks/readiness":
                    self.reply(404)
                    return
                # Identity and exact managed-NIC restrictions, not just liveness.
                if POLICY.read_bounded(policy.data_dir, ["backup-installation-id"], 128).strip() != policy.installation:
                    raise POLICY.PolicyError("Installation identity changed")
                policy.project_policy()
                self.reply(200, {"ready": True, "installation": policy.installation, "project": policy.project,
                                 "primary": policy.primary})
            except (OSError, ValueError, POLICY.PolicyError, IncusRejected):
                self.reply(409)

        def do_POST(self):
            try:
                path = self.validate()
                cleanup_request = path == "/v1/host-mounts/cleanup-worker"
                mount_request = cleanup_request or path in ("/v1/host-mounts/ensure", "/v1/host-mounts/inspect")
                account_request = path == "/v1/account-shares/ensure"
                admin_request = path in ("/v1/admin-networks/ensure", "/v1/admin-networks/inspect")
                if not mount_request and not account_request and not admin_request and path not in ("/v1/managed-networks/ensure", "/v1/managed-networks/remove", "/v1/managed-networks/inspect"):
                    self.reply(404)
                    return
                if ((mount_request or account_request) and host_mounts is None) or (admin_request and admin_networks is None):
                    self.reply(503)
                    return
                lengths = self.headers.get_all("Content-Length", [])
                length = lengths[0] if len(lengths) == 1 else ""
                if self.headers.get("Transfer-Encoding") or not length.isdecimal() or not 0 < int(length) <= 4096:
                    self.reply(400)
                    return
                payload = json.loads(self.rfile.read(int(length)))
                if admin_request:
                    result = admin_networks.inspect(payload) if path.endswith("/inspect") else admin_networks.ensure(payload)
                elif account_request:
                    result = host_mounts.ensure_account_shares(payload)
                elif mount_request:
                    if cleanup_request:
                        result = host_mounts.cleanup_worker_exports(payload)
                        logging.info("[host-export-cleanup] verified stopped worker exports; cleaned=%s; source data retained", result["cleaned"])
                    else:
                        result = host_mounts.inspect(payload) if path.endswith("/inspect") else host_mounts.ensure(payload)
                elif path.endswith("/inspect"):
                    result = policy.inspect(payload)
                else:
                    result = policy.ensure(payload) if path.endswith("/ensure") else policy.remove(payload)
                self.reply(200, result)
            except (OSError, ValueError, POLICY.PolicyError, IncusRejected) as error:
                if locals().get("cleanup_request"):
                    reason = str(error)[:512] if type(error).__name__ == "SourceRejected" else "Host authority could not be verified"
                    logging.warning("[host-export-cleanup] %s; cleanup unconfirmed, source data retained", reason)
                self.reply(409)
    return Handler


def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ["data-dir", "installation", "project", "primary", "bind", "server-cert", "server-key", "client-cert"]:
        parser.add_argument("--" + argument, required=True)
    parser.add_argument("--port", type=int, default=8444)
    parser.add_argument("--incus-socket", default="/var/lib/incus/unix.socket")
    parser.add_argument("--host-mounts", action="store_true", help="Enable catalog-ID-only host export policy")
    parser.add_argument("--docker-socket", default="/var/run/docker.sock")
    parser.add_argument("--admin-pool")
    parser.add_argument("--orchestrator-container")
    args = parser.parse_args()
    if ipaddress.ip_address(args.bind).is_unspecified:
        parser.error("Explicit narrow listener address required; wildcard binding is forbidden")
    client_pem = Path(args.client_cert).read_text()
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(client_pem)).hexdigest()
    policy = POLICY.ManagedNetworkPolicy(args.data_dir, args.installation, args.project, args.primary,
                                         incus_request(args.incus_socket))
    mounts = None
    if args.host_mounts:
        spec = importlib.util.spec_from_file_location("incus_host_mount_policy", Path(__file__).with_name("incus-host-mount-policy.py"))
        host_mounts = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(host_mounts)
        mounts = host_mounts.HostMountPolicy(args.data_dir, args.installation, args.project,
            str(Path(args.incus_socket).parent), [args.server_cert, args.server_key, args.client_cert],
            incus_request(args.incus_socket), docker_inventory(args.docker_socket))
    admin_networks = None
    if args.admin_pool or args.orchestrator_container:
        if not args.admin_pool or not args.orchestrator_container:
            parser.error("Admin networking requires both the pinned pool and orchestrator container")
        spec = importlib.util.spec_from_file_location("incus_admin_network_policy", Path(__file__).with_name("incus-admin-network-policy.py"))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        # Share the existing exception type with the redacted HTTP boundary.
        module.PolicyError = module.BASE.PolicyError = POLICY.PolicyError
        admin_networks = module.AdminNetworkPolicy(policy, args.admin_pool, args.orchestrator_container,
                                                   docker_request(args.docker_socket))
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.server_cert, args.server_key)
    context.load_verify_locations(cafile=args.client_cert)
    context.verify_mode = ssl.CERT_REQUIRED
    # HTTPServer serializes bridge/firewall/policy updates; If-Match additionally fences
    # unrelated operator changes. No thread pool, scheduler or global journal.
    server = TlsPolicyServer((args.bind, args.port), handler(policy, fingerprint, mounts, admin_networks), context)
    server.serve_forever()


if __name__ == "__main__":
    main()
