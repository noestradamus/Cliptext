#!/usr/bin/env python3
"""Build a relocatable, credential-free local Cliptext engine (developer tool).

The build requires macOS build tools; the produced runtime must not require them.
The Python archive and all wheel artifacts are checksum-verified. This prototype
is not a signed/notarized public release and contains no model weights by default.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent
ENGINE_FILES = ('worker.py', 'standalone.py', 'ocr.py', 'image_posts.py', 'insights.py',
                'checkpoints.py', 'local_processes.py', 'vision-ocr.swift')
TARGET_MACOS = '15.0'
TARGET_PYTHON = 'cp311'


def target_platform(value: str) -> str:
    if not re.fullmatch(r'\d+\.\d+', value) or int(value.split('.')[0]) < 11:
        raise ValueError('Choose an arm64 macOS deployment target such as 15.0.')
    major, minor = (int(part) for part in value.split('.'))
    return f'macosx_{major}_{minor}_arm64'


def normalized_name(value: str) -> str:
    return re.sub(r'[-_.]+', '-', value).lower()


def locked_packages(lock: Path, platform: str) -> dict[str, tuple[str, set[str]]]:
    """A reviewed lock selects a target artifact, not just a package version."""
    text = lock.read_text()
    if f'# target-platform: {platform}' not in text.splitlines() or f'# target-python: {TARGET_PYTHON}' not in text.splitlines():
        raise ValueError('The reviewed wheel lock does not match the requested macOS/Python target.')
    packages = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        row = re.fullmatch(r'([A-Za-z0-9_.-]+)==([^\s]+)((?: --hash=sha256:[0-9a-f]{64})+)', line.strip())
        if not row:
            raise ValueError('The wheel lock must contain only exact versions and SHA-256 hashes.')
        key = normalized_name(row[1])
        if key in packages:
            raise ValueError(f'Duplicate locked distribution: {key}')
        packages[key] = (row[2], set(re.findall(r'sha256:([0-9a-f]{64})', row[3])))
    if not packages:
        raise ValueError('The reviewed wheel lock is empty.')
    return packages


def wheel_target_matches(filename: str, platform: str) -> bool:
    """Check wheel tags without trusting the current build host's newer OS."""
    try:
        _, _, python_tags, abi_tags, platforms = filename[:-4].rsplit('-', 4)
        target = tuple(map(int, re.fullmatch(r'macosx_(\d+)_(\d+)_arm64', platform).groups()))
    except (ValueError, AttributeError):
        return False
    abi = set(abi_tags.split('.'))
    python_ok = any(tag in {'py3', TARGET_PYTHON} or
                    bool('abi3' in abi and re.fullmatch(r'cp3\d+', tag) and int(tag[2:]) <= 311)
                    for tag in python_tags.split('.'))
    if not python_ok or not abi.intersection({'none', 'abi3', TARGET_PYTHON}):
        return False
    for tag in platforms.split('.'):
        if tag == 'any':
            return True
        match = re.fullmatch(r'macosx_(\d+)_(\d+)_(arm64|universal2)', tag)
        if match and tuple(map(int, match.groups()[:2])) <= target:
            return True
    return False


def validate_wheelhouse(wheelhouse: Path, lock: Path, platform: str) -> list[dict]:
    from email.parser import BytesParser
    from zipfile import ZipFile
    expected = locked_packages(lock, platform)
    found = {}
    for wheel in sorted(wheelhouse.glob('*.whl')):
        if not wheel_target_matches(wheel.name, platform):
            raise ValueError(f'Wheel is incompatible with {platform}/{TARGET_PYTHON}: {wheel.name}')
        with ZipFile(wheel) as archive:
            paths = [name for name in archive.namelist() if name.endswith('.dist-info/METADATA') and name.count('/') == 1]
            if len(paths) != 1:
                raise ValueError(f'Invalid wheel metadata: {wheel.name}')
            metadata = BytesParser().parsebytes(archive.read(paths[0]))
        key = normalized_name(metadata.get('Name', ''))
        sha = digest(wheel)
        if key not in expected or metadata.get('Version') != expected[key][0] or sha not in expected[key][1]:
            raise ValueError(f'Wheel identity, version, or hash does not match the reviewed target lock: {wheel.name}')
        if key in found:
            raise ValueError(f'Duplicate target wheel: {key}')
        found[key] = {'file': wheel.name, 'sha256': sha}
    if found.keys() != expected.keys():
        raise ValueError('The target wheelhouse does not contain exactly the reviewed distributions.')
    return [found[key] for key in sorted(found)]


def target_download_command(interpreter: Path, requirements: Path, wheelhouse: Path, platform: str, hashes=True) -> list[str]:
    return [str(interpreter), '-I', '-m', 'pip', 'download', '--disable-pip-version-check', '--no-cache-dir',
            '--platform', platform, '--python-version', '3.11', '--implementation', 'cp', '--abi', TARGET_PYTHON,
            *(['--require-hashes'] if hashes else []), '--only-binary=:all:', '--no-deps', '-r', str(requirements), '--dest', str(wheelhouse)]


def target_install_command(interpreter: Path, lock: Path, wheelhouse: Path) -> list[str]:
    # A cloned prototype can already have the same MLX version from a newer-OS
    # wheel. Force replacement; 'requirement already satisfied' is not evidence.
    return [str(interpreter), '-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir',
            '--no-index', '--find-links', str(wheelhouse), '--require-hashes', '--force-reinstall', '--no-compile', '--no-deps', '-r', str(lock)]


def target_wheelhouse(cache: Path, lock: Path, platform: str) -> Path:
    return cache / 'wheels' / f'{platform}-{TARGET_PYTHON}' / digest(lock)[:16]


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def download(url: str, destination: Path, expected: str):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and digest(destination) == expected:
        return
    temporary = destination.with_name(destination.name + '.partial')
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Cliptext-engine-builder/0.1'}), timeout=60) as response, temporary.open('wb') as stream:
            shutil.copyfileobj(response, stream, 1024 * 1024)
        if digest(temporary) != expected:
            raise ValueError('Downloaded Python archive checksum does not match its pinned source.')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def run(command: list[str], **kwargs):
    print(json.dumps({'build': command[:5]}), flush=True)
    subprocess.run(command, check=True, **kwargs)


def wheel_lock(wheelhouse: Path, output: Path, platform: str = 'macosx_15_0_arm64'):
    # The download directory is isolated; each locked distribution has one wheel.
    from zipfile import ZipFile
    from email.parser import BytesParser
    packages = []
    names = set()
    for wheel in sorted(wheelhouse.glob('*.whl')):
        with ZipFile(wheel) as archive:
            paths = [name for name in archive.namelist() if name.endswith('.dist-info/METADATA') and name.count('/') == 1]
            if len(paths) != 1:
                raise ValueError(f'Invalid wheel metadata: {wheel.name}')
            info = BytesParser().parsebytes(archive.read(paths[0]))
        name = info['Name']
        if normalized_name(name) in names:
            raise ValueError(f'Duplicate wheel: {name}')
        names.add(normalized_name(name))
        packages.append(f"{name}=={info['Version']} --hash=sha256:{digest(wheel)}")
    output.write_text(f'# macOS arm64 CPython 3.11 wheel hashes; no source builds.\n# target-platform: {platform}\n# target-python: {TARGET_PYTHON}\n' + '\n'.join(sorted(packages, key=str.casefold)) + '\n')


def write_launcher(output: Path):
    (output / 'engine' / 'boot.py').write_text('''from pathlib import Path
import runpy
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
runpy.run_module("standalone", run_name="__main__")
''')
    launcher = output / 'cliptext-engine'
    launcher.write_text('''#!/bin/sh
set -eu
cliptext_bundle_root="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && /bin/pwd -P)"
unset PYTHONPATH PYTHONHOME DYLD_LIBRARY_PATH DYLD_FALLBACK_LIBRARY_PATH
export PATH="$cliptext_bundle_root/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
export TOKENIZERS_PARALLELISM=false
export CLIPTEXT_BUNDLE_ROOT="$cliptext_bundle_root"
export CLIPTEXT_VISION_OCR_HELPER="$cliptext_bundle_root/bin/vision-ocr"
exec "$cliptext_bundle_root/python/bin/python3.11" -I -B "$cliptext_bundle_root/engine/boot.py" "$@"
''')
    launcher.chmod(0o755)


def finish_runtime(output: Path):
    """Remove wheel build-machine paths and unused absolute console scripts."""
    from bundle_tools import is_macho, rpaths
    changes = []
    runtime = output / 'python'
    for binary in runtime.rglob('*'):
        if binary.is_symlink() or not binary.is_file() or not is_macho(binary):
            continue
        modified = False
        for search in rpaths(binary):
            system = search in {'/usr/lib', '/System/Library'} or search.startswith(('/usr/lib/', '/System/Library/'))
            if search.startswith('/') and not system:
                run(['/usr/bin/install_name_tool', '-delete_rpath', search, str(binary)])
                changes.append({'path': str(binary.relative_to(output)), 'removedRpath': search})
                modified = True
        if binary.name.startswith('omppool.'):
            relative = '@loader_path/../../../torch/lib/libomp.dylib'
            omp = binary.parent / '../../../torch/lib/libomp.dylib'
            if not omp.resolve().is_file():
                raise ValueError('Numba requires the bundled OpenMP runtime.')
            loads = subprocess.check_output(['/usr/bin/otool', '-L', str(binary)], text=True)
            if '@rpath/libomp.dylib' in loads:
                run(['/usr/bin/install_name_tool', '-change', '@rpath/libomp.dylib', relative, str(binary)])
                changes.append({'path': str(binary.relative_to(output)), 'openMP': relative})
                modified = True
        if modified:
            run(['/usr/bin/codesign', '--force', '--sign', '-', str(binary)])
            run(['/usr/bin/codesign', '--verify', '--strict', str(binary)])
    # These pip-created console scripts contain build-location shebangs. The
    # supported entry point uses an explicit relative interpreter; packages
    # remain available as modules, including pip for deliberate rebuilds.
    for script in (runtime / 'bin').iterdir():
        if script.name not in {'python', 'python3', 'python3.11'} and (script.is_file() or script.is_symlink()):
            script.unlink()
    resources = output / 'resources'
    resources.mkdir(exist_ok=True)
    existing = resources / 'runtime-relocations.json'
    prior = json.loads(existing.read_text()) if existing.is_file() else []
    if changes or not existing.exists():
        existing.write_text(json.dumps(prior + changes, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--bootstrap-lock', action='store_true', help='Download pinned versions and create the reviewed wheel hash lock.')
    parser.add_argument('--python-only', action='store_true', help='Prepare embedded Python and dependencies before engine sources are ready.')
    parser.add_argument('--target-macos', default=TARGET_MACOS, help='Reviewed wheel deployment target (default: 15.0), independent of the build host.')
    args = parser.parse_args()
    try:
        platform = target_platform(args.target_macos)
    except ValueError as error:
        parser.error(str(error))
    lock = HERE / 'requirements-macos-arm64.lock'
    if not args.bootstrap_lock:
        if not lock.is_file():
            raise ValueError('Generate/review the standalone wheel lock before building.')
        locked_packages(lock, platform)
    output, cache = args.output.resolve(), args.cache.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    sources = json.loads((HERE / 'runtime-sources.json').read_text())
    python_source = sources['python']
    archive = cache / 'python-runtime.tar.gz'
    download(python_source['url'], archive, python_source['sha256'])
    interpreter = output / 'python' / 'bin' / 'python3.11'
    stamp = output / 'python' / '.cliptext-runtime-source.json'
    prior = output / 'resources' / 'runtime-sources.json'
    if interpreter.is_file():
        recorded = json.loads(stamp.read_text()) if stamp.is_file() else json.loads(prior.read_text()).get('python') if prior.is_file() else None
        if recorded != python_source:
            raise ValueError('Existing embedded Python has a different or unverified source; use a fresh output directory.')
    if not interpreter.is_file():
        with tarfile.open(archive) as distribution:
            distribution.extractall(output, filter='data')
    version = subprocess.check_output([str(interpreter), '-I', '-c', 'import platform;print(platform.python_version())'], text=True).strip()
    if version != python_source['version']:
        raise ValueError('Embedded Python version does not match the pinned source.')
    stamp.write_text(json.dumps(python_source, indent=2) + '\n')
    # Never reuse a host-selected wheel directory. Both the declared platform and
    # reviewed lock digest are part of the namespace; pip's ambient cache is off.
    cache_target = cache / 'wheels' / f'{platform}-{TARGET_PYTHON}'
    wheelhouse = cache_target / ('bootstrap-' + digest(HERE / 'requirements-versions.lock')[:16]) if args.bootstrap_lock else target_wheelhouse(cache, lock, platform)
    wheelhouse.mkdir(parents=True, exist_ok=True)
    if args.bootstrap_lock:
        if lock.exists():
            raise ValueError('A wheel hash lock already exists; review/remove it explicitly before bootstrapping again.')
        versions = HERE / 'requirements-versions.lock'
        run(target_download_command(interpreter, versions, wheelhouse, platform, hashes=False))
        wheel_lock(wheelhouse, lock, platform)
    if not lock.is_file():
        raise ValueError('Generate/review the standalone wheel lock before building.')
    run(target_download_command(interpreter, lock, wheelhouse, platform))
    artifacts = validate_wheelhouse(wheelhouse, lock, platform)
    run(target_install_command(interpreter, lock, wheelhouse))
    run([str(interpreter), '-I', '-m', 'pip', 'check'])
    resources = output / 'resources'
    resources.mkdir(exist_ok=True)
    (resources / 'runtime-target.json').write_text(json.dumps({'platform': platform, 'python': TARGET_PYTHON, 'lockSha256': digest(lock), 'wheels': artifacts}, indent=2) + '\n')
    shutil.copy2(HERE / 'runtime-sources.json', resources)
    shutil.copy2(lock, resources)
    shutil.copy2(HERE / 'models.lock.json', resources)
    finish_runtime(output)
    if not args.python_only:
        engine = output / 'engine'
        engine.mkdir(exist_ok=True)
        for name in ENGINE_FILES:
            shutil.copy2(SOURCE / name, engine / name)
        write_launcher(output)
        manifest = {'format': 'cliptext-local-engine', 'version': '0.1.0', 'platform': 'macos-arm64',
                    'python': python_source, 'modelsIncluded': False, 'publicReleaseReady': False,
                    'sourceSha256': {name: digest(engine / name) for name in ENGINE_FILES}}
        (resources / 'engine-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'ready': True, 'bundle': str(output), 'interpreter': str(interpreter), 'publicReleaseReady': False}))


if __name__ == '__main__':
    main()
