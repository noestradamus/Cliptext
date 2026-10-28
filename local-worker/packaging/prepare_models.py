#!/usr/bin/env python3
"""Explicit one-time model setup; never called implicitly during inference.

Downloads pinned public artifacts, or imports matching existing local weights.
Model content is verified against the reviewed manifest in either case.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent


def sha256(path: Path) -> str:
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def prepare(manifest: dict, destination: Path, imports: dict[str, Path], allow_download: bool):
    for model in manifest['models']:
        target = destination / model['id']
        if target.is_symlink():
            raise ValueError('The prepared model directory must not be a symlink.')
        target.mkdir(parents=True, exist_ok=True)
        expected = {artifact['name'] for artifact in model['files']}
        partials = {name + '.partial' for name in expected}
        for existing in target.iterdir():
            if existing.is_symlink() or existing.is_dir() or existing.name not in expected | partials:
                raise ValueError(f'Unexpected model artifact: {model["id"]}/{existing.name}; use a clean target or review it explicitly.')
        for artifact in model['files']:
            name = artifact['name']
            if Path(name).name != name or name.startswith('.'):
                raise ValueError('Model manifest paths must be simple file names.')
            output = target / name
            if output.is_file() and output.stat().st_size == artifact['bytes'] and sha256(output) == artifact['sha256']:
                continue
            temporary = output.with_name(output.name + '.partial')
            try:
                source = imports.get(model['id'])
                if source is not None:
                    source_file = source / name
                    if not source_file.is_file():
                        raise ValueError(f'Missing imported model file: {model["id"]}/{name}')
                    shutil.copyfile(source_file, temporary)
                elif allow_download:
                    url = f"https://huggingface.co/{model['repository']}/resolve/{model['revision']}/{urllib.parse.quote(name)}"
                    with urllib.request.urlopen(url, timeout=120) as response, temporary.open('wb') as stream:
                        shutil.copyfileobj(response, stream, 4 * 1024 * 1024)
                else:
                    raise ValueError(f'Missing model artifact: {model["id"]}/{name}; provide a local import or explicitly allow setup downloads.')
                if temporary.stat().st_size != artifact['bytes'] or sha256(temporary) != artifact['sha256']:
                    raise ValueError(f'Model checksum mismatch: {model["id"]}/{name}')
                temporary.replace(output)
            finally:
                temporary.unlink(missing_ok=True)
        print(json.dumps({'model': model['id'], 'verified': True, 'revision': model['revision']}), flush=True)
    (destination / 'models.lock.json').write_text(json.dumps(manifest, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--speech-from', type=Path)
    parser.add_argument('--insights-from', type=Path)
    parser.add_argument('--download', action='store_true', help='Explicitly permit one-time model downloads.')
    args = parser.parse_args()
    manifest = json.loads((HERE / 'models.lock.json').read_text())
    imports = {key: value.resolve() for key, value in {'whisper-large-v3': args.speech_from, 'qwen3-4b': args.insights_from}.items() if value}
    prepare(manifest, args.output.resolve(), imports, args.download)


if __name__ == '__main__':
    main()
