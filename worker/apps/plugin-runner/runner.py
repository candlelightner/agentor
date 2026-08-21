#!/usr/bin/env python3
"""Small, deliberately boring executor for Agentor plugin lifecycle commands.

The control document is supplied by the orchestrator over stdin.  It contains
names of user environment variables, never their values; values are read from
this worker's own environment only.
"""
from __future__ import annotations

import hashlib
import json
import os
import selectors
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

MAX_INPUT = 1024 * 1024
MAX_ARGS, MAX_ARG_BYTES = 128, 8192
MAX_OUTPUT = 4 * 1024 * 1024
MAX_TIMEOUT = 300
ID_RE = __import__("re").compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", __import__("re").I)
ENV_RE = __import__("re").compile(r"^[A-Z_][A-Z0-9_]*$")
RUNTIME = Path(os.environ.get("HOME", "/home/agent")) / ".agent-data/plugins/runtime"
SKILL_ROOTS = (
    Path(os.environ.get("HOME", "/home/agent")) / ".agents/skills",
    Path(os.environ.get("HOME", "/home/agent")) / ".claude/skills",
)


class Invalid(Exception):
    pass


def fail(code: int = 2, message: str = "invalid request") -> None:
    # Do not include exception text: it can contain command arguments or env.
    sys.stdout.write(json.dumps({"exitCode": code, "error": message}, separators=(",", ":")) + "\n")


def read_request() -> dict[str, Any]:
    # Docker hijacked exec sockets do not reliably propagate a write-side EOF.
    # The orchestrator therefore sends exactly one newline-delimited frame.
    raw = sys.stdin.buffer.readline(MAX_INPUT + 1)
    if not raw or len(raw) > MAX_INPUT or not raw.endswith(b"\n"):
        raise Invalid()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Invalid() from None
    if not isinstance(value, dict):
        raise Invalid()
    return value


def installation(value: Any) -> str:
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise Invalid()
    return value.lower()


def positive(value: Any, default: int) -> int:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_TIMEOUT:
        raise Invalid()
    return value


def command(value: Any, *, background_ok: bool = True) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - {"argv", "cwd", "mode", "timeoutSeconds", "maxOutputBytes"}:
        raise Invalid()
    argv = value.get("argv")
    if not isinstance(argv, list) or not 1 <= len(argv) <= MAX_ARGS:
        raise Invalid()
    if any(not isinstance(x, str) or not x or "\0" in x or len(x.encode()) > MAX_ARG_BYTES for x in argv):
        raise Invalid()
    cwd = value.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd.startswith("/") or "\0" in cwd or ".." in cwd.split("/")):
        raise Invalid()
    mode = value.get("mode", "oneshot")
    if mode not in ("oneshot", "background") or (mode == "background" and not background_ok):
        raise Invalid()
    output = value.get("maxOutputBytes", 256 * 1024)
    if isinstance(output, bool) or not isinstance(output, int) or not 1024 <= output <= MAX_OUTPUT:
        raise Invalid()
    return {"argv": argv, "cwd": cwd, "mode": mode, "timeout": positive(value.get("timeoutSeconds"), 30), "output": output}


def child_env(req: dict[str, Any]) -> dict[str, str]:
    keys = req.get("envKeys", []) + req.get("secretKeys", [])
    if not isinstance(req.get("envKeys", []), list) or not isinstance(req.get("secretKeys", []), list) or len(keys) > 512:
        raise Invalid()
    if any(not isinstance(k, str) or not ENV_RE.fullmatch(k) for k in keys) or len(set(keys)) != len(keys):
        raise Invalid()
    generated = req.get("systemEnvironment", {})
    if not isinstance(generated, dict) or len(generated) > 64:
        raise Invalid()
    env: dict[str, str] = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/home/agent"), "LANG": os.environ.get("LANG", "C.UTF-8")}
    for key in keys:
        # Explicitly resolve no values from any file/store/parent API.
        if key in os.environ:
            env[key] = os.environ[key]
    for key, value in generated.items():
        if not isinstance(key, str) or not isinstance(value, str) or not ENV_RE.fullmatch(key) or len(value.encode()) > 8192:
            raise Invalid()
        if key == "DISPLAY" or key in ("AGENTOR_PLUGIN_ID", "AGENTOR_PLUGIN_INSTANCE_ID", "AGENTOR_PLUGIN_DEFINITION_ID") or key.startswith("AGENTOR_PLUGIN_PORT_") or key == "AGENTOR_PLUGIN_DISPLAY":
            env[key] = value
        else:
            raise Invalid()
    return env


def state_path(ident: str) -> Path:
    RUNTIME.mkdir(parents=True, exist_ok=True, mode=0o700)
    try: os.chmod(RUNTIME, 0o700)
    except OSError: pass
    return RUNTIME / (ident + ".json")


def proc_start(pid: int) -> str | None:
    try:
        # field 22, with comm possibly containing spaces/parentheses
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        # A zombie has an identity in /proc but is no longer a runnable
        # background service.
        if fields[0] == "Z":
            return None
        return fields[19]
    except (OSError, IndexError):
        return None


def load_state(ident: str) -> dict[str, Any] | None:
    path = state_path(ident)
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict) or not isinstance(data.get("pid"), int) or not isinstance(data.get("start"), str) or data.get("start") != proc_start(data["pid"]):
            path.unlink(missing_ok=True); return None
        return data
    except (OSError, ValueError):
        return None


def write_state(ident: str, proc: subprocess.Popen[bytes], argv: list[str]) -> None:
    start = proc_start(proc.pid)
    if not start: raise RuntimeError()
    data = {"pid": proc.pid, "pgid": os.getpgid(proc.pid), "start": start, "argv": hashlib.sha256("\0".join(argv).encode()).hexdigest()}
    target = state_path(ident); temp = target.with_suffix(".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, separators=(",", ":")); f.flush(); os.fsync(f.fileno())
    os.replace(temp, target); os.chmod(target, 0o600)


def stop_state(ident: str, grace: float = 3.0) -> bool:
    data = load_state(ident)
    if not data: return False
    try: os.killpg(int(data["pgid"]), signal.SIGTERM)
    except ProcessLookupError: pass
    except OSError: return False
    until = time.monotonic() + grace
    while time.monotonic() < until and proc_start(int(data["pid"])) == data["start"]: time.sleep(.05)
    if proc_start(int(data["pid"])) == data["start"]:
        try: os.killpg(int(data["pgid"]), signal.SIGKILL)
        except OSError: pass
    state_path(ident).unlink(missing_ok=True)
    return True


def reconcile_skill(req: dict[str, Any], ident: str, enabled: bool) -> None:
    name = f"agentor-plugin-{ident}"
    raw = req.get("skillMarkdown")
    if raw is not None and (not isinstance(raw, str) or len(raw.encode()) > 256 * 1024 or "\0" in raw):
        raise Invalid()
    for root in SKILL_ROOTS:
        target = root / name
        if not enabled or not raw:
            try:
                (target / "SKILL.md").unlink(missing_ok=True)
                target.rmdir()
            except OSError:
                pass
            continue
        root.mkdir(parents=True, exist_ok=True)
        target.mkdir(mode=0o700, exist_ok=True)
        temporary = target / ".SKILL.md.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(raw)
            if not raw.endswith("\n"):
                stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target / "SKILL.md")
        os.chmod(target / "SKILL.md", 0o600)


def oneshot(spec: dict[str, Any], env: dict[str, str]) -> dict[str, Any]:
    proc = subprocess.Popen(spec["argv"], cwd=spec["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
    assert proc.stdout
    sel = selectors.DefaultSelector(); sel.register(proc.stdout, selectors.EVENT_READ)
    chunks: list[bytes] = []; size = 0; truncated = False; timed_out = False
    deadline = time.monotonic() + spec["timeout"]
    while sel.get_map():
        if time.monotonic() >= deadline and not timed_out:
            timed_out = True
            try: os.killpg(proc.pid, signal.SIGTERM)
            except OSError: pass
            deadline = time.monotonic() + 1
        for key, _ in sel.select(max(0, min(.1, deadline - time.monotonic()))):
            data = os.read(key.fd, 65536)
            if not data: sel.unregister(key.fileobj); continue
            remaining = spec["output"] - size
            if remaining > 0: chunks.append(data[:remaining]); size += min(len(data), remaining)
            if len(data) > remaining: truncated = True
            # Keeping a noisy command alive after its allowed response has
            # filled up makes the output limit merely a memory limit.  End its
            # process group too, while still draining already-buffered bytes.
            if truncated and proc.poll() is None:
                try: os.killpg(proc.pid, signal.SIGTERM)
                except OSError: pass
        if timed_out and time.monotonic() >= deadline and proc.poll() is None:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except OSError: pass
    rc = proc.wait()
    result: dict[str, Any] = {"exitCode": 124 if timed_out else rc}
    if chunks: result["output"] = b"".join(chunks).decode("utf-8", "replace")
    if truncated: result["truncated"] = True
    return result


def execute(req: dict[str, Any]) -> dict[str, Any]:
    ident = installation(req.get("installationId")); phase = req.get("phase")
    if phase not in ("install", "start", "stop", "cleanup"): raise Invalid()
    reconcile_skill(req, ident, phase in ("install", "start"))
    env = child_env(req)
    raw = req.get("command")
    if raw is None:
        if phase in ("stop", "cleanup"):
            stop_state(ident)
            return {"exitCode": 0}
        raise Invalid()
    spec = command(raw)
    if phase == "start" and spec["mode"] == "background":
        stop_state(ident)
        proc = subprocess.Popen(spec["argv"], cwd=spec["cwd"], env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        try: write_state(ident, proc, spec["argv"])
        except Exception:
            try: os.killpg(proc.pid, signal.SIGKILL)
            except OSError: pass
            return {"exitCode": 1}
        return {"exitCode": 0}
    if phase == "stop":
        try:
            return oneshot(spec, env)
        finally:
            stop_state(ident)
    return oneshot(spec, env)


def probe_once(req: dict[str, Any], ready: dict[str, Any], env: dict[str, str], ident: str) -> bool:
    kind = ready["kind"]
    if kind == "process": return load_state(ident) is not None
    if kind in ("tcp", "http"):
        alloc = req.get("allocations", {}); ports = alloc.get("ports", {}) if isinstance(alloc, dict) else {}
        port = ports.get(ready.get("portId")) if isinstance(ports, dict) else None
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535: raise Invalid()
        if kind == "tcp":
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=1): return True
            except OSError: return False
        path = ready.get("path", "/")
        if not isinstance(path, str) or not path.startswith("/") or "\0" in path or ".." in path.split("/"): raise Invalid()
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
                return 200 <= response.status < 400
        except (urllib.error.URLError, OSError, ValueError): return False
    if kind == "exec": return oneshot(ready["command"], env)["exitCode"] == 0
    raise Invalid()


def probe(req: dict[str, Any]) -> dict[str, Any]:
    ident = installation(req.get("installationId")); env = child_env(req); raw = req.get("readiness")
    if not isinstance(raw, dict) or set(raw) - {"kind", "portId", "path", "command", "timeoutSeconds", "intervalMs"}: raise Invalid()
    kind = raw.get("kind")
    if kind not in ("process", "tcp", "http", "exec"): raise Invalid()
    ready: dict[str, Any] = {"kind": kind, "timeout": positive(raw.get("timeoutSeconds"), 30)}
    interval = raw.get("intervalMs", 250)
    if isinstance(interval, bool) or not isinstance(interval, int) or not 50 <= interval <= 5000: raise Invalid()
    if kind == "exec": ready["command"] = command(raw.get("command"), background_ok=False)
    if kind in ("tcp", "http"): ready["portId"] = raw.get("portId")
    if kind == "http": ready["path"] = raw.get("path", "/")
    deadline = time.monotonic() + ready["timeout"]
    while True:
        if probe_once(req, ready, env, ident): return {"exitCode": 0}
        if time.monotonic() >= deadline: return {"exitCode": 1}
        time.sleep(min(interval / 1000, max(0, deadline - time.monotonic())))


def main() -> None:
    try:
        operation = sys.argv[1] if len(sys.argv) == 2 else ""
        req = read_request()
        result = execute(req) if operation == "execute" else probe(req) if operation == "probe" else None
        if result is None: raise Invalid()
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
    except Invalid: fail()
    except Exception: fail(1, "plugin runner failed")


if __name__ == "__main__": main()
