import { spawnSync } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
function argument(name) { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}).`);
}
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function checkSymlinks(root) {
  const allowedRoot = await realpath(root);
  const links = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (target !== allowedRoot && !target.startsWith(allowedRoot + sep)) throw new Error(`App symlink escapes its resources: ${relative(root, path)}`);
        links.push(relative(root, path));
      } else if (entry.isDirectory()) await visit(path);
    }
  }
  await visit(root);
  return links;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this prototype on an Apple Silicon Mac.');
if (!argument('--package') || !argument('--output')) throw new Error('Usage: node local-app/build-mac.mjs --package PACKAGE_ROOT --output Cliptext.app [--replace]');
const source = await realpath(resolve(argument('--package')));
const output = resolve(argument('--output'));
if (!output.endsWith('.app')) throw new Error('The output must end in .app.');
if (await exists(output)) {
  if (!process.argv.includes('--replace')) throw new Error('Output exists. Use a new output or --replace for a previous managed prototype.');
  const old = JSON.parse(await readFile(join(output, 'Contents', 'Resources', 'mac-prototype.json'), 'utf8'));
  if (old.format !== 'cliptext-mac-prototype') throw new Error('Refusing to replace an unmanaged app.');
  const active = spawnSync('/usr/bin/pgrep', ['-x', 'Cliptext'], { encoding: 'utf8' });
  if (active.status !== 1) throw new Error('Quit running Cliptext processes before replacing the app.');
}
for (const directory of ['engine', 'models', 'server', 'client', 'migrations']) {
  if (!(await stat(join(source, directory))).isDirectory()) throw new Error(`Package is missing ${directory}.`);
}
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'cliptext-mac-build-'));
const stagingParent = await mkdtemp(join(dirname(output), '.cliptext-app-build-'));
const staging = join(stagingParent, basename(output));
try {
  const executable = join(scratch, 'Cliptext');
  run('/usr/bin/xcrun', ['swiftc', '-O', '-parse-as-library', '-swift-version', '5', '-target', 'arm64-apple-macos14.0',
    '-module-cache-path', join(scratch, 'module-cache'), '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'UniformTypeIdentifiers',
    join(here, 'mac', 'CliptextApp.swift'), '-o', executable]);
  const contents = join(staging, 'Contents');
  const resources = join(contents, 'Resources');
  await mkdir(join(contents, 'MacOS'), { recursive: true });
  await mkdir(resources);
  await cp(executable, join(contents, 'MacOS', 'Cliptext'));
  await cp(join(here, 'mac', 'Info.plist'), join(contents, 'Info.plist'));
  await writeFile(join(contents, 'PkgInfo'), 'APPL????');
  for (const directory of ['engine', 'models', 'server', 'client', 'migrations']) {
    run('/bin/cp', ['-cR', join(source, directory), join(resources, directory)]);
  }
  // Hosted companion installers are unrelated to the local sync milestone.
  await rm(join(resources, 'client', 'downloads'), { recursive: true, force: true });
  await rm(join(resources, 'client', 'manifest.webmanifest'), { force: true });
  const iconSource = join(source, 'client', 'icon-512.png');
  run('/usr/bin/sips', ['-s', 'format', 'icns', iconSource, '--out', join(resources, 'AppIcon.icns')]);
  const symlinks = await checkSymlinks(resources);
  await writeFile(join(resources, 'mac-prototype.json'), JSON.stringify({ format: 'cliptext-mac-prototype', version: '0.2.1',
    framework: 'AppKit + WKWebView', architecture: 'arm64', minimumMacOS: '26.2', signature: 'ad-hoc', notarized: false,
    publicReleaseReady: false, modelsIncluded: true, resourceSymlinks: symlinks,
    config: { dataDirectoryArgument: '--data-dir', dataDirectoryEnvironment: 'CLIPTEXT_DATA_DIR', portArgument: '--port', portEnvironment: 'CLIPTEXT_PORT' },
  }, null, 2) + '\n');
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', join(contents, 'MacOS', 'Cliptext')]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', staging]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staging]);
  if (await exists(output)) await rm(output, { recursive: true });
  await rename(staging, output);
  console.log(JSON.stringify({ app: output, framework: 'WKWebView', modelsIncluded: true, notarized: false, publicReleaseReady: false }));
} finally {
  await rm(scratch, { recursive: true, force: true });
  await rm(stagingParent, { recursive: true, force: true });
}
