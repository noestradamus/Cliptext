#!/usr/bin/env python3
"""Resolve the installed engine's dependency closure without copying its venv.

Developer-only lock bootstrap. Run with the known working Python environment;
downloads/builds subsequently use only the pinned wheel lock, never that venv.
"""
from __future__ import annotations

import argparse
from importlib import metadata
import json
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


def installed_closure(roots: list[str]) -> list[str]:
    pending = [Requirement(value) for value in roots]
    extras_by_name: dict[str, set[str]] = {}
    versions: dict[str, str] = {}
    evaluated: set[tuple[str, tuple[str, ...]]] = set()
    while pending:
        request = pending.pop()
        name = canonicalize_name(request.name)
        extras = extras_by_name.setdefault(name, set())
        extras.update(request.extras)
        key = name, tuple(sorted(extras))
        distribution = metadata.distribution(name)
        if distribution.version not in request.specifier:
            raise ValueError(f"Installed {name} {distribution.version} does not satisfy {request.specifier}")
        if key in evaluated:
            continue
        evaluated.add(key)
        versions[name] = distribution.version
        for requirement in distribution.requires or []:
            child = Requirement(requirement)
            if child.marker and not any(child.marker.evaluate({'extra': extra}) for extra in {'', *extras}):
                continue
            pending.append(child)
    return [f"{name}=={versions[name]}" for name in sorted(versions)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=Path(__file__).with_name('requirements.in'))
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    roots = [line.strip() for line in args.input.read_text().splitlines() if line.strip() and not line.startswith('#')]
    locked = installed_closure(roots)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text('# Engine-only dependency closure. Regenerate deliberately.\n' + '\n'.join(locked) + '\n')
    print(json.dumps({'packages': len(locked), 'output': str(args.output)}))


if __name__ == '__main__':
    main()
