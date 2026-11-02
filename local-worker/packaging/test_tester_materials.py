"""Source-material integrity checks; no network or upstream code execution."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


PROJECT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("cliptext_tester_materials", PROJECT / "local-app/collect-tester-materials.py")
materials = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(materials)


class Response(io.BytesIO):
    def geturl(self):
        return "https://example.invalid/source.tar.gz"


class MaterialIntegrityTests(unittest.TestCase):
    def test_wrong_archive_does_not_replace_prior_file_or_leave_partial(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "source.tar.gz"
            destination.write_bytes(b"prior source")
            expected = hashlib.sha256(b"approved source").hexdigest()
            with patch.object(materials.urllib.request, "urlopen", return_value=Response(b"wrong source")):
                with self.assertRaisesRegex(ValueError, "SHA-256"):
                    materials.fetch("https://example.invalid/source.tar.gz", destination, expected)
            self.assertEqual(destination.read_bytes(), b"prior source")
            self.assertFalse(destination.with_name("source.tar.gz.partial").exists())

    def test_hash_verified_cache_does_not_contact_network(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / "cache"
            cache.mkdir()
            data = b"approved cached source"
            (cache / "urlhash--source.tar.gz").write_bytes(data)
            expected = hashlib.sha256(data).hexdigest()
            with patch.object(materials.urllib.request, "urlopen", side_effect=AssertionError("Network forbidden")):
                record = materials.fetch("https://example.invalid/source.tar.gz", root / "out/source.tar.gz", expected, cache)
            self.assertTrue(record["cacheVerified"])
            self.assertEqual(record["sha256"], expected)

    def test_formula_is_read_as_data_and_nested_resource_does_not_override_pin(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            formula = '''class Example < Formula
  url "https://example.invalid/source.tar.gz"
  sha256 "''' + "a" * 64 + '''"
  def install
    system "never-execute-source"
  end
  test do
    resource "fixture" do
      url "https://example.invalid/test-fixture.bin"
      sha256 "''' + "b" * 64 + '''"
    end
  end
end
'''
            (root / "example.rb").write_text(formula)
            with patch.object(materials.subprocess, "run", side_effect=AssertionError("No execution allowed")):
                pin = materials.formula_input(root)
            self.assertEqual(pin["url"], "https://example.invalid/source.tar.gz")
            self.assertEqual(pin["sha256"], "a" * 64)

    def test_receipt_redaction_is_confined_to_copy_and_preserves_build_information(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = root / "original"
            original.mkdir()
            receipt = {"source": {"path": "/Users/build-user/private/cache/formula.json", "spec": "stable"}, "compiler": "clang"}
            path = original / "build-receipt.json"
            path.write_text(json.dumps(receipt))
            materials.copy_recipe(original, root / "copy")
            copied = json.loads((root / "copy/build-receipt.json").read_text())
            self.assertEqual(json.loads(path.read_text()), receipt)
            self.assertEqual(copied["source"]["path"], "[build-machine Homebrew formula cache]")
            self.assertEqual(copied["source"]["spec"], "stable")
            self.assertEqual(copied["compiler"], "clang")

    def test_inventory_rejects_symlinks_and_hashes_each_nonmanifest_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "manifest.json").write_text("{}")
            (root / "BUILDING.md").write_bytes(b"build recipe notes")
            records = materials.inventory(root)
            self.assertEqual(records, [{"path": "BUILDING.md", "sha256": hashlib.sha256(b"build recipe notes").hexdigest(), "bytes": 18}])
            (root / "linked-notes").symlink_to(root / "BUILDING.md")
            with self.assertRaisesRegex(ValueError, "symlinks"):
                materials.inventory(root)


if __name__ == "__main__":
    unittest.main()
