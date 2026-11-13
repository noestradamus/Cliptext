#!/bin/bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo 'Usage: bash build.sh MANIFEST.json OUTPUT_DIRECTORY' >&2
    exit 2
fi

source_dir=$(cd "$(dirname "$0")" && pwd -P)
manifest=$1
output=$2
mkdir -p "$output"
output=$(cd "$output" && pwd -P)
scratch=$(mktemp -d "$output/.cliptext-installer.XXXXXXXX")
trap 'rm -rf "$scratch"' EXIT

app="$scratch/Cliptext Installer.app"
contents="$app/Contents"
resources="$contents/Resources"
archive='Cliptext-Installer-Mac.zip'
mkdir -p "$resources" "$contents/MacOS"
/bin/cp "$manifest" "$resources/manifest.json"
/bin/cp "$source_dir/Info.plist" "$contents/Info.plist"
/usr/bin/plutil -lint "$contents/Info.plist"
/usr/bin/sips -s format icns "$source_dir/../../public/icon-512.png" --out "$resources/AppIcon.icns" >/dev/null
/usr/bin/xcrun swiftc -O -parse-as-library -swift-version 5 -target arm64-apple-macos15.6 \
    -file-prefix-map "$source_dir=CliptextInstaller" -module-cache-path "$scratch/module-cache" \
    "$source_dir/Download.swift" "$source_dir/Main.swift" -o "$contents/MacOS/CliptextInstaller"
/usr/bin/strip -x "$contents/MacOS/CliptextInstaller"
/usr/bin/codesign --force --sign - --timestamp=none "$app"
/usr/bin/codesign --verify --deep --strict "$app"
/usr/bin/ditto -c -k --keepParent --norsrc --noextattr "$app" "$scratch/$archive"
# Publish atomically and leave any existing package untouched.
/bin/ln "$scratch/$archive" "$output/$archive"
echo "$output/$archive"
