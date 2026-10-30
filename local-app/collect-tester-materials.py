#!/usr/bin/env python3
"""Collect source archives, recipes, and notices for a private tester payload.

This downloads and hashes upstream material; it never executes a formula or
downloaded source. Collection is not an attestation of redistribution compliance.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.parse
import urllib.request

FORMAT = "cliptext-tester-materials"
TOOLS = ("dav1d", "ffmpeg", "lame", "libvmaf", "libvpx", "openssl@3", "opus", "svt-av1", "x264", "x265")
X264_REVISION = "b35605ace3ddf7c1a5d67a2eb553f034aef41d55"


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def fetch(url: str, destination: Path, expected: str | None = None, cache: Path | None = None) -> dict:
    if not url.startswith("https://"):
        raise ValueError("Source downloads require HTTPS")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_symlink():
        raise ValueError("Source output must not be a symlink")
    if destination.is_file() and (expected is None or digest(destination) == expected):
        return {"url": url, "sha256": digest(destination), "bytes": destination.stat().st_size, "reused": True}
    if expected and cache and cache.is_dir():
        for candidate in cache.glob("*--" + destination.name):
            if candidate.is_file() and not candidate.is_symlink() and digest(candidate) == expected:
                shutil.copyfile(candidate, destination)
                return {"url": url, "sha256": expected, "bytes": destination.stat().st_size, "cacheVerified": True}
    temporary = destination.with_name(destination.name + ".partial")
    started = time.monotonic()
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Cliptext-private-tester-source-collector/1"})
        with urllib.request.urlopen(request, timeout=30) as response, temporary.open("wb") as stream:
            if not response.geturl().startswith("https://"):
                raise ValueError("Source download redirected away from HTTPS")
            size = 0
            while block := response.read(1024 * 1024):
                size += len(block)
                if size > 256 * 1024 * 1024 or time.monotonic() - started > 120:
                    raise ValueError("Source download exceeded its size or time bound")
                stream.write(block)
        actual = digest(temporary)
        if expected and actual != expected:
            raise ValueError("Source archive does not match the formula's SHA-256")
        temporary.replace(destination)
        return {"url": url, "sha256": actual, "bytes": destination.stat().st_size, "publisherHashVerified": expected is not None}
    finally:
        temporary.unlink(missing_ok=True)


def formula_input(directory: Path) -> dict:
    formulas = list(directory.glob("*.rb"))
    if len(formulas) != 1:
        raise ValueError("Expected one collected Homebrew formula")
    text = formulas[0].read_text()
    url = re.search(r'^  url "([^"\n]+)"', text, re.M)
    checksum = re.search(r'^  sha256 "([0-9a-f]{64})"', text, re.M)
    revision = re.search(r'^\s+revision: "([0-9a-f]{40})"', text, re.M)
    if not url or not (checksum or revision):
        raise ValueError("Formula has no pinned top-level source")
    return {"formula": formulas[0], "url": url[1], "sha256": checksum[1] if checksum else None,
            "revision": revision[1] if revision else None,
            "mirrors": re.findall(r'^  mirror "(https://[^"\n]+)"', text, re.M)}


def copy_recipe(original: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=True)
    for path in original.iterdir():
        if not path.is_file() or path.is_symlink():
            continue
        destination = output / path.name
        if path.name == "build-receipt.json":
            receipt = json.loads(path.read_text())
            if isinstance(receipt.get("source"), dict) and "path" in receipt["source"]:
                receipt["source"]["path"] = "[build-machine Homebrew formula cache]"
            destination.write_text(json.dumps(receipt, indent=2) + "\n")
        else:
            shutil.copyfile(path, destination)


def git_x264(destination: Path) -> dict:
    """Verify the formula's exact Git object before creating the source archive."""
    revision = X264_REVISION
    work = destination.parent / ".x264-source-git"
    work.mkdir(exist_ok=True)
    if not (work / ".git").exists():
        subprocess.run(["git", "init", "--quiet", "--template=", str(work)], check=True, capture_output=True, timeout=30)
    environment = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    errors = []
    origin = None
    for url in ["https://code.videolan.org/videolan/x264.git", "https://github.com/mirror/x264.git"]:
        try:
            subprocess.run(["git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-C", str(work),
                            "fetch", "--depth=1", "--no-tags", url, revision],
                           check=True, capture_output=True, text=True, timeout=30, env=environment)
            actual = subprocess.check_output(["git", "-C", str(work), "rev-parse", "FETCH_HEAD^{commit}"], text=True).strip()
            if actual != revision:
                raise ValueError("x264 Git revision differs from the formula pin")
            origin = url
            break
        except (subprocess.SubprocessError, ValueError) as error:
            errors.append(type(error).__name__)
    if origin is None:
        raise ValueError("Could not fetch pinned x264 Git source: " + ", ".join(errors))
    with destination.open("wb") as stream:
        subprocess.run(["git", "-C", str(work), "archive", "--format=tar.gz", "--prefix=x264-" + revision + "/", revision],
                       stdout=stream, stderr=subprocess.PIPE, check=True, timeout=30)
    shutil.rmtree(work)
    return {"url": origin, "revision": revision, "gitCommitVerified": True, "sha256": digest(destination), "bytes": destination.stat().st_size}


def collect_tool(name: str, tools: Path, output: Path, cache: Path) -> dict:
    versions = [p for p in (tools / name).iterdir() if p.is_dir()]
    if len(versions) != 1:
        raise ValueError("Expected one installed tool version")
    source = versions[0]
    pin = formula_input(source)
    copy_recipe(source, output / "recipes" / name / source.name)
    if name == "x264":
        if pin["revision"] != X264_REVISION:
            raise ValueError("x264 source revision must be deliberately reviewed")
        destination = output / "sources" / ("x264-" + X264_REVISION + ".tar.gz")
        record = git_x264(destination)
    else:
        filename = urllib.parse.unquote(urllib.parse.urlsplit(pin["url"]).path.rsplit("/", 1)[-1])
        if not re.fullmatch(r"[A-Za-z0-9_.+-]+", filename):
            raise ValueError("Unexpected source archive filename")
        destination = output / "sources" / filename
        candidates = [pin["url"], *pin["mirrors"]]
        if name == "ffmpeg":
            candidates.append(pin["url"].replace("https://ffmpeg.org/", "https://www.ffmpeg.org/"))
        errors = []
        for url in candidates[:2]:
            try:
                record = fetch(url, destination, pin["sha256"], cache)
                break
            except Exception as error:
                errors.append(type(error).__name__ + ": " + str(error)[:180])
        else:
            return {"name": name, "version": source.name, "available": False, "errors": errors, "url": pin["url"], "expectedSHA256": pin["sha256"]}
    return {"name": name, "version": source.name, "available": True, "archive": str(destination.relative_to(output)),
            "recipe": str((output / "recipes" / name / source.name).relative_to(output)), **record}


def collect_node(tools: Path, output: Path) -> dict:
    manifest = json.loads((tools.parent.parent / "resources/tool-manifest.json").read_text())
    version = manifest["node"]["version"].removeprefix("v")
    filename = "node-v" + version + ".tar.xz"
    base = "https://nodejs.org/dist/v" + version + "/"
    sums = output / "recipes/node/SHASUMS256.txt"
    fetch(base + "SHASUMS256.txt", sums)
    matches = re.findall(r"^([0-9a-f]{64})\s+" + re.escape(filename) + r"$", sums.read_text(), re.M)
    if len(matches) != 1:
        raise ValueError("Official Node source checksum missing")
    shutil.copyfile(tools / "node/LICENSE", sums.parent / "LICENSE")
    destination = output / "sources" / filename
    record = fetch(base + filename, destination, matches[0])
    return {"name": "node", "version": version, "available": True, "archive": str(destination.relative_to(output)), "recipe": "recipes/node", **record}


def collect_js_and_fonts(repository: Path, output: Path) -> dict:
    result = []
    lock = json.loads((repository / "package-lock.json").read_text())
    for relative, package in lock.get("packages", {}).items():
        if not relative.startswith("node_modules/"):
            continue
        directory = repository / relative
        if not directory.is_dir() or directory.is_symlink():
            continue
        files = []
        for path in directory.iterdir():
            if path.is_file() and not path.is_symlink() and re.match(r"(?i)^(license|licence|copying|copyright|notice)(?:[._-]|$)", path.name):
                destination = output / "notices/javascript" / relative.removeprefix("node_modules/") / path.name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(path, destination)
                files.append(str(destination.relative_to(output)))
        result.append({"package": relative, "version": package.get("version"), "declaredLicense": package.get("license"), "files": files})
    # This package supplies its notice in the source header instead of a
    # standalone LICENSE file. Preserve that header and the MIT permission text.
    qr = repository / "node_modules/qrcode-generator"
    if qr.is_dir():
        package = json.loads((qr / "package.json").read_text())
        entry = qr / package["main"]
        header = entry.read_text().split("var qrcode =", 1)[0].strip()
        if package.get("license") != "MIT" or "Copyright (c) 2009 Kazuhiko Arase" not in header:
            raise ValueError("QR-code package notice must be deliberately reviewed")
        template = (repository / "node_modules/react/LICENSE").read_text()
        permission = "Permission is hereby granted" + template.split("Permission is hereby granted", 1)[1]
        destination = output / "notices/javascript/qrcode-generator/SOURCE-NOTICE.txt"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(header + "\n\nMIT permission text (license identified by the source header and package metadata):\n\n" + permission)
        for item in result:
            if item["package"] == "node_modules/qrcode-generator":
                item["files"].append(str(destination.relative_to(output)))
    shutil.copytree(repository / "public/fonts/licenses", output / "notices/fonts/licenses", dirs_exist_ok=True)
    shutil.copyfile(repository / "public/fonts/OFL.txt", output / "notices/fonts/OFL.txt")
    shutil.copyfile(repository / "public/fonts/README.md", output / "notices/fonts/README.md")
    return {"javascript": result, "fontNotices": "notices/fonts"}


def collect_models(repository: Path, output: Path) -> list[dict]:
    lock = json.loads((repository / "local-worker/packaging/models.lock.json").read_text())
    records = []
    for model in lock["models"]:
        directory = output / "notices/models" / model["id"]
        directory.mkdir(parents=True, exist_ok=True)
        entry = {key: model[key] for key in ["id", "repository", "revision", "license"]}
        entry["files"] = []
        if model["id"] == "whisper-large-v3":
            urls = {"LICENSE": "https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE",
                    "UPSTREAM-README.md": "https://raw.githubusercontent.com/openai/whisper/v20250625/README.md"}
        else:
            info_url = "https://huggingface.co/api/models/Qwen/Qwen3-4B-Instruct-2507"
            info = json.load(urllib.request.urlopen(urllib.request.Request(info_url, headers={"User-Agent": "Cliptext-source-collector/1"}), timeout=30))
            upstream_revision = info["sha"]
            if not re.fullmatch(r"[0-9a-f]{40}", upstream_revision):
                raise ValueError("Unexpected model upstream revision")
            entry["upstreamLicenseRevision"] = upstream_revision
            urls = {"LICENSE": "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/resolve/" + upstream_revision + "/LICENSE",
                    "CONVERSION-README.md": "https://huggingface.co/" + model["repository"] + "/resolve/" + model["revision"] + "/README.md"}
        for name, url in urls.items():
            expected = next((file["sha256"] for file in model["files"] if file["name"] == "README.md"), None) if name == "CONVERSION-README.md" else None
            item = fetch(url, directory / name, expected)
            entry["files"].append({"path": str((directory / name).relative_to(output)), **item})
        text = (directory / "LICENSE").read_text()
        if model["license"] == "MIT" and "Permission is hereby granted" not in text or model["license"] == "Apache-2.0" and "Apache License" not in text:
            raise ValueError("Model license text differs from its declared license")
        records.append(entry)
    return records


def collect_build_inputs(repository: Path, tools: Path, output: Path) -> dict:
    packaging = repository / "local-worker/packaging"
    destination = output / "cliptext/local-worker/packaging"
    destination.mkdir(parents=True, exist_ok=True)
    included = []
    for path in sorted(packaging.iterdir()):
        if not path.is_file() or path.is_symlink() or path.name.startswith("test_"):
            continue
        if path.suffix in {".py", ".json", ".lock", ".in", ".md"}:
            shutil.copyfile(path, destination / path.name)
            included.append(str((destination / path.name).relative_to(output)))
    shutil.copyfile(repository / "local-worker/vision-ocr.swift", output / "cliptext/local-worker/vision-ocr.swift")
    included.append("cliptext/local-worker/vision-ocr.swift")
    native = output / "cliptext/local-app"
    native.mkdir(parents=True, exist_ok=True)
    for name in ["build-mac.mjs", "build-dmg.mjs", "package.mjs", "package-policy.mjs", "clean-runtime.py", "collect-tester-materials.py"]:
        shutil.copyfile(repository / "local-app" / name, native / name)
        included.append(str((native / name).relative_to(output)))
    (native / "mac").mkdir(exist_ok=True)
    for name in ["CliptextApp.swift", "Info.plist"]:
        shutil.copyfile(repository / "local-app/mac" / name, native / "mac" / name)
        included.append(str((native / "mac" / name).relative_to(output)))
    def anonymous(value):
        if isinstance(value, dict):
            return {key: anonymous(item) for key, item in value.items()}
        if isinstance(value, list):
            return [anonymous(item) for item in value]
        if isinstance(value, str):
            # Keep the relevant package suffix, without the build user's home.
            if value.startswith("/Users/"):
                if "/site-packages/" in value:
                    return "[build-machine]/site-packages/" + value.split("/site-packages/", 1)[1]
                return "[build-machine path]"
            if value.startswith(("/private/tmp/", "/tmp/")):
                return "[temporary build-machine path]"
        return value
    records = {}
    resources = tools.parent.parent / "resources"
    for name in ["runtime-relocations.json", "tool-manifest.json"]:
        source = resources / name
        target = output / "cliptext" / name
        target.write_text(json.dumps(anonymous(json.loads(source.read_text())), indent=2) + "\n")
        records[name] = str(target.relative_to(output))
    (output / "BUILDING.md").write_text("""# Source and build inputs for the private tester package

The sources/ directory carries the exact upstream releases used by the bundled
media tools and libraries, plus Node. Each archive has its size and SHA-256 in
manifest.json. The x264 archive was made only after fetching and verifying the
exact Git commit pinned by its Homebrew formula.

The recipes/ directory preserves the collected Homebrew formula for each media
component, its license files, and its build receipt. The receipt's source.path
has been replaced on this copy to remove the build user's private cache path.
The formulas retain their configure/CMake/Meson flags and source modifications,
including the LAME symbol-list inreplace. They are text inputs and were not run
while collecting these materials. Homebrew version/compiler information remains
in the receipts; formula helpers come from the corresponding Homebrew toolchain.

The cliptext/local-worker/packaging directory contains the app's runtime
collection, audit, and relocation scripts and pinned runtime/model manifests.
cliptext/local-app carries the matching package/native/disk-image builders and
native wrapper source. These scripts retain Cliptext's existing license status.
cliptext/runtime-relocations.json records the actual Python-library relocation
operations. Private build paths are represented by neutral placeholders; the
package-relative paths and OpenMP replacement remain intact. The copied
tool-manifest.json identifies tool versions and collection/audit inputs.

To rebuild, build the versions in sources/ using their recipes, then use the
included bundle_tools.py and build_engine.py scripts to collect the native
closure and Python runtime. Supply FFmpeg/FFprobe explicitly and keep the lock
files and full runtime directory together. Run audit_bundle.py with
--max-macos 15.6, and run inference and installation checks separately. The
installed tester app already includes its runtime; none of these build tools
are needed for normal use.

The notices/ directory includes JavaScript notices, font licenses, and the
upstream model licenses/readmes. Python/runtime license metadata remains inside
the app's embedded runtime. Source collection and hash verification do not
establish an exact binary reproduction build or certify redistribution
compliance. Cliptext's own license has not been selected by this collection.
""")
    return {"files": included, "records": records}


def inventory(output: Path) -> list[dict]:
    result = []
    for path in sorted(output.rglob("*")):
        if path.is_symlink():
            raise ValueError("Materials must not contain symlinks")
        if path.is_file() and path != output / "manifest.json":
            result.append({"path": str(path.relative_to(output)), "sha256": digest(path), "bytes": path.stat().st_size})
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools-dir", type=Path, required=True)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--homebrew-cache", type=Path, default=Path.home() / "Library/Caches/Homebrew/downloads")
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    marker = output / "manifest.json"
    legacy_marker = output / ".cliptext-materials.json"
    if marker.exists():
        if json.loads(marker.read_text()).get("format") != FORMAT:
            parser.error("Output is not a managed materials directory")
    elif legacy_marker.exists():
        if json.loads(legacy_marker.read_text()).get("format") != FORMAT:
            parser.error("Output is not a managed materials directory")
    elif any(output.iterdir()):
        parser.error("Use a fresh output directory")
    legacy_marker.unlink(missing_ok=True)
    (output / "sources").mkdir(exist_ok=True)
    result = {"format": FORMAT, "version": 1, "recordedAtUTC": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "sourceArchives": [], "issues": [], "limits": ["No downloaded source or Homebrew formula was executed.",
              "Source archive and build-recipe collection is not a reproduction build or an attestation of complete redistribution compliance."]}
    def save():
        temporary = output / "manifest.json.partial"
        temporary.write_text(json.dumps(result, indent=2) + "\n")
        temporary.replace(output / "manifest.json")
    save()
    with ThreadPoolExecutor(max_workers=4) as executor:
        tasks = {executor.submit(collect_tool, name, args.tools_dir, output, args.homebrew_cache): name for name in TOOLS}
        tasks[executor.submit(collect_node, args.tools_dir, output)] = "node"
        for task in as_completed(tasks):
            name = tasks[task]
            try:
                record = task.result()
            except Exception as error:
                record = {"name": name, "available": False, "error": type(error).__name__ + ": " + str(error)[:200]}
            result["sourceArchives"].append(record)
            print(json.dumps({"component": name, "available": record["available"], "bytes": record.get("bytes")}), flush=True)
            save()
    for name, action in [("notices", lambda: collect_js_and_fonts(args.repository, output)), ("models", lambda: collect_models(args.repository, output)),
                         ("buildInputs", lambda: collect_build_inputs(args.repository, args.tools_dir, output))]:
        try:
            result[name] = action()
        except Exception as error:
            result["issues"].append({"component": name, "error": type(error).__name__ + ": " + str(error)[:200]})
        save()
    result["allRequestedSourcesAvailable"] = all(record["available"] for record in result["sourceArchives"]) and len(result["sourceArchives"]) == 11
    result["includeFiles"] = inventory(output)
    save()
    print(json.dumps({"allRequestedSourcesAvailable": result["allRequestedSourcesAvailable"], "issueCount": len(result["issues"])}), flush=True)
    return 0 if result["allRequestedSourcesAvailable"] and not result["issues"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
