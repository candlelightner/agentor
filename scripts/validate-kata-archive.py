#!/usr/bin/env python3
"""Read-only validation before extracting a checksummed Kata release archive."""
import posixpath
import subprocess
import sys
import tarfile


def inside_tree(path):
    return path == "opt/kata" or path.startswith("opt/kata/")


def member_path(path):
    if path.startswith("/") or ".." in path.split("/"):
        raise ValueError(f"absolute/traversing archive path: {path!r}")
    normalized = posixpath.normpath(path)
    if not inside_tree(normalized):
        raise ValueError(f"path outside opt/kata: {path!r}")
    return normalized


def validate(stream):
    members = {}
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for item in archive:
            path = member_path(item.name)
            if path in members:
                raise ValueError(f"duplicate archive member: {path!r}")
            if not (item.isfile() or item.isdir() or item.issym() or item.islnk()):
                raise ValueError(f"special archive entry: {path!r}")
            if path == "opt/kata" and not item.isdir():
                raise ValueError("archive root must be a directory")
            if item.issym() or item.islnk():
                if item.linkname.startswith("/"):
                    raise ValueError(f"absolute archive link: {path!r}")
                target = (posixpath.normpath(posixpath.join(posixpath.dirname(path), item.linkname))
                          if item.issym() else member_path(item.linkname))
                if not inside_tree(target):
                    raise ValueError(f"link escapes archive tree: {path!r}")
            members[path] = item
    if not members:
        raise ValueError("empty archive")
    for path, item in members.items():
        parent = posixpath.dirname(path)
        while inside_tree(parent):
            if parent in members and not members[parent].isdir():
                raise ValueError(f"member beneath non-directory: {path!r}")
            parent = posixpath.dirname(parent)
        if item.islnk():
            target = members.get(member_path(item.linkname))
            if target is None or not target.isfile():
                raise ValueError(f"hardlink target is not a regular member: {path!r}")
        if item.issym():
            # Normalize only after resolving every symlink: a/../b can escape
            # despite looking internal if a itself points at a shallower path.
            pending = path.split("/")[2:]
            resolved = ["opt", "kata"]
            hops = 0
            while pending:
                component = pending.pop(0)
                if component in ("", "."):
                    continue
                if component == "..":
                    if len(resolved) <= 2:
                        raise ValueError(f"resolved link escapes archive tree: {path!r}")
                    resolved.pop()
                    continue
                resolved.append(component)
                linked = members.get("/".join(resolved))
                if linked is not None and linked.issym():
                    hops += 1
                    if hops > 40:
                        raise ValueError(f"cyclic or excessively chained link: {path!r}")
                    resolved.pop()
                    pending = linked.linkname.split("/") + pending


def main():
    if len(sys.argv) != 2:
        raise ValueError("expected one .tar.zst archive path")
    with subprocess.Popen(["zstd", "-dc", "--", sys.argv[1]], stdout=subprocess.PIPE) as decompressor:
        try:
            validate(decompressor.stdout)
            # Consume stream trailer so zstd can validate the complete frame.
            while decompressor.stdout.read(1024 * 1024):
                pass
        except Exception:
            decompressor.kill()
            raise
        if decompressor.wait() != 0:
            raise ValueError("zstd decompression failed")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, tarfile.TarError, OSError) as error:
        print(f"Unsafe Kata archive: {error}", file=sys.stderr)
        sys.exit(1)
