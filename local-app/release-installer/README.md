# Mac release installer

The release ZIP contains a native Mac app. It reads a manifest embedded in its signed bundle, downloads each part from the tagged GitHub release, and checks the byte count and SHA-256 of each part and the complete disk image. It saves the verified image in Downloads and opens it through macOS. A failed or cancelled attempt discards the incomplete image. Transient connection errors retry the current part.

## Build a release

On an Apple Silicon Mac with the Xcode command-line tools, start from a verified disk image and its independently recorded SHA-256. From the repository root, run the following with a new output directory.

```sh
tag=v0.4.1-beta.1
release_dir="$(mktemp -d)"
python3 local-app/release-installer/split-image.py "$disk_image" "$verified_sha256" "$tag" "$release_dir/assets"
cmp "$release_dir/assets/manifest.json" "local-app/release-installer/manifests/$tag.json"
bash local-app/release-installer/build.sh "$release_dir/assets/manifest.json" "$release_dir/package"
local-app/release-installer/tests/run.sh
```

For a new release, review and record the new manifest before building. Attach the ZIP and every generated `.dmg.part*` file to the same tag using the exact filenames in the manifest. Verify the server's asset sizes and SHA-256 digests, and include the source materials and notices matching that build.
