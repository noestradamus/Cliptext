import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { FileBucket, LocalDatabase } from '../server/storage.ts';

const migrations = fileURLToPath(new URL('../../drizzle/', import.meta.url));

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-sqlite-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('migrates SQLite, keeps library/themes/search/images across close and reopen', async t => {
  const directory = await sandbox(t);
  let db = new LocalDatabase(directory, migrations);
  await db.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').bind('c1', 'owner', 'Ideas', '2026-10-28').run();
  await db.prepare("INSERT INTO jobs(id,owner_id,url,platform,status,transcript,notes,tags,collection_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind('j1', 'owner', 'https://youtu.be/abcdefghijk', 'youtube', 'completed', 'Pricing strategies improve customer value.', 'Keep this insight.', '["pricing"]', 'c1', '2026-10-28', '2026-10-28').run();
  await db.prepare("INSERT INTO appearance_themes(id,owner_id,name,name_key,accent,background,foreground,font,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .bind('t1', 'owner', 'Custom', 'custom', '#FF8E3C', '#FFFAEE', '#502E1A', 'dm-sans', '2026-10-28', '2026-10-28').run();
  await db.prepare('INSERT INTO appearance_settings(owner_id,active_theme_id,active_preset_id) VALUES(?,?,?)').bind('owner', 't1', 'glacial').run();
  assert.equal(await db.prepare('SELECT count(*) AS total FROM schema_migrations').first('total'), 14);
  assert.equal((await db.prepare("SELECT count(*) AS total FROM jobs_fts WHERE jobs_fts MATCH ?").bind('pricing').first()).total, 1);
  db.close();
  db = new LocalDatabase(directory, migrations);
  t.after(() => db.close());
  assert.equal((await db.prepare('SELECT * FROM jobs WHERE id=?').bind('j1').first()).notes, 'Keep this insight.');
  assert.equal((await db.prepare('SELECT * FROM appearance_settings').first()).active_theme_id, 't1');
  assert.equal((await db.prepare('SELECT * FROM appearance_themes').first()).font, 'dm-sans');
  assert.equal(db.migrationBackup, null);
  assert.equal((await stat(db.databasePath)).mode & 0o777, 0o600);
});

test('D1 batch is atomic, consumes RETURNING rows, and bindings are immutable', async t => {
  const directory = await sandbox(t);
  const db = new LocalDatabase(directory, migrations);
  t.after(() => db.close());
  const base = db.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?) RETURNING id,name');
  const a = base.bind('a', 'owner', 'Alpha', 'now');
  const b = base.bind('b', 'owner', 'Beta', 'now');
  const result = await db.batch([a, b]);
  assert.deepEqual(result.map(r => r.results[0].id), ['a', 'b']);
  await assert.rejects(db.batch([
    base.bind('c', 'owner', 'Gamma', 'now'),
    base.bind('d', 'owner', 'Alpha', 'now'),
  ]), /UNIQUE/);
  assert.equal(await db.prepare("SELECT id FROM collections WHERE id='c'").first(), null);
  assert.equal((await db.prepare('SELECT count(*) AS total FROM collections').first()).total, 2);
  assert.equal((await db.prepare('UPDATE collections SET name=? WHERE id=? RETURNING name').bind('Renamed', 'a').first()).name, 'Renamed');
  assert.deepEqual(await db.prepare('SELECT id FROM collections ORDER BY id').raw(), [['a'], ['b']]);
});

test('new schema upgrade saves a consistent pre-upgrade backup and rejects changed history', async t => {
  const directory = await sandbox(t);
  const schema = join(directory, 'migrations');
  await mkdir(schema);
  await writeFile(join(schema, '0000_first.sql'), 'CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT);');
  let db = new LocalDatabase(join(directory, 'data'), schema);
  await db.prepare('INSERT INTO items VALUES(?,?)').bind('saved', 'original').run();
  db.close();
  await writeFile(join(schema, '0001_second.sql'), 'ALTER TABLE items ADD extra TEXT;');
  db = new LocalDatabase(join(directory, 'data'), schema);
  assert.ok(db.migrationBackup);
  const saved = new DatabaseSync(db.migrationBackup, { readOnly: true });
  assert.equal(saved.prepare('SELECT value FROM items').get().value, 'original');
  assert.equal(saved.prepare('SELECT COUNT(*) AS total FROM schema_migrations').get().total, 1);
  saved.close();
  db.close();
  await writeFile(join(schema, '0000_first.sql'), 'CREATE TABLE changed(id TEXT);');
  assert.throws(() => new LocalDatabase(join(directory, 'data'), schema), /migrations differ/);
});

test('failed schema upgrade rolls back its schema changes and migration records', async t => {
  const directory = await sandbox(t);
  const schema = join(directory, 'migrations');
  await mkdir(schema);
  await writeFile(join(schema, '0000_first.sql'), 'CREATE TABLE items(id TEXT PRIMARY KEY);');
  let db = new LocalDatabase(join(directory, 'data'), schema);
  db.close();
  await writeFile(join(schema, '0001_broken.sql'), 'ALTER TABLE items ADD extra TEXT; INSERT INTO missing VALUES(1);');
  assert.throws(() => new LocalDatabase(join(directory, 'data'), schema), /no such table/);
  const raw = new DatabaseSync(join(directory, 'data', 'library.sqlite'));
  assert.deepEqual(raw.prepare('PRAGMA table_info(items)').all().map(r => r.name), ['id']);
  assert.equal(raw.prepare('SELECT count(*) AS total FROM schema_migrations').get().total, 1);
  raw.close();
});

test('file bucket persists exact bytes and metadata without interpreting object keys as paths', async t => {
  const directory = await sandbox(t);
  const key = '../../outside/user.jpg';
  const bytes = Uint8Array.from([0xff, 0xd8, 0x00, 0x7f, 0xff, 0xd9]);
  let bucket = new FileBucket(directory);
  const result = await bucket.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' } });
  assert.equal(result.size, 6);
  assert.equal((await readdir(join(directory, 'assets'))).length, 1);
  assert.equal((await readdir(directory)).includes('outside'), false);
  bucket = new FileBucket(directory);
  const object = await bucket.get(key);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()), bytes);
  assert.deepEqual(new Uint8Array(await new Response(object.body).arrayBuffer()), bytes);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  assert.equal(headers.get('content-type'), 'image/jpeg');
  assert.equal(headers.get('cache-control'), 'private, no-store');
  await bucket.delete([key, 'already-missing']);
  assert.equal(await bucket.get(key), null);
});

test('file bucket atomically replaces objects and detects corrupted data', async t => {
  const directory = await sandbox(t);
  const bucket = new FileBucket(directory);
  await bucket.put('same', 'first');
  const old = await bucket.get('same');
  await bucket.put('same', 'replacement');
  assert.equal(Buffer.from(await old.arrayBuffer()).toString(), 'first');
  assert.equal(Buffer.from(await (await bucket.get('same')).arrayBuffer()).toString(), 'replacement');
  const [file] = await readdir(join(directory, 'assets'));
  const stored = await readFile(join(directory, 'assets', file));
  stored[stored.length - 1] ^= 1;
  await writeFile(join(directory, 'assets', file), stored);
  await assert.rejects(bucket.get('same'), /integrity check/);
});
