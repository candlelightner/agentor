#!/usr/bin/env python3
"""Offline contract fixtures: fake Docker only, never a socket or real containers."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/test-kata-worker.sh"
IMAGE = "sha256:" + "a" * 64

MOCK_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
p = Path(os.environ["KATA_FIXTURE_STATE"])
args = sys.argv[1:]
with (p / "calls.jsonl").open("a") as f: f.write(json.dumps(args) + "\n")
assert args[:2] == ["-H", "unix:///var/run/docker.sock"], args
args = args[2:]
cfg = {"User":"agent", "Entrypoint":["/home/agent/entrypoint.sh"], "Cmd":None, "Volumes":None}
image = "sha256:" + "a"*64
mode = os.environ.get("KATA_FIXTURE_MODE", "success")
if args[0] == "info":
    print(json.dumps({"agentor-kata-qemu":{}}) if "--format" in args else "fixture Docker")
elif args[0] == "version": print("fixture Docker")
elif args[:2] == ["image", "inspect"]: print(json.dumps([{"Id":image,"Config":cfg}]))
elif args[:2] == ["volume", "inspect"]: sys.exit(1)
elif args[:2] == ["volume", "create"]: print(args[-1])
elif args[0] == "create":
    cidfile = Path(args[args.index("--cidfile")+1])
    cid = ("1" if cidfile.name.startswith("first") else "2")*64
    cidfile.write_text(cid)
    (p / (cid + ".json")).write_text(json.dumps(args))
    print(cid)
elif args[0] == "inspect":
    if "--format" in args: print("false" if mode == "not-running" else "true")
    else:
        cid = args[-1]
        create = json.loads((p / (cid + ".json")).read_text())
        cfg.update({"Tty":True,"OpenStdin":True,"Env":[create[n+1] for n,a in enumerate(create) if a == "--env"]})
        mounts = []
        for n, a in enumerate(create):
            if a == "--mount":
                parts = dict(v.split("=",1) for v in create[n+1].split(","))
                mounts.append({"Type":"volume","Name":parts["source"],"Destination":parts["target"],"RW":True})
        hc = {"Runtime":"agentor-kata-qemu","Privileged": mode == "privileged", "Init":True,
          "ShmSize":536870912,"RestartPolicy":{"Name":"no"},"PublishAllPorts":False,
          "IpcMode":"private","CgroupnsMode":"private","NetworkMode":"host" if mode == "host-network" else "bridge",
          "Tmpfs":{"/run/agentor-secrets":"rw,nosuid,nodev,noexec,mode=0711,uid=0,gid=0,size=16777216"}}
        if mode == "host-mount": mounts.append({"Type":"bind","Source":"/etc","Destination":"/host","RW":True})
        print(json.dumps([{"Id":cid,"Image":image,"Config":cfg,"HostConfig":hc,"Mounts":mounts}]))
elif args[0] == "exec":
    if mode == "service-fail" and any("curl --fail" in arg for arg in args): sys.exit(17)
    if mode == "marker-fail" and any("stat -c %u:%g" in arg for arg in args): sys.exit(18)
elif args[0] in ["start","stop","restart","rm","logs"]:
    if args[0] == "start":
        starts = p / (args[-1] + ".starts")
        count = int(starts.read_text()) + 1 if starts.exists() else 1
        starts.write_text(str(count))
        if mode == "restart-start-fail" and count == 2: sys.exit(21)
        if mode == "slow-stop" and count == 2: assert (p / "stop-completed").exists()
    if args[0] == "stop":
        if mode == "stop-fail": sys.exit(22)
        if mode == "stop-uncertain": sys.exit(124)
        if mode == "slow-stop":
            import time
            time.sleep(0.05)
            (p / "stop-completed").write_text("done")
    if mode == "restart-fail" and args[0] == "restart": sys.exit(23)
    if mode == "start-fail" and args[0] == "start": sys.exit(19)
    if mode == "cleanup-fail" and args[0] == "rm": sys.exit(20)
else: raise AssertionError(args)
'''


class WorkerCanaryFixtures(unittest.TestCase):
    def run_fixture(self, mode="success", arguments=None, restart_method=None):
        with tempfile.TemporaryDirectory(prefix="kata-worker-fixture.") as directory:
            root = Path(directory)
            mock = root / "docker"
            mock.write_text(MOCK_DOCKER)
            mock.chmod(0o755)
            env = {**os.environ, "PATH":str(root) + os.pathsep + os.environ["PATH"],
                   "KATA_FIXTURE_STATE":str(root), "KATA_FIXTURE_MODE":mode, "TMPDIR":str(root)}
            selected_args = arguments if arguments is not None else ["--disposable-host", "--image", "fixture-worker:local"]
            if restart_method is not None:
                selected_args = [*selected_args, "--restart-method", restart_method]
            process = subprocess.run(["bash", str(SCRIPT)] + selected_args,
                                     env=env, capture_output=True, text=True, timeout=30)
            calls_file = root / "calls.jsonl"
            calls = [json.loads(line)[2:] for line in calls_file.read_text().splitlines()] if calls_file.exists() else []
            results = list(root.glob("agentor-kata-worker.*/result.json"))
            result = json.loads(results[0].read_text()) if results else None
            return process, calls, result

    def test_opt_in_required_before_docker_access(self):
        process, calls, result = self.run_fixture(arguments=["--image", "fixture-worker:local"])
        self.assertEqual(process.returncode, 2)
        self.assertEqual(calls, [])
        self.assertIsNone(result)

    def test_help_does_not_access_docker(self):
        process, calls, _ = self.run_fixture(arguments=["--help"])
        self.assertEqual(process.returncode, 0)
        self.assertEqual(calls, [])

    def test_success_immutable_image_safe_options_lifecycle_and_exact_cleanup(self):
        process, calls, result = self.run_fixture()
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(result["passed"])
        self.assertFalse(result["hostValidated"])
        self.assertEqual(result["restartMethod"], "stop-start")
        creates = [args for args in calls if args[0] == "create"]
        self.assertEqual(len(creates), 2)
        for create in creates:
            self.assertEqual(create[-1], IMAGE)
            self.assertEqual(create[create.index("--runtime")+1], "agentor-kata-qemu")
            self.assertEqual(create[create.index("--network")+1], "bridge")
            self.assertEqual(create.count("--mount"), 2)
            self.assertIn("--init", create)
            self.assertIn("--tty", create)
            self.assertIn("--interactive", create)
            self.assertIn("AGENTOR_RUNTIME_ROLE=worker", create)
            self.assertIn("DOCKER_ENABLED=false", create)
            for forbidden in ["--privileged", "--cap-add", "--device", "--volume", "--publish", "--user", "--entrypoint"]:
                self.assertNotIn(forbidden, create)
        self.assertEqual(len([a for a in calls if a[:2] == ["image", "inspect"]]), 1)
        self.assertEqual([a for a in calls if a[0] == "rm"], [["rm","-f","1"*64],["rm","-f","2"*64]])
        self.assertFalse(any(a[0] == "restart" for a in calls))
        lifecycle = [a[0] for a in calls if a[0] in ["start", "stop", "restart"]]
        self.assertEqual(lifecycle, ["start", "stop", "start", "stop", "start"])
        self.assertTrue(any(a[0] == "exec" and a[-2:] == ["rm", "/tmp/worker-events"] for a in calls))
        self.assertEqual(len([a for a in calls if a[0] == "exec" and any("stat -c %u:%g" in v for v in a)]), 3)
        self.assertFalse(any(a[:2] in [["volume","rm"],["image","rm"],["system","prune"]] for a in calls))

    def test_start_and_service_and_marker_failures_preserve_containers(self):
        for mode in ["start-fail", "not-running", "service-fail", "marker-fail"]:
            with self.subTest(mode=mode):
                process, calls, result = self.run_fixture(mode)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(result["passed"])
                self.assertFalse(any(a[0] == "rm" for a in calls))
                self.assertEqual(len([a for a in calls if a[0] == "create"]), 1)

    def test_unsafe_inspection_fails_before_start(self):
        for mode in ["privileged", "host-mount", "host-network"]:
            with self.subTest(mode=mode):
                process, calls, result = self.run_fixture(mode)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(result["passed"])
                self.assertFalse(any(a[0] in ["start", "rm"] for a in calls))

    def test_cleanup_failure_is_not_reported_as_pass(self):
        process, _, result = self.run_fixture("cleanup-fail")
        self.assertNotEqual(process.returncode, 0)
        self.assertFalse(result["passed"])

    def test_explicit_restart_methods_do_not_fall_back_or_change_privileges(self):
        for method, expected in [("docker", ["start", "restart", "stop", "start"]),
                                 ("stop-start", ["start", "stop", "start", "stop", "start"])]:
            with self.subTest(method=method):
                process, calls, result = self.run_fixture(restart_method=method)
                self.assertEqual(process.returncode, 0, process.stderr)
                self.assertEqual(result["restartMethod"], method)
                self.assertEqual([a[0] for a in calls if a[0] in ["start", "stop", "restart"]], expected)
                self.assertEqual([a for a in calls if a[0] == "rm"], [["rm", "-f", "1"*64], ["rm", "-f", "2"*64]])
                for create in [a for a in calls if a[0] == "create"]:
                    self.assertEqual(create[create.index("--runtime")+1], "agentor-kata-qemu")
                    self.assertEqual(create[-1], IMAGE)
                    for flag in ["--privileged", "--cap-add", "--device", "--publish", "--user", "--entrypoint"]:
                        self.assertNotIn(flag, create)

    def test_failed_or_uncertain_stop_never_starts_or_recreates(self):
        for mode in ["stop-fail", "stop-uncertain"]:
            with self.subTest(mode=mode):
                process, calls, result = self.run_fixture(mode, restart_method="stop-start")
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(result["passed"])
                self.assertEqual(result["restartMethod"], "stop-start")
                self.assertEqual([a[0] for a in calls if a[0] in ["start", "stop", "restart"]], ["start", "stop"])
                self.assertEqual(len([a for a in calls if a[0] == "create"]), 1)
                self.assertFalse(any(a[0] == "rm" for a in calls))

    def test_stop_completes_before_start_is_issued(self):
        process, calls, result = self.run_fixture("slow-stop")
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(result["passed"])
        self.assertEqual([a[0] for a in calls if a[0] in ["start", "stop", "restart"]],
                         ["start", "stop", "start", "stop", "start"])

    def test_restart_failure_never_switches_methods(self):
        for method, mode, expected in [("docker", "restart-fail", ["start", "restart"]),
                                       ("stop-start", "restart-start-fail", ["start", "stop", "start"])]:
            with self.subTest(method=method):
                process, calls, result = self.run_fixture(mode, restart_method=method)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(result["passed"])
                self.assertEqual(result["restartMethod"], method)
                self.assertEqual([a[0] for a in calls if a[0] in ["start", "stop", "restart"]], expected)
                self.assertFalse(any(a[0] == "rm" for a in calls))

    def test_bad_arguments_reject_before_docker_access(self):
        base = ["--disposable-host", "--image", "fixture-worker:local"]
        for extra in [["--restart-method", "auto"], ["--restart-method"],
                      ["--restart-method", "docker", "--restart-method", "stop-start"], ["--unrecognized"]]:
            with self.subTest(extra=extra):
                process, calls, result = self.run_fixture(arguments=base+extra)
                self.assertEqual(process.returncode, 2)
                self.assertEqual(calls, [])
                self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()
