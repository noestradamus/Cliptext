"""Focused static-audit tests with synthetic Mach-O headers/load commands."""
from pathlib import Path
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import struct
import tempfile
import unittest
from unittest.mock import patch

import audit_bundle


def binary(path: Path, executable=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(struct.pack("<IIII", 0xFEEDFACF, 0x100000C, 0, 2 if executable else 6))
    return path


def loads(*dependencies, rpaths=(), install_id=None, version="14.0"):
    commands = []
    if install_id:
        commands.append(f"      cmd LC_ID_DYLIB\n     name {install_id} (offset 24)")
    for dep in dependencies:
        commands.append(f"      cmd LC_LOAD_DYLIB\n     name {dep} (offset 24)")
    for rpath in rpaths:
        commands.append(f"      cmd LC_RPATH\n     path {rpath} (offset 12)")
    commands.append(f"      cmd LC_BUILD_VERSION\n platform 1\n    minos {version}\n      sdk 26.5")
    return "fixture:\n" + "\n".join(f"Load command {i}\n{command}" for i, command in enumerate(commands))


class AuditTests(unittest.TestCase):
    def test_install_id_is_not_a_dependency(self):
        parsed = audit_bundle.parse_load_commands(loads("/usr/lib/libSystem.B.dylib", install_id="/old/build/libfoo.dylib"))
        self.assertEqual(parsed[0]["installIds"], ["/old/build/libfoo.dylib"])
        self.assertEqual([v["name"] for v in parsed[0]["dependencies"]], ["/usr/lib/libSystem.B.dylib"])

    def test_executable_rpath_inherits_into_transitive_dependency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            exe = binary(root / "bin/engine", executable=True)
            one = binary(root / "lib/libone.dylib")
            two = binary(root / "lib/libtwo.dylib")
            outputs = {
                exe: loads("@rpath/libone.dylib", rpaths=("@executable_path/../lib",)),
                one: loads("@rpath/libtwo.dylib", install_id="/build/libone.dylib", version="26.2"),
                two: loads("/usr/lib/libSystem.B.dylib"),
            }
            with patch("audit_bundle.run_otool", side_effect=lambda p: outputs[p]):
                report = audit_bundle.Auditor(root).report()
            self.assertTrue(report["passed"], report["issues"])
            self.assertEqual(report["highestMinimumMacOS"], "26.2")
            target = next(v for v in report["machos"] if v["path"] == "lib/libone.dylib")
            self.assertEqual(target["resolutions"][0]["target"], "lib/libtwo.dylib")

    def test_missing_dependency_and_outside_absolute_path_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            exe = binary(root / "engine", executable=True)
            with patch("audit_bundle.run_otool", return_value=loads("/opt/homebrew/lib/libfoo.dylib", "@rpath/libmissing.dylib")):
                report = audit_bundle.Auditor(root).report()
            self.assertFalse(report["passed"])
            self.assertEqual({v["kind"] for v in report["issues"]}, {"dependency_outside_bundle", "dependency_unresolved"})

    def test_escaping_and_dangling_symlinks_fail(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary(root / "engine", executable=True)
            (root / "outside").symlink_to("/opt/homebrew/bin/python3")
            (root / "missing").symlink_to("missing-target")
            with patch("audit_bundle.run_otool", return_value=loads()):
                report = audit_bundle.Auditor(root).report()
            self.assertEqual({v["kind"] for v in report["issues"]}, {"escaping_symlink", "dangling_symlink"})

    def test_loader_path_resolution_does_not_use_ambient_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary(root / "engine", executable=True)
            with patch("audit_bundle.run_otool", return_value=loads("@loader_path/missing.dylib")):
                report = audit_bundle.Auditor(root).report()
            self.assertFalse(report["passed"])
            self.assertEqual(report["issues"][0]["kind"], "dependency_unresolved")

    def test_absolute_outside_rpath_is_reported_even_if_unused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary(root / "engine", executable=True)
            with patch("audit_bundle.run_otool", return_value=loads("/usr/lib/libSystem.B.dylib", rpaths=("/opt/homebrew/lib",))):
                report = audit_bundle.Auditor(root).report()
            self.assertEqual(report["issues"][0]["kind"], "outside_rpath")

    def test_python_dlopen_module_uses_python_executable_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            exe = binary(root / "python/bin/python3.11", executable=True)
            extension = binary(root / "python/lib/python3.11/site-packages/extension.so")
            dylib = binary(root / "python/lib/libdependency.dylib")
            outputs = {
                exe: loads(rpaths=("@executable_path/../lib",)),
                extension: loads("@rpath/libdependency.dylib"),
                dylib: loads("/usr/lib/libSystem.B.dylib"),
            }
            with patch("audit_bundle.run_otool", side_effect=lambda p: outputs[p]):
                report = audit_bundle.Auditor(root).report()
            self.assertTrue(report["passed"], report["issues"])
            ext = next(v for v in report["machos"] if v["path"].endswith("extension.so"))
            self.assertEqual(ext["resolutions"][0]["context"], "python_dlopen_assumption")

    def test_universal_slice_minimum_versions_remain_separate(self):
        output = "fixture (architecture arm64):\n" + loads(version="15.0") + "\nfixture (architecture x86_64):\n" + loads(version="13.0")
        parsed = audit_bundle.parse_load_commands(output)
        self.assertEqual([(v["architecture"], v["minimumMacOS"]) for v in parsed], [("arm64", "15.0"), ("x86_64", "13.0")])

    def test_python_transitive_dylib_retains_extension_rpath_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            exe = binary(root / "python/bin/python3.11", executable=True)
            extension = binary(root / "python/lib/python3.11/site-packages/mlx/core.so")
            first = binary(extension.parent / "lib/libmlx.dylib")
            second = binary(extension.parent / "lib/libjaccl.dylib")
            outputs = {
                exe: loads(),
                extension: loads("@rpath/libmlx.dylib", rpaths=("@loader_path/lib",)),
                first: loads("@rpath/libjaccl.dylib"),
                second: loads("/usr/lib/libSystem.B.dylib"),
            }
            with patch("audit_bundle.run_otool", side_effect=lambda p: outputs[p]):
                report = audit_bundle.Auditor(root).report()
            self.assertTrue(report["passed"], report["issues"])

    def test_ceiling_rejects_unattached_native_library(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            exe = binary(root / 'engine', executable=True)
            unused = binary(root / 'lib/unused.dylib')
            outputs = {exe: loads(version='15.0'), unused: loads(version='26.2')}
            with patch('audit_bundle.run_otool', side_effect=lambda p: outputs[p]):
                report = audit_bundle.Auditor(root, max_macos='15.6').report()
            self.assertFalse(report['passed'])
            self.assertFalse(report['deploymentTargetsWithinLimit'])
            self.assertEqual(report['maximumAllowedMacOS'], '15.6')
            self.assertEqual(report['issues'], [{'kind': 'deployment_target_exceeds_limit', 'path': 'lib/unused.dylib', 'architecture': 'arm64', 'minimumMacOS': '26.2', 'maximumAllowedMacOS': '15.6'}])

    def test_ceiling_checks_every_universal_slice(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); binary(root / 'engine', executable=True)
            output = 'fixture (architecture arm64):\n' + loads(version='15.0') + '\nfixture (architecture x86_64):\n' + loads(version='26.0')
            with patch('audit_bundle.run_otool', return_value=output):
                report = audit_bundle.Auditor(root, max_macos='15.6').report()
            self.assertFalse(report['passed'])
            self.assertEqual(report['issues'][0]['architecture'], 'x86_64')

    def test_ceiling_normalizes_trailing_zero_versions(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); binary(root / 'engine', executable=True)
            with patch('audit_bundle.run_otool', return_value=loads(version='15.6.0')):
                report = audit_bundle.Auditor(root, max_macos='15.6').report()
            self.assertTrue(report['passed'], report['issues'])
            self.assertTrue(report['deploymentTargetsWithinLimit'])
            self.assertEqual(audit_bundle.version_key('15.6.0'), audit_bundle.version_key('15.6'))

    def test_requested_ceiling_cannot_certify_missing_native_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); binary(root / 'engine', executable=True)
            with patch('audit_bundle.run_otool', return_value='fixture:\n'):
                report = audit_bundle.Auditor(root, max_macos='15.6').report()
            self.assertFalse(report['passed'])
            self.assertEqual(report['issues'][0]['kind'], 'deployment_target_unknown')

    def test_cli_ceiling_is_recorded_and_returns_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); binary(root / 'engine', executable=True)
            output = root / 'audit.json'
            with patch('audit_bundle.run_otool', return_value=loads(version='26.2')), redirect_stdout(io.StringIO()):
                status = audit_bundle.main(['--bundle', str(root), '--output', str(output), '--max-macos', '15.6'])
            self.assertEqual(status, 1)
            report = json.loads(output.read_text())
            self.assertEqual(report['maximumAllowedMacOS'], '15.6')
            self.assertFalse(report['deploymentTargetsWithinLimit'])

    def test_invalid_cli_ceiling_fails_before_native_inspection(self):
        with tempfile.TemporaryDirectory() as temporary:
            for value in ['15.x', '-1', '15.6/../../', '15.6.0.0']:
                with self.subTest(value=value), patch('audit_bundle.run_otool') as inspect, redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as raised:
                        audit_bundle.main(['--bundle', temporary, '--output', str(Path(temporary) / 'audit.json'), '--max-macos=' + value])
                    self.assertEqual(raised.exception.code, 2)
                    inspect.assert_not_called()


if __name__ == "__main__":
    unittest.main()
