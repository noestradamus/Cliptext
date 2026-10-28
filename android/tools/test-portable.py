#!/usr/bin/env python3
"""Run pure JVM policy/protocol tests with the provisioned portable toolchain.

This does not simulate Android SQLite, lifecycle, JobScheduler or AndroidKeyStore.
"""
import argparse
import os
from pathlib import Path
import subprocess

project = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--toolchain', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
toolchain = args.toolchain.resolve()
java = next(toolchain.glob('jdk-*/Contents/Home'))
tools = toolchain / 'tools'
output = args.output.resolve()
if output == project or project in output.parents:
    raise SystemExit('Test outputs must stay outside the source tree')
output.mkdir(parents=True, exist_ok=True)
names = ['VideoUrlParser', 'TikTokUrlParser', 'QueuePolicy', 'LocalConnection', 'SyncPage', 'CertificatePins', 'LocalApi', 'CacheChunks']
sources = [project / 'app/src/main/java/life/cliptext/save' / (name + '.java') for name in names]
tests = sorted((project / 'app/src/test/java').rglob('*Test.java'))
classpath = os.pathsep.join(str(tools / name) for name in ['android-all.jar', 'junit.jar', 'hamcrest.jar'])
subprocess.run([str(java / 'bin/javac'), '--release', '8', '-cp', classpath, '-d', str(output), *map(str, sources + tests + [project / 'tools/LocalProtocolProbe.java'])], check=True)
subprocess.run([str(java / 'bin/java'), '-cp', str(output) + os.pathsep + classpath, 'org.junit.runner.JUnitCore', *['life.cliptext.save.' + path.stem for path in tests]], check=True)
