import { spawnSync } from 'node:child_process';
import { chmod, lstat, open, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';

export const release = Object.freeze({ version: '0.4.1', build: '6', minimumMacOS: '15.6', architecture: 'arm64' });
const machoMagic = new Set(['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
const blockedExtensions = new Set(['.db', '.sqlite', '.sqlite3', '.log', '.key', '.p8', '.p12', '.pfx', '.der', '.keychain', '.keychain-db', '.keystore', '.jks']);
const blockedNames = /^(?:\.git|\.svn|\.hg|\.ssh|\.aws|\.gnupg|\.env(?:\..*)?|\.npmrc|\.pypirc|\.DS_Store|\.AppleDouble|\.Spotlight-V100|\.Trashes|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials|identity\.json|launch\.json|ready(?:-\d+)?\.json|cliptext-connection\.(?:json|txt)|verified-library-backup\.json)$/i;
const sqliteSidecar = /\.(?:db|sqlite3?)-(?:wal|shm|journal)$/i;
const privateKey = /(?:^|\r?\n)\s*-----BEGIN (?:[A-Z0-9 ]* )?PRIVATE KEY-----/;

export function isMachOMagic(bytes) { return machoMagic.has(bytes.subarray(0, 4).toString('hex')); }

export function command(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(program)} failed (${result.status}): ${(result.stderr || '').trim().slice(0, 1200)}`);
  return result.stdout || '';
}

function versionParts(value) {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(value)) throw new Error(`Invalid macOS version: ${value}`);
  return value.split('.').map(Number).concat([0, 0]).slice(0, 3);
}
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

// Accept only a declared macOS deployment target for the arm64 slice. The SDK
// used to build a binary can be newer; its minimum OS is the compatibility gate.
export function macOSMinimumFromOtool(output) {
  const minimums = [];
  for (const block of output.split(/(?=Load command \d+)/)) {
    if (/\bcmd LC_BUILD_VERSION\b/.test(block)) {
      const platform = block.match(/^\s*platform\s+(\S+)/m)?.[1];
      if (!platform || !['1', 'macos', 'macOS', 'MACOS'].includes(platform)) throw new Error('Mach-O declares a non-macOS platform.');
      const minimum = block.match(/^\s*minos\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1];
      if (!minimum) throw new Error('Mach-O has no readable minimum macOS version.');
      minimums.push(minimum);
    } else if (/\bcmd LC_VERSION_MIN_MACOSX\b/.test(block)) {
      const minimum = block.match(/^\s*version\s+(\d+\.\d+(?:\.\d+)?)/m)?.[1];
      if (!minimum) throw new Error('Mach-O has no readable minimum macOS version.');
      minimums.push(minimum);
    } else if (/\bcmd LC_VERSION_MIN_(?:IPHONEOS|TVOS|WATCHOS)\b/.test(block)) {
      throw new Error('Mach-O declares a non-macOS platform.');
    }
  }
  if (!minimums.length) throw new Error('Mach-O has no declared macOS deployment target.');
  return minimums.sort(compareVersions).at(-1);
}

async function prefix(path, length = 4) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally { await file.close(); }
}

export async function walkPayload(root, visit) {
  const allowedRoot = await realpath(root);
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(directory, entry.name), name = relative(allowedRoot, path);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (target !== allowedRoot && !target.startsWith(allowedRoot + sep)) throw new Error(`Payload symlink escapes its root: ${name}`);
        await visit(path, name, 'symlink');
      } else if (entry.isDirectory()) {
        await visit(path, name, 'directory');
        await walk(path);
      } else if (entry.isFile()) await visit(path, name, 'file');
      else throw new Error(`Unsupported payload entry: ${name}`);
    }
  }
  await walk(allowedRoot);
}

function nativeInspection(path) {
  const architectures = command('/usr/bin/lipo', ['-archs', path]).trim().split(/\s+/);
  if (!architectures.includes('arm64')) throw new Error('Mach-O has no arm64 slice.');
  return { architectures, minimumMacOS: macOSMinimumFromOtool(command('/usr/bin/otool', ['-arch', 'arm64', '-l', path])) };
}

export async function auditNativeCompatibility(root, { maximumMinimumMacOS = release.minimumMacOS, inspect = nativeInspection } = {}) {
  versionParts(maximumMinimumMacOS);
  const binaries = [];
  await walkPayload(root, async (path, name, kind) => {
    if (kind !== 'file') return;
    const first = await prefix(path), magic = first.toString('hex');
    if (!isMachOMagic(first)) {
      if (magic === '7f454c46' || (magic.startsWith('4d5a') && /\.(?:exe|dll|pyd)$/i.test(name))) throw new Error(`Non-macOS native binary in payload: ${name}`);
      return;
    }
    let inspected;
    try { inspected = await inspect(path); }
    catch (error) { throw new Error(`Native compatibility could not be verified for ${name}: ${error.message}`); }
    if (!inspected.architectures.includes('arm64')) throw new Error(`Mach-O has no arm64 slice: ${name}`);
    if (compareVersions(inspected.minimumMacOS, maximumMinimumMacOS) > 0) throw new Error(`${name} requires macOS ${inspected.minimumMacOS}, above the ${maximumMinimumMacOS} target.`);
    binaries.push({ path: name, minimumMacOS: inspected.minimumMacOS });
  });
  if (!binaries.length) throw new Error('No Mach-O binaries were found; native compatibility was not established.');
  return { format: 'cliptext-macos-portability', architecture: 'arm64', maximumAllowedMinimumMacOS: maximumMinimumMacOS,
    highestDeclaredMinimumMacOS: binaries.map(item => item.minimumMacOS).sort(compareVersions).at(-1), binariesExamined: binaries.length };
}

export async function assertCleanPayload(root) {
  await walkPayload(root, async (path, name, kind) => {
    const base = basename(path);
    if (blockedNames.test(base) || (kind === 'file' && (blockedExtensions.has(extname(base).toLowerCase()) || sqliteSidecar.test(base)))) throw new Error(`Private/state/development payload entry is not allowed: ${name}`);
    if (kind !== 'file') return;
    // Public CA certificates are runtime dependencies. Private key material and
    // personal connection files must never be mistaken for those certificates.
    const textCandidate = /\.(?:pem|crt|cer|txt|md|json|ya?ml|conf|ini|env)$/i.test(base) || !extname(base);
    if (textCandidate && (await lstat(path)).size <= 2 * 1024 * 1024 && privateKey.test(await readFile(path, 'utf8'))) throw new Error(`Private key material is not allowed: ${name}`);
  });
}

// Apply to a disposable staged copy only. Do not follow symlinks, especially the
// disk image's Applications alias, or change permissions on the source bundle.
export async function makeRecipientReadable(root) {
  await chmod(root, 0o755);
  await walkPayload(root, async (path, name, kind) => {
    if (kind === 'directory') await chmod(path, 0o755);
    else if (kind === 'file') await chmod(path, (await lstat(path)).mode & 0o111 ? 0o755 : 0o644);
  });
}
