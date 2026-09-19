#!/usr/bin/env python3
"""Agentor-owned displays. No TCP listener, public port, or plugin command here.

State is disposable and process identities include Linux start time. The global
lock serializes allocation checks; each supervisor owns exactly one process
group. X authentication prevents accidental cross-display application access.
Worker users (including sudo-capable plugins) remain a single trust boundary.
"""
from __future__ import annotations

import fcntl
import ctypes
import json
import os
import secrets
import selectors
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import runner

ROOT = runner.RUNTIME / "desktops"


def die_with_parent():
    """A killed supervisor/relay must not leave an unowned X server or viewer."""
    parent = os.getppid()
    if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM) != 0:
        os._exit(1)
    if parent == 1 or os.getppid() != parent:
        os._exit(1)


def paths(ident):
    directory = ROOT / runner.installation(ident)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory, directory / "authority", directory / "ready.json"


def spec(raw):
    if not isinstance(raw, dict) or set(raw) != {"display", "width", "height", "depth"}:
        raise runner.Invalid()
    for key, low, high in (("display", 100, 999), ("width", 320, 3840), ("height", 200, 2160), ("depth", 24, 24)):
        if type(raw[key]) is not int or not low <= raw[key] <= high:
            raise runner.Invalid()
    return raw


def env_for(ident, display):
    _, authority, _ = paths(ident)
    return {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": str(paths(ident)[0]), "LANG": "C.UTF-8", "DISPLAY": f":{display}", "XAUTHORITY": str(authority)}


def healthy(ident, config):
    state = runner.load_state(ident)
    if not state:
        return False
    try:
        ready = json.loads(paths(ident)[2].read_text())
        return ready == {"config": config, "start": state["start"]} and subprocess.run(
            ["xdpyinfo"], env=env_for(ident, config["display"]), stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=2).returncode == 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return False


def clear_owned_stale_x_lock(ident, display):
    """A container restart can reuse a dead Xvfb PID for an unrelated process.

    Xvfb considers that stale PID's lock live. Only reclaim our recorded lock,
    after proving the socket has no listener and the original server is gone.
    Unknown locks and a new X server starting on the display are left alone.
    """
    try:
        saved = json.loads((paths(ident)[0] / "xserver.json").read_text())
        lock = Path(f"/tmp/.X{display}-lock")
        if saved["display"] != display or int(lock.read_text().strip()) != saved["pid"]:
            return
        if runner.proc_start(saved["pid"]) == saved["start"]:
            return
        try:
            argv = Path(f"/proc/{saved['pid']}/cmdline").read_bytes().split(b"\0")
            if f":{display}".encode() in argv:
                return
        except FileNotFoundError:
            pass
        with socket.socket(socket.AF_UNIX) as existing:
            existing.settimeout(.5)
            if existing.connect_ex(f"/tmp/.X11-unix/X{display}") == 0:
                return
        lock.unlink()
        socket_path = Path(f"/tmp/.X11-unix/X{display}")
        if socket_path.exists() and socket_path.stat().st_ino == saved.get("socketInode"):
            socket_path.unlink()
    except (OSError, ValueError, KeyError, TypeError):
        pass


def control(req):
    ident = runner.installation(req.get("installationId"))
    operation = req.get("operation")
    if operation not in ("ensure", "status", "stop"):
        raise runner.Invalid()
    config = spec(req.get("config"))
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    runner.RUNTIME = ROOT
    with (ROOT / "control.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if operation == "stop":
            runner.stop_state(ident)
            for target in (paths(ident)[1], paths(ident)[2]):
                target.unlink(missing_ok=True)
            return {"exitCode": 0}
        if healthy(ident, config):
            return {"exitCode": 0}
        if operation == "status":
            return {"exitCode": 1}
        runner.stop_state(ident)
        paths(ident)[2].unlink(missing_ok=True)
        clear_owned_stale_x_lock(ident, config["display"])
        with socket.socket(socket.AF_UNIX) as existing:
            existing.settimeout(.5)
            try:
                existing.connect(f"/tmp/.X11-unix/X{config['display']}")
                return {"exitCode": 98}
            except OSError:
                pass
        # Never remove another server's sockets or locks. Xvfb atomically takes
        # its own X lock, so an unregistered process can only cause a safe failure.
        proc = subprocess.Popen([sys.executable, __file__, "serve", ident, json.dumps(config)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True)
        runner.write_state(ident, proc, ["agentor-desktop", ident])
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            if healthy(ident, config):
                return {"exitCode": 0}
            if proc.poll() is not None:
                break
            time.sleep(.1)
        runner.stop_state(ident)
        return {"exitCode": 1}


def serve(ident, config):
    runner.RUNTIME = ROOT
    directory, authority, ready = paths(ident)
    children = []
    def interrupted(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        authority.touch(mode=0o600, exist_ok=True)
        os.chmod(authority, 0o600)
        subprocess.run(["xauth", "-f", str(authority), "add", f":{config['display']}", ".", secrets.token_hex(16)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = env_for(ident, config["display"])
        children.append(subprocess.Popen(["Xvfb", env["DISPLAY"], "-screen", "0",
            f"{config['width']}x{config['height']}x{config['depth']}", "-nolisten", "tcp", "-auth", str(authority)], env=env, preexec_fn=die_with_parent))
        deadline = time.monotonic() + 8
        while subprocess.run(["xdpyinfo"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2).returncode:
            if children[0].poll() is not None or time.monotonic() > deadline:
                return
            time.sleep(.1)
        (directory / "xserver.json").write_text(json.dumps({"display": config["display"], "pid": children[0].pid,
            "start": runner.proc_start(children[0].pid), "socketInode": Path(f"/tmp/.X11-unix/X{config['display']}").stat().st_ino}))
        # A private HOME gives every window manager independent settings/session.
        children.append(subprocess.Popen(["fluxbox", "-display", env["DISPLAY"]], env=env, preexec_fn=die_with_parent))
        time.sleep(.2)
        ready.write_text(json.dumps({"config": config, "start": runner.proc_start(os.getpid())}))
        while all(child.poll() is None for child in children):
            time.sleep(.5)
    finally:
        ready.unlink(missing_ok=True)
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


def connect(ident, display):
    runner.RUNTIME = ROOT
    _, authority, ready = paths(ident)
    config = spec(json.loads(ready.read_text())["config"])
    if config["display"] != display or not healthy(ident, config):
        raise runner.Invalid()
    # inetd speaks RFB on stdio. Docker carries these bytes to the authenticated
    # WebSocket; neither x11vnc nor websockify opens a network port.
    parent, child = socket.socketpair()
    proc = subprocess.Popen(["x11vnc", "-inetd", "-q", "-display", f":{display}",
        "-auth", str(authority), "-nopw", "-shared", "-once", "-noxdamage", "-xkb",
        "-noremote", "-nosel", "-noclipboard"], env=env_for(ident, display), stdin=child, stdout=child, stderr=subprocess.DEVNULL, preexec_fn=die_with_parent)
    child.close()
    selector = selectors.DefaultSelector()
    selector.register(sys.stdin.buffer, selectors.EVENT_READ)
    selector.register(parent, selectors.EVENT_READ)
    try:
        while proc.poll() is None:
            for key, _ in selector.select(.5):
                data = os.read(key.fd, 65536)
                if not data:
                    return
                if key.fileobj is parent:
                    sys.stdout.buffer.write(data)
                    sys.stdout.buffer.flush()
                else:
                    parent.sendall(data)
    finally:
        selector.close()
        parent.close()
        if proc.poll() is None:
            proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "serve":
            serve(runner.installation(sys.argv[2]), spec(json.loads(sys.argv[3])))
        elif len(sys.argv) == 4 and sys.argv[1] == "connect":
            connect(runner.installation(sys.argv[2]), int(sys.argv[3]))
        else:
            raise runner.Invalid()
    except Exception:
        sys.exit(1)
