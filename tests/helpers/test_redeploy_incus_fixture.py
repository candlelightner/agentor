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
        parent = "/var/tmp/agentor-phase6-production.fixture"
        self.old = {"Id": "old-fixture-id", "Config": {"Env": ["TEST_SECRET=fixture-only", "INCUS_WORKER_IMAGE=old"]},
                    "HostConfig": {"Binds": [parent + "/stack-data:/data", parent + "/tls:/tls:ro", "/var/run/docker.sock:/var/run/docker.sock"],
                                   "PortBindings": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "38000"}, {"HostIp": "10.159.68.1", "HostPort": "38000"}]}},
                    "NetworkSettings": {"Networks": {"agentor-phase6-net": {"IPAddress": "172.22.0.2"}, "agentor-management": {"IPAddress": "172.20.0.2"}}}}
        self.calls = []
        self.envfile = None

    def execute(self, fail=None, hostname="agentor-kata-preflight"):
        def docker(argv, **_kwargs):
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
                return "new-fixture-id"
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


if __name__ == "__main__":
    unittest.main()
