#!/usr/bin/env python3
"""Build the plain-Java receiver using published open-source Maven tools.

No Android SDK packages or SDK license acceptance are involved. Tool artifacts
and a portable JDK must first be obtained from their official repositories. The
framework JAR is compile/link input only and is never packaged into the APK.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import struct
import subprocess
import xml.etree.ElementTree as ET
import zipfile

PROJECT = Path(__file__).resolve().parents[1]


def command(args, **kwargs):
    result = subprocess.run([str(arg) for arg in args], check=True, text=True, **kwargs)
    return result


def aligned_apk(resource_apk, dex_dir, target):
    """Align all uncompressed ZIP entries to four bytes before APK signing."""
    with zipfile.ZipFile(resource_apk) as src, zipfile.ZipFile(target, "w") as dst:
        values = [(info.filename, src.read(info), info.compress_type) for info in src.infolist()]
        values += [(p.name, p.read_bytes(), zipfile.ZIP_STORED) for p in sorted(dex_dir.glob("*.dex"))]
        for name, data, compression in values:
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_STORED if name in {"resources.arsc", "classes.dex"} else compression
            if info.compress_type == zipfile.ZIP_STORED:
                pad = (-(dst.fp.tell() + 30 + len(name.encode("utf-8")) + 4)) % 4
                info.extra = struct.pack("<HH", 0xCAFE, pad) + bytes(pad)
            dst.writestr(info, data)
    with zipfile.ZipFile(target) as apk:
        for info in apk.infolist():
            if info.compress_type == zipfile.ZIP_STORED:
                offset = info.header_offset + 30 + len(info.filename.encode("utf-8")) + len(info.extra)
                if offset % 4: raise RuntimeError("Unaligned APK entry: " + info.filename)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", type=Path, required=True)
    parser.add_argument("--java-home", type=Path)
    parser.add_argument("--output", type=Path, required=True, help="Artifact directory outside the source checkout")
    args = parser.parse_args()
    toolchain = args.toolchain.resolve()
    candidates = list(toolchain.glob("jdk-*/Contents/Home"))
    java_home = args.java_home.resolve() if args.java_home else (candidates[0] if candidates else None)
    if not java_home: raise SystemExit("Supply --java-home for a portable JDK17 or newer.")
    tools = toolchain / "tools"
    for name in ("aapt2.jar", "r8.jar", "apksig.jar", "android-all.jar", "artifact-provenance.json"):
        if not (tools / name).is_file(): raise SystemExit("Missing verified tool: " + name)
    provenance = json.loads((tools / "artifact-provenance.json").read_text())
    for item in provenance:
        if hashlib.sha256((tools / item["file"]).read_bytes()).hexdigest() != item["sha256"]:
            raise SystemExit("Tool integrity check failed: " + item["file"])
    build = toolchain / "build"
    build.mkdir(parents=True, exist_ok=True)
    private = toolchain / "private"
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(private, 0o700)
    if PROJECT == private or PROJECT in private.parents:
        raise SystemExit("Signing material must live outside the distributable project.")
    aapt2 = tools / "aapt2"
    if not aapt2.is_file():
        with zipfile.ZipFile(tools / "aapt2.jar") as archive: aapt2.write_bytes(archive.read("aapt2"))
        aapt2.chmod(0o755)
    command([java_home / "bin" / "java", "-version"])
    command([aapt2, "version"])
    manifest_path = PROJECT / "app" / "src" / "main" / "AndroidManifest.xml"
    gradle = (PROJECT / "app" / "build.gradle").read_text()
    code_match = re.search(r"^\s*versionCode\s+([0-9]+)\s*$", gradle, re.MULTILINE)
    name_match = re.search(r"^\s*versionName\s+['\"]([A-Za-z0-9_.-]{1,64})['\"]\s*$", gradle, re.MULTILINE)
    if not code_match or not name_match:
        raise SystemExit("Expected explicit versionCode and versionName in app/build.gradle.")
    version_code, version_name = code_match.group(1), name_match.group(1)
    ET.register_namespace("android", "http://schemas.android.com/apk/res/android")
    manifest = ET.parse(manifest_path)
    manifest.getroot().set("package", "life.cliptext.save")
    manifest.write(build / "AndroidManifest.xml", encoding="utf-8", xml_declaration=True)
    generated, classes, dex = (build / name for name in ("generated", "classes", "dex"))
    for directory in (generated, classes, dex):
        if directory.exists(): shutil.rmtree(directory)
        directory.mkdir()
    resources = PROJECT / "app" / "src" / "main" / "res"
    command([aapt2, "compile", "--dir", resources, "-o", build / "compiled.zip"])
    command([aapt2, "link", "-I", tools / "android-all.jar", "--manifest", build / "AndroidManifest.xml",
             "--java", generated, "--min-sdk-version", "26", "--target-sdk-version", "35",
             "--version-code", version_code, "--version-name", version_name, "-o", build / "resources.apk", build / "compiled.zip"])
    sources = sorted((PROJECT / "app" / "src" / "main" / "java").rglob("*.java")) + sorted(generated.rglob("*.java"))
    command([java_home / "bin" / "javac", "--release", "8", "-encoding", "UTF-8", "-cp", tools / "android-all.jar",
             "-d", classes, *sources])
    classes_jar = build / "app-classes.jar"
    with zipfile.ZipFile(classes_jar, "w") as jar:
        for path in sorted(classes.rglob("*.class")): jar.write(path, path.relative_to(classes).as_posix())
    command([java_home / "bin" / "java", "-cp", tools / "r8.jar", "com.android.tools.r8.D8", "--release",
             "--min-api", "26", "--lib", tools / "android-all.jar", "--lib", java_home, "--output", dex, classes_jar])
    unsigned = build / "aligned-unsigned.apk"
    aligned_apk(build / "resources.apk", dex, unsigned)
    password_file = private / "signing-password"
    keystore = private / "cliptext-signing.p12"
    if not password_file.exists():
        password_file.write_text(secrets.token_urlsafe(36) + "\n")
        os.chmod(password_file, 0o600)
    password = password_file.read_text().strip()
    if not keystore.exists():
        env = dict(os.environ, CLIPTEXT_SIGNING_STORE_PASSWORD=password)
        command([java_home / "bin" / "keytool", "-genkeypair", "-alias", "cliptext", "-keyalg", "RSA", "-keysize", "3072",
                 "-sigalg", "SHA256withRSA", "-validity", "10000", "-dname", "CN=Cliptext Personal Receiver",
                 "-storetype", "PKCS12", "-keystore", keystore, "-storepass:env", "CLIPTEXT_SIGNING_STORE_PASSWORD", "-noprompt"], env=env)
        os.chmod(keystore, 0o600)
    signer_classes = build / "signer-classes"
    signer_classes.mkdir(exist_ok=True)
    command([java_home / "bin" / "javac", "--release", "8", "-cp", tools / "apksig.jar", "-d", signer_classes,
             PROJECT / "tools" / "PortableApkSigner.java"])
    releases = args.output.resolve()
    if releases == PROJECT or PROJECT in releases.parents:
        raise SystemExit("Write APKs and build reports outside the distributable source project.")
    releases.mkdir(parents=True, exist_ok=True)
    apk = releases / "cliptext-share.apk"
    cp = os.pathsep.join([str(signer_classes), str(tools / "apksig.jar")])
    signed = command([java_home / "bin" / "java", "-cp", cp, "PortableApkSigner", unsigned, apk, keystore],
                     input=password + "\n", capture_output=True)
    verification = json.loads(signed.stdout.strip())
    with zipfile.ZipFile(apk) as archive:
        entries = archive.namelist()
        if "classes.dex" not in entries or "resources.arsc" not in entries: raise RuntimeError("Incomplete APK")
        if any(name.startswith("android/") or name.endswith(".class") for name in entries):
            raise RuntimeError("Compile-only framework classes were packaged into the APK")
        if not archive.read("AndroidManifest.xml").startswith(b"\x03\x00\x08\x00"):
            raise RuntimeError("APK manifest is not compiled Android binary XML")
        for name in ("resources.arsc", "classes.dex"):
            info = archive.getinfo(name)
            offset = info.header_offset + 30 + len(info.filename.encode("utf-8")) + len(info.extra)
            if info.compress_type != zipfile.ZIP_STORED or offset % 4:
                raise RuntimeError("APK entry must be uncompressed and aligned: " + name)
    badging = command([aapt2, "dump", "badging", apk], capture_output=True).stdout
    for expected in ("package: name='life.cliptext.save'", "versionCode='" + version_code + "'", "versionName='" + version_name + "'", "minSdkVersion:'26'", "targetSdkVersion:'35'"):
        if expected not in badging: raise RuntimeError("Unexpected APK manifest metadata: " + expected)
    report = {"apk": apk.name, "bytes": apk.stat().st_size, "sha256": hashlib.sha256(apk.read_bytes()).hexdigest(),
              "package": "life.cliptext.save", "min_sdk": 26, "target_sdk": 35, "framework_packaged": False,
              "version_code": int(version_code), "version_name": version_name,
              "binary_manifest": True, "resources_and_dex_aligned": True,
              "signatures": verification, "tool_artifacts": provenance,
              "device_test": "Not run by this build; installation and Android share-sheet behavior require a device."}
    (releases / "build-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
