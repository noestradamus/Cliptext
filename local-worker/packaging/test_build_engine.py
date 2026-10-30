"""Artifact-boundary regressions; these tests do not build or alter a runtime."""
import hashlib
import importlib.util
import io
import os
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


class TargetWheelTests(unittest.TestCase):
    platform = 'macosx_15_0_arm64'

    def fixture(self, root, filename='sample-1.2.3-cp311-cp311-macosx_15_0_arm64.whl'):
        artifact = root / filename
        wheel(artifact, [('sample-1.2.3.dist-info/METADATA', 'Metadata-Version: 2.1\nName: sample\nVersion: 1.2.3\n')])
        lock = root / 'requirements.lock'
        build_engine.wheel_lock(root, lock, self.platform)
        return artifact, lock

    def test_newer_build_host_never_selects_its_native_platform(self):
        with patch.dict(os.environ, {'MACOSX_DEPLOYMENT_TARGET': '26.2'}):
            command = build_engine.target_download_command(Path('/bundle/python'), Path('/lock'), Path('/cache/target'), self.platform)
        for flag, value in [('--platform', self.platform), ('--python-version', '3.11'), ('--implementation', 'cp'), ('--abi', 'cp311')]:
            self.assertEqual(command[command.index(flag) + 1], value)
        self.assertIn('--require-hashes', command)
        self.assertIn('--no-cache-dir', command)
        self.assertNotIn('macosx_26_0_arm64', command)

    def test_target_lock_rejects_cross_version_or_python_reuse(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, lock = self.fixture(root)
            with self.assertRaisesRegex(ValueError, 'target'):
                build_engine.locked_packages(lock, 'macosx_26_0_arm64')
            lock.write_text(lock.read_text().replace('target-python: cp311', 'target-python: cp312'))
            with self.assertRaisesRegex(ValueError, 'target'):
                build_engine.locked_packages(lock, self.platform)

    def test_wheelhouse_is_isolated_from_legacy_host_cache_and_other_locks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, lock = self.fixture(root)
            cache = root / 'cache'; legacy = cache / 'wheels'; legacy.mkdir(parents=True)
            (legacy / 'mlx-0.32.4-cp311-cp311-macosx_26_0_arm64.whl').write_bytes(b'old host artifact')
            selected = build_engine.target_wheelhouse(cache, lock, self.platform)
            self.assertNotEqual(selected, legacy)
            self.assertIn(self.platform + '-cp311', selected.parts)
            lock.write_text(lock.read_text() + '# reviewed lock update\n')
            self.assertNotEqual(selected, build_engine.target_wheelhouse(cache, lock, self.platform))

    def test_exact_hash_cannot_make_newer_os_or_python_wheel_compatible(self):
        for filename in ['sample-1.2.3-cp311-cp311-macosx_26_2_arm64.whl', 'sample-1.2.3-cp312-cp312-macosx_15_0_arm64.whl']:
            with self.subTest(filename=filename), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary); self.fixture(root, filename)
                with self.assertRaisesRegex(ValueError, 'incompatible'):
                    build_engine.validate_wheelhouse(root, root / 'requirements.lock', self.platform)

    def test_target_artifact_requires_exact_locked_metadata_version_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); artifact, lock = self.fixture(root)
            receipt = build_engine.validate_wheelhouse(root, lock, self.platform)
            self.assertEqual(receipt[0]['file'], artifact.name)
            # Rehash altered metadata while retaining the reviewed version. A
            # filename/hash alone must not bypass a mismatching distribution.
            previous_hash = build_engine.digest(artifact)
            wheel(artifact, [('sample-2.0.dist-info/METADATA', 'Name: sample\nVersion: 2.0\n')])
            lock.write_text(lock.read_text().replace(previous_hash, build_engine.digest(artifact)))
            with self.assertRaisesRegex(ValueError, 'identity, version, or hash'):
                build_engine.validate_wheelhouse(root, lock, self.platform)

    def test_missing_locked_distribution_is_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); artifact, lock = self.fixture(root); artifact.unlink()
            with self.assertRaisesRegex(ValueError, 'exactly'):
                build_engine.validate_wheelhouse(root, lock, self.platform)

    def test_install_replaces_same_version_newer_os_wheel_offline(self):
        command = build_engine.target_install_command(Path('/bundle/python'), Path('/lock'), Path('/target-wheels'))
        for flag in ['--force-reinstall', '--no-index', '--require-hashes', '--no-cache-dir', '--no-compile']:
            self.assertIn(flag, command)
        self.assertEqual(command[command.index('--find-links') + 1], '/target-wheels')

    def test_compatible_universal_and_abi3_tags_are_retained(self):
        for name in ['sample-1-cp39-abi3-macosx_11_0_arm64.whl', 'sample-1-py3-none-any.whl', 'sample-1-cp311-cp311-macosx_11_0_universal2.whl']:
            self.assertTrue(build_engine.wheel_target_matches(name, self.platform), name)
        self.assertFalse(build_engine.wheel_target_matches('sample-1-cp311-cp311-macosx_15_1_arm64.whl', self.platform))

    def test_reviewed_mlx_versions_use_only_sequoia_wheel_hashes(self):
        locked = build_engine.locked_packages(HERE / 'requirements-macos-arm64.lock', self.platform)
        self.assertEqual(locked['mlx'], ('0.32.4', {'fbb3fcf1363a631d05aa5adcb30d07655158be07e09339c1fe62f7267b3a78f5'}))
        self.assertEqual(locked['mlx-metal'], ('0.32.4', {'9f0a3cc26d89724434d9684932fc6f3e4e83669d2a895d858ed2c8a55eb84e8b'}))


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
