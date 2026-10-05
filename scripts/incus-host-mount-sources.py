"""Host-only validation of exact catalog exports before Incus allowlisting.

This module does not grant paths, mount filesystems, or execute commands. The
operator-installed service supplies current native exports and pinned storage /
credential locations. Request bodies must never supply these authority inputs.
"""
import os
import re


class SourceRejected(ValueError):
    pass


SYSTEM_PATHS = ("/proc", "/sys", "/dev", "/run", "/var/run", "/boot", "/etc", "/root",
                "/usr", "/bin", "/sbin", "/lib", "/lib64", "/var/lib/docker",
                "/var/lib/containerd", "/var/lib/incus")
UUID = re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}")


def canonical(path):
    if not isinstance(path, str) or not path.startswith("/") or path.startswith("//") or path == "/" or \
            os.path.normpath(path) != path or re.search(r"[\x00-\x1f\x7f\\:,]", path):
        raise SourceRejected("Exact canonical absolute host directory required")
    return path


def overlaps(left, right):
    return left == "/" or right == "/" or left == right or left.startswith(right + "/") or right.startswith(left + "/")


def directory_identity(path):
    """Refuse symlink components, including symlinks to otherwise safe trees."""
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for part in canonical(path).split("/")[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
        return info.st_dev, info.st_ino
    except OSError as error:
        raise SourceRejected("Catalog source is missing, nondirectory, or has a symlink component") from error
    finally:
        os.close(descriptor)


def alias_mounts(mountinfo):
    """A non-root mount root can alias a protected subtree; reject ambiguity.

    realpath does not detect host bind mounts. Ordinary filesystem mounts with
    root '/' remain supported; this is not a filesystem candidate scanner.
    """
    if not isinstance(mountinfo, str) or len(mountinfo) > 4 * 1024 * 1024:
        raise SourceRejected("Host mount authority is unavailable")
    aliases, roots, root_seen = [], {}, False
    for line in mountinfo.splitlines():
        fields = line.split()
        if len(fields) < 10 or "-" not in fields:
            raise SourceRejected("Host mount authority is malformed")
        target = re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), fields[4])
        if target == "/":
            root_seen = True
            roots.setdefault(fields[2], set()).add(target)
            continue
        if fields[3] != "/":
            aliases.append(canonical(target))
        else:
            roots.setdefault(fields[2], set()).add(target)
    # Binding an entire filesystem has root '/' too. Multiple locations for
    # that same device are aliases, not a newly mounted independent filesystem.
    for targets in roots.values():
        if len(targets) > 1:
            aliases.extend(canonical(target) for target in targets if target != "/")
    if not root_seen:
        raise SourceRejected("Host root mount authority is unavailable")
    return aliases


def validate_sources(catalog, *, data_path, incus_path, protected_paths, existing_exports, mountinfo):
    """Return immediate source identities, not durable export authority.

    Revalidate this result before granting/exporting. Disjointness includes
    stale native exports after failed revocation, not just today's catalog.
    A guest can modify an export's contents, but cannot rename its host root or
    parent through that export. Disjoint trees exclude that replacement channel.
    """
    protected = [canonical(data_path), canonical(incus_path)]
    protected += [canonical(path) for path in protected_paths]
    protected += [os.path.realpath(path) for path in protected]
    protected += list(SYSTEM_PATHS) + alias_mounts(mountinfo)
    exports = [canonical(path) for path in existing_exports]
    if not isinstance(catalog, list) or len(catalog) > 4096:
        raise SourceRejected("Bounded platform host-mount catalog required")
    result, ids, sources = [], set(), []
    for record in catalog:
        if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or record.get("schemaVersion") != 1 or \
                not isinstance(record.get("id"), str) or not UUID.fullmatch(record["id"]) or \
                type(record.get("allowWrite")) is not bool or record["id"] in ids:
            raise SourceRejected("Catalog identity or mode is ambiguous")
        source = canonical(record.get("sourcePath"))
        if any(overlaps(source, path) for path in protected + sources) or \
                any(source != path and overlaps(source, path) for path in exports):
            raise SourceRejected("Catalog source overlaps protected storage, another catalog tree, or a stale export")
        identity = directory_identity(source)
        sources.append(source)
        ids.add(record["id"])
        result.append({"id": record["id"], "sourcePath": source, "allowWrite": record["allowWrite"],
                       "identity": identity})
    return result
