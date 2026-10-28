"""Artifact-boundary regressions; these tests do not build or alter a runtime."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cliptext_build_engine_tested", HERE / "build_engine.py")
build_engine = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(build_engine)


def wheel(path, records):
    with ZipFile(path, "w") as archive:
        for name, metadata in records:
            archive.writestr(name, metadata)


class WheelLockTests(unittest.TestCase):
    def test_vendored_nested_metadata_does_not_replace_distribution_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            artifact = root / "sample-1.2.3-py3-none-any.whl"
            wheel(artifact, [
                ("sample-1.2.3.dist-info/METADATA", "Metadata-Version: 2.1\nName: sample\nVersion: 1.2.3\n"),
                ("sample/_vendor/other-9.9.dist-info/METADATA", "Metadata-Version: 2.1\nName: other\nVersion: 9.9\n"),
            ])
            output = root / "requirements.lock"
            build_engine.wheel_lock(root, output)
            rows = [row for row in output.read_text().splitlines() if not row.startswith("#")]
            self.assertEqual(rows, ["sample==1.2.3 --hash=sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()])

    def test_ambiguous_or_only_nested_distribution_metadata_is_rejected(self):
        cases = [
            [("vendor/nested-1.dist-info/METADATA", "Name: nested\nVersion: 1\n")],
            [("one-1.dist-info/METADATA", "Name: one\nVersion: 1\n"),
             ("two-1.dist-info/METADATA", "Name: two\nVersion: 1\n")],
        ]
        for records in cases:
            with self.subTest(records=records), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                wheel(root / "ambiguous.whl", records)
                with self.assertRaisesRegex(ValueError, "metadata"):
                    build_engine.wheel_lock(root, root / "requirements.lock")
                self.assertFalse((root / "requirements.lock").exists())


class DownloadIntegrityTests(unittest.TestCase):
    def test_verified_cached_archive_never_contacts_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "python.tar.gz"
            destination.write_bytes(b"already-verified-python-artifact")
            expected = hashlib.sha256(destination.read_bytes()).hexdigest()
            with patch.object(build_engine.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")) as network:
                build_engine.download("https://example.invalid/python.tar.gz", destination, expected)
            network.assert_not_called()

    def test_bad_download_is_not_promoted_to_cache_or_left_as_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "python.tar.gz"
            destination.write_bytes(b"previous-cache-is-untouched-on-failure")
            expected = hashlib.sha256(b"expected-verified-artifact").hexdigest()
            with patch.object(build_engine.urllib.request, "urlopen", return_value=io.BytesIO(b"tampered-download")):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    build_engine.download("https://example.invalid/python.tar.gz", destination, expected)
            self.assertEqual(destination.read_bytes(), b"previous-cache-is-untouched-on-failure")
            self.assertFalse(destination.with_name(destination.name + ".partial").exists())


class DependencyConstraintTests(unittest.TestCase):
    def test_a_second_constraint_is_checked_after_distribution_was_expanded(self):
        # This uses the lock-bootstrap tool's own packaging dependency and no
        # installed package inventory; inconsistent root requirements must fail.
        spec = importlib.util.spec_from_file_location("cliptext_freeze_runtime_tested", HERE / "freeze_runtime.py")
        freeze = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(freeze)
        installed = types.SimpleNamespace(version="2.0", requires=[])
        with patch.object(freeze.metadata, "distribution", return_value=installed):
            with self.assertRaisesRegex(ValueError, "does not satisfy"):
                freeze.installed_closure(["fixture<2", "fixture>=2"])


if __name__ == "__main__":
    unittest.main()
