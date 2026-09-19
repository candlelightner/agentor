"""Real X11/RFB round trips, isolated from the worker's own :99 desktop."""
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import tempfile
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent


class ManagedDesktopTests(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="agentor-desktop-test-")
        self.env = {**os.environ, "HOME": self.home.name}
        self.ids = [str(uuid.uuid4()), str(uuid.uuid4())]
        free = [n for n in range(700, 999) if not Path(f"/tmp/.X{n}-lock").exists()][:2]
        self.configs = [{"display": n, "width": 800 + index * 160, "height": 600, "depth": 24} for index, n in enumerate(free)]
        self.children = []

    def control(self, index, operation):
        result = subprocess.run(["python3", str(HERE / "runner.py"), "desktop"], env=self.env,
            input=json.dumps({"installationId": self.ids[index], "operation": operation, "config": self.configs[index]}) + "\n",
            capture_output=True, text=True, timeout=20)
        return json.loads(result.stdout)

    def tearDown(self):
        for index in range(2):
            self.control(index, "stop")
        for child in self.children:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
        self.home.cleanup()

    def xenv(self, index):
        return {**self.env, "DISPLAY": f":{self.configs[index]['display']}", "XAUTHORITY": f"{self.home.name}/.agent-data/plugins/runtime/desktops/{self.ids[index]}/authority"}

    def test_concurrent_isolation_and_scoped_cleanup(self):
        for index in range(2):
            self.assertEqual(self.control(index, "ensure")["exitCode"], 0)
            result = subprocess.run(["xdpyinfo"], env=self.xenv(index), capture_output=True, text=True, check=True)
            self.assertIn(f"{self.configs[index]['width']}x600 pixels", result.stdout)
        # The other installation's cookie must not authorize an X connection.
        wrong = {**self.xenv(0), "DISPLAY": self.xenv(1)["DISPLAY"]}
        self.assertNotEqual(subprocess.run(["xdpyinfo"], env=wrong, capture_output=True).returncode, 0)
        self.assertEqual(self.control(0, "stop")["exitCode"], 0)
        self.assertEqual(self.control(0, "status")["exitCode"], 1)
        self.assertEqual(self.control(1, "status")["exitCode"], 0)

    def test_rfb_roundtrip_refresh_and_wrong_allocation(self):
        self.assertEqual(self.control(0, "ensure")["exitCode"], 0)
        for _ in range(2):
            proc = subprocess.Popen(["python3", str(HERE / "desktop_runtime.py"), "connect", self.ids[0], str(self.configs[0]["display"])], env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            self.children.append(proc)
            self.assertTrue(select.select([proc.stdout], [], [], 8)[0])
            self.assertEqual(proc.stdout.read(12), b"RFB 003.008\n")
            proc.stdin.write(b"RFB 003.008\n"); proc.stdin.flush()
            self.assertEqual(proc.stdout.read(2), b"\x01\x01")
            proc.stdin.write(b"\x01"); proc.stdin.flush()
            self.assertEqual(proc.stdout.read(4), b"\x00\x00\x00\x00")
            proc.stdin.close()
            proc.wait(timeout=5)
            proc.stdout.close()
        wrong = subprocess.run(["python3", str(HERE / "desktop_runtime.py"), "connect", self.ids[0], str(self.configs[1]["display"])], env=self.env, capture_output=True, timeout=5)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertEqual(wrong.stdout, b"")

    def test_crash_reconciliation_and_collision_fail_closed(self):
        self.assertEqual(self.control(0, "ensure")["exitCode"], 0)
        old = self.configs[1]
        self.configs[1] = self.configs[0]
        self.assertNotEqual(self.control(1, "ensure")["exitCode"], 0)
        self.assertEqual(self.control(0, "status")["exitCode"], 0)
        self.configs[1] = old
        # Kill the supervisor, not a graceful stop: PDEATHSIG must clean Xvfb
        # and fluxbox before a fresh supervisor claims the same allocation.
        state = json.loads(Path(f"{self.home.name}/.agent-data/plugins/runtime/desktops/{self.ids[0]}.json").read_text())
        os.kill(state["pid"], signal.SIGKILL)
        deadline = time.monotonic() + 5
        while Path(f"/tmp/.X11-unix/X{self.configs[0]['display']}").exists() and time.monotonic() < deadline:
            time.sleep(.05)
        self.assertEqual(self.control(0, "ensure")["exitCode"], 0)
        self.assertEqual(self.control(0, "status")["exitCode"], 0)
        self.control(0, "stop")
        # Model Docker restart: Xvfb's old PID has been reused by this unrelated
        # test process, and its lock survived. Reclaim only recorded own state.
        directory = Path(f"{self.home.name}/.agent-data/plugins/runtime/desktops/{self.ids[0]}")
        (directory / "xserver.json").write_text(json.dumps({"display": self.configs[0]["display"], "pid": os.getpid(), "start": "old-start", "socketInode": 0}))
        with Path(f"/tmp/.X{self.configs[0]['display']}-lock").open("x") as lock:
            lock.write(str(os.getpid()))
        self.assertEqual(self.control(0, "ensure")["exitCode"], 0)
        self.assertEqual(self.control(0, "status")["exitCode"], 0)


if __name__ == "__main__":
    unittest.main()
