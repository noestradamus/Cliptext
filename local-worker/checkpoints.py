"""Private, crash-safe local processing checkpoints (never credentials)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import tempfile


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".checkpoint-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, allow_nan=False)
            output.flush()
            os.fsync(output.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def read_json(path: Path, default=None, limit=4_000_000):
    try:
        if path.is_symlink() or path.stat().st_size > limit:
            return default
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return default


def job_directory(root: Path, job_id: str) -> Path:
    if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
        raise ValueError("The job identifier is invalid.")
    target = root / "jobs" / job_id
    if target.is_symlink():
        raise ValueError("The local checkpoint directory is invalid.")
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    return target


def local_file(directory: Path, name: str) -> Path | None:
    if not isinstance(name, str):
        return None
    path = directory / name
    try:
        if path.is_symlink() or directory.resolve() not in path.resolve().parents or not path.is_file():
            return None
    except OSError:
        return None
    return path
