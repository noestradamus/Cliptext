import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("bundle_tools", Path(__file__).with_name("bundle_tools.py"))
tools = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tools)


class PortableToolsTests(unittest.TestCase):
    def test_relative_linkage_survives_spaces_and_moves(self):
        self.assertEqual(tools.relative_reference(Path("/new folder/Engine/bin/ffmpeg"),
                                                 Path("/new folder/Engine/lib/codec.dylib")),
                         "@loader_path/../lib/codec.dylib")

    def test_library_identifier_is_not_an_external_load_dependency(self):
        path = Path("/tmp/codec.dylib")
        def output(command, **_):
            if "-D" in command:
                return "/tmp/codec.dylib:\n@rpath/codec.dylib"
            return ("/tmp/codec.dylib:\n"
                    "\t@rpath/codec.dylib (compatibility version 1.0.0, current version 1.0.0)\n"
                    "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)")
        with patch.object(tools, "run", side_effect=output):
            self.assertEqual(tools.dependencies(path), ["/usr/lib/libSystem.B.dylib"])

    def test_audit_rejects_external_and_escaping_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Engine"
            (root / "bin").mkdir(parents=True)
            binary = root / "bin/ffmpeg"
            binary.write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")
            with patch.object(tools, "dependencies", return_value=["/opt/homebrew/lib/missing.dylib", "@loader_path/../../outside.dylib"]), \
                 patch.object(tools, "rpaths", return_value=["/opt/homebrew/lib"]), \
                 patch.object(tools, "minimum_macos", return_value="15.0"):
                result = tools.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(len(result["externalLoadFindings"]), 3)
            self.assertEqual(result["toolMinimumMacOS"], "15.0")

    def test_audit_accepts_only_present_in_bundle_or_system_libraries(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "Engine"
            (root / "bin").mkdir(parents=True)
            (root / "lib").mkdir()
            (root / "bin/ffmpeg").write_bytes(b"\xcf\xfa\xed\xfe" + b"fixture")
            (root / "lib/codec.dylib").write_bytes(b"dependency")
            with patch.object(tools, "dependencies", return_value=["@loader_path/../lib/codec.dylib", "/usr/lib/libSystem.B.dylib"]), \
                 patch.object(tools, "rpaths", return_value=[]), \
                 patch.object(tools, "minimum_macos", return_value="15.0"):
                self.assertTrue(tools.audit(root)["passed"])


if __name__ == "__main__":
    unittest.main()
