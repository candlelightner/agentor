"""Trusted one-shot helper: selected volume + target PID namespace only.

Agentor freezes the worker for the whole operation. No host root/socket/PID
namespace is mounted. Never execute code from the worker filesystem.
"""
import ctypes
import json
import os
import platform
import resource
import stat
import sys
import time

MAX_FILES = 100_000
MAX_BYTES = 20 * 1024**3
MAX_SECONDS = 120
PROTECTED = ["/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc",
             "/root", "/bin", "/sbin", "/lib", "/lib64", "/usr",
             "/var/lib/docker", "/var/lib/containerd", "/home/agent/.agent-data",
             "/home/agent/.ssh", "/home/agent/.claude", "/home/agent/.codex",
             "/home/agent/.gemini", "/home/agent/.agents",
             "/home/agent/.config/kilo", "/home/agent/.local/share/kilo"]


def validate_target(path):
    if not isinstance(path, str) or not path.startswith("/") or path == "/" or len(path) > 4096:
        raise ValueError("Invalid target directory")
    if os.path.normpath(path) != path or any(ord(c) < 32 or ord(c) == 127 or c in "\\:" for c in path):
        raise ValueError("Target must be canonical")
    if any(path == p or path.startswith(p + "/") or p.startswith(path + "/") for p in PROTECTED):
        raise ValueError("Protected target directory")


def open_directory(root_fd, path, create=False):
    fd = os.dup(root_fd)
    try:
        for part in path.strip("/").split("/"):
            if part in ("", ".", ".."):
                raise ValueError("Invalid component")
            try:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=fd)
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.fchown(child, 1000, 1000)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def tree_identity(root_fd, deadline):
    identities = set()
    size = 0

    def walk(fd):
        nonlocal size
        st = os.fstat(fd)
        identities.add((st.st_dev, st.st_ino))
        for name in os.listdir(fd):
            if time.monotonic() > deadline or len(identities) >= MAX_FILES:
                raise ValueError("Directory exceeds live-mount scan limit; use recreation")
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            identities.add((st.st_dev, st.st_ino))
            if stat.S_ISDIR(st.st_mode):
                sub = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    walk(sub)
                finally:
                    os.close(sub)
            elif stat.S_ISREG(st.st_mode):
                size += st.st_size
                if size > MAX_BYTES:
                    raise ValueError("Directory exceeds live-mount copy limit; use recreation")
            elif not stat.S_ISLNK(st.st_mode):
                raise ValueError("Directory contains a socket or special device; stop its application first")
    walk(root_fd)
    return identities


def assert_not_busy(identities):
    # Pausing alone does not close descriptors still addressing the old tree.
    for pid in os.listdir("/proc"):
        if not pid.isdigit() or int(pid) == os.getpid():
            continue
        try:
            handles = [f"/proc/{pid}/cwd", f"/proc/{pid}/exe"]
            handles += [f"/proc/{pid}/fd/{n}" for n in os.listdir(f"/proc/{pid}/fd")]
            handles += [f"/proc/{pid}/map_files/{n}" for n in os.listdir(f"/proc/{pid}/map_files")]
            for handle in handles:
                try:
                    st = os.stat(handle)
                except FileNotFoundError:
                    continue
                if (st.st_dev, st.st_ino) in identities:
                    raise ValueError("Directory is busy: close files and stop its applications, or choose recreation")
        except FileNotFoundError:
            continue


def copy_tree(source_fd, destination_fd, deadline):
    if os.listdir(destination_fd):
        raise ValueError("Volume is not empty; refusing to overwrite established data")
    hardlinks = {}

    def copy(src, dst):
        for name in os.listdir(src):
            if time.monotonic() > deadline:
                raise ValueError("Copy deadline exceeded")
            st = os.stat(name, dir_fd=src, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                os.mkdir(name, 0o700, dir_fd=dst)
                sf = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=src)
                df = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=dst)
                try:
                    copy(sf, df)
                finally:
                    os.close(sf)
                    os.close(df)
            elif stat.S_ISREG(st.st_mode):
                key = (st.st_dev, st.st_ino)
                if key in hardlinks:
                    old_fd, old_name = hardlinks[key]
                    os.link(old_name, name, src_dir_fd=old_fd, dst_dir_fd=dst, follow_symlinks=False)
                else:
                    sf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=src)
                    df = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dst)
                    try:
                        while True:
                            if time.monotonic() > deadline:
                                raise ValueError("Copy deadline exceeded")
                            chunk = os.read(sf, 1024 * 1024)
                            if not chunk:
                                break
                            view = memoryview(chunk)
                            while view:
                                view = view[os.write(df, view):]
                        os.fsync(df)
                    finally:
                        os.close(sf)
                        os.close(df)
                    if st.st_nlink > 1:
                        hardlinks[key] = (os.dup(dst), name)
            elif stat.S_ISLNK(st.st_mode):
                os.symlink(os.readlink(name, dir_fd=src), name, dir_fd=dst)
            else:
                raise ValueError("Special files cannot be persisted")
            os.chown(name, st.st_uid, st.st_gid, dir_fd=dst, follow_symlinks=False)
            if not stat.S_ISLNK(st.st_mode):
                os.chmod(name, stat.S_IMODE(st.st_mode), dir_fd=dst, follow_symlinks=False)
            os.utime(name, ns=(st.st_atime_ns, st.st_mtime_ns), dir_fd=dst, follow_symlinks=False)
        st = os.fstat(src)
        os.fchown(dst, st.st_uid, st.st_gid)
        os.fchmod(dst, stat.S_IMODE(st.st_mode))
        os.utime(dst, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.fsync(dst)
    try:
        copy(source_fd, destination_fd)
    finally:
        for fd, _ in hardlinks.values():
            os.close(fd)


def live_mount(target, seeded=False):
    validate_target(target)
    if platform.machine() not in ("x86_64", "aarch64"):
        raise ValueError("Live mounting requires Linux amd64/arm64; use recreation")
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long

    def syscall(number, *args):
        result = libc.syscall(ctypes.c_long(number), *args)
        if result < 0:
            raise OSError(ctypes.get_errno(), "Live mount syscall failed")
        return result

    root = os.open("/proc/1/root", os.O_RDONLY | os.O_DIRECTORY)
    namespace = os.open("/proc/1/ns/mnt", os.O_RDONLY)
    volume = os.open("/volume", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    target_fd = tree = None
    try:
        # open_tree/move_mount syscall numbers match on amd64/arm64, Linux >=5.2.
        tree = syscall(428, ctypes.c_int(volume), ctypes.c_char_p(b""), ctypes.c_uint(1 | os.O_CLOEXEC | 0x1000))
        target_fd = open_directory(root, target, create=True)
        with open("/proc/1/mountinfo", encoding="utf-8") as mounts:
            for line in mounts:
                mountpoint = line.split()[4]
                for encoded, decoded in (("\\040", " "), ("\\011", "\t"), ("\\134", "\\")):
                    mountpoint = mountpoint.replace(encoded, decoded)
                if mountpoint == target or mountpoint.startswith(target + "/"):
                    raise ValueError("Target overlaps an existing mount")
        deadline = time.monotonic() + MAX_SECONDS
        assert_not_busy(tree_identity(target_fd, deadline))
        if not seeded:
            copy_tree(target_fd, volume, deadline)
        if libc.setns(namespace, 0) != 0:
            raise OSError(ctypes.get_errno(), "Cannot enter target mount namespace")
        syscall(429, ctypes.c_int(tree), ctypes.c_char_p(b""), ctypes.c_int(target_fd), ctypes.c_char_p(b""), ctypes.c_uint(0x4 | 0x40))
    finally:
        for fd in (tree, target_fd, volume, namespace, root):
            if fd is not None:
                os.close(fd)


def probe(target):
    validate_target(target)
    root = os.open("/proc/1/root", os.O_RDONLY | os.O_DIRECTORY)
    try:
        try:
            fd = open_directory(root, target)
        except FileNotFoundError:
            return False
        try:
            actual, expected = os.fstat(fd), os.stat("/volume")
            return (actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino)
        finally:
            os.close(fd)
    finally:
        os.close(root)


if __name__ == "__main__":
    try:
        resource.setrlimit(resource.RLIMIT_AS, (256 * 1024**2, 256 * 1024**2))
        resource.setrlimit(resource.RLIMIT_CPU, (MAX_SECONDS, MAX_SECONDS))
        resource.setrlimit(resource.RLIMIT_NOFILE, (2048, 2048))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if len(sys.argv) != 3 or sys.argv[2] not in ("new", "seeded", "probe"):
            raise ValueError("Invalid helper invocation")
        if sys.argv[2] == "probe":
            print(json.dumps({"ok": True, "mounted": probe(sys.argv[1])}))
        else:
            live_mount(sys.argv[1], sys.argv[2] == "seeded")
            print(json.dumps({"ok": True}))
    except (OSError, ValueError) as error:
        message = str(error) if isinstance(error, ValueError) else "Live mount unavailable on this runtime; use recreation"
        print(json.dumps({"ok": False, "error": message[:300]}))
        sys.exit(1)
