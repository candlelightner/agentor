import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('restore', Path(__file__).with_name('restore-worker-home.py'))
restore = importlib.util.module_from_spec(spec)
spec.loader.exec_module(restore)


class ArchiveValidation(unittest.TestCase):
    def check_entries(self, entries, valid):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'home.tar'
            with tarfile.open(path, 'w') as archive:
                for name, link in entries:
                    member = tarfile.TarInfo(name)
                    if link is not None:
                        member.type = tarfile.SYMTYPE
                        member.linkname = link
                    else:
                        member.size = 1
                    archive.addfile(member, io.BytesIO(b'x') if link is None else None)
            if valid:
                restore.validate_archive(path, '.local')
            else:
                with self.assertRaises(ValueError):
                    restore.validate_archive(path, '.local')

    def test_cli_and_canonical_links(self):
        self.check_entries([('.local/bin/codex', '../lib/codex'),
                            ('.local/lib/codex', None),
                            ('.local/state/kilo', '/home/agent/.agent-data/.kilo/state')], True)

    def test_path_traversal(self):
        for name in ['/etc/passwd', '.local/../../escape', '.config/unselected']:
            with self.subTest(name=name):
                self.check_entries([(name, None)], False)

    def test_escaping_links(self):
        for target in ['/etc', '../../escape']:
            with self.subTest(target=target):
                self.check_entries([('.local/link', target)], False)

    def test_symlink_ancestor_in_either_order(self):
        entries = [('.local/state', '/home/agent/.agent-data'), ('.local/state/overwrite', None)]
        self.check_entries(entries, False)
        self.check_entries(list(reversed(entries)), False)


if __name__ == '__main__':
    unittest.main()
