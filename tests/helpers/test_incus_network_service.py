"""Real TLS transport tests; no Incus host or platform credentials required."""
import hashlib
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import threading
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location(
    "agentor_network_service", Path(__file__).resolve().parents[2] / "scripts/agentor-incus-network-service.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="agentor-network-tls-")
        cls.root = Path(cls.scratch.name)
        for identity in ("server", "client", "other"):
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-keyout", str(cls.root / (identity + ".key")),
                            "-out", str(cls.root / (identity + ".crt")), "-days", "1",
                            "-subj", "/CN=" + ("localhost" if identity == "server" else identity),
                            "-addext", "subjectAltName=DNS:localhost"],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    @classmethod
    def tearDownClass(cls):
        cls.scratch.cleanup()

    def setUp(self):
        self.installation = str(uuid.uuid4())
        (self.root / "backup-installation-id").write_text(self.installation)
        outer = self

        class Policy:
            data_dir = str(outer.root)
            installation = outer.installation
            project = "agentor"
            primary = "workers"

            def project_policy(self):
                pass

            def ensure(self, payload):
                if not isinstance(payload, dict) or set(payload) != {"networkId", "userId"}:
                    raise MODULE.POLICY.PolicyError("Unexpected authority")
                outer.calls.append(payload)
                return {"name": "owned-bridge"}

            def remove(self, payload):
                return self.ensure(payload)

            def inspect(self, payload):
                return self.ensure(payload)

        self.calls = []
        self.host_calls = []
        self.path_id = str(uuid.uuid4())
        self.selected_source = {"pathId": self.path_id, "source": "/srv/approved-fixture",
                                "readOnly": True, "installation": self.installation}

        class HostMountPolicy:
            def selected(self, operation, payload):
                if not isinstance(payload, dict) or set(payload) != {"pathId"} or payload["pathId"] != outer.path_id:
                    raise MODULE.POLICY.PolicyError("Unexpected host mount authority")
                outer.host_calls.append((operation, payload))
                return dict(outer.selected_source)

            def ensure(self, payload):
                return self.selected("ensure", payload)

            def inspect(self, payload):
                return self.selected("inspect", payload)

        self.policy = Policy()
        self.host_mounts = HostMountPolicy()
        self.start_server(self.host_mounts)

    def start_server(self, host_mounts):
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(self.root / "server.crt", self.root / "server.key")
        # Trust both test clients so the independent exact fingerprint fence
        # must reject the other certificate even after a valid TLS handshake.
        context.load_verify_locations(cafile=self.root / "client.crt")
        context.load_verify_locations(cafile=self.root / "other.crt")
        context.verify_mode = ssl.CERT_REQUIRED
        fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert((self.root / "client.crt").read_text())).hexdigest()
        self.server = MODULE.TlsPolicyServer(("127.0.0.1", 0), MODULE.handler(self.policy, fingerprint, host_mounts=host_mounts), context,
                                            request_timeout=0.25)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(self.server.shutdown)
        self.port = self.server.server_address[1]

    def context(self, identity="client"):
        context = ssl.create_default_context(cafile=self.root / "server.crt")
        if identity:
            context.load_cert_chain(self.root / (identity + ".crt"), self.root / (identity + ".key"))
        return context

    def request(self, method="GET", path="/v1/managed-networks/readiness", body=None,
                identity="client", headers=None):
        connection = http.client.HTTPSConnection("localhost", self.port, timeout=2, context=self.context(identity))
        try:
            connection.request(method, path, body, headers or {})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_exact_mtls_identity_readiness_and_bounded_operations(self):
        self.assertEqual(self.request()[1]["metadata"]["ready"], True)
        payload = {"userId": "owner", "networkId": str(uuid.uuid4())}
        status, result = self.request("POST", "/v1/managed-networks/ensure?project=agentor", json.dumps(payload))
        self.assertEqual(status, 200)
        self.assertEqual(result["metadata"], {"name": "owned-bridge"})
        self.assertEqual(self.calls, [payload])
        status, result = self.request("POST", "/v1/managed-networks/inspect?project=agentor", json.dumps(payload))
        self.assertEqual(status, 200)
        self.assertEqual(result["metadata"], {"name": "owned-bridge"})
        self.assertEqual(self.calls, [payload, payload])
        self.assertEqual(self.request(identity="other")[0], 409)
        with self.assertRaises((ssl.SSLError, OSError, http.client.HTTPException)):
            self.request(identity=None)

    def test_no_generic_proxy_project_or_body_authority(self):
        for path in ("/1.0/instances", "/v1/managed-networks/readiness?project=default",
                     "/v1/managed-networks/readiness?project=agentor&project=agentor"):
            self.assertGreaterEqual(self.request(path=path)[0], 400)
        for endpoint in ("ensure", "inspect"):
            for body in (b"x" * 4097, b"not-json", json.dumps({"path": "/etc"}).encode()):
                self.assertGreaterEqual(self.request("POST", f"/v1/managed-networks/{endpoint}", body)[0], 400)
        self.assertEqual(self.calls, [])

    def test_host_mount_endpoints_forward_only_selected_catalog_identity(self):
        payload = {"pathId": self.path_id}
        for endpoint in ("ensure", "inspect"):
            status, result = self.request("POST", f"/v1/host-mounts/{endpoint}?project=agentor", json.dumps(payload))
            self.assertEqual(status, 200)
            self.assertEqual(result["metadata"], self.selected_source)
        self.assertEqual(self.host_calls, [("ensure", payload), ("inspect", payload)])
        self.assertEqual(self.calls, [])

    def test_host_mount_endpoints_cannot_accept_raw_source_project_or_commands(self):
        for endpoint in ("ensure", "inspect"):
            for payload in ({}, {"pathId": "unknown"}, [self.path_id],
                            {"source": "/etc"}, {"pathId": self.path_id, "source": "/etc"},
                            {"pathId": self.path_id, "project": "default"},
                            {"pathId": self.path_id, "command": ["sh", "-c", "true"]},
                            {"pathId": self.path_id, "readOnly": False}):
                self.assertGreaterEqual(self.request("POST", f"/v1/host-mounts/{endpoint}", json.dumps(payload))[0], 400)
            for body in (b"x" * 4097, b"not-json"):
                self.assertGreaterEqual(self.request("POST", f"/v1/host-mounts/{endpoint}", body)[0], 400)
            for query in ("?project=default", "?project=agentor&project=agentor", "?command=true"):
                self.assertGreaterEqual(self.request("POST", f"/v1/host-mounts/{endpoint}{query}",
                                                    json.dumps({"pathId": self.path_id}))[0], 400)
        self.assertEqual(self.host_calls, [])
        self.assertEqual(self.calls, [])

    def test_host_mount_endpoints_retain_exact_mtls_fence(self):
        for endpoint in ("ensure", "inspect"):
            self.assertEqual(self.request("POST", f"/v1/host-mounts/{endpoint}",
                                          json.dumps({"pathId": self.path_id}), identity="other")[0], 409)
            with self.assertRaises((ssl.SSLError, OSError, http.client.HTTPException)):
                self.request("POST", f"/v1/host-mounts/{endpoint}",
                             json.dumps({"pathId": self.path_id}), identity=None)
        self.assertEqual(self.host_calls, [])
        self.assertEqual(self.calls, [])

    def test_absent_optional_host_mount_policy_fails_closed_without_network_dispatch(self):
        self.start_server(None)
        for endpoint in ("ensure", "inspect"):
            self.assertEqual(self.request("POST", f"/v1/host-mounts/{endpoint}",
                                          json.dumps({"pathId": self.path_id}))[0], 503)
        # Optional compatibility does not affect existing network transport.
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.host_calls, [])
        self.assertEqual(self.calls, [])

    def test_unverified_handshake_stall_is_bounded(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=2) as stalled:
            # Trigger no TLS handshake. The next authenticated request still
            # finishes within its two-second bound on this serialized server.
            self.assertEqual(self.request()[0], 200)
            self.assertEqual(stalled.recv(1), b"")

    def test_authenticated_partial_body_stall_and_duplicate_lengths_are_bounded(self):
        def connect():
            return self.context().wrap_socket(socket.create_connection(("127.0.0.1", self.port), timeout=2),
                                              server_hostname="localhost")

        with connect() as stalled:
            stalled.sendall(b"POST /v1/managed-networks/ensure HTTP/1.1\r\nHost: localhost\r\n"
                            b"Content-Length: 100\r\n\r\n{")
            self.assertEqual(self.request()[0], 200)
        with connect() as duplicate:
            duplicate.sendall(b"POST /v1/managed-networks/ensure HTTP/1.1\r\nHost: localhost\r\n"
                              b"Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}")
            self.assertIn(b"400", duplicate.recv(4096).split(b"\r\n", 1)[0])
        self.assertEqual(self.calls, [])


@unittest.skipUnless(os.environ.get("INCUS_NETWORK_HOST_TEST") == "true",
                     "Explicit root-only disposable Incus host gate")
class NativePolicyLiveTests(unittest.TestCase):
    def test_native_lifecycle_allowlist_mtls_and_exact_cleanup(self):
        # Run serially as root on the disposable host, never against production.
        self.assertEqual(os.geteuid(), 0)
        scratch = Path(tempfile.mkdtemp(prefix="agentor-native-network-"))
        installation, network_id, owner = str(uuid.uuid4()), str(uuid.uuid4()), "network-service-live"
        (scratch / "backup-installation-id").write_text(installation)
        (scratch / "users" / owner).mkdir(parents=True)
        (scratch / "users" / owner / "managed-networks.json").write_text(json.dumps([
            {"id": network_id, "userId": owner, "dockerName": "agentor-managed-" + network_id}]))
        request = MODULE.incus_request("/var/lib/incus/unix.socket")
        policy = MODULE.POLICY.ManagedNetworkPolicy(str(scratch), installation,
            os.environ["INCUS_HOST_PROJECT"], os.environ["INCUS_HOST_PRIMARY"], request)
        original, _ = request("GET", "/1.0/projects/" + policy.project)
        payload = {"userId": owner, "networkId": network_id}
        _, _, name = policy.identity(payload)
        server, thread = None, None
        completed = False
        print("Exact native service fixture:", scratch, name, installation, network_id, flush=True)
        try:
            for identity in ("server", "client"):
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                    "-keyout", str(scratch / (identity + ".key")), "-out", str(scratch / (identity + ".crt")),
                    "-days", "1", "-subj", "/CN=" + ("localhost" if identity == "server" else identity),
                    "-addext", "subjectAltName=DNS:localhost"], check=True,
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                (scratch / (identity + ".key")).chmod(0o600)
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(scratch / "server.crt", scratch / "server.key")
            tls.load_verify_locations(cafile=scratch / "client.crt")
            tls.verify_mode = ssl.CERT_REQUIRED
            fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert((scratch / "client.crt").read_text())).hexdigest()
            server = MODULE.TlsPolicyServer(("127.0.0.1", 0), MODULE.handler(policy, fingerprint), tls)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            thread.start()
            client_tls = ssl.create_default_context(cafile=scratch / "server.crt")
            client_tls.load_cert_chain(scratch / "client.crt", scratch / "client.key")

            def call(method, path, body=None):
                connection = http.client.HTTPSConnection("localhost", server.server_address[1],
                                                        timeout=45, context=client_tls)
                try:
                    connection.request(method, path, None if body is None else json.dumps(body))
                    response = connection.getresponse()
                    result = json.loads(response.read())
                    self.assertEqual(response.status, 200, result)
                    return result["metadata"]
                finally:
                    connection.close()

            self.assertTrue(call("GET", "/v1/managed-networks/readiness")["ready"])
            result = call("POST", "/v1/managed-networks/ensure", payload)
            self.assertEqual(result["name"], name)
            self.assertEqual(call("POST", "/v1/managed-networks/ensure", payload), result)
            network, _ = request("GET", "/1.0/networks/" + name)
            self.assertEqual(network["config"]["user.agentor.installation"], installation)
            self.assertTrue(network["config"]["ipv4.dhcp.ranges"].endswith(".254"))
            current, _ = request("GET", "/1.0/projects/" + policy.project)
            self.assertIn(name, current["config"]["restricted.networks.access"].split(","))
            for key, value in original["config"].items():
                if key != "restricted.networks.access":
                    self.assertEqual(current["config"][key], value)
            call("POST", "/v1/managed-networks/remove", payload)
            call("POST", "/v1/managed-networks/remove", payload)
            with self.assertRaises(MODULE.IncusRejected) as absent:
                request("GET", "/1.0/networks/" + name)
            self.assertEqual(absent.exception.status_code, 404)
            restored, _ = request("GET", "/1.0/projects/" + policy.project)
            self.assertEqual(restored["config"], original["config"])
            completed = True
        finally:
            if server:
                server.shutdown()
                server.server_close()
            if thread:
                thread.join(2)
            if not completed:
                # Exact-owned cleanup only; a policy mismatch retains all
                # diagnostic metadata rather than bypassing native fences.
                policy.remove(payload)
                print("Failed fixture metadata retained:", scratch, flush=True)
            else:
                import shutil
                shutil.rmtree(scratch)


if __name__ == "__main__":
    unittest.main()
