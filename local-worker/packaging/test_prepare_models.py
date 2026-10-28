"""Verify setup integrity without model downloads or inference."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("cliptext_prepare_models_tested", HERE / "prepare_models.py")
prepare_models = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare_models)


CONTENTS = {"config.json": b'{"model_type":"synthetic-fixture"}', "model.safetensors": b"synthetic-weight-bytes"}


def manifest():
    return {"models": [{"id": "fixture", "repository": "publisher/fixture", "revision": "a" * 40,
        "files": [{"name": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                  for name, data in CONTENTS.items()]}]}


def setup_input(root):
    source = root / "source"
    source.mkdir()
    for name, data in CONTENTS.items():
        (source / name).write_bytes(data)
    return source


def prepare(value, output, imports=None, allow_download=False):
    with contextlib.redirect_stdout(io.StringIO()):
        prepare_models.prepare(value, output, imports or {}, allow_download)


class ModelIntegrityTests(unittest.TestCase):
    def test_local_import_verifies_all_files_without_download_then_reuses_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = setup_input(root)
            output = root / "prepared"
            value = manifest()
            with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                prepare(value, output, {"fixture": source})
                with patch.object(prepare_models.shutil, "copyfile", side_effect=AssertionError("Verified cache must be reused")):
                    prepare(value, output)
            network.assert_not_called()
            self.assertEqual(json.loads((output / "models.lock.json").read_text()), value)
            for name, data in CONTENTS.items():
                self.assertEqual((output / "fixture" / name).read_bytes(), data)

    def test_missing_model_without_explicit_download_permission_never_fetches(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
            output = Path(temporary) / "prepared"
            with self.assertRaisesRegex(ValueError, "explicitly allow"):
                prepare(manifest(), output)
            network.assert_not_called()
            self.assertFalse((output / "models.lock.json").exists())
            self.assertFalse(list(output.rglob("*.partial")))

    def test_same_size_tampered_cache_is_detected_by_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = setup_input(root)
            output = root / "prepared"
            prepare(manifest(), output, {"fixture": source})
            target = output / "fixture" / "model.safetensors"
            target.write_bytes(b"X" * len(CONTENTS["model.safetensors"]))
            with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                with self.assertRaisesRegex(ValueError, "Missing model artifact"):
                    prepare(manifest(), output)
            network.assert_not_called()
            self.assertEqual(target.read_bytes(), b"X" * len(CONTENTS["model.safetensors"]))
            self.assertFalse(list(output.rglob("*.partial")))

    def test_tampered_import_is_never_promoted_as_verified_model(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = setup_input(root)
            source.joinpath("model.safetensors").write_bytes(b"X" * len(CONTENTS["model.safetensors"]))
            output = root / "prepared"
            with self.assertRaisesRegex(ValueError, "checksum"):
                prepare(manifest(), output, {"fixture": source})
            self.assertFalse((output / "fixture" / "model.safetensors").exists())
            self.assertFalse((output / "models.lock.json").exists())
            self.assertFalse(list(output.rglob("*.partial")))

    def test_download_permission_still_requires_pinned_size_and_hash(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "prepared"
            with patch.object(prepare_models.urllib.request, "urlopen", return_value=io.BytesIO(b"wrong-content")):
                with self.assertRaisesRegex(ValueError, "checksum"):
                    prepare(manifest(), output, allow_download=True)
            self.assertFalse((output / "models.lock.json").exists())
            self.assertFalse(list(output.rglob("*.partial")))

    def test_manifest_artifact_cannot_escape_model_directory(self):
        for name in ("../outside", "/absolute-outside", ".hidden"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                value = manifest()
                value["models"][0]["files"][0]["name"] = name
                with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                    with self.assertRaisesRegex(ValueError, "simple file"):
                        prepare(value, root / "prepared", allow_download=True)
                network.assert_not_called()
                self.assertFalse((root / "outside").exists())

    def test_unlisted_alternative_weights_or_shards_cannot_override_verified_model(self):
        for name in ("weights.safetensors", "model-00002-of-00002.safetensors"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = setup_input(root)
                output = root / "prepared"
                prepare(manifest(), output, {"fixture": source})
                extra = output / "fixture" / name
                extra.write_bytes(b"unlisted-weights-must-not-be-loaded")
                with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                    with self.assertRaisesRegex(ValueError, "Unexpected model artifact"):
                        prepare(manifest(), output, {"fixture": source})
                network.assert_not_called()
                self.assertEqual(extra.read_bytes(), b"unlisted-weights-must-not-be-loaded")

    def test_expected_artifact_or_staging_file_cannot_be_a_symlink(self):
        for name in ("config.json", "config.json.partial"):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = setup_input(root)
                output = root / "prepared"
                target = output / "fixture"
                target.mkdir(parents=True)
                linked = target / name
                linked.symlink_to(source / "config.json")
                with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                    with self.assertRaisesRegex(ValueError, "Unexpected model artifact"):
                        prepare(manifest(), output, {"fixture": source})
                network.assert_not_called()
                self.assertTrue(linked.is_symlink())
                self.assertEqual((source / "config.json").read_bytes(), CONTENTS["config.json"])

    def test_prepared_model_directory_cannot_link_back_to_import_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = setup_input(root)
            output = root / "prepared"
            output.mkdir()
            (output / "fixture").symlink_to(source, target_is_directory=True)
            with patch.object(prepare_models.urllib.request, "urlopen", side_effect=AssertionError("No network")) as network:
                with self.assertRaisesRegex(ValueError, "directory must not be a symlink"):
                    prepare(manifest(), output, {"fixture": source})
            network.assert_not_called()
            self.assertFalse((output / "models.lock.json").exists())
            self.assertTrue((output / "fixture").is_symlink())


if __name__ == "__main__":
    unittest.main()
