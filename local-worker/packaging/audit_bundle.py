#!/usr/bin/env python3
"""Static Mach-O and symlink portability audit for a local Cliptext engine.

This is a build-machine tool: it uses Apple's otool, never executes bundled code,
and does not certify signing, redistribution licenses, or runtime correctness.
"""
from __future__ import annotations

import argparse
from collections import deque
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys


SYSTEM_PREFIXES = ("/usr/lib/", "/System/Library/")
MACH_MAGICS = {
    b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",
}
LOAD_COMMANDS = {
    "LC_LOAD_DYLIB", "LC_LOAD_WEAK_DYLIB", "LC_REEXPORT_DYLIB",
    "LC_LOAD_UPWARD_DYLIB", "LC_LAZY_LOAD_DYLIB",
}


def system_path(value: str) -> bool:
    return value in ("/usr/lib", "/System/Library") or value.startswith(SYSTEM_PREFIXES)


def inside(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def version_key(value: str) -> tuple[int, ...]:
    parts = [int(part) for part in value.split(".")]
    while len(parts) > 1 and parts[-1] == 0:
        parts.pop()
    return tuple(parts)


def run_otool(path: Path) -> str:
    result = subprocess.run(
        ["/usr/bin/otool", "-l", str(path)], check=True,
        capture_output=True, text=True, timeout=30,
    )
    return result.stdout


def parse_load_commands(output: str) -> list[dict]:
    """Parse otool -l, keeping slices and LC_ID_DYLIB separate from loads."""
    slices: list[dict] = []
    current = {"architecture": "default", "dependencies": [], "rpaths": [], "installIds": [], "minimumMacOS": None}
    command: list[str] = []

    def flush_command():
        if not command:
            return
        fields = {}
        for line in command:
            pieces = line.strip().split(None, 1)
            if len(pieces) == 2:
                fields[pieces[0]] = pieces[1]
        kind = fields.get("cmd")
        if kind in LOAD_COMMANDS or kind == "LC_ID_DYLIB":
            name = re.sub(r" \(offset \d+\)$", "", fields.get("name", ""))
            if name:
                if kind == "LC_ID_DYLIB":
                    current["installIds"].append(name)
                else:
                    current["dependencies"].append({"name": name, "command": kind})
        elif kind == "LC_RPATH":
            value = re.sub(r" \(offset \d+\)$", "", fields.get("path", ""))
            if value:
                current["rpaths"].append(value)
        elif kind == "LC_BUILD_VERSION" and fields.get("platform") in {"1", "MACOS", "macos"}:
            current["minimumMacOS"] = fields.get("minos")
        elif kind == "LC_VERSION_MIN_MACOSX":
            current["minimumMacOS"] = fields.get("version")
        command.clear()

    for line in output.splitlines():
        architecture = re.search(r"\(architecture ([^)]+)\):$", line)
        if architecture:
            flush_command()
            if current["dependencies"] or current["rpaths"] or current["minimumMacOS"] or current["installIds"]:
                slices.append(current)
            current = {"architecture": architecture[1], "dependencies": [], "rpaths": [], "installIds": [], "minimumMacOS": None}
        elif re.match(r"^Load command \d+$", line):
            flush_command()
        else:
            command.append(line)
    flush_command()
    slices.append(current)
    return slices


def is_macho(path: Path) -> bool:
    with path.open("rb") as source:
        return source.read(4) in MACH_MAGICS


def executable_macho(path: Path) -> bool:
    """Read Mach-O filetype without loading or running the binary."""
    def header_at(source, offset):
        source.seek(offset)
        header = source.read(16)
        if len(header) < 16:
            return False
        if header[:4] in (b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
            return struct.unpack("<I", header[12:16])[0] == 2
        if header[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf"):
            return struct.unpack(">I", header[12:16])[0] == 2
        return False

    with path.open("rb") as source:
        magic = source.read(4)
        if magic not in (b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"):
            return header_at(source, 0)
        endian = ">" if magic in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf") else "<"
        raw = source.read(4)
        if len(raw) != 4:
            return False
        count = struct.unpack(endian + "I", raw)[0]
        if count > 100:
            return False
        wide = magic in (b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca")
        size = 32 if wide else 20
        table = source.read(count * size)
        if len(table) != count * size:
            return False
        for index in range(count):
            record = table[index * size:(index + 1) * size]
            offset = struct.unpack(endian + ("Q" if wide else "I"), record[8:16 if wide else 12])[0]
            if header_at(source, offset):
                return True
    return False


def thin_architecture(path: Path) -> str | None:
    with path.open("rb") as source:
        header = source.read(12)
    if len(header) < 12:
        return None
    if header[:4] in (b"\xce\xfa\xed\xfe", b"\xcf\xfa\xed\xfe"):
        cpu, subtype = struct.unpack("<II", header[4:12])
    elif header[:4] in (b"\xfe\xed\xfa\xce", b"\xfe\xed\xfa\xcf"):
        cpu, subtype = struct.unpack(">II", header[4:12])
    else:
        return None
    if cpu == 0x100000C:
        return "arm64e" if subtype & 0xFFFFFF == 2 else "arm64"
    if cpu == 0x1000007:
        return "x86_64h" if subtype & 0xFFFFFF == 8 else "x86_64"
    return {7: "i386", 12: "arm", 18: "ppc", 0x1000012: "ppc64"}.get(cpu)


def slice_for(record: dict, architecture: str) -> dict | None:
    for item in record["slices"]:
        if item["architecture"] == architecture:
            return item
    default = [item for item in record["slices"] if item["architecture"] == "default"]
    return default[0] if len(default) == 1 else None


class Auditor:
    def __init__(self, root: Path, max_macos: str | None = None):
        if max_macos is not None and not re.fullmatch(r"\d+(?:\.\d+){0,2}", max_macos):
            raise ValueError("The maximum macOS version must be a version such as 15.6.")
        self.root = root.resolve(strict=True)
        self.max_macos = max_macos
        self.catalog: dict[Path, dict] = {}
        self.issues: list[dict] = []
        self._issue_keys: set[str] = set()
        self.symlinks: list[dict] = []

    def relative(self, path: Path) -> str:
        return str(path.relative_to(self.root)) if inside(path, self.root) else str(path)

    def issue(self, kind: str, path: Path, **details):
        value = {"kind": kind, "path": self.relative(path), **details}
        key = json.dumps(value, sort_keys=True)
        if key not in self._issue_keys:
            self._issue_keys.add(key)
            self.issues.append(value)

    def inventory(self):
        for directory, dirs, files in os.walk(self.root, followlinks=False):
            for name in sorted(dirs + files):
                path = Path(directory) / name
                if path.is_symlink():
                    try:
                        target = path.resolve(strict=False)
                    except (OSError, RuntimeError) as error:
                        self.issue("invalid_symlink", path, error=str(error))
                        continue
                    self.symlinks.append({"path": self.relative(path), "target": self.relative(target)})
                    if not inside(target, self.root):
                        self.issue("escaping_symlink", path, target=str(target))
                    elif not target.exists():
                        self.issue("dangling_symlink", path, target=self.relative(target))
                    continue
                if not path.is_file():
                    continue
                try:
                    if is_macho(path):
                        slices = parse_load_commands(run_otool(path))
                        if len(slices) == 1 and slices[0]["architecture"] == "default":
                            slices[0]["architecture"] = thin_architecture(path) or "default"
                        self.catalog[path] = {
                            "path": self.relative(path), "executable": executable_macho(path),
                            "slices": slices, "resolutions": [],
                        }
                except (OSError, subprocess.SubprocessError) as error:
                    self.issue("inspection_error", path, error=str(error))

    def expand(self, value: str, loader: Path, executable: Path | None, inherited: tuple[str, ...]) -> list[str]:
        if value == "@loader_path" or value.startswith("@loader_path/"):
            return [str(loader.parent) + value[len("@loader_path"):]]
        if value == "@executable_path" or value.startswith("@executable_path/"):
            return [str(executable.parent) + value[len("@executable_path"):]] if executable else []
        if value.startswith("@rpath/"):
            return [base + value[len("@rpath"):] for base in inherited]
        return [value] if value.startswith("/") else []

    def rpaths(self, item: dict, loader: Path, executable: Path | None, inherited: tuple[str, ...]) -> tuple[str, ...]:
        expanded = []
        for value in item["rpaths"]:
            values = self.expand(value, loader, executable, inherited)
            if not values:
                self.issue("unresolved_rpath", loader, reference=value, executable=self.relative(executable) if executable else None)
            for entry in values:
                target = Path(entry).resolve(strict=False)
                if not inside(target, self.root) and not system_path(str(target)):
                    self.issue("outside_rpath", loader, reference=value, target=str(target))
                expanded.append(str(target))
        return tuple(dict.fromkeys(expanded + list(inherited)))

    def dependency(self, value: str, loader: Path, executable: Path | None, paths: tuple[str, ...]) -> dict:
        if system_path(value):
            # Modern macOS keeps these in the dyld shared cache, not necessarily on disk.
            return {"status": "system", "target": value}
        if value.startswith("/"):
            target = Path(value).resolve(strict=False)
            if not inside(target, self.root):
                return {"status": "outside_bundle", "target": str(target)}
            return {"status": "bundled" if target.is_file() else "missing", "target": self.relative(target)}
        candidates = self.expand(value, loader, executable, paths)
        for candidate in candidates:
            target = Path(candidate).resolve(strict=False)
            if system_path(str(target)):
                return {"status": "system", "target": str(target)}
            if target.is_file():
                return {"status": "bundled" if inside(target, self.root) else "outside_bundle", "target": self.relative(target)}
        return {"status": "unresolved", "candidates": [self.relative(Path(candidate).resolve(strict=False)) for candidate in candidates]}

    def resolve(self):
        pending = deque()
        for path, record in self.catalog.items():
            if record["executable"]:
                for item in record["slices"]:
                    pending.append((path, path, item["architecture"], (), "executable"))
        python_executables = [path for path, record in self.catalog.items() if record["executable"] and path.name.startswith("python")]
        visited = set()
        reached = set()

        def drain():
            while pending:
                loader, executable, architecture, inherited, context_kind = pending.popleft()
                context = (loader, executable, architecture, inherited)
                if context in visited:
                    continue
                visited.add(context)
                reached.add((loader, architecture))
                record = self.catalog[loader]
                item = slice_for(record, architecture)
                if item is None:
                    self.issue("missing_architecture", loader, architecture=architecture, executable=self.relative(executable) if executable else None)
                    continue
                paths = self.rpaths(item, loader, executable, inherited)
                for dependency in item["dependencies"]:
                    resolved = self.dependency(dependency["name"], loader, executable, paths)
                    edge = {**dependency, **resolved, "architecture": architecture, "executable": self.relative(executable) if executable else None, "context": context_kind}
                    if edge not in record["resolutions"]:
                        record["resolutions"].append(edge)
                    if resolved["status"] not in {"bundled", "system"}:
                        self.issue("dependency_" + resolved["status"], loader, **edge)
                    elif resolved["status"] == "bundled":
                        target = self.root / resolved["target"]
                        if target not in self.catalog:
                            self.issue("non_macho_dependency", loader, **edge)
                        else:
                            pending.append((target, executable, architecture, paths, context_kind))

        drain()
        # Python uses dlopen for extensions; those do not appear in the interpreter's
        # LC_LOAD_DYLIB graph. Explicitly inspect each in a Python host context.
        for path, record in self.catalog.items():
            if record["executable"] or "python" not in path.relative_to(self.root).parts or path.suffix != ".so":
                continue
            for item in record["slices"]:
                if (path, item["architecture"]) in reached:
                    continue
                hosts = [host for host in python_executables if slice_for(self.catalog[host], item["architecture"]) is not None]
                if not hosts:
                    pending.append((path, None, item["architecture"], (), "unattached_library"))
                for host in hosts:
                    host_slice = slice_for(self.catalog[host], item["architecture"])
                    inherited = self.rpaths(host_slice, host, host, ())
                    pending.append((path, host, item["architecture"], inherited, "python_dlopen_assumption"))
        drain()
        for path, record in self.catalog.items():
            for item in record["slices"]:
                if (path, item["architecture"]) not in reached:
                    # Only now inspect libraries that no extension or executable
                    # reached. Seeding transitive dylibs earlier would discard
                    # the valid extension LC_RPATH inherited by their real load.
                    hosts = [host for host in python_executables if "python" in path.relative_to(self.root).parts
                             and slice_for(self.catalog[host], item["architecture"]) is not None]
                    if not hosts:
                        pending.append((path, None, item["architecture"], (), "unattached_library"))
                    for host in hosts:
                        host_slice = slice_for(self.catalog[host], item["architecture"])
                        inherited = self.rpaths(host_slice, host, host, ())
                        pending.append((path, host, item["architecture"], inherited, "python_unattached_library_assumption"))
        drain()

    def report(self) -> dict:
        self.inventory()
        self.resolve()
        targets = [
            {"path": record["path"], "architecture": item["architecture"], "version": item["minimumMacOS"]}
            for record in self.catalog.values() for item in record["slices"]
            if item["minimumMacOS"] and re.fullmatch(r"\d+(?:\.\d+)*", item["minimumMacOS"])
        ]
        highest = max((target["version"] for target in targets), key=version_key, default=None)
        ceiling_passed = None
        if self.max_macos is not None:
            ceiling_passed = True
            # Inspect every slice, including unloaded/unattached libraries. A
            # successful dependency closure alone says nothing about the OS floor.
            for path, record in self.catalog.items():
                for item in record["slices"]:
                    minimum = item["minimumMacOS"]
                    if not minimum or not re.fullmatch(r"\d+(?:\.\d+)*", minimum):
                        ceiling_passed = False
                        self.issue("deployment_target_unknown", path, architecture=item["architecture"], maximumAllowedMacOS=self.max_macos)
                    elif version_key(minimum) > version_key(self.max_macos):
                        ceiling_passed = False
                        self.issue("deployment_target_exceeds_limit", path, architecture=item["architecture"], minimumMacOS=minimum, maximumAllowedMacOS=self.max_macos)
        if not self.catalog:
            self.issue("no_macho_files", self.root)
            if self.max_macos is not None:
                ceiling_passed = False
        return {
            "format": "cliptext-engine-portability-audit", "version": 1,
            "bundle": str(self.root), "passed": not self.issues,
            "machoCount": len(self.catalog), "symlinkCount": len(self.symlinks),
            "highestMinimumMacOS": highest,
            "highestMinimumMacOSFiles": [target for target in targets if highest is not None and version_key(target["version"]) == version_key(highest)],
            "maximumAllowedMacOS": self.max_macos,
            "deploymentTargetsWithinLimit": ceiling_passed,
            "issues": self.issues, "symlinks": self.symlinks,
            "machos": sorted(self.catalog.values(), key=lambda value: value["path"]),
            "limits": [
                "Static source/deployment-target audit only; no bundled executable was run.",
                "Python extension loading contexts are conservative assumptions, not observed runtime traces.",
                "System dependencies may reside in the macOS dyld shared cache and need not exist as disk files.",
                "Does not certify code signing, notarization, redistribution licenses, minimum-OS runtime compatibility, or clean-machine acceptance.",
            ],
        }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--max-macos", help="Fail if any native slice requires a newer macOS version (for example 15.6).")
    args = parser.parse_args(argv)
    if not args.bundle.is_dir():
        parser.error("--bundle must be an existing directory")
    if args.max_macos is not None and not re.fullmatch(r"\d+(?:\.\d+){0,2}", args.max_macos):
        parser.error("--max-macos must be a version such as 15.6")
    result = Auditor(args.bundle, max_macos=args.max_macos).report()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({key: result[key] for key in ("passed", "machoCount", "symlinkCount", "highestMinimumMacOS", "maximumAllowedMacOS", "deploymentTargetsWithinLimit")}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
