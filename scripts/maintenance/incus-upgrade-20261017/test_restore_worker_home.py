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


class ClaudePreferences(unittest.TestCase):
    def test_already_canonical_symlink_is_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical, captured, backup = (root / name for name in ['canonical', 'captured', 'backup'])
            canonical.write_text('{"latest":true}')
            captured.symlink_to(canonical)
            restore.reconcile_claude_preferences(captured, canonical, backup)
            self.assertEqual(canonical.read_text(), '{"latest":true}')
            self.assertFalse(backup.exists())

    def test_atomic_write_replacement_preserves_previous_canonical_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical, captured, backup = (root / name for name in ['canonical', 'captured', 'backup'])
            canonical.write_text('{"old":true}')
            captured.write_text('{"new":true}')
            restore.reconcile_claude_preferences(captured, canonical, backup)
            restore.reconcile_claude_preferences(captured, canonical, backup)
            self.assertEqual(canonical.read_text(), '{"new":true}')
            self.assertEqual(backup.read_text(), '{"old":true}')

    def test_invalid_captured_json_does_not_overwrite_canonical(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical, captured, backup = (root / name for name in ['canonical', 'captured', 'backup'])
            canonical.write_text('{"old":true}')
            captured.write_text('incomplete JSON')
            with self.assertRaises(ValueError):
                restore.reconcile_claude_preferences(captured, canonical, backup)
            self.assertEqual(canonical.read_text(), '{"old":true}')
            self.assertFalse(backup.exists())


if __name__ == '__main__':
    unittest.main()
