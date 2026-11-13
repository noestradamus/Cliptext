"""Prepare GitHub release assets from a previously verified Cliptext disk image."""

import argparse
import hashlib
import json
import re
import tempfile
from pathlib import Path


def split_image(image, expected_hash, tag, output):
    if not re.fullmatch(r"v[0-9][A-Za-z0-9.-]*", tag):
        raise ValueError("Expected a version tag beginning with v")
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.dmg", image.name):
        raise ValueError("Expected a release disk image filename")
    if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
        raise ValueError("Expected the verified disk image SHA-256")
    if output.exists():
        raise FileExistsError(output)
    total_hash = hashlib.sha256()
    total_size = 0
    part_size = 512 * 1024 * 1024
    base_url = f"https://github.com/noestradamus/Cliptext/releases/download/{tag}"
    parts = []
    with tempfile.TemporaryDirectory(dir=output.parent) as temp, image.open("rb") as source:
        assets = Path(temp) / "assets"
        assets.mkdir()
        while chunk := source.read(1024 * 1024):
            filename = f"{image.name}.part{len(parts) + 1:02d}"
            part_hash = hashlib.sha256()
            size = 0
            with (assets / filename).open("xb") as part:
                while chunk:
                    part.write(chunk)
                    total_hash.update(chunk)
                    part_hash.update(chunk)
                    size += len(chunk)
                    if size == part_size:
                        break
                    chunk = source.read(min(part_size - size, 1024 * 1024))
            parts.append({"url": f"{base_url}/{filename}", "size": size, "sha256": part_hash.hexdigest()})
            total_size += size
        if total_hash.hexdigest() != expected_hash or not parts:
            raise ValueError("Disk image does not match the verified SHA-256 or is empty")
        manifest = {"filename": image.name, "sha256": expected_hash, "size": total_size, "parts": parts}
        (assets / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        assets.rename(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("expected_sha256")
    parser.add_argument("tag")
    parser.add_argument("output", type=Path, help="New asset directory in an existing parent directory")
    args = parser.parse_args()
    split_image(args.image, args.expected_sha256, args.tag, args.output)
