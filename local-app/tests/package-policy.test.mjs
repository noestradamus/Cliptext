import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertCleanPayload, auditNativeCompatibility, macOSMinimumFromOtool, makeRecipientReadable } from '../package-policy.mjs';
import { assertOwnedOutput, assertStaticExtra, parseArguments, sha256, validateSourceMaterials } from '../build-dmg.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cliptext-package-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('native deployment parsing distinguishes minimum OS from newer SDK and non-Mac platforms', () => {
  assert.equal(macOSMinimumFromOtool('Load command 8\n cmd LC_BUILD_VERSION\n platform 1\n minos 15.6\n sdk 27.0\nLoad command 9\n cmd LC_UUID'), '15.6');
  assert.equal(macOSMinimumFromOtool('Load command 1\n cmd LC_VERSION_MIN_MACOSX\n version 11.0\n sdk 15.0'), '11.0');
  assert.throws(() => macOSMinimumFromOtool('Load command 1\n cmd LC_BUILD_VERSION\n platform 7\n minos 15.0'), /non-macOS/);
  assert.throws(() => macOSMinimumFromOtool('Load command 1\n cmd LC_BUILD_VERSION\n platform 1\n sdk 27.0'), /no readable minimum/);
  assert.throws(() => macOSMinimumFromOtool('Load command 1\n cmd LC_UUID'), /no declared/);
});

test('native gate rejects a single too-new transitive binary or missing arm64 slice', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'lib'));
  await writeFile(join(root, 'node'), Buffer.from('cffaedfe00000000', 'hex'));
  await writeFile(join(root, 'lib', 'dependency.dylib'), Buffer.from('cffaedfe00000000', 'hex'));
  const report = await auditNativeCompatibility(root, { inspect: () => ({ architectures: ['arm64'], minimumMacOS: '15.6' }) });
  assert.equal(report.binariesExamined, 2);
  assert.equal(report.highestDeclaredMinimumMacOS, '15.6');
  await assert.rejects(auditNativeCompatibility(root, { inspect: path => ({ architectures: ['arm64'], minimumMacOS: path.endsWith('.dylib') ? '26.0' : '11.0' }) }), /dependency\.dylib requires macOS 26\.0/);
  await assert.rejects(auditNativeCompatibility(root, { inspect: () => ({ architectures: ['x86_64'], minimumMacOS: '11.0' }) }), /no arm64 slice/);
});

test('payload policy permits public certificates but refuses keys, runtime data, and escaping links', async t => {
  const root = await fixture(t), bundle = join(root, 'payload');
  await mkdir(bundle);
  await writeFile(join(bundle, 'cacert.pem'), '-----BEGIN CERTIFICATE-----\npublic\n-----END CERTIFICATE-----\n');
  await assertCleanPayload(bundle);
  await writeFile(join(bundle, 'certificate.pem'), '-----BEGIN EC PRIVATE KEY-----\nfixture\n-----END EC PRIVATE KEY-----\n');
  await assert.rejects(assertCleanPayload(bundle), /Private key/);
  await rm(join(bundle, 'certificate.pem'));
  await writeFile(join(bundle, 'library.sqlite3'), 'fixture');
  await assert.rejects(assertCleanPayload(bundle), /Private\/state/);
  await rm(join(bundle, 'library.sqlite3'));
  await writeFile(join(root, 'outside.txt'), 'fixture');
  await symlink('../outside.txt', join(bundle, 'outside.txt'));
  await assert.rejects(assertCleanPayload(bundle), /symlink escapes/);
});

test('payload policy rejects SQLite sidecars and readiness state even without their main database', async t => {
  const root = await fixture(t);
  for (const name of ['library.sqlite-wal', 'library.sqlite-shm', 'library.sqlite-journal', 'library.sqlite3-wal', 'library.sqlite3-shm', 'library.sqlite3-journal', 'library.db-journal', 'ready.json', 'ready-47321.json']) {
    await writeFile(join(root, name), 'private state fixture');
    await assert.rejects(assertCleanPayload(root), /Private\/state\/development payload entry/, name);
    await rm(join(root, name));
  }
  await writeFile(join(root, 'readiness-guide.json'), '{}');
  await assertCleanPayload(root);
});

test('staged payload becomes readable to the recipient without following internal links', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'private'), { mode: 0o700 });
  await writeFile(join(root, 'private', 'data.txt'), 'fixture', { mode: 0o600 });
  await writeFile(join(root, 'launcher'), 'fixture', { mode: 0o700 });
  await symlink('private/data.txt', join(root, 'alias.txt'));
  await chmod(root, 0o700);
  await makeRecipientReadable(root);
  assert.equal((await lstat(root)).mode & 0o777, 0o755);
  assert.equal((await lstat(join(root, 'private'))).mode & 0o777, 0o755);
  assert.equal((await lstat(join(root, 'private', 'data.txt'))).mode & 0o777, 0o644);
  assert.equal((await lstat(join(root, 'launcher'))).mode & 0o777, 0o755);
  assert.ok((await lstat(join(root, 'alias.txt'))).isSymbolicLink());
});

test('DMG replacement requires an unchanged owned image and matching receipt', async t => {
  const root = await fixture(t), output = join(root, 'Cliptext.dmg');
  await assertOwnedOutput(output, false);
  await writeFile(output, 'fixture image');
  await assert.rejects(assertOwnedOutput(output, false), /Output or ownership/);
  await assert.rejects(assertOwnedOutput(output, true), /unmanaged/);
  await writeFile(`${output}.cliptext.json`, JSON.stringify({ format: 'cliptext-clean-dmg', file: 'Cliptext.dmg', sha256: await sha256(output) }));
  await assertOwnedOutput(output, true);
  await writeFile(output, 'changed image');
  await assert.rejects(assertOwnedOutput(output, true), /ownership\/hash/);
});

test('only explicitly supplied static extras enter the image', async t => {
  const root = await fixture(t);
  const doc = join(root, 'QuickStart.md');
  await writeFile(doc, 'Fixture instructions.');
  await assertStaticExtra(doc);
  const shortcut = join(root, 'Save.shortcut');
  await writeFile(shortcut, 'signed fixture placeholder');
  await assertStaticExtra(shortcut);
  assert.equal(await readFile(shortcut, 'utf8'), 'signed fixture placeholder');
  const script = join(root, 'install.md');
  await writeFile(script, '#!/bin/sh\necho fixture\n');
  await assert.rejects(assertStaticExtra(script), /Executable content/);
  await assert.rejects(assertStaticExtra(join(root, 'not-present')), /ENOENT/);
  assert.throws(() => parseArguments(['--app', 'Cliptext.app']), /Explicit/);
  assert.throws(() => parseArguments(['--app', 'Cliptext.app', '--output']), /incomplete/);
  const options = parseArguments(['--app', 'Cliptext.app', '--output', 'Cliptext.dmg', '--quick-start', 'QuickStart.md', '--notices', 'Notices.txt', '--extra', 'Save.shortcut']);
  assert.equal(options.extras.length, 1);
});

test('static extras reject all thin/fat Mach-O headers even with a document extension', async t => {
  const root = await fixture(t);
  for (const magic of ['cffaedfe', 'feedfacf', 'cefaedfe', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']) {
    const file = join(root, `disguised-${magic}.txt`);
    await writeFile(file, Buffer.from(magic + '00000000', 'hex'));
    await assert.rejects(assertStaticExtra(file), /Executable content/, magic);
  }
});

test('source materials require exact inventory and pinned archive hashes, including staged metadata', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'sources'));
  await mkdir(join(root, 'recipes'));
  const includeFiles = [], sourceArchives = [];
  for (let index = 0; index < 11; index++) {
    const path = `sources/fixture-${index}.tar.gz`, contents = `source fixture ${index}`;
    await writeFile(join(root, path), contents);
    const item = { path, sha256: await sha256(join(root, path)), bytes: Buffer.byteLength(contents) };
    includeFiles.push(item);
    sourceArchives.push({ name: `fixture-${index}`, archive: path, available: true, sha256: item.sha256, bytes: item.bytes });
  }
  const recipe = 'recipes/fixture.rb';
  await writeFile(join(root, recipe), '# Inert build recipe fixture\n');
  includeFiles.push({ path: recipe, sha256: await sha256(join(root, recipe)), bytes: (await lstat(join(root, recipe))).size });
  const manifest = { format: 'cliptext-tester-materials', version: 1, allRequestedSourcesAvailable: true, issues: [], sourceArchives, includeFiles };
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  assert.equal((await validateSourceMaterials(root)).archives, 11);
  await writeFile(join(root, 'unexpected.txt'), 'unlisted');
  await assert.rejects(validateSourceMaterials(root), /does not match its inventory/);
  await rm(join(root, 'unexpected.txt'));
  await writeFile(join(root, recipe), '# Changed recipe fixture\n');
  await assert.rejects(validateSourceMaterials(root), /does not match its inventory/);
  await rm(join(root, recipe));
  await assert.rejects(validateSourceMaterials(root), /missing files/);
  manifest.includeFiles[0].path = '../escape.tar.gz';
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(validateSourceMaterials(root), /unsafe relative path/);
});
