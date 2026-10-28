#!/usr/bin/env python3
"""Build portable macOS tools for the isolated Cliptext engine prototype.

This is a *build-time* utility: otool, install_name_tool and swiftc are used here,
not by the resulting engine. The current FFmpeg input is a local Homebrew build;
the manifest deliberately does not claim redistribution/license readiness.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import urllib.request


NODE_VERSION = "22.23.4"
NODE_ARCHIVE = f"node-v{NODE_VERSION}-darwin-arm64.tar.gz"
NODE_SHA256 = "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428"
NODE_URL = f"https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}"
SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")
MACHO_MAGIC = {b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"}


def run(command: list[str], *, timeout: int = 120, env: dict | None = None) -> str:
    result = subprocess.run(command, check=True, capture_output=True, text=True,
                            timeout=timeout, env=env)
    return result.stdout.strip()


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def is_system(value: str) -> bool:
    return value.startswith(SYSTEM_PREFIXES)


def is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as source:
            return source.read(4) in MACHO_MAGIC
    except OSError:
        return False


def library_id(path: Path) -> str | None:
    lines = run(["/usr/bin/otool", "-D", str(path)]).splitlines()
    return next((line.strip() for line in lines[1:] if line.strip() and not line.endswith(":")), None)


def dependencies(path: Path) -> list[str]:
    identity = library_id(path)
    output = run(["/usr/bin/otool", "-L", str(path)])
    values = [line.strip().split(" (compatibility version", 1)[0]
              for line in output.splitlines()[1:] if " (compatibility version" in line]
    return [value for value in values if value != identity]


def rpaths(path: Path) -> list[str]:
    output = run(["/usr/bin/otool", "-l", str(path)])
    return re.findall(r"cmd LC_RPATH\n\s+cmdsize \d+\n\s+path (.*?) \(offset", output)


def minimum_macos(path: Path) -> str | None:
    output = run(["/usr/bin/otool", "-l", str(path)])
    match = re.search(r"cmd LC_BUILD_VERSION\n(?:[^\n]*\n){1,3}?\s+minos ([\d.]+)", output)
    if not match:
        match = re.search(r"cmd LC_VERSION_MIN_MACOSX\n\s+cmdsize \d+\n\s+version ([\d.]+)", output)
    return match[1] if match else None


def relative_reference(loader: Path, target: Path) -> str:
    return "@loader_path/" + os.path.relpath(target, loader.parent)


class ToolBundler:
    def __init__(self, output: Path):
        self.output = output.resolve()
        self.bin = self.output / "bin"
        self.lib = self.output / "lib"
        self.licenses = self.output / "licenses" / "tools"
        self.sources: dict[Path, Path] = {}
        self.original: dict[Path, dict] = {}
        self.formulas: set[Path] = set()
        for path in (self.bin, self.lib, self.licenses, self.output / "resources"):
            path.mkdir(parents=True, exist_ok=True)

    def resolve(self, value: str, loader: Path, executable: Path) -> Path:
        if value.startswith("@loader_path/"):
            return (loader.parent / value.removeprefix("@loader_path/")).resolve(strict=True)
        if value.startswith("@executable_path/"):
            return (executable.parent / value.removeprefix("@executable_path/")).resolve(strict=True)
        if value.startswith("@rpath/"):
            suffix = value.removeprefix("@rpath/")
            for search in rpaths(loader) + rpaths(executable):
                expanded = search.replace("@loader_path", str(loader.parent)).replace("@executable_path", str(executable.parent))
                candidate = Path(expanded) / suffix
                if candidate.is_file():
                    return candidate.resolve()
            raise ValueError(f"Unresolved library {value!r} in {loader}")
        if value.startswith("/"):
            return Path(value).resolve(strict=True)
        raise ValueError(f"Unsupported load dependency {value!r} in {loader}")

    def add(self, source: Path, destination: Path, executable: Path | None = None) -> None:
        source = source.resolve(strict=True)
        if source in self.sources:
            return
        if not is_macho(source):
            raise ValueError(f"Expected a Mach-O binary: {source}")
        if destination.exists() and destination not in self.sources.values():
            # Rebuilds may replace their own prior artifact; collisions within a
            # closure are checked when assigning each dependency below.
            destination.unlink()
        shutil.copy2(source, destination)
        destination.chmod(destination.stat().st_mode | 0o200)
        self.sources[source] = destination
        entry = executable or source
        self.original[source] = {"source": str(source), "sha256": digest(source),
                                 "executable": str(entry), "loadDependencies": dependencies(source)}
        self._remember_formula(source)
        for value in self.original[source]["loadDependencies"]:
            if is_system(value):
                continue
            dependency = self.resolve(value, source, entry)
            if dependency in self.sources:
                continue
            name = dependency.name
            proposed = self.lib / name
            existing = next((old for old, dest in self.sources.items() if dest == proposed), None)
            if existing and existing != dependency:
                if digest(existing) == digest(dependency):
                    self.sources[dependency] = proposed
                    continue
                proposed = self.lib / f"{digest(dependency)[:12]}-{name}"
            self.add(dependency, proposed, entry)

    def _remember_formula(self, path: Path) -> None:
        parts = path.parts
        if "Cellar" in parts:
            index = parts.index("Cellar")
            if len(parts) >= index + 3:
                self.formulas.add(Path(*parts[:index + 3]))

    def relocate(self) -> None:
        for source, destination in self.sources.items():
            original = self.original.get(source)
            if original is None:
                continue  # byte-identical alternate source name
            changes = []
            for value in original["loadDependencies"]:
                if is_system(value):
                    continue
                # Every input used by this prototype has absolute or
                # loader-relative linkage. resolve() also covers explicit
                # rpaths without relying on the runtime environment.
                dependency = self.resolve(value, source, Path(original["executable"]))
                target = self.sources[dependency]
                changes.extend(["-change", value, relative_reference(destination, target)])
            identity = library_id(destination)
            if identity:
                changes.extend(["-id", "@rpath/" + destination.name])
            for search in rpaths(destination):
                if not is_system(search):
                    changes.extend(["-delete_rpath", search])
            if changes:
                run(["/usr/bin/install_name_tool", *changes, str(destination)])
            run(["/usr/bin/codesign", "--force", "--sign", "-", str(destination)])
            run(["/usr/bin/codesign", "--verify", "--strict", str(destination)])

    def collect_licenses(self) -> list[dict]:
        result = []
        for formula in sorted(self.formulas):
            destination = self.licenses / formula.parent.name / formula.name
            destination.mkdir(parents=True, exist_ok=True)
            copied = []
            for source in formula.iterdir():
                if source.is_file() and any(term in source.name.lower() for term in ("license", "copying", "copyright", "notice")):
                    shutil.copy2(source, destination / source.name)
                    copied.append(source.name)
            receipt = formula / "INSTALL_RECEIPT.json"
            if receipt.is_file():
                raw = json.loads(receipt.read_text())
                selected = {key: raw[key] for key in ("homebrew_version", "built_as_bottle", "poured_from_bottle", "compiler", "source", "runtime_dependencies") if key in raw}
                (destination / "build-receipt.json").write_text(json.dumps(selected, indent=2) + "\n")
            brew = formula / ".brew"
            if brew.is_dir():
                for recipe in brew.glob("*.rb"):
                    shutil.copy2(recipe, destination / recipe.name)
            result.append({"formula": formula.parent.name, "version": formula.name,
                           "licenseFiles": copied, "directory": str(destination.relative_to(self.output))})
        return result


def install_node(bundle: ToolBundler, cache: Path) -> dict:
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / NODE_ARCHIVE
    if not archive.is_file() or digest(archive) != NODE_SHA256:
        temporary = archive.with_suffix(".download")
        try:
            with urllib.request.urlopen(NODE_URL, timeout=45) as response, temporary.open("wb") as output:
                shutil.copyfileobj(response, output)
            if digest(temporary) != NODE_SHA256:
                raise ValueError("The pinned Node archive checksum did not match.")
            os.replace(temporary, archive)
        finally:
            temporary.unlink(missing_ok=True)
    prefix = f"node-v{NODE_VERSION}-darwin-arm64"
    with tarfile.open(archive, "r:gz") as source:
        binary = source.extractfile(prefix + "/bin/node")
        license_file = source.extractfile(prefix + "/LICENSE")
        if binary is None or license_file is None:
            raise ValueError("The Node archive is missing its binary or license.")
        node = cache / "node"
        with node.open("wb") as output:
            shutil.copyfileobj(binary, output)
        node.chmod(0o755)
        license_destination = bundle.licenses / "node"
        license_destination.mkdir(parents=True, exist_ok=True)
        (license_destination / "LICENSE").write_bytes(license_file.read())
    bundle.add(node, bundle.bin / "node")
    return {"version": NODE_VERSION, "url": NODE_URL, "archiveSha256": NODE_SHA256}


def compile_vision(bundle: ToolBundler, source: Path, scratch: Path) -> dict:
    scratch.mkdir(parents=True, exist_ok=True)
    cache = scratch / "swift-module-cache"
    cache.mkdir(exist_ok=True)
    binary = scratch / "vision-ocr"
    run(["/usr/bin/xcrun", "swiftc", "-O", "-target", "arm64-apple-macosx14.0",
         "-module-cache-path", str(cache), str(source), "-o", str(binary)], timeout=180)
    bundle.add(binary, bundle.bin / "vision-ocr")
    return {"sourceSha256": digest(source), "target": "arm64-apple-macosx14.0",
            "compiler": run(["/usr/bin/xcrun", "swiftc", "--version"])}


def audit(output: Path) -> dict:
    output = output.resolve()
    findings = []
    checked = []
    minimums = []
    for directory in (output / "bin", output / "lib"):
        if not directory.is_dir():
            continue
        for path in sorted(directory.iterdir()):
            if not path.is_file() or not is_macho(path):
                continue
            loads = dependencies(path)
            for value in loads:
                if is_system(value):
                    continue
                if value.startswith("@loader_path/"):
                    target = (path.parent / value.removeprefix("@loader_path/")).resolve()
                    if not target.is_relative_to(output) or not target.is_file():
                        findings.append({"file": str(path.relative_to(output)), "dependency": value})
                elif value.startswith("@rpath/libswift") and "/usr/lib/swift" in rpaths(path):
                    # Apple ships these libraries in the system dyld cache.
                    continue
                else:
                    findings.append({"file": str(path.relative_to(output)), "dependency": value})
            for value in rpaths(path):
                if value.startswith("/") and not is_system(value):
                    findings.append({"file": str(path.relative_to(output)), "rpath": value})
            minimum = minimum_macos(path)
            if minimum:
                minimums.append(tuple(int(part) for part in minimum.split(".")))
            checked.append({"file": str(path.relative_to(output)), "sha256": digest(path),
                            "bytes": path.stat().st_size, "minimumMacOS": minimum,
                            "loadDependencies": loads})
    return {"passed": not findings, "externalLoadFindings": findings, "binaries": checked,
            "toolMinimumMacOS": ".".join(map(str, max(minimums))) if minimums else None}


def smoke(output: Path) -> dict:
    # This does not borrow any Homebrew PATH entries or developer executables.
    environment = {"PATH": str(output / "bin") + ":/usr/bin:/bin", "HOME": str(output.parent / "tool-smoke-home"),
                   "LANG": "en_US.UTF-8", "LC_ALL": "en_US.UTF-8"}
    return {"ffmpeg": run([str(output / "bin/ffmpeg"), "-version"], env=environment).splitlines()[0],
            "ffprobe": run([str(output / "bin/ffprobe"), "-version"], env=environment).splitlines()[0],
            "node": run([str(output / "bin/node"), "--version"], env=environment),
            "nodeEvaluation": run([str(output / "bin/node"), "-e", "console.log(6*7)"], env=environment)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, default=Path("/opt/homebrew/bin/ffmpeg"))
    parser.add_argument("--ffprobe", type=Path, default=Path("/opt/homebrew/bin/ffprobe"))
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--audit-only", action="store_true")
    arguments = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("This prototype tool builder requires an Apple Silicon Mac.")
    output = arguments.output.resolve()
    if arguments.audit_only:
        report = audit(output)
        print(json.dumps(report, indent=2))
        raise SystemExit(0 if report["passed"] else 1)
    bundle = ToolBundler(output)
    scratch = (arguments.cache or output.parent / "tool-build").resolve()
    bundle.add(arguments.ffmpeg, bundle.bin / "ffmpeg")
    bundle.add(arguments.ffprobe, bundle.bin / "ffprobe")
    node = install_node(bundle, scratch / "downloads")
    vision = compile_vision(bundle, Path(__file__).resolve().parents[1] / "vision-ocr.swift", scratch / "vision")
    bundle.relocate()
    report = audit(output)
    if not report["passed"]:
        raise RuntimeError(json.dumps(report["externalLoadFindings"]))
    manifest = {"format": "cliptext-engine-tools", "version": 1,
                "builtAt": datetime.now(timezone.utc).isoformat(), "architecture": "arm64",
                "signature": "ad-hoc; not notarized", "redistributionReady": False,
                "redistributionNotes": ["Prototype FFmpeg is built with GPL/version3 support and GPL libraries.",
                                        "Collected notices and build receipts are not a corresponding-source distribution.",
                                        "A distributable release needs a deliberate license/source compliance review."],
                "node": node, "vision": vision, "licenses": bundle.collect_licenses(),
                "audit": report, "smoke": smoke(output)}
    (output / "resources/tool-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"output": str(output), "binaryCount": len(report["binaries"]),
                      "auditPassed": report["passed"], "toolMinimumMacOS": report["toolMinimumMacOS"],
                      "smoke": manifest["smoke"], "redistributionReady": False}))


if __name__ == "__main__":
    main()
