/**
 * A single, audited Python probe executed inside a worker container (as
 * uid 1000 / `agent`) to perform realpath/lstat containment checks and
 * one-level directory listings of `/workspace`.
 *
 * Why Python: the worker image ships `python3` (Ubuntu 24.04 base), and Python
 * gives portable `os.lstat`/`os.readlink`/`os.path.realpath` + ISO mtime
 * formatting without shelling out to `stat`/`find` whose flag sets vary.
 *
 * Why argv (not interpolation): the probe is invoked as
 *   `python3 -c <PROBE_SCRIPT> <subcommand> <arg>...`
 * The script body is a fixed constant defined here (audited once); every path
 * argument is passed as a SEPARATE argv element (`sys.argv[2]`…) and is never
 * interpolated into source, so a path can never inject code or break out of
 * the probe's own logic. The server has already lexically validated each path
 * before invoking the probe; the probe performs the in-container realpath
 * containment check that defeats symlink traversal.
 *
 * Output contract: exactly one JSON object on stdout. Exit codes:
 *   0  success            -> `{ "ok": true, ...payload }`
 *   1  not found (ENOENT)  -> `{ "ok": false, "error": "not_found", "path": ... }`
 *   2  escapes workspace   -> `{ "ok": false, "error": "escapes", "path": ... }`
 *   3  not a directory     -> `{ "ok": false, "error": "not_directory", "path": ... }`
 *   4  other OS error      -> `{ "ok": false, "error": "<str(errno)>", "path": ..., "message": ... }`
 *   64 bad invocation      -> `{ "ok": false, "error": "bad_args" }`
 *
 * Containment rule: the REALPATH of a path must equal `/workspace` or live
 * under `/workspace/` for EVERY entry type — not just symlinks. A regular file
 * reached through an intermediate symlink (e.g. `/workspace/link -> /etc`,
 * path `link/passwd`) has realpath `/etc/passwd` and is rejected as escaping.
 * For a missing target (used by upload/move/delete/create pre-checks), the
 * probe walks up to the nearest existing ancestor and requires THAT ancestor's
 * realpath to be contained; if the ancestor escapes, the requested path is
 * reported as escaping (this catches a nested upload path whose parent is an
 * escaping symlink before any byte is written).
 */
import type { FileEntry } from '../../shared/types';

export const WORKSPACE_PROBE_SCRIPT = `
import os, sys, json, errno, datetime

ROOT = "/workspace"
ROOT_SLASH = ROOT + "/"

def _contained(p):
    rp = os.path.realpath(p)
    return rp == ROOT or rp.startswith(ROOT_SLASH)

def _entry(name, full, rel):
    st = os.lstat(full)
    if os.path.islink(full):
        typ = "symlink"
        try:
            link_target = os.readlink(full)
        except OSError:
            link_target = None
    elif os.path.isdir(full):
        typ = "directory"
        link_target = None
    else:
        typ = "file"
        link_target = None
    # Containment is checked for ALL types via realpath (see module docstring):
    # a regular file reached through an intermediate escaping symlink must be
    # flagged. lstat itself does not follow symlinks, so realpath is the
    # authoritative containment signal.
    try:
        escapes = not _contained(full)
    except OSError:
        escapes = True
    size = 0 if typ in ("directory", "symlink") else st.st_size
    mtime = datetime.datetime.utcfromtimestamp(st.st_mtime).strftime("%Y-%m-%dT%H:%M:%SZ")
    e = {"name": name, "path": rel, "type": typ, "size": size, "mtime": mtime,
         "mode": format(st.st_mode & 0o7777, "04o"), "owner": str(st.st_uid), "group": str(st.st_gid)}
    if link_target is not None:
        e["linkTarget"] = link_target
    if escapes:
        e["linkEscapes"] = True
    return e

def _emit(obj, code=0):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()
    sys.exit(code)

def _fail(kind, path=None, message=None, code=4):
    o = {"ok": False, "error": kind}
    if path is not None:
        o["path"] = path
    if message is not None:
        o["message"] = message
    _emit(o, code)

def _nearest_existing_ancestor(full):
    # Walk up from the path to the nearest existing ancestor, returning
    # (ancestor, exists_flag). exists_flag is True when the path itself exists.
    cur = full
    while True:
        try:
            os.lstat(cur)
            return cur, (cur == full)
        except OSError as e:
            if e.errno != errno.ENOENT:
                raise
            parent = os.path.dirname(cur)
            if parent == cur:
                # Reached filesystem root without finding anything.
                return cur, False
            cur = parent

def _check_ancestor_contained(full):
    # For a (possibly missing) path, require the nearest existing ancestor's
    # realpath to be contained in /workspace. Returns True when contained (or
    # when the path is /workspace itself), False when an ancestor escapes — in
    # which case the requested path is reported as escaping.
    if full == ROOT:
        return True
    ancestor, _exists = _nearest_existing_ancestor(full)
    try:
        return _contained(ancestor)
    except OSError:
        return False

def cmd_lstat(args):
    if len(args) != 1:
        _fail("bad_args", code=64)
    full = args[0]
    try:
        os.lstat(full)
    except OSError as e:
        if e.errno in (errno.ENOENT, errno.ENOTDIR):
            # A missing path may still be rejected as escaping if its nearest
            # existing ancestor escapes (e.g. lstat of a path under an escaping
            # symlink). ENOTDIR means an intermediate component is a non-dir
            # file — surface as not_found (the path cannot be resolved).
            if e.errno == errno.ENOENT and not _check_ancestor_contained(full):
                _fail("escapes", full, code=2)
            _fail("not_found", full, code=1)
        _fail(e.__class__.__name__, full, str(e), code=4)
    rel = full[len(ROOT):].lstrip("/") if full != ROOT else ""
    name = os.path.basename(full) if full != ROOT else "."
    e = _entry(name, full, rel)
    if e.get("linkEscapes"):
        _fail("escapes", full, code=2)
    _emit({"ok": True, "entry": e})

def cmd_list(args):
    if len(args) != 1:
        _fail("bad_args", code=64)
    full = args[0]
    try:
        os.lstat(full)
    except OSError as e:
        if e.errno == errno.ENOENT:
            if not _check_ancestor_contained(full):
                _fail("escapes", full, code=2)
            _fail("not_found", full, code=1)
        _fail(e.__class__.__name__, full, str(e), code=4)
    # The directory itself must be contained (realpath) before listing.
    try:
        if not _contained(full):
            _fail("escapes", full, code=2)
    except OSError:
        _fail("escapes", full, code=2)
    if not os.path.isdir(full):
        _fail("not_directory", full, code=3)
    rel = full[len(ROOT):].lstrip("/") if full != ROOT else ""
    names = []
    try:
        names = os.listdir(full)
    except OSError as e:
        _fail(e.__class__.__name__, full, str(e), code=4)
    entries = []
    for nm in names:
        child_full = os.path.join(full, nm)
        child_rel = (rel + "/" + nm) if rel else nm
        try:
            e = _entry(nm, child_full, child_rel)
        except OSError as ex:
            # Skip unreadable entries but keep the listing usable.
            continue
        entries.append(e)
    entries.sort(key=lambda x: (x["type"] != "directory", x["name"].lower(), x["name"]))
    _emit({"ok": True, "path": rel, "entries": entries})

def cmd_check_many(args):
    # Paths are supplied on stdin as a JSON array of absolute in-container paths
    # (never interpolated into source). For each path returns whether it exists
    # and whether it (or its nearest existing ancestor) escapes /workspace.
    # This powers the upload/move/delete pre-checks in a single exec and is the
    # primary escape gate for nested upload paths whose parent is an escaping
    # symlink.
    if len(args) != 0:
        _fail("bad_args", code=64)
    # One newline-framed JSON record avoids depending on EOF propagation over
    # Docker's hijacked exec socket.
    raw = sys.stdin.readline()
    try:
        paths = json.loads(raw) if raw else []
    except Exception:
        _fail("bad_args", code=64)
    if not isinstance(paths, list):
        _fail("bad_args", code=64)
    existing = []
    escaping = []
    for p in paths:
        if not isinstance(p, str):
            continue
        try:
            os.lstat(p)
            exists = True
        except OSError as e:
            if e.errno == errno.ENOENT:
                exists = False
            else:
                exists = True
        # Containment is checked for the path's nearest existing ancestor so a
        # missing target under an escaping symlink is flagged as escaping (this
        # is what blocks an upload into a nested path whose parent is an
        # escaping symlink, even when overwrite=true).
        if not _check_ancestor_contained(p):
            escaping.append(p)
            # A missing escaping path is not "existing" but is still escaping;
            # only append to existing when it actually exists.
            if exists:
                existing.append(p)
            continue
        if exists:
            existing.append(p)
    _emit({"ok": True, "existing": existing, "escaping": escaping})

def main():
    if len(sys.argv) < 2:
        _fail("bad_args", code=64)
    sub = sys.argv[1]
    rest = sys.argv[2:]
    if sub == "lstat":
        cmd_lstat(rest)
    elif sub == "list":
        cmd_list(rest)
    elif sub == "check_many":
        cmd_check_many(rest)
    else:
        _fail("bad_args", code=64)

main()
`;

/** Result of a Docker exec capture (non-TTY, demuxed stdout/stderr + exit
 *  code from `exec.inspect`). */
export interface ExecCaptureResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
}

/** Parsed probe result. `ok` mirrors the probe's own flag; the discriminator is
 *  the `error` field when `ok` is false. */
export type ProbeResult =
  | { ok: true; entry?: FileEntry; path?: string; entries?: FileEntry[]; existing?: string[]; escaping?: string[] }
  | { ok: false; error: string; path?: string; message?: string };
