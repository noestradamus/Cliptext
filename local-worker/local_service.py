#!/usr/bin/env python3
"""Supervised packaged engine for Cliptext's loopback-only local backend.

Reads one private configuration object on stdin. There is no Site credential,
Keychain lookup, hosted fallback or implicit model download in this entry point.
"""
from __future__ import annotations

import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
from urllib.parse import urlsplit, urlunsplit

# The bundled interpreter is deliberately launched with -I. Resolve only our
# adjacent packaged engine modules, never an ambient PYTHONPATH/user install.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from worker import DEFAULT_MODEL, STOP, SiteClient, SiteError, Worker, log, safe_error, stop_worker

MAX_CONFIG_BYTES = 64 * 1024
CONFIG_KEYS = {"api_url", "engine_key", "runtime_dir", "speech_model_path",
               "insights_model_path", "poll_seconds", "model_repo", "supervisor_pid"}


class LocalClient(SiteClient):
    """Reuse bounded media uploads/pools with independent local authorization."""

    def __init__(self, origin: str, engine_key: str):
        if not isinstance(origin, str):
            raise ValueError("A loopback API origin is required.")
        try:
            parsed = urlsplit(origin)
            address = ipaddress.ip_address(parsed.hostname or "")
            valid = (parsed.scheme == "http" and address.is_loopback
                     and parsed.port is not None and 1 <= parsed.port <= 65535
                     and parsed.username is None and parsed.password is None
                     and parsed.path in ("", "/") and not parsed.query and not parsed.fragment)
        except ValueError:
            valid = False
        if not valid:
            raise ValueError("The local engine requires an HTTP loopback IP origin with an explicit port.")
        if not isinstance(engine_key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", engine_key):
            raise ValueError("A valid local engine authorization key is required.")
        self.origin = urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        self._engine_key = engine_key
        self._bearer = engine_key  # Existing Worker error redaction also covers this value.
        self._connections = threading.local()

    def _request(self, method: str, path: str, body: dict, attempts: int, extra_headers=None) -> dict:
        import requests

        if not isinstance(path, str) or not re.fullmatch(r"/api/worker/[A-Za-z0-9/_-]+", path):
            raise ValueError("Worker requests must stay within the local worker API.")
        headers = {"Content-Type": "application/json",
                   **{key: value for key, value in (extra_headers or {}).items() if not key.lower().startswith("oai-")},
                   "Authorization": "Bearer " + self._engine_key,
                   "X-Cliptext-Engine": "1", "X-Cliptext-Engine-Key": self._engine_key}
        attempts = max(1, min(3, int(attempts)))
        request_body = {} if method.upper() in {"GET", "HEAD"} else body
        for attempt in range(attempts):
            try:
                response = self.session().request(method, self.origin + path, headers=headers, **request_body,
                                                  timeout=(5, 35), allow_redirects=False)
                if 200 <= response.status_code < 300:
                    return response.json() if response.content else {}
                if response.status_code in {408, 425, 429} or response.status_code >= 500:
                    if attempt + 1 < attempts:
                        STOP.wait(min(2 ** attempt, 20))
                        continue
                raise SiteError(response.status_code, "The local Cliptext backend could not accept the worker request.")
            except requests.RequestException:
                if attempt + 1 >= attempts:
                    raise SiteError(0, "The local Cliptext backend could not be reached.") from None
                STOP.wait(min(2 ** attempt, 20))
        raise SiteError(0, "The local Cliptext backend could not be reached.")


def model_directory(value, label: str) -> Path:
    if not isinstance(value, str) or not Path(value).expanduser().is_absolute():
        raise ValueError(f"The {label} model must be an absolute local directory.")
    path = Path(value).expanduser().resolve(strict=True)
    weights = (any((path / name).is_file() for name in ("weights.npz", "weights.safetensors"))
               if label == "speech" else any(path.glob("model*.safetensors")))
    if not path.is_dir() or not (path / "config.json").is_file() or not weights:
        raise ValueError(f"The local {label} model is incomplete. Prepare its pinned artifacts before starting.")
    if label == "insights" and not (path / "tokenizer.json").is_file():
        raise ValueError("The local insights tokenizer is missing.")
    return path


def read_config(stream=None) -> dict:
    stream = stream or sys.stdin
    raw = stream.readline(MAX_CONFIG_BYTES + 1)
    if len(raw.encode("utf-8")) > MAX_CONFIG_BYTES:
        raise ValueError("The local engine configuration is too large.")
    try:
        config = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError("A local engine configuration object is required on stdin.") from None
    if not isinstance(config, dict) or set(config) - CONFIG_KEYS:
        raise ValueError("The local engine configuration contains unsupported fields.")
    pid = config.get("supervisor_pid")
    if pid is not None and (isinstance(pid, bool) or not isinstance(pid, int) or pid <= 1):
        raise ValueError("The local supervisor PID must identify a running parent process.")
    return config


def monitor_supervisor(pid: int) -> None:
    """A crashed supervisor must not leave the local AI worker running alone."""
    while not STOP.is_set():
        if os.getppid() != pid:
            stop_worker()
            return
        STOP.wait(2)


def create_worker(config: dict) -> Worker:
    client = LocalClient(config.get("api_url"), config.get("engine_key"))
    value = config.get("runtime_dir")
    if not isinstance(value, str) or not Path(value).expanduser().is_absolute():
        raise ValueError("The local engine requires an absolute private runtime directory.")
    runtime = Path(value).expanduser().resolve()
    speech = model_directory(config.get("speech_model_path"), "speech")
    insights = model_directory(config.get("insights_model_path"), "insights")
    repository = config.get("model_repo", DEFAULT_MODEL)
    if not isinstance(repository, str) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
        raise ValueError("The local speech model label is invalid.")
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ.update({"HF_HOME": str(runtime / "huggingface"), "XDG_CACHE_HOME": str(runtime / "cache"),
                       "NUMBA_CACHE_DIR": str(runtime / "cache" / "numba"),
                       "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                       "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_PROGRESS_BARS": "1",
                       "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
                       "TOKENIZERS_PARALLELISM": "false"})
    return Worker({"runtime_dir": str(runtime), "speech_model_path": str(speech),
                   "insights_model_path": str(insights), "model_repo": repository,
                   "poll_seconds": config.get("poll_seconds", 2)}, client=client)


def main() -> int:
    config = {}
    previous = os.umask(0o077)
    try:
        config = read_config()
        worker = create_worker(config)
        signal.signal(signal.SIGTERM, stop_worker)
        signal.signal(signal.SIGINT, stop_worker)
        if config.get("supervisor_pid") is not None:
            threading.Thread(target=monitor_supervisor, args=(config["supervisor_pid"],),
                             name="cliptext-supervisor-watch", daemon=True).start()
        log("local_worker_ready", model=worker.repository)
        worker.run()
        return 0
    except Exception as error:
        log("local_worker_error", error=safe_error(error, (config.get("engine_key"),)))
        return 1
    finally:
        os.umask(previous)


if __name__ == "__main__":
    raise SystemExit(main())
