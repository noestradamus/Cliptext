import { execFile } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export type PhoneIdentity = { key: string; cert: string; fingerprint: string; pairingSecret: string };

function validate(value: unknown): PhoneIdentity {
  const identity = value as Partial<PhoneIdentity>;
  if (!identity || typeof identity.key !== 'string' || typeof identity.cert !== 'string') throw new Error('Invalid phone identity.');
  const certificate = new X509Certificate(identity.cert);
  const privateKey = createPrivateKey(identity.key);
  const actual = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const expected = certificate.publicKey.export({ type: 'spki', format: 'der' });
  if (!actual.equals(expected) || Date.parse(certificate.validTo) <= Date.now()) throw new Error('Invalid phone identity.');
  if (identity.pairingSecret !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(identity.pairingSecret)) throw new Error('Invalid pairing secret.');
  return { key: identity.key, cert: identity.cert, fingerprint: createHash('sha256').update(certificate.raw).digest('hex'),
    pairingSecret: identity.pairingSecret ?? randomBytes(32).toString('base64url') };
}

async function saveIdentity(directory: string, path: string, identity: PhoneIdentity) {
  const temporary = join(directory, randomUUID() + '.partial');
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify({ key: identity.key, cert: identity.cert, pairingSecret: identity.pairingSecret })); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}

/** One atomic private file keeps the TLS key and certificate consistent after a crash. */
export async function phoneIdentity(dataDir: string): Promise<PhoneIdentity> {
  const directory = join(dataDir, 'phone-sync');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid phone identity directory.');
  await chmod(directory, 0o700);
  const path = join(directory, 'identity.json');
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) throw new Error('Invalid phone identity file.');
    await chmod(path, 0o600);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    const identity = validate(saved);
    // Upgrade the identity atomically without rotating its pinned certificate.
    if (saved.pairingSecret === undefined) await saveIdentity(directory, path, identity);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const scratch = join(directory, randomUUID());
  await mkdir(scratch, { mode: 0o700 });
  try {
    const key = join(scratch, 'key.pem'), cert = join(scratch, 'cert.pem');
    // macOS supplies this executable. No Homebrew, Python, or developer tools.
    await execute('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-days', '3650', '-subj', '/CN=Cliptext Phone Sync', '-keyout', key, '-out', cert],
    { timeout: 20_000, maxBuffer: 32_768 });
    await chmod(key, 0o600); await chmod(cert, 0o600);
    const identity = validate({ key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8') });
    await saveIdentity(directory, path, identity);
    return identity;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
