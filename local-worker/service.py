#!/usr/bin/env python3
"""Prepare or run Cliptext's login-started macOS engine with a Keychain secret."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import signal
import sys
import tempfile
from urllib.parse import urlsplit

from worker import DEFAULT_MODEL, STOP, SiteClient, Worker, log, read_secret_config, runtime_path, stop_worker


PUBLIC_KEYS = {"site_url", "runtime_dir", "model_repo", "poll_seconds", "keychain_service", "keychain_account"}
ENGINE_KEY_ACCOUNT = "local-engine-key"


def macos_keyring():
    if sys.platform != "darwin":
        raise RuntimeError("The background service requires macOS Keychain.")
    # Choose the native Security.framework backend explicitly. Never use a
    # fallback keyring backend that could save credentials in a plain file.
    from keyring.backends.macOS import Keyring

    return Keyring()


def write_private_file(path: Path, data: bytes) -> None:
    if path.is_symlink():
        raise ValueError("Refusing to replace a symbolic-link configuration file.")
    descriptor, temporary = tempfile.mkstemp(prefix=".cliptext-", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as output:
            output.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def service_identity(site_url: str) -> tuple[str, str, str]:
    parsed = urlsplit(site_url)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("The background service requires the production HTTPS Site origin.")
    suffix = hashlib.sha256(site_url.encode()).hexdigest()[:12]
    return (
        "com.cliptext.local-engine." + suffix,
        "Cliptext local engine: " + site_url,
        "private-site-service",
    )


def public_configuration(config: dict) -> dict:
    # Reuse the worker's origin validation without making a network request.
    client = SiteClient(config.get("site_url", ""), config.get("site_bearer", ""), config.get("engine_key", ""))
    label, service, account = service_identity(client.origin)
    root = runtime_path(config.get("runtime_dir"))
    if root.is_symlink():
        raise ValueError("The engine runtime directory must not be a symbolic link.")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    return {
        "site_url": client.origin,
        "runtime_dir": str(root),
        "model_repo": config.get("model_repo") or DEFAULT_MODEL,
        "poll_seconds": min(30, max(2, float(config.get("poll_seconds", 5)))),
        "keychain_service": service,
        "keychain_account": account,
    }


def runtime_search_path(python: str) -> str:
    directories = [os.path.dirname(python)]
    # yt-dlp can use the existing Node runtime for YouTube player JavaScript.
    # Resolve a local executable at setup time; never depend on a login shell,
    # execute a discovered binary here, or persist the caller's entire PATH.
    node = shutil.which("node")
    if node:
        executable = Path(node).resolve()
        directory = str(executable.parent)
        if executable.is_file() and os.access(executable, os.X_OK) and not re.search(r"[\x00-\x1f\x7f:]", directory):
            directories.append(directory)
    directories.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"])
    return ":".join(dict.fromkeys(directories))


def launch_agent(public: dict, config_path: Path) -> dict:
    label, _service, _account = service_identity(public["site_url"])
    root = Path(public["runtime_dir"])
    logs = root / "logs"
    logs.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Preserve the venv executable path. Resolving this symlink would bypass its
    # site-packages and launch the Homebrew base interpreter instead.
    python = os.path.abspath(sys.executable)
    path = runtime_search_path(python)
    return {
        "Label": label,
        "ProgramArguments": [python, str(Path(__file__).resolve()), "--run", "--config", str(config_path)],
        "WorkingDirectory": str(Path(__file__).resolve().parent),
        "EnvironmentVariables": {"PATH": path, "PYTHONUNBUFFERED": "1"},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 30,
        "ProcessType": "Background",
        "LimitLoadToSessionType": "Aqua",
        "ExitTimeOut": 20,
        "Umask": 0o077,
        "StandardOutPath": str(logs / "engine.log"),
        "StandardErrorPath": str(logs / "engine-error.log"),
    }


def prepare_service(config: dict, keyring_backend=None) -> dict:
    public = public_configuration(config)
    root = Path(public["runtime_dir"])
    config_path = root / "service-config.json"
    label, service, account = service_identity(public["site_url"])
    plist_path = root / (label + ".plist")
    backend = keyring_backend or macos_keyring()
    bearer = config["site_bearer"]
    engine_key = config["engine_key"]
    backend.set_password(service, account, bearer)
    stored = backend.get_password(service, account)
    if stored is None or not hmac.compare_digest(stored, bearer):
        raise RuntimeError("The existing Site credential could not be verified in macOS Keychain.")
    backend.set_password(service, ENGINE_KEY_ACCOUNT, engine_key)
    stored_engine_key = backend.get_password(service, ENGINE_KEY_ACCOUNT)
    if stored_engine_key is None or not hmac.compare_digest(stored_engine_key, engine_key):
        raise RuntimeError("The Mac-only engine key could not be verified in macOS Keychain.")
    # Only whitelisted public values reach disk. Secret configuration stays in
    # memory and the native keychain, never JSON, plist, logs, argv, or env vars.
    write_private_file(config_path, (json.dumps(public, indent=2) + "\n").encode())
    write_private_file(plist_path, plistlib.dumps(launch_agent(public, config_path)))
    return {
        "configured": True,
        "credential_storage": "macOS Keychain",
        "label": label,
        "public_config": str(config_path),
        "launch_agent_plist": str(plist_path),
        "installation_destination": str(Path.home() / "Library" / "LaunchAgents" / plist_path.name),
        "profile_installed": False,
    }


def read_service_configuration(path: Path, keyring_backend=None) -> dict:
    if path.is_symlink():
        raise ValueError("The service configuration must not be a symbolic link.")
    public = json.loads(path.read_text())
    if not isinstance(public, dict) or set(public) != PUBLIC_KEYS:
        raise ValueError("The public service configuration has unexpected or missing keys.")
    _label, expected_service, expected_account = service_identity(public["site_url"])
    if public["keychain_service"] != expected_service or public["keychain_account"] != expected_account:
        raise ValueError("The Keychain item must belong to the configured private Site.")
    backend = keyring_backend or macos_keyring()
    bearer = backend.get_password(expected_service, expected_account)
    if not bearer:
        raise RuntimeError("Cliptext's Site credential is unavailable in macOS Keychain. Unlock the login keychain or repeat secure service setup.")
    engine_key = backend.get_password(expected_service, ENGINE_KEY_ACCOUNT)
    if not engine_key:
        raise RuntimeError("Cliptext's Mac-only engine key is unavailable in macOS Keychain. Complete secure engine-key setup before starting the worker.")
    # Verify the origin again before the credential is used anywhere.
    SiteClient(public["site_url"], bearer, engine_key)
    return {**public, "site_bearer": bearer, "engine_key": engine_key}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--setup", action="store_true", help="Read hidden-stdin configuration; store both credentials in Keychain and prepare a plist under runtime_dir.")
    action.add_argument("--run", action="store_true", help="Read public config and retrieve its Site credential and Mac-only engine key from Keychain, then run the engine.")
    action.add_argument("--check", action="store_true", help="Check public config and Keychain access without starting the engine.")
    parser.add_argument("--config", type=Path)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, stop_worker)
    signal.signal(signal.SIGINT, stop_worker)
    if args.setup:
        result = prepare_service(read_secret_config())
        print(json.dumps(result, indent=2), flush=True)
        return
    if not args.config:
        parser.error("--config is required for --run or --check")
    config = read_service_configuration(args.config)
    if args.check:
        print(json.dumps({"ready": True, "site_url": config["site_url"], "credential_storage": "macOS Keychain"}), flush=True)
        return
    Worker(config).run()


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Keychain/framework errors are deliberately not echoed; they may carry
        # backend internals. Details needed for operation remain non-secret.
        log("service_error", message="Cliptext service could not start. Check its public configuration and allow its Python process to access the Cliptext item in macOS Keychain.")
        sys.exit(1)
