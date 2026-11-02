import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, cp, link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCleanPayload, auditNativeCompatibility, command, isMachOMagic, makeRecipientReadable, release, walkPayload } from './package-policy.mjs';

const ownershipFormat = 'cliptext-clean-dmg';
const staticExtensions = new Set(['.md', '.txt', '.pdf', '.html', '.css', '.png', '.jpg', '.jpeg', '.svg', '.json', '.shortcut']);

export function parseArguments(args) {
  const options = { extras: [], replace: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--replace') { options.replace = true; continue; }
    if (flag === '--help') { options.help = true; continue; }
    if (!['--app', '--output', '--quick-start', '--notices', '--extra', '--source-materials'].includes(flag) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete argument: ${flag}`);
    const value = resolve(args[++i]);
    if (flag === '--extra') options.extras.push(value);
    else {
      const key = { '--app': 'app', '--output': 'output', '--quick-start': 'quickStart', '--notices': 'notices', '--source-materials': 'sourceMaterials' }[flag];
      if (options[key]) throw new Error(`Duplicate argument: ${flag}`);
      options[key] = value;
    }
  }
  if (!options.help && (!options.app || !options.output || !options.quickStart || !options.notices)) throw new Error('Explicit --app, --output, --quick-start and --notices inputs are required.');
  return options;
}

export async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exists(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

export async function assertOwnedOutput(output, replace) {
  const current = await exists(output), marker = await exists(`${output}.cliptext.json`);
  if (!current && !marker) return;
  if (!replace) throw new Error('Output or ownership receipt exists. Choose a new path, or use --replace for an unchanged managed image.');
  if (!current?.isFile() || !marker?.isFile() || current.isSymbolicLink() || marker.isSymbolicLink()) throw new Error('Refusing to replace an unmanaged image or receipt.');
  let receipt;
  try { receipt = JSON.parse(await readFile(`${output}.cliptext.json`, 'utf8')); }
  catch { throw new Error('Refusing to replace an image without a valid ownership receipt.'); }
  if (receipt.format !== ownershipFormat || receipt.file !== basename(output) || receipt.sha256 !== await sha256(output)) throw new Error('Refusing to replace an image whose ownership/hash does not match.');
}

function safeName(path) {
  const name = basename(path);
  if (name.startsWith('.') || ['Applications', 'Cliptext.app', 'Extras', 'Source Materials'].includes(name)) throw new Error(`Reserved payload name: ${name}`);
  return name;
}

export async function assertStaticExtra(path) {
  const top = await lstat(path);
  if (top.isSymbolicLink()) throw new Error(`Extras must not be symlinks: ${basename(path)}`);
  if (top.isDirectory() && /\.(?:app|bundle|framework|pkg)$/i.test(path)) throw new Error(`Application/installer extras are not allowed: ${basename(path)}`);
  async function check(file, name, kind) {
    if (kind === 'symlink') throw new Error(`Extras must not contain symlinks: ${name}`);
    if (kind === 'directory' && /\.(?:app|bundle|framework|pkg)$/i.test(name)) throw new Error(`Application/installer extras are not allowed: ${name}`);
    if (kind !== 'file') return;
    if (!(staticExtensions.has(extname(file).toLowerCase()) || /^(?:LICEN[CS]E|NOTICE|COPYING)(?:\.[\w.-]+)?$/i.test(basename(file)))) throw new Error(`Only explicit static documentation and signed Shortcuts may be extras: ${name}`);
    const handle = await open(file, 'r');
    const first = Buffer.alloc(4);
    try { await handle.read(first, 0, 4, 0); } finally { await handle.close(); }
    if (isMachOMagic(first) || first.toString('hex') === '7f454c46' || first.subarray(0, 2).toString() === '#!' || first.subarray(0, 2).toString() === 'MZ') throw new Error(`Executable content is not allowed in extras: ${name}`);
  }
  if (top.isDirectory()) await walkPayload(path, check);
  else if (top.isFile()) await check(path, basename(path), 'file');
  else throw new Error('Unsupported extra input.');
}

function materialPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..') || value.startsWith('/')) throw new Error('Source-material inventory contains an unsafe relative path.');
  return value;
}

// Source archives and build recipes are inert documentation, with a separate
// exact-file inventory. They are never installed, unpacked, or executed here.
export async function validateSourceMaterials(root) {
  const top = await lstat(root);
  if (!top.isDirectory() || top.isSymbolicLink()) throw new Error('--source-materials must be a regular directory.');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'cliptext-tester-materials' || manifest.version !== 1 || manifest.allRequestedSourcesAvailable !== true || !Array.isArray(manifest.issues) || manifest.issues.length || !Array.isArray(manifest.sourceArchives) || manifest.sourceArchives.length !== 11 || !Array.isArray(manifest.includeFiles) || !manifest.includeFiles.length || manifest.includeFiles.length > 10000) throw new Error('Source-material manifest is incomplete or is not an inventoried collector output.');
  const expected = new Map();
  for (const item of manifest.includeFiles) {
    const name = materialPath(item.path);
    if (name === 'manifest.json' || expected.has(name) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 256 * 1024 * 1024) throw new Error('Source-material file inventory is invalid or exceeds its size bound.');
    expected.set(name, { path: name, sha256: item.sha256, bytes: item.bytes });
  }
  const archivePaths = new Set(), components = new Set();
  for (const record of manifest.sourceArchives) {
    const name = materialPath(record.archive);
    const item = expected.get(name);
    if (record.available !== true || !item || item.sha256 !== record.sha256 || item.bytes !== record.bytes || !name.startsWith('sources/') || !/\.(?:tar\.(?:gz|bz2|xz)|zip)$/.test(name) || archivePaths.has(name) || components.has(record.name)) throw new Error('A pinned source archive is missing, duplicated, or differs from the exact file inventory.');
    archivePaths.add(name); components.add(record.name);
  }
  const found = new Set();
  let totalBytes = 0;
  await walkPayload(root, async (path, name, kind) => {
    const portableName = name.split(sep).join('/');
    if (kind === 'symlink') throw new Error(`Source materials must not contain symlinks: ${portableName}`);
    if (kind === 'directory') {
      if (/\.(?:app|bundle|framework|pkg)$/i.test(name)) throw new Error(`Source materials must not include applications/installers: ${portableName}`);
      return;
    }
    const size = (await lstat(path)).size;
    totalBytes += size;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('Source-material payload exceeds 512 MiB.');
    if (portableName === 'manifest.json') return;
    const item = expected.get(portableName);
    if (!item || item.bytes !== size || item.sha256 !== await sha256(path)) throw new Error(`Source-material file does not match its inventory: ${portableName}`);
    if (!archivePaths.has(portableName)) {
      if (/\.(?:gz|bz2|xz|zip|7z|dmg|pkg|app|exe|dll|dylib|so|node|a|o)$/i.test(name)) throw new Error(`Unpinned archive or compiled file in source materials: ${portableName}`);
      const handle = await open(path, 'r'), first = Buffer.alloc(4);
      try { await handle.read(first, 0, 4, 0); } finally { await handle.close(); }
      if (isMachOMagic(first) || first.toString('hex') === '7f454c46' || first.subarray(0, 2).toString() === 'MZ') throw new Error(`Compiled executable in source materials: ${portableName}`);
    }
    found.add(portableName);
  });
  if (found.size !== expected.size) throw new Error('Source-material inventory includes missing files.');
  await assertCleanPayload(root);
  return { manifestSha256: await sha256(join(root, 'manifest.json')), files: found.size + 1, bytes: totalBytes,
    archives: archivePaths.size, includeFiles: [...expected.values()].sort((a, b) => a.path.localeCompare(b.path, 'en')) };
}

function plistValue(path, key) { return command('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path]).trim(); }

export async function buildDiskImage(options) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build the Apple Silicon disk image on an Apple Silicon Mac.');
  if (!options.output.endsWith('.dmg')) throw new Error('Output must end in .dmg.');
  const app = await realpath(options.app);
  if (!(await lstat(app)).isDirectory() || !app.endsWith('.app')) throw new Error('--app must be a Cliptext.app bundle.');
  await mkdir(dirname(options.output), { recursive: true });
  const outputParent = await realpath(dirname(options.output));
  const output = join(outputParent, basename(options.output));
  const inputs = [app, options.quickStart, options.notices, ...options.extras, ...(options.sourceMaterials ? [options.sourceMaterials] : [])];
  const usedNames = new Set();
  for (const input of inputs) {
    const actual = await realpath(input);
    if (output === actual || output.startsWith(actual + sep)) throw new Error('Output must be outside every input payload.');
    if (input !== app) {
      const name = safeName(input).toLocaleLowerCase('en-US');
      if (usedNames.has(name)) throw new Error(`Duplicate payload basename: ${basename(input)}`);
      usedNames.add(name);
      if (input !== options.sourceMaterials) await assertStaticExtra(input);
    }
  }
  for (const document of [options.quickStart, options.notices]) if (!(await lstat(document)).isFile()) throw new Error('QuickStart and notices must be explicit regular document files.');
  await assertOwnedOutput(output, options.replace);
  const sourceMaterials = options.sourceMaterials ? await validateSourceMaterials(options.sourceMaterials) : undefined;
  const info = join(app, 'Contents', 'Info.plist');
  for (const [key, expected] of Object.entries({ CFBundleIdentifier: 'life.cliptext.local', CFBundleExecutable: 'Cliptext', CFBundleShortVersionString: release.version, CFBundleVersion: release.build, LSMinimumSystemVersion: release.minimumMacOS })) {
    if (plistValue(info, key) !== expected) throw new Error(`App metadata ${key} must be ${expected}.`);
  }
  const appReceipt = JSON.parse(await readFile(join(app, 'Contents', 'Resources', 'mac-prototype.json'), 'utf8'));
  if (appReceipt.format !== 'cliptext-mac-prototype' || appReceipt.version !== release.version || appReceipt.minimumMacOS !== release.minimumMacOS) throw new Error('App is not the managed, compatible tester build.');
  await assertCleanPayload(app);
  const compatibility = await auditNativeCompatibility(app);
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const scratch = await mkdtemp(join(outputParent, '.cliptext-dmg-'));
  try {
    const payload = join(scratch, 'payload');
    await mkdir(payload, { mode: 0o755 });
    const stagedApp = join(payload, 'Cliptext.app');
    command('/bin/cp', ['-cR', app, stagedApp]);
    for (const document of [options.quickStart, options.notices]) await cp(document, join(payload, safeName(document)));
    if (options.extras.length) {
      await mkdir(join(payload, 'Extras'));
      for (const input of options.extras) await cp(input, join(payload, 'Extras', safeName(input)), { recursive: true, verbatimSymlinks: true });
    }
    if (sourceMaterials) {
      const destination = join(payload, 'Source Materials');
      await cp(options.sourceMaterials, destination, { recursive: true, verbatimSymlinks: true });
      const copied = await validateSourceMaterials(destination);
      if (copied.manifestSha256 !== sourceMaterials.manifestSha256) throw new Error('Source-material manifest changed during staging.');
      await walkPayload(destination, async (path, name, kind) => { if (kind === 'file') await chmod(path, 0o644); });
    }
    await assertCleanPayload(payload);
    await makeRecipientReadable(payload);
    // Only these disposable copies are stripped of inherited ACLs/xattrs.
    command('/bin/chmod', ['-R', '-P', '-N', payload]);
    command('/usr/bin/xattr', ['-cr', payload]);
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', stagedApp]);
    await symlink('/Applications', join(payload, 'Applications'));
    const temporaryImage = join(scratch, 'Cliptext.dmg');
    command('/usr/bin/hdiutil', ['create', '-srcfolder', payload, '-format', 'UDZO', '-imagekey', 'zlib-level=9', '-fs', 'HFS+', '-volname', `Cliptext ${release.version}`, '-nospotlight', '-noanyowners', temporaryImage]);
    command('/usr/bin/hdiutil', ['verify', temporaryImage]);
    await chmod(temporaryImage, 0o644);
    const receipt = { format: ownershipFormat, file: basename(output), version: release.version, build: release.build,
      architecture: release.architecture, minimumMacOS: release.minimumMacOS, nativeCompatibility: compatibility,
      sha256: await sha256(temporaryImage), bytes: (await lstat(temporaryImage)).size,
      filesystem: 'HFS+', signature: 'ad-hoc app; unsigned disk image', notarized: false, publicReleaseReady: false,
      ...(sourceMaterials ? { sourceMaterials } : {}),
      contents: ['Cliptext.app', 'Applications', safeName(options.quickStart), safeName(options.notices), ...(options.extras.length ? ['Extras'] : []), ...(sourceMaterials ? ['Source Materials'] : [])] };
    const temporaryReceipt = join(scratch, 'receipt.json');
    await writeFile(temporaryReceipt, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
    // Recheck immediately before replacement. Never overwrite an unrelated file.
    await assertOwnedOutput(output, options.replace);
    if (options.replace && await exists(output)) {
      await rename(temporaryImage, output);
      await rename(temporaryReceipt, `${output}.cliptext.json`);
    } else {
      // Same-filesystem links publish without clobbering a path that appeared
      // after the ownership check. Scratch cleanup removes the temporary names.
      await link(temporaryReceipt, `${output}.cliptext.json`);
      try { await link(temporaryImage, output); }
      catch (error) { await rm(`${output}.cliptext.json`); throw error; }
    }
    return { image: output, ...receipt };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) console.log('Usage: node local-app/build-dmg.mjs --app Cliptext.app --output NEW.dmg --quick-start QuickStart.md --notices ThirdPartyNotices.txt [--extra PATH ...] [--source-materials DIR] [--replace]\nCreates a drag-to-Applications tester image. No installer scripts, privileges or notarization.');
  else console.log(JSON.stringify(await buildDiskImage(options)));
}
