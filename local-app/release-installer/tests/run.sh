#!/bin/sh
set -eu

cd "$(dirname "$0")"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
xcrun swiftc -O -target arm64-apple-macos15.6 ../Download.swift DownloadTests.swift \
  -module-cache-path "$scratch/modules" -o "$scratch/test"
"$scratch/test"
