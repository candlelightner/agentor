"""Mocked native cleanup tests: no Incus calls or disposable-host writes."""
import contextlib
import copy
import io
import json
from pathlib import Path
import runpy
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch


HELPER = Path(__file__).with_name("restore-incus-host-mount-fixture.py")
DISK_PATHS = "restricted.devices.disk.paths"
HOST_ROOTS = "user.agentor.host-mount-roots"
STAGE = "/var/tmp/agentor-host-mount-live.mocked"


class RestoreFixtureTests(unittest.TestCase):
    def setUp(self):
        self.before = {DISK_PATHS: "/srv/retained", HOST_ROOTS: None}
        self.expected = {DISK_PATHS: "/srv/retained,/srv/disposable",
                         HOST_ROOTS: '{"fixture":"/srv/disposable"}'}
        self.current = {
            "config": {**self.expected, "restricted": "true",
                       "restricted.networks.access": "workers,concurrent-network",
                       "user.concurrent": "preserve-current-value"},
            "description": "concurrently updated project description",
        }
        self.etag = '"native-current-etag"'
        self.calls = []
        self.loads = []
        self.sockets = []

    def execute(self, *, stage=STAGE, before=None, expected=None, final=None):
        outer = self

        def request(method, path, payload=None, etag=None):
            outer.calls.append((method, path, copy.deepcopy(payload), etag))
            if method == "GET":
                if len(outer.calls) == 1:
                    return copy.deepcopy(outer.current), outer.etag
                if final is not None:
                    return copy.deepcopy(final), '"after-etag"'
                return {"config": copy.deepcopy(outer.calls[1][2]["config"])}, '"after-etag"'
            if method != "PUT":
                raise AssertionError("Unexpected native operation")
            return {}, None

        def incus_request(socket):
            self.sockets.append(socket)
            return request

        class Loader:
            def exec_module(self, module):
                module.incus_request = incus_request

        def fake_spec(name, path):
            self.loads.append((name, path))
            return SimpleNamespace(loader=Loader())

        argv = [str(HELPER), stage,
                json.dumps(self.before if before is None else before),
                json.dumps(self.expected if expected is None else expected)]
        output = io.StringIO()
        # Replace the staged import entirely: neither the stage directory nor
        # the root-owned Incus socket is ever opened by these tests.
        with patch.object(sys, "argv", argv), \
                patch("importlib.util.spec_from_file_location", side_effect=fake_spec), \
                patch("importlib.util.module_from_spec", return_value=SimpleNamespace()), \
                contextlib.redirect_stdout(output):
            runpy.run_path(str(HELPER), run_name="__main__")
        return output.getvalue()

    def test_exact_delta_restores_on_current_etag_preserving_concurrent_fields(self):
        output = self.execute()
        restored = {**self.current["config"], DISK_PATHS: self.before[DISK_PATHS]}
        del restored[HOST_ROOTS]
        self.assertEqual(self.calls, [
            ("GET", "/1.0/projects/agentor", None, None),
            ("PUT", "/1.0/projects/agentor",
             {"config": restored, "description": self.current["description"]}, self.etag),
            ("GET", "/1.0/projects/agentor", None, None),
        ])
        self.assertEqual(self.loads, [("host_fixture_service",
                                     Path(STAGE) / "scripts/agentor-incus-network-service.py")])
        self.assertEqual(self.sockets, ["/var/lib/incus/unix.socket"])
        self.assertIn("unrelated restrictions preserved", output)

    def test_absent_before_field_is_removed_and_retained_root_value_restored(self):
        before = {DISK_PATHS: None, HOST_ROOTS: "retained-root-reservation"}
        self.execute(before=before)
        config = self.calls[1][2]["config"]
        self.assertNotIn(DISK_PATHS, config)
        self.assertEqual(config[HOST_ROOTS], before[HOST_ROOTS])
        self.assertEqual(config["user.concurrent"], self.current["config"]["user.concurrent"])

    def test_stale_exact_delta_never_submits_put(self):
        for field in (DISK_PATHS, HOST_ROOTS):
            with self.subTest(field=field):
                self.setUp()
                self.current["config"][field] = "changed-by-another-operation"
                with self.assertRaisesRegex(ValueError, "retain authority for diagnosis"):
                    self.execute()
                self.assertEqual([call[0] for call in self.calls], ["GET"])

    def test_missing_etag_never_submits_put(self):
        for etag in (None, ""):
            with self.subTest(etag=etag):
                self.setUp()
                self.etag = etag
                with self.assertRaisesRegex(ValueError, "retain authority for diagnosis"):
                    self.execute()
                self.assertEqual([call[0] for call in self.calls], ["GET"])

    def test_only_two_permitted_fields_rejected_before_native_loading(self):
        for argument in ("before", "expected"):
            for malformed in ({DISK_PATHS: "x"},
                              {DISK_PATHS: "x", HOST_ROOTS: None, "restricted": "false"},
                              {DISK_PATHS: "x", "unrelated": "x"}):
                with self.subTest(argument=argument, malformed=malformed):
                    self.setUp()
                    with self.assertRaisesRegex(ValueError, "Only two fixture policy fields"):
                        self.execute(**{argument: malformed})
                    self.assertEqual(self.loads, [])
                    self.assertEqual(self.calls, [])

    def test_only_exact_disposable_stage_rejected_before_native_loading(self):
        for stage in ("/tmp/agentor-host-mount-live.mocked", "/var/tmp/unrelated",
                      "/var/tmp/nested/agentor-host-mount-live.mocked",
                      "var/tmp/agentor-host-mount-live.mocked",
                      "/var/tmp/agentor-host-mount-live.mocked/../foreign",
                      "/var/tmp/agentor-host-mount-live.mocked/scripts"):
            with self.subTest(stage=stage):
                self.setUp()
                with self.assertRaisesRegex(ValueError, "Exact disposable host mount fixture"):
                    self.execute(stage=stage)
                self.assertEqual(self.loads, [])
                self.assertEqual(self.calls, [])

    def test_final_read_mismatch_retains_authority_without_retrying_put(self):
        for changed_field in (DISK_PATHS, "user.concurrent"):
            with self.subTest(changed_field=changed_field):
                self.setUp()
                final = copy.deepcopy(self.current)
                final["config"].pop(HOST_ROOTS)
                final["config"][DISK_PATHS] = self.before[DISK_PATHS]
                final["config"][changed_field] = "unexpected-after-acknowledgement"
                with self.assertRaisesRegex(ValueError, "retain authority"):
                    self.execute(final=final)
                self.assertEqual([call[0] for call in self.calls], ["GET", "PUT", "GET"])


if __name__ == "__main__":
    unittest.main()
