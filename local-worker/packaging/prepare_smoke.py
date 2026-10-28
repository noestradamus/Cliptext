#!/usr/bin/env python3
"""Prepare a relocated runtime test without using the production worker.

Preparation copies supplied local fixtures/models. The printed sandbox command
then denies network, original workspace access, Homebrew and developer tools.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent


def clone(source: Path, destination: Path):
    if destination.exists():
        raise ValueError(f'Test destination already exists: {destination}')
    subprocess.run(['/bin/cp', '-cR', str(source), str(destination)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--audio', type=Path, required=True)
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--image', type=Path, required=True)
    parser.add_argument('--speech-word', action='append', default=[])
    parser.add_argument('--ocr-word', action='append', default=[])
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--deny-workspace', type=Path, action='append', default=[])
    args = parser.parse_args()
    root = args.workspace.resolve()
    if not root.is_relative_to(Path('/private/tmp')) or root.exists():
        raise ValueError('Use a new task-owned directory under /private/tmp for isolated verification.')
    root.mkdir(mode=0o700)
    clone(args.bundle.resolve(), root / 'Cliptext Engine')
    clone(args.models.resolve(), root / 'models')
    fixtures = root / 'fixtures'
    fixtures.mkdir(mode=0o700)
    for source, name in [(args.audio, 'speech.wav'), (args.video, 'video.mp4'), (args.image, 'slide.jpg')]:
        shutil.copyfile(source.resolve(strict=True), fixtures / name)
    (fixtures / 'expectations.json').write_text(json.dumps({'speechWords': args.speech_word, 'ocrWords': args.ocr_word}))
    (fixtures / 'insights.txt').write_text('A good pricing strategy compares customer value with alternatives. '
        'Ask customers which prices feel expensive and which feel cheap. '
        'Test prices with real customer segments before changing your offer. '
        'Use customer feedback to improve your pricing decisions.\n')
    for name in ('tmp', 'cache', 'results'):
        (root / name).mkdir(mode=0o700)
    shutil.copyfile(HERE / 'smoke_runtime.py', root / 'smoke_runtime.py')
    blocked = ['/opt/homebrew', '/usr/local', '/Library/Developer', '/Applications/Xcode.app',
               '/Applications/Codex.app', '/Library/Frameworks/Python.framework',
               str(Path.home() / 'Library' / 'Keychains'), str(Path.home() / 'Library' / 'Python'),
               str(Path.home() / '.cache'), str(Path.home() / '.codex'), str(Path.home() / '.local'),
               *[str(p.resolve()) for p in args.deny_workspace],
               str(args.bundle.resolve()), str(args.models.resolve()),
               str(args.audio.resolve()), str(args.video.resolve()), str(args.image.resolve())]
    (root / 'isolation.json').write_text(json.dumps({'network': 'OS-denied', 'developerTools': 'OS-denied',
        'originalInputs': 'OS-denied', 'blockedPaths': list(dict.fromkeys(blocked)),
        'bundleWrites': 'OS-denied', 'modelWrites': 'OS-denied', 'relocatedWithSpaces': True}, indent=2) + '\n')
    entries = '\n'.join(f'  (subpath {json.dumps(path)})' for path in blocked)
    profile = f'''(version 1)
(allow default)
(deny network*)
(deny file-write*
  (subpath {json.dumps(str(root / 'Cliptext Engine'))})
  (subpath {json.dumps(str(root / 'models'))}))
(deny file-read*
{entries})
(deny process-exec
  (literal "/usr/bin/xcrun")
  (literal "/usr/bin/swiftc")
  (literal "/usr/bin/clang")
  (literal "/usr/bin/cc")
  (literal "/usr/bin/security"))
'''
    (root / 'isolation.sb').write_text(profile)
    command = ['/usr/bin/sandbox-exec', '-f', str(root / 'isolation.sb'),
               str(root / 'Cliptext Engine' / 'python' / 'bin' / 'python3.11'), '-I', '-B',
               str(root / 'smoke_runtime.py'), '--root', str(root)]
    (root / 'run-command.json').write_text(json.dumps(command, indent=2) + '\n')
    print(json.dumps({'prepared': str(root), 'command': command}, indent=2))


if __name__ == '__main__':
    main()
