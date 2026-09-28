#!/usr/bin/env python3
"""Offline, in-memory malicious archive fixtures. No extraction or host access."""
import importlib.util
import io
from pathlib import Path
import tarfile
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location(
    "kata_archive", Path(__file__).resolve().parents[1] / "scripts/validate-kata-archive.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def archive(*entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as output:
        for name, kind, target in entries:
            item = tarfile.TarInfo(name)
            item.type = kind
            item.linkname = target
            output.addfile(item)
    stream.seek(0)
    return stream


class ArchiveFixtures(unittest.TestCase):
    def test_internal_files_and_links(self):
        validator.validate(archive(
            ("opt/kata", tarfile.DIRTYPE, ""),
            ("opt/kata/bin/shim", tarfile.REGTYPE, ""),
            ("opt/kata/shim", tarfile.SYMTYPE, "bin/shim"),
            ("opt/kata/lib/shim", tarfile.SYMTYPE, "../bin/shim"),
            ("opt/kata/hard", tarfile.LNKTYPE, "opt/kata/bin/shim")))

    def test_reject_unsafe_paths_and_types(self):
        for name, kind, target in [
            ("/opt/kata/absolute", tarfile.REGTYPE, ""),
            ("opt/kata/../../escape", tarfile.REGTYPE, ""),
            ("opt/other/file", tarfile.REGTYPE, ""),
            ("opt/kata/device", tarfile.CHRTYPE, ""),
            ("opt/kata/fifo", tarfile.FIFOTYPE, ""),
            ("opt/kata/link", tarfile.SYMTYPE, "../../etc"),
            ("opt/kata/link", tarfile.SYMTYPE, "/etc"),
            ("opt/kata/link", tarfile.LNKTYPE, "opt/kata/missing"),
            ("opt/kata/link", tarfile.LNKTYPE, "opt/kata/../../etc/passwd"),
            ("opt/kata/link", tarfile.LNKTYPE, "/etc/passwd"),
        ]:
            with self.subTest(name=name, kind=kind, target=target):
                with self.assertRaises(ValueError):
                    validator.validate(archive((name, kind, target)))

    def test_reject_symlink_ancestors_in_either_order(self):
        entries = [("opt/kata/link", tarfile.SYMTYPE, "target"),
                   ("opt/kata/link/file", tarfile.REGTYPE, "")]
        for order in (entries, list(reversed(entries))):
            with self.assertRaises(ValueError):
                validator.validate(archive(*order))

    def test_reject_duplicate_and_empty_archives(self):
        with self.assertRaises(ValueError):
            validator.validate(archive(*[("opt/kata/file", tarfile.REGTYPE, "")] * 2))
        with self.assertRaises(ValueError):
            validator.validate(archive())

    def test_reject_link_chain_escape_and_cycles(self):
        with self.assertRaises(ValueError):
            validator.validate(archive(
                ("opt/kata/base", tarfile.SYMTYPE, "."),
                ("opt/kata/deep/escape", tarfile.SYMTYPE, "../base/../outside")))
        with self.assertRaises(ValueError):
            validator.validate(archive(
                ("opt/kata/a", tarfile.SYMTYPE, "b"),
                ("opt/kata/b", tarfile.SYMTYPE, "a")))


if __name__ == "__main__":
    unittest.main()
