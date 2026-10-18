import copy
import io
import json
import os
from pathlib import Path
import runpy
import stat
import unittest
from unittest.mock import patch


class RedeployFixtureTest(unittest.TestCase):
    def setUp(self):
        parent = "/var/tmp/agentor-phase6-production.SSkg3hQz"
        self.old = {"Id": "old-fixture-id", "Config": {"Env": ["TEST_SECRET=fixture-only", "INCUS_WORKER_IMAGE=old", "INCUS_ENDPOINT=https://agentor-kata-preflight:8443"]},
                    "HostConfig": {"Binds": [parent + "/stack-data:/data", parent + "/tls:/tls:ro", "/var/run/docker.sock:/var/run/docker.sock"],
                                   "ExtraHosts": ["agentor-kata-preflight:host-gateway"],
                                   "PortBindings": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "38000"}, {"HostIp": "10.159.68.1", "HostPort": "38000"}]}},
                    "NetworkSettings": {"Networks": {"agentor-phase6-net": {"IPAddress": "172.22.0.2"}, "agentor-management": {"IPAddress": "172.20.0.2"}}}}
        self.calls = []
        self.envfile = None
        self.ambiguous_create = False

    def execute(self, fail=None, hostname="agentor-kata-preflight"):
        def docker(argv, **kwargs):
            self.assertEqual(argv[:3], ["docker", "--host", "unix:///var/run/docker.sock"])
            self.assertNotIn("DOCKER_HOST", kwargs["env"])
            self.assertNotIn("DOCKER_CONTEXT", kwargs["env"])
            self.assertEqual(kwargs["timeout"], 60)
            argv = argv[2:]
            self.calls.append(argv[1:])
            if fail and fail(argv[1:]):
                raise RuntimeError("fixture operation failed")
            if argv[1:3] == ["inspect", "agentor-orchestrator"]:
                return json.dumps([copy.deepcopy(self.old)])
            if argv[1] == "create":
                self.envfile = argv[argv.index("--env-file") + 1]
                self.assertEqual(stat.S_IMODE(os.stat(self.envfile).st_mode), 0o600)
                self.assertIn("TEST_SECRET=fixture-only", Path(self.envfile).read_text())
                self.assertIn("INCUS_WORKER_IMAGE=agentor-worker-phase7-candidate", Path(self.envfile).read_text())
                self.assertNotIn("TEST_SECRET=fixture-only", argv)
                self.assertEqual(argv[argv.index("--add-host") + 1], "agentor-kata-preflight:host-gateway")
                if self.ambiguous_create:
                    raise RuntimeError("lost create response")
                return "new-fixture-id"
            if argv[1] == "ps" and any(value.startswith("label=agentor.incus.acceptance.attempt=") for value in argv):
                return "new-fixture-id" if self.ambiguous_create else ""
            return ""
        script = str(Path(__file__).with_name("redeploy-incus-fixture.py"))
        with patch("sys.argv", [script, "--image", "agentor-phase7-orchestrator:trial", "--worker-image", "agentor-worker-phase7-candidate", "--retain-as", "agentor-orchestrator-before-phase7"]), \
             patch("socket.gethostname", return_value=hostname), patch("os.geteuid", return_value=0), \
             patch("subprocess.check_output", side_effect=docker), patch("sys.stdout", new_callable=io.StringIO) as output:
            runpy.run_path(script, run_name="__main__")
            self.assertNotIn("fixture-only", output.getvalue())

    def test_replaces_only_compute_and_removes_temporary_secret_file(self):
        self.execute()
        self.assertIn(["rename", "old-fixture-id", "agentor-orchestrator-before-phase7"], self.calls)
        self.assertIn(["start", "new-fixture-id"], self.calls)
        self.assertFalse(Path(self.envfile).exists())
        self.assertFalse(any(call[0] in ["rm", "volume"] for call in self.calls))

    def test_wrong_host_and_unexpected_incus_mount_fail_before_mutation(self):
        with self.assertRaises(SystemExit):
            self.execute(hostname="not-the-disposable-host")
        self.assertEqual(self.calls, [])
        self.old["HostConfig"]["Binds"].append("/var/lib/incus/unix.socket:/incus.sock")
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] in ["stop", "rename", "create"] for call in self.calls))

    def test_failed_new_start_restores_exact_source_without_deleting_data(self):
        with self.assertRaises(RuntimeError):
            self.execute(fail=lambda args: args == ["start", "new-fixture-id"])
        self.assertIn(["rm", "-f", "new-fixture-id"], self.calls)
        self.assertIn(["rename", "old-fixture-id", "agentor-orchestrator"], self.calls)
        self.assertEqual(self.calls[-1], ["start", "old-fixture-id"])
        self.assertFalse(any(call[:2] == ["rm", "-f"] and call[-1] != "new-fixture-id" for call in self.calls))
        self.assertFalse(Path(self.envfile).exists())

    def test_empty_ip_or_other_scratch_data_fails_before_stop(self):
        self.old["NetworkSettings"]["Networks"]["agentor-phase6-net"]["IPAddress"] = ""
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] == "stop" for call in self.calls))
        self.old["HostConfig"]["Binds"][0] = "/var/tmp/agentor-phase6-production.other/stack-data:/data"
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] == "stop" for call in self.calls))

    def test_failed_removal_never_starts_two_shared_data_writers(self):
        with self.assertRaisesRegex(RuntimeError, "rollback incomplete") as caught:
            self.execute(fail=lambda args: args in [["start", "new-fixture-id"], ["rm", "-f", "new-fixture-id"]])
        self.assertIsNotNone(caught.exception.__cause__)
        self.assertNotIn(["start", "old-fixture-id"], self.calls)
        self.assertFalse(Path(self.envfile).exists())

    def test_reconnect_failure_does_not_skip_other_network_or_safe_source_restart(self):
        with self.assertRaisesRegex(RuntimeError, "rollback incomplete"):
            self.execute(fail=lambda args: args == ["start", "new-fixture-id"] or args[:5] == ["network", "connect", "--ip", "172.22.0.2", "agentor-phase6-net"])
        self.assertIn(["network", "connect", "--ip", "172.20.0.2", "agentor-management", "old-fixture-id"], self.calls)
        self.assertEqual(self.calls[-1], ["start", "old-fixture-id"])

    def test_lost_create_response_removes_only_nonce_owned_replacement(self):
        self.ambiguous_create = True
        with self.assertRaisesRegex(RuntimeError, "lost create response"):
            self.execute()
        self.assertIn(["rm", "-f", "new-fixture-id"], self.calls)
        self.assertEqual(self.calls[-1], ["start", "old-fixture-id"])

    def test_missing_host_mapping_repairs_only_helper_owned_fixture(self):
        self.old["HostConfig"]["ExtraHosts"] = None
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] == "stop" for call in self.calls))
        self.old["Config"]["Labels"] = {"agentor.incus.acceptance": "true"}
        self.execute()
        self.assertIn(["start", "new-fixture-id"], self.calls)

    def test_other_hostname_mapping_or_endpoint_fails_before_mutation(self):
        self.old["HostConfig"]["ExtraHosts"] = ["agentor-kata-preflight:192.0.2.1"]
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] == "stop" for call in self.calls))
        self.old["HostConfig"]["ExtraHosts"] = ["agentor-kata-preflight:host-gateway"]
        self.old["Config"]["Env"] = ["INCUS_ENDPOINT=https://elsewhere:8443"]
        with self.assertRaises(SystemExit):
            self.execute()
        self.assertFalse(any(call[0] == "stop" for call in self.calls))


if __name__ == "__main__":
    unittest.main()
