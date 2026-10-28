# Portable APK build

The receiver is plain Java and Android platform code. A portable build uses a JDK and separately published open-source resource, DEX, and APK-signing tools. It does not install an Android SDK, accept SDK license terms, or package framework classes into the app.

The normal Gradle project remains available for developers who already have a licensed Android SDK. The portable route uses the same `app/src/main` application sources and resources.

## Verified tool inputs

- Eclipse Temurin JDK 17 for macOS/aarch64, obtained through the [official Adoptium API](https://adoptium.net/installation/ci-scripts). Keep its bundled legal notices with the local toolchain.
- [AAPT2 9.4.1-15978811, macOS universal binary](https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/9.4.1-15978811/aapt2-9.4.1-15978811-osx.jar). Its Google Maven POM declares Apache 2.0. Android documents this [standalone Maven distribution](https://developer.android.com/tools/aapt2).
- [D8/R8 8.13.17](https://dl.google.com/dl/android/maven2/com/android/tools/r8/8.13.17/r8-8.13.17.jar). Its POM records BSD and included dependency licenses. The [official project](https://r8.googlesource.com/r8/+/refs/heads/main/README.md) documents this Maven artifact and D8's CLI.
- [apksig 8.13.2](https://dl.google.com/dl/android/maven2/com/android/tools/build/apksig/8.13.2/apksig-8.13.2.jar). Its Google Maven POM declares Apache 2.0. `PortableApkSigner.java` uses the library's [documented public API](https://android.googlesource.com/platform/tools/apksig/).
- [Robolectric android-all 15-robolectric-12650502](https://repo.maven.apache.org/maven2/org/robolectric/android-all/15-robolectric-12650502/android-all-15-robolectric-12650502.jar). Its Maven Central POM declares Apache 2.0 for the AOSP-built framework. It supplies compile-time APIs and the framework resource table to AAPT2; it is not copied into the APK.

Tool downloads are checked against the official repository `.sha1` files, with local SHA-256 values recorded in `artifact-provenance.json`. The builder rechecks those SHA-256 values before every build.

## Local invocation

Provision an external toolchain directory; do not place downloaded tools in this repository. It contains `tools/aapt2.jar`, `tools/r8.jar`, `tools/apksig.jar`, `tools/android-all.jar`, `tools/artifact-provenance.json`, and the portable JDK.

```sh
python3 tools/build-portable.py --toolchain /absolute/path/to/android-build --output /absolute/path/to/apk-output
python3 tools/test-portable.py --toolchain /absolute/path/to/android-build --output /absolute/path/to/test-classes
```

An optional `--java-home` points to the JDK's `Contents/Home` directory. The builder compiles resources and the binary manifest with AAPT2, compiles application Java, converts only application classes to DEX, aligns the APK, signs it, and verifies its signatures and manifest metadata.

The selected output directory contains `cliptext-share.apk` and `build-verification.json`, which records its hash, certificate fingerprint, signature checks, and build inputs. Structural and signature checks do not replace installation and share-sheet testing on an Android device.

## Preserve the private signing material

The persistent signing key and its password are created with restricted permissions under the supplied toolchain’s `private/` directory, outside this distributable project. Do not include that directory in source archives, APK downloads, or Site assets. Retain it privately to sign compatible future updates; deleting it would require uninstalling the old app before installing a build signed with a different key.
