import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import uuid

SPEC = importlib.util.spec_from_file_location("incus_host_mount_sources",
    Path(__file__).resolve().parents[2] / "scripts/incus-host-mount-sources.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SourcesTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="incus-host-sources-")
        self.addCleanup(self.scratch.cleanup)
        self.root = Path(self.scratch.name)
        for name in ["data", "incus", "credentials", "pool", "share", "other"]:
            (self.root / name).mkdir()
        self.record = {"schemaVersion": 1, "id": str(uuid.uuid4()),
                       "sourcePath": str(self.root / "share"), "allowWrite": False}
        self.options = {"data_path": str(self.root / "data"), "incus_path": str(self.root / "incus"),
                        "protected_paths": [str(self.root / "credentials"), str(self.root / "pool")],
                        "existing_exports": [], "mountinfo": "1 0 8:1 / / rw - ext4 /dev/vda1 rw\n"}

    def check(self, records=None, **changes):
        return MODULE.validate_sources(records if records is not None else [self.record],
                                       **{**self.options, **changes})

    def test_exact_disjoint_directory_preserves_mode_and_identity_without_modification(self):
        before = os.stat(self.record["sourcePath"])
        for writable in [False, True]:
            self.record["allowWrite"] = writable
            result = self.check()[0]
            self.assertEqual(result["allowWrite"], writable)
            self.assertEqual(result["identity"], (before.st_dev, before.st_ino))
        self.assertEqual(os.stat(self.record["sourcePath"]), before)

    def test_protected_actual_data_pool_credentials_and_their_ancestors_are_denied(self):
        for source in ["/var/lib/incus", str(self.root), *self.options["protected_paths"],
                       self.options["data_path"], self.options["incus_path"]]:
            with self.subTest(source=source), self.assertRaises(MODULE.SourceRejected):
                self.check([{**self.record, "sourcePath": source}])

    def test_symlink_source_and_symlink_parent_never_bless_an_alias(self):
        (self.root / "link").symlink_to(self.root / "share", target_is_directory=True)
        (self.root / "parent").symlink_to(self.root / "incus", target_is_directory=True)
        for source in [self.root / "link", self.root / "parent" / "nested"]:
            with self.assertRaises(MODULE.SourceRejected):
                self.check([{**self.record, "sourcePath": str(source)}])

    def test_protected_location_resolving_to_host_root_fails_closed(self):
        protected = self.root / "protected-root"; protected.symlink_to("/", target_is_directory=True)
        with self.assertRaises(MODULE.SourceRejected):
            self.check(protected_paths=[str(protected)])

    def test_parent_export_even_after_catalog_removal_blocks_guest_replacement_channel(self):
        nested = self.root / "share" / "nested"; nested.mkdir()
        candidate = {**self.record, "sourcePath": str(nested)}
        with self.assertRaises(MODULE.SourceRejected):
            self.check([candidate], existing_exports=[str(self.root / "share")])
        # Same export root does not expose its parent, and may be shared.
        self.assertEqual(len(self.check(existing_exports=[self.record["sourcePath"]])), 1)

    def test_catalog_overlap_and_unknown_modes_are_denied(self):
        nested = self.root / "share" / "nested"; nested.mkdir()
        with self.assertRaises(MODULE.SourceRejected):
            self.check([self.record, {**self.record, "id": str(uuid.uuid4()), "sourcePath": str(nested)}])
        for patch in [{"allowWrite": "true"}, {"schemaVersion": True}, {"id": "../other"},
                      {"sourcePath": str(self.root / "share") + ",/etc"}]:
            with self.assertRaises(MODULE.SourceRejected):
                self.check([{**self.record, **patch}])

    def test_host_bind_alias_is_denied_but_ordinary_filesystem_mount_remains_supported(self):
        source = self.record["sourcePath"]
        with self.assertRaises(MODULE.SourceRejected):
            self.check(mountinfo=self.options["mountinfo"] +
                       f"2 1 8:1 /var/lib/incus {source} rw - ext4 /dev/vda1 rw\n")
        with self.assertRaises(MODULE.SourceRejected):
            self.check(mountinfo=self.options["mountinfo"] +
                       f"2 1 8:1 / {source} rw - ext4 /dev/vda1 rw\n")
        self.assertEqual(len(self.check(mountinfo=self.options["mountinfo"] +
                                       f"2 1 8:2 / {source} rw - ext4 /dev/vdb rw\n")), 1)
        with self.assertRaises(MODULE.SourceRejected):
            self.check(mountinfo="")

    def test_source_replacement_changes_immediate_identity_and_revalidation_detects_it(self):
        before = self.check()
        source = Path(self.record["sourcePath"])
        source.rename(self.root / "old-share"); source.mkdir()
        self.assertNotEqual(self.check(), before)


if __name__ == "__main__":
    unittest.main()
