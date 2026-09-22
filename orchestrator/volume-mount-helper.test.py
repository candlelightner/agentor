import importlib.util
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location("helper", Path(__file__).with_name("volume-mount-helper.py"))
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class VolumeHelperTests(unittest.TestCase):
    def test_rejects_protected_paths_and_aliases(self):
        for path in ("/", "/etc/cache", "/home", "/home/agent", "/proc/1/root", "/var",
                     "/home/agent/.codex", "/data/../etc", "/data/", "/data//x", "relative"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                helper.validate_target(path)
        for path in ("/opt/models", "/home/agent/cache", "/var/lib/myapp", "/data"):
            helper.validate_target(path)

    def test_component_resolution_never_follows_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "real").mkdir()
            (root / "alias").symlink_to(root / "real")
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                for path in ("/alias", "/alias/child"):
                    with self.subTest(path=path), self.assertRaises(OSError):
                        helper.open_directory(fd, path)
                child = helper.open_directory(fd, "/real")
                os.close(child)
            finally:
                os.close(fd)

    def test_copies_bytes_links_and_modes_without_following_links(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            target = Path(directory) / "target"
            source.mkdir(mode=0o750)
            target.mkdir()
            (source / "nested").mkdir()
            (source / "nested/file").write_bytes(b"volume-data\x00" * 100)
            (source / "nested/file").chmod(0o640)
            os.link(source / "nested/file", source / "hardlink")
            (source / "outside-link").symlink_to("/etc/shadow")
            src = os.open(source, os.O_RDONLY | os.O_DIRECTORY)
            dst = os.open(target, os.O_RDONLY | os.O_DIRECTORY)
            try:
                helper.tree_identity(src, time.monotonic() + 10)
                helper.copy_tree(src, dst, time.monotonic() + 10)
                with self.assertRaisesRegex(ValueError, "not empty"):
                    helper.copy_tree(src, dst, time.monotonic() + 10)
            finally:
                os.close(src)
                os.close(dst)
            self.assertEqual((target / "nested/file").read_bytes(), (source / "nested/file").read_bytes())
            self.assertEqual((target / "hardlink").stat().st_ino, (target / "nested/file").stat().st_ino)
            self.assertEqual(os.readlink(target / "outside-link"), "/etc/shadow")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o750)
            self.assertEqual(stat.S_IMODE((target / "nested/file").stat().st_mode), 0o640)

    def test_scan_rejects_special_files_and_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            os.mkfifo(root / "fifo")
            fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                with self.assertRaisesRegex(ValueError, "special device"):
                    helper.tree_identity(fd, time.monotonic() + 10)
                with self.assertRaisesRegex(ValueError, "scan limit"):
                    helper.tree_identity(fd, time.monotonic() - 1)
            finally:
                os.close(fd)


if __name__ == "__main__":
    unittest.main()
