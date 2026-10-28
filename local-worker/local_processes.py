"""Track only Cliptext-owned subprocess groups for bounded shutdown."""
from __future__ import annotations

import contextlib
import os
import signal
import subprocess

_children = set()


def start(*args, **kwargs):
    # Every registered command must have its own group, so stopping it cannot
    # interrupt the app, shell, or any other local project.
    if kwargs.get("start_new_session") is not True:
        raise ValueError("Local helpers require a dedicated process group.")
    for child in tuple(_children):
        if child.poll() is not None:
            _children.discard(child)
    child = subprocess.Popen(*args, **kwargs)
    _children.add(child)
    return child


def stop_all():
    for child in tuple(_children):
        if child.poll() is None:
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(child.pid, signal.SIGKILL)
