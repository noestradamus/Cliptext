"""Disposable fixture checks; never opens an application or a real runtime."""
import importlib.util
from contextlib import redirect_stdout
import hashlib
import io
import json
import marshal
from pathlib import Path
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location('clean_runtime', Path(__file__).resolve().parents[1] / 'clean-runtime.py')
cleaner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleaner)
HOME_MARKER = Path('/Users/fixture-builder')


class CleanupTests(unittest.TestCase):
    def fixture(self, temporary):
        root = Path(temporary) / 'CliptextEngine'
        for name in ['engine', 'python', 'resources']:
            (root / name).mkdir(parents=True)
        manifest = {'format': 'cliptext-local-engine', 'version': '0.4.1', 'sourceSha256': {'worker.py': 'a' * 64}, 'python': {'url': 'https://example.invalid/python.tar.gz', 'sha256': 'b' * 64}}
        (root / 'resources/engine-manifest.json').write_text(json.dumps(manifest))
        return root, manifest

    def test_source_backed_bytecode_removed_with_hashes_and_pins_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, manifest = self.fixture(temporary)
            source = root / 'python/module.py'; source.write_text('value = 1\n')
            cache = root / 'python/__pycache__'; cache.mkdir()
            (cache / 'module.cpython-311.pyc').write_bytes(b'fixture ' + str(HOME_MARKER).encode())
            legacy = root / 'engine/helper.pyc'; legacy.write_bytes(b'fixture'); legacy.with_suffix('.py').write_text('pass\n')
            tool = {'build': str(HOME_MARKER) + '/work/tool', 'url': 'https://example.invalid/tool', 'sha256': 'c' * 64, 'version': '1.2.3'}
            (root / 'resources/tool-manifest.json').write_text(json.dumps(tool))
            receipt = cleaner.clean_runtime(root, HOME_MARKER)
            self.assertEqual(receipt['removedBytecodeCount'], 2)
            self.assertFalse(cache.exists()); self.assertTrue(source.is_file())
            self.assertEqual(json.loads((root / 'resources/engine-manifest.json').read_text()), manifest)
            tool['build'] = '<build-home>/work/tool'
            self.assertEqual(json.loads((root / 'resources/tool-manifest.json').read_text()), tool)
            self.assertNotIn(str(HOME_MARKER), json.dumps(receipt))
            self.assertTrue(all(not value.startswith('/') for value in receipt['removedBytecodePaths']))

    def test_live_app_paths_and_live_library_are_refused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(Path(temporary) / 'Cliptext.app')
            with self.assertRaisesRegex(ValueError, 'installed application'):
                cleaner.clean_runtime(root, HOME_MARKER)
            root, _ = self.fixture(Path(temporary) / 'home/Library/Application Support/Cliptext')
            with self.assertRaisesRegex(ValueError, 'live Library'):
                cleaner.clean_runtime(root, Path(temporary) / 'home')

    def test_orphan_bytecode_retained_only_without_builder_markers(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            orphan = root / 'python/upstream.pyc'; orphan.write_bytes(b'upstream-bytecode-without-user-path')
            receipt = cleaner.clean_runtime(root, HOME_MARKER)
            self.assertTrue(orphan.exists())
            self.assertEqual(receipt['retainedOrphanBytecode'][0]['path'], 'python/upstream.pyc')
            orphan.write_bytes(str(HOME_MARKER).encode())
            with self.assertRaisesRegex(ValueError, 'Orphan bytecode'):
                cleaner.clean_runtime(root, HOME_MARKER)
            self.assertTrue(orphan.exists())

    def test_homebrew_local_source_path_removed_and_public_provenance_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            value = {'source': {'path': str(HOME_MARKER) + '/Formula/tool.rb', 'url': 'https://example.invalid/tool.tar.gz'}, 'version': '8.0', 'sha256': 'd' * 64}
            paths = []
            for name in ['licenses/ffmpeg/INSTALL_RECEIPT.json', 'licenses/tools/ffmpeg/8.0/build-receipt.json']:
                path = root / name; path.parent.mkdir(parents=True); path.write_text(json.dumps(value)); paths.append(path)
            cleaner.clean_runtime(root, HOME_MARKER)
            del value['source']['path']
            for path in paths:
                self.assertEqual(json.loads(path.read_text()), value)

    def test_unknown_private_metadata_refuses_before_any_deletion(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            bytecode = root / 'engine/helper.pyc'; bytecode.write_bytes(b'fixture'); bytecode.with_suffix('.py').write_text('pass\n')
            (root / 'resources/identity.json').write_text(json.dumps({'path': str(HOME_MARKER) + '/identity'}))
            with self.assertRaisesRegex(ValueError, 'review explicitly'):
                cleaner.clean_runtime(root, HOME_MARKER)
            self.assertTrue(bytecode.exists())
            self.assertTrue((root / 'resources/identity.json').exists())

    def test_local_file_uri_is_not_rewritten_silently(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            path = root / 'resources/tool-manifest.json'
            text = json.dumps({'url': 'file://' + str(HOME_MARKER) + '/tool'})
            path.write_text(text)
            with self.assertRaisesRegex(ValueError, 'review explicitly'):
                cleaner.clean_runtime(root, HOME_MARKER)
            self.assertEqual(path.read_text(), text)

    def test_only_exact_distlib_windows_launchers_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            folder = root / cleaner.DISTLIB; folder.mkdir(parents=True)
            for name in cleaner.WINDOWS_LAUNCHERS:
                (folder / name).write_bytes(b'MZ-known-upstream-launcher-fixture')
            other = folder / 'Other.exe'; other.write_bytes(b'MZ-unknown-foreign-executable')
            code = folder / '__init__.py'; code.write_text('# Mac pip code remains\n')
            license = folder / 'LICENSE.txt'; license.write_text('Upstream license remains.\n')
            receipt = cleaner.clean_runtime(root, HOME_MARKER)
            self.assertEqual(receipt['removedWindowsLauncherCount'], 6)
            self.assertEqual(receipt['removedWindowsLauncherPaths'], [(cleaner.DISTLIB / name).as_posix() for name in cleaner.WINDOWS_LAUNCHERS])
            self.assertTrue(other.exists())
            self.assertEqual(code.read_text(), '# Mac pip code remains\n')
            self.assertEqual(license.read_text(), 'Upstream license remains.\n')
            self.assertTrue(all(not (folder / name).exists() for name in cleaner.WINDOWS_LAUNCHERS))

    def test_distlib_pruning_requires_regular_file_and_windows_header(self):
        for kind in ['wrong-header', 'symlink']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root, _ = self.fixture(temporary)
                folder = root / cleaner.DISTLIB; folder.mkdir(parents=True)
                path = folder / 't32.exe'
                if kind == 'wrong-header': path.write_bytes(b'not-a-Windows-launcher')
                else:
                    target = folder / 'other.bin'; target.write_bytes(b'MZ-fixture'); path.symlink_to(target.name)
                with self.assertRaisesRegex(ValueError, 'regular staged file|expected Windows header'):
                    cleaner.clean_runtime(root, HOME_MARKER)
                self.assertTrue(path.exists())

    def test_only_exact_setuptools_windows_launchers_are_pruned(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            folder = root / cleaner.SETUPTOOLS; folder.mkdir(parents=True)
            for name in cleaner.SETUPTOOLS_LAUNCHERS: (folder / name).write_bytes(b'MZ-upstream-launcher')
            (folder / 'Unknown.exe').write_bytes(b'MZ-retain-for-native-gate')
            (folder / '__init__.py').write_text('# Mac setuptools remains\n')
            receipt = cleaner.clean_runtime(root, HOME_MARKER)
            self.assertEqual(receipt['removedWindowsLauncherCount'], 8)
            self.assertTrue((folder / 'Unknown.exe').exists())
            self.assertTrue((folder / '__init__.py').exists())

    def test_compile_option_refuses_host_interpreter_before_cleanup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            bytecode = root / 'engine/test.pyc'; bytecode.write_bytes(b'fixture')
            bytecode.with_suffix('.py').write_text('value = 1\n')
            with self.assertRaisesRegex(ValueError, 'host Python bytecode is not accepted'):
                cleaner.clean_runtime(root, HOME_MARKER, compile_caches=True)
            self.assertTrue(bytecode.exists())

    @unittest.skipUnless(sys.version_info[:2] == (3, 11), 'Run with embedded Python 3.11 for bytecode/header acceptance.')
    def test_embedded_compiler_uses_checked_hashes_and_logical_nested_code_names(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            folder = root / 'python/bin'; folder.mkdir()
            (folder / 'python3.11').symlink_to(sys.executable)
            source = root / 'engine/module.py'
            source.write_text('def outer():\n    def inner():\n        return 7\n    return inner\n')
            receipt = cleaner.clean_runtime(root, Path(temporary), compile_caches=True)
            self.assertEqual(receipt['compiledBytecodeCount'], 1)
            self.assertTrue(receipt['compiledBytecodeVerified'])
            cache = Path(importlib.util.cache_from_source(str(source), optimization=''))
            data = cache.read_bytes()
            self.assertEqual(data[:4], importlib.util.MAGIC_NUMBER)
            self.assertEqual(int.from_bytes(data[4:8], 'little'), 3)
            self.assertEqual(data[8:16], importlib.util.source_hash(source.read_bytes()))
            self.assertNotIn(str(Path(temporary).resolve()).encode(), data)
            code = marshal.loads(data[16:])
            self.assertEqual(code.co_filename, '/CliptextRuntime/engine/module.py')
            self.assertEqual(code.co_consts[0].co_filename, code.co_filename)

    @unittest.skipUnless(sys.version_info[:2] == (3, 11), 'Run with embedded Python 3.11 for future-syntax fixture acceptance.')
    def test_only_known_torch_py312_syntax_fixture_is_left_uncompiled(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            folder = root / 'python/bin'; folder.mkdir()
            (folder / 'python3.11').symlink_to(sys.executable)
            relative = 'python/lib/python3.11/site-packages/torch/testing/_internal/py312_intrinsics.py'
            source = root / relative; source.parent.mkdir(parents=True)
            original = b'def f[T](value: T) -> T:\n    return value\n'
            source.write_bytes(original)
            receipt = cleaner.clean_runtime(root, Path(temporary), compile_caches=True)
            self.assertEqual(source.read_bytes(), original)
            self.assertEqual(receipt['compiledBytecodeCount'], 0)
            self.assertEqual(receipt['uncompiledSourceFixtures'], [{'path': relative, 'sha256': hashlib.sha256(original).hexdigest(), 'reason': 'Upstream Python 3.12 syntax fixture'}])
            self.assertFalse(Path(importlib.util.cache_from_source(str(source))).exists())

    @unittest.skipUnless(sys.version_info[:2] == (3, 11), 'Run with embedded Python 3.11 for syntax-error refusal acceptance.')
    def test_unknown_invalid_production_source_still_refuses_compilation(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, _ = self.fixture(temporary)
            folder = root / 'python/bin'; folder.mkdir()
            (folder / 'python3.11').symlink_to(sys.executable)
            source = root / 'engine/production.py'; source.write_text('def broken(:\n')
            with redirect_stdout(io.StringIO()), self.assertRaisesRegex(ValueError, 'compilation failed'):
                cleaner.clean_runtime(root, Path(temporary), compile_caches=True)
            self.assertTrue(source.exists())


if __name__ == '__main__':
    unittest.main()
