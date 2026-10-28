import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url));
const migrations = join(root, 'drizzle');
// Bundle the same runtime bindings as production without starting the app/engine.
const bundle = await build({
  stdin: { contents: "export {startPhoneSync} from './local-app/server/phone.ts'; export {initializeRuntime} from './local-app/server/bindings.ts'; export {validateBackup} from './lib/backup.ts'; export {serializeJob} from './lib/server.ts';", resolveDir: root },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
  plugins: [{ name: 'phone-test-bindings', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: join(root, 'local-app/server/bindings.ts') }));
    builder.onResolve({ filter: /(?:^|\/)app\/chatgpt-auth$/ }, () => ({ path: join(root, 'local-app/server/auth.ts') }));
  } }],
});
const { startPhoneSync, initializeRuntime, validateBackup, serializeJob } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

async function sandbox(t, schema = migrations) {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-phone-test-'));
  const dataDir = join(directory, 'data');
  let runtime = initializeRuntime({ dataDir, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: schema });
  let phone = await startPhoneSync({ DB: runtime.DB, dataDir, port: 0 });
  t.after(async () => { await phone.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const context = {
    directory, dataDir,
    get DB() { return runtime.DB; }, get phone() { return phone; },
    async restart(nextSchema = schema) {
      await phone.close(); runtime.close();
      runtime = initializeRuntime({ dataDir, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: nextSchema });
      phone = await startPhoneSync({ DB: runtime.DB, dataDir, port: 0 });
    },
    async admin(action, extra = {}) {
      const request = new Request('http://127.0.0.1:47321/api/local/phone', action ? { method: 'POST', body: JSON.stringify({ action, ...extra }), headers: { 'Content-Type': 'application/json' } } : {});
      const response = await phone.handleAdmin(request);
      return { status: response.status, value: await response.json() };
    },
    async enable() {
      const enabled = await this.admin('enable');
      assert.equal(enabled.status, 200); assert.equal(enabled.value.error, undefined);
      // Tests need no Wi-Fi/Tailscale interface or DNS; actual traffic is loopback.
      assert.equal((await this.admin('address', { address: `https://test-mac.local:${enabled.value.port}` })).status, 200);
      return enabled.value;
    },
    async pair(name = 'Test phone') {
      const pairing = await this.admin('pair'); assert.equal(pairing.status, 200);
      const capsule = JSON.parse(Buffer.from(pairing.value.code, 'base64url').toString('utf8'));
      assert.equal(capsule.v, 1); assert.equal(capsule.fingerprint, phone.configuration().fingerprint);
      const response = await this.request('/api/phone/pair', { method: 'POST', token: capsule.token, body: { name } });
      assert.equal(response.status, 200); assert.equal(response.value.deviceId, capsule.deviceId);
      assert.match(response.value.token, /^[A-Za-z0-9_-]{43}$/);
      assert.notEqual(response.value.token, capsule.token);
      return { ...capsule, bootstrapToken: capsule.token, token: response.value.token };
    },
    request(path, { method = 'GET', token, body, headers = {}, trust = true } = {}) {
      const encoded = body === undefined ? null : Buffer.from(JSON.stringify(body));
      return new Promise((resolve, reject) => {
        const request = httpsRequest({ hostname: '127.0.0.1', port: phone.configuration().port, path, method,
          rejectUnauthorized: !trust, agent: false,
          headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': encoded.length } : {}), ...headers } }, response => {
          const chunks = []; let fingerprint = null;
          const peer = response.socket.getPeerCertificate();
          if (peer.raw) fingerprint = createHash('sha256').update(peer.raw).digest('hex');
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            const bytes = Buffer.concat(chunks);
            resolve({ status: response.statusCode, headers: response.headers, value: JSON.parse(bytes.toString('utf8')), bytes: bytes.length, fingerprint });
          });
        });
        request.setTimeout(5000, () => request.destroy(new Error('Phone test request timed out.')));
        request.on('error', reject); request.end(encoded);
      });
    },
  };
  return context;
}

function seed(context, id, extra = {}) {
  const values = { id, owner_id: 'owner', url: `https://www.youtube.com/watch?v=${id.padEnd(11, 'x').slice(0, 11)}`,
    platform: 'youtube', status: 'completed', title: 'Synthetic title', transcript: 'Synthetic speech.', created_at: '2026-01-01', updated_at: '2026-01-01', ...extra };
  const columns = Object.keys(values);
  context.DB.connection.prepare(`INSERT INTO jobs(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...Object.values(values));
}

test('phone service is opt-in, private TLS identity persists, and listener excludes browser/local/worker access', async t => {
  const context = await sandbox(t);
  assert.equal(context.phone.configuration().enabled, false);
  assert.deepEqual(context.phone.configuration().endpoints, []);
  assert.equal((await context.admin('pair')).status, 409);
  await assert.rejects(readFile(join(context.dataDir, 'phone-sync/identity.json')));
  await context.enable();
  const fingerprint = context.phone.configuration().fingerprint;
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await stat(join(context.dataDir, 'phone-sync'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(context.dataDir, 'phone-sync/identity.json'))).mode & 0o777, 0o600);
  const capsule = await context.pair();
  const response = await context.request('/api/phone/sync', { token: capsule.token });
  assert.equal(response.fingerprint, fingerprint);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  await assert.rejects(context.request('/api/phone/sync', { token: capsule.token, trust: false }), /self.signed|certificate/i);
  assert.equal((await context.request('/api/phone/sync')).status, 401);
  for (const headers of [{ Origin: 'https://example.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'same-origin' }, { Referer: 'https://example.invalid/' }, { Host: `attacker.invalid:${context.phone.configuration().port}` }]) {
    assert.equal((await context.request('/api/phone/sync', { token: capsule.token, headers })).status, 403);
  }
  assert.equal((await context.request('/api/phone/sync', { token: capsule.token, headers: { Host: `new-mac.private-tailnet.ts.net:${context.phone.configuration().port}` } })).status, 200);
  assert.equal((await context.request('/api/phone/sync', { token: capsule.token, headers: { Host: `new-mac.local:${context.phone.configuration().port}` } })).status, 200);
  assert.equal((await context.request('/api/phone/sync', { method: 'OPTIONS', token: capsule.token })).status, 403);
  for (const path of ['/api/local/phone', '/api/jobs', '/api/worker/claim', '/api/phone/sync/../links']) {
    assert.equal((await context.request(path, { token: capsule.token })).status, 404);
  }
  await assert.rejects(new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: context.phone.configuration().port, path: '/api/phone/sync', agent: false }, resolve);
    request.on('error', reject); request.end();
  }), /socket hang up|ECONNRESET/);
  await context.restart();
  assert.equal(context.phone.configuration().enabled, true);
  assert.equal(context.phone.configuration().fingerprint, fingerprint);
  assert.equal((await context.request('/api/phone/sync', { token: capsule.token })).status, 200);
  const stoppedPort = context.phone.configuration().port;
  assert.equal((await context.admin('disable')).value.enabled, false);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port: stoppedPort, rejectUnauthorized: false, agent: false }, resolve);
    request.on('error', reject); request.end();
  }), /ECONNREFUSED/);
  await context.restart();
  assert.equal(context.phone.configuration().enabled, false);
});

test('pairing stores only token hashes, expires, retries safely, caps pending codes and revokes immediately', async t => {
  const context = await sandbox(t); await context.enable();
  const pending = await context.admin('pair');
  const capsule = JSON.parse(Buffer.from(pending.value.code, 'base64url'));
  assert.ok(Date.parse(pending.value.expiresAt) > Date.now());
  const row = context.DB.connection.prepare('SELECT * FROM phone_sync_devices WHERE id=?').get(capsule.deviceId);
  assert.notEqual(row.token_hash, capsule.token);
  assert.equal(row.token_hash, createHash('sha256').update(capsule.token).digest('hex'));
  assert.equal((await context.request('/api/phone/sync', { token: capsule.token })).status, 401);
  context.DB.connection.prepare('UPDATE phone_sync_devices SET expires_at=? WHERE id=?').run(Date.now() - 1, capsule.deviceId);
  assert.equal((await context.request('/api/phone/pair', { method: 'POST', token: capsule.token, body: { name: 'Expired phone' } })).status, 401);
  const active = await context.pair('Phone A');
  const retry = await context.request('/api/phone/pair', { method: 'POST', token: active.bootstrapToken, body: { name: 'Phone A' } });
  assert.equal(retry.status, 200); assert.equal(retry.value.token, active.token);
  assert.equal((await context.request('/api/phone/pair', { method: 'POST', token: active.bootstrapToken, body: { name: 'Different phone' } })).status, 409);
  await context.restart();
  const replay = await context.request('/api/phone/pair', { method: 'POST', token: active.bootstrapToken, body: { name: 'Phone A' } });
  assert.equal(replay.status, 200); assert.equal(replay.value.token, active.token);
  assert.equal((await context.request('/api/phone/sync', { token: active.bootstrapToken })).status, 401);
  assert.equal((await context.request('/api/phone/links', { method: 'POST', token: active.bootstrapToken, body: { requestId: randomUUID(), url: 'https://youtu.be/abcdefghijk' } })).status, 401);
  assert.equal((await context.request('/api/phone/pair', { method: 'POST', token: active.token, body: { name: 'Phone A' } })).status, 401);
  context.DB.connection.prepare('UPDATE phone_sync_devices SET expires_at=? WHERE id=?').run(Date.now() - 1, active.deviceId);
  assert.equal((await context.request('/api/phone/pair', { method: 'POST', token: active.bootstrapToken, body: { name: 'Phone A' } })).status, 401);
  assert.equal((await context.request('/api/phone/sync', { token: active.token })).status, 200);
  assert.equal(context.phone.configuration().devices.length, 1);
  assert.equal(context.phone.configuration().devices[0].name, 'Phone A');
  for (let index = 0; index < 10; index++) assert.equal((await context.admin('pair')).status, 200);
  assert.equal((await context.admin('pair')).status, 429);
  assert.equal((await context.admin('revoke', { deviceId: active.deviceId })).status, 200);
  assert.equal((await context.request('/api/phone/sync', { token: active.token })).status, 401);
  assert.equal((await context.request('/api/phone/pair', { method: 'POST', token: active.token, body: { name: 'Phone A' } })).status, 401);
  await context.restart();
  assert.equal((await context.request('/api/phone/sync', { token: active.token })).status, 401);
});

test('link receipts are durable, canonical duplicates reuse one job and failed receipts roll back submission', async t => {
  const context = await sandbox(t); await context.enable(); const capsule = await context.pair();
  const requestId = randomUUID(), url = 'https://youtu.be/abcdefghijk';
  const submit = (body = { requestId, url }) => context.request('/api/phone/links', { method: 'POST', token: capsule.token, body });
  const results = await Promise.all([submit(), submit()]);
  assert.deepEqual(results.map(result => result.status), [200, 200]);
  const jobId = results[0].value.jobId;
  assert.equal(results[1].value.jobId, jobId);
  assert.equal((await submit({ requestId: randomUUID(), url: 'https://www.youtube.com/watch?v=abcdefghijk' })).value.jobId, jobId);
  assert.equal((await submit({ requestId, url: 'https://youtu.be/lmnopqrstuv' })).status, 409);
  assert.equal(context.DB.connection.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 1);
  assert.equal(context.DB.connection.prepare('SELECT COUNT(*) AS count FROM phone_sync_receipts').get().count, 2);
  await context.restart();
  assert.equal((await submit()).value.jobId, jobId);
  context.DB.connection.exec("CREATE TRIGGER phone_receipt_failure BEFORE INSERT ON phone_sync_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  assert.equal((await submit({ requestId: randomUUID(), url: 'https://youtu.be/lmnopqrstuv' })).status, 500);
  assert.equal(context.DB.connection.prepare('SELECT COUNT(*) AS count FROM jobs').get().count, 1);
  context.DB.connection.exec('DROP TRIGGER phone_receipt_failure');
  assert.equal((await submit({ requestId: randomUUID(), url: 'https://youtu.be/lmnopqrstuv' })).status, 200);
  assert.equal((await submit({ requestId: 'invalid', url })).status, 400);
  assert.equal((await submit({ requestId: randomUUID(), url: 'https://example.invalid/private' })).status, 400);
  assert.equal((await submit({ requestId: randomUUID(), url: 'x'.repeat(10_000) })).status, 413);
  const config = JSON.stringify((await context.admin()).value);
  assert.equal(config.includes(capsule.token), false); assert.equal(config.includes(rowHash(capsule.token)), false);
});
const rowHash = value => createHash('sha256').update(value).digest('hex');

test('sync carries effective library fields, ordered pagination and durable Trash/restore/purge tombstones', async t => {
  const context = await sandbox(t); await context.enable(); const capsule = await context.pair();
  context.DB.connection.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').run('ideas', 'owner', 'Ideas', '2026-01-01');
  context.DB.connection.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').run('private', 'other', 'Other owner', '2026-01-01');
  seed(context, 'article', { title: 'Caption', generated_title: 'Clear title', edited_title: 'Edited title', transcript: 'Original words', edited_transcript: 'Edited words',
    notes: 'A note', tags: '["ideas"]', insights: '{"summary":"A short summary.","takeaways":["One idea"]}', segments: '[{"start":0,"end":2,"text":"Original words"}]',
    reviewed_at: '2026-01-02', collection_id: 'ideas', lease_token: 'private-worker-lease' });
  seed(context, 'slides', { content_kind: 'carousel', pages: '[{"index":1,"text":"Original slide"}]', edited_pages: '[{"index":1,"text":"Edited slide"}]' });
  seed(context, 'other', { owner_id: 'other' });
  const sync = cursor => context.request('/api/phone/sync?cursor=' + cursor + '&limit=1', { token: capsule.token });
  const first = await sync(0);
  assert.equal(first.value.changes.length, 1); assert.equal(first.value.hasMore, true);
  const job = first.value.changes[0].job;
  assert.equal(job.title, 'Edited title'); assert.equal(job.transcript, 'Edited words'); assert.equal(job.originalTranscript, undefined);
  assert.equal(job.notes, 'A note'); assert.deepEqual(job.tags, ['ideas']); assert.equal(job.reviewedAt, '2026-01-02');
  assert.equal(job.segments, undefined); assert.equal(job.insights.summary, 'A short summary.');
  assert.equal(JSON.stringify(first.value).includes('private-worker-lease'), false);
  assert.deepEqual(first.value.collections, [{ id: 'ideas', name: 'Ideas' }]);
  const second = await sync(first.value.cursor);
  assert.equal(second.value.changes[0].job.pages[0].text, 'Edited slide'); assert.equal(second.value.hasMore, false);
  let cursor = second.value.cursor;
  context.DB.connection.prepare('UPDATE jobs SET notes=? WHERE id=?').run('Updated note', 'article');
  let next = await sync(cursor); assert.equal(next.value.changes[0].job.notes, 'Updated note'); cursor = next.value.cursor;
  context.DB.connection.prepare('UPDATE jobs SET trashed_at=? WHERE id=?').run('2026-01-03', 'article');
  next = await sync(cursor); assert.deepEqual(next.value.changes.map(change => change.deleted), [true]); assert.equal(next.value.changes[0].job, undefined); cursor = next.value.cursor;
  context.DB.connection.prepare('UPDATE jobs SET trashed_at=NULL WHERE id=?').run('article');
  next = await sync(cursor); assert.equal(next.value.changes[0].deleted, false); cursor = next.value.cursor;
  context.DB.connection.prepare('DELETE FROM jobs WHERE id=?').run('article');
  await context.restart();
  next = await sync(cursor); assert.equal(next.value.changes[0].deleted, true); assert.equal(next.value.changes[0].id, 'article');
  assert.equal((await context.request('/api/phone/sync?cursor=-1', { token: capsule.token })).status, 400);
  assert.equal((await context.request('/api/phone/sync?limit=51', { token: capsule.token })).status, 400);
  const reset = await context.request('/api/phone/sync?cursor=999999', { token: capsule.token });
  assert.equal(reset.status, 409); assert.equal(reset.value.resetRequired, true);
});

test('byte-bounded pages never advance past unsent changes and stable private addresses are validated', async t => {
  const context = await sandbox(t); await context.enable(); const capsule = await context.pair();
  for (let index = 0; index < 16; index++) seed(context, 'large' + index, { transcript: '界'.repeat(250_000) });
  const first = await context.request('/api/phone/sync?limit=50', { token: capsule.token });
  assert.ok(first.bytes < 8 * 1024 * 1024); assert.ok(first.value.changes.length < 16); assert.equal(first.value.hasMore, true);
  assert.equal(first.value.cursor, first.value.changes.at(-1).seq);
  const second = await context.request('/api/phone/sync?cursor=' + first.value.cursor, { token: capsule.token });
  assert.equal(first.value.changes.length + second.value.changes.length, 16); assert.equal(second.value.hasMore, false);
  const port = context.phone.configuration().port;
  assert.equal((await context.admin('address', { address: `https://test-mac.example.ts.net:${port}` })).status, 200);
  assert.equal(context.phone.configuration().address, `https://test-mac.example.ts.net:${port}`);
  assert.ok(context.phone.configuration().endpoints.includes(`https://test-mac.example.ts.net:${port}`));
  assert.equal((await context.admin('address', { address: `https://100.100.100.100:${port}` })).status, 200);
  for (const address of [`http://test-mac.local:${port}`, `https://example.com:${port}`, `https://test-mac.local:${port}/api`, `https://user:secret@test-mac.local:${port}`]) {
    assert.equal((await context.admin('address', { address })).status, 400);
  }
});

test('upgrade bootstraps existing items into the journal without rewriting their content', async t => {
  const schema = await mkdtemp(join(tmpdir(), 'cliptext-phone-schema-'));
  t.after(() => rm(schema, { recursive: true, force: true }));
  for (const name of await readdir(migrations)) if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) < 11) await writeFile(join(schema, name), await readFile(join(migrations, name)));
  // Create an existing library at the previous schema before the phone service exists.
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-phone-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let runtime = initializeRuntime({ dataDir: directory, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: schema });
  seed({ DB: runtime.DB }, 'existing', { transcript: 'Keep the existing words.', notes: 'Keep this note.' });
  runtime.close();
  runtime = initializeRuntime({ dataDir: directory, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: migrations });
  t.after(() => runtime.close());
  const change = runtime.DB.connection.prepare('SELECT job_id,deleted FROM phone_sync_changes').get();
  assert.equal(change.job_id, 'existing'); assert.equal(change.deleted, 0);
  assert.equal(runtime.DB.connection.prepare('SELECT transcript,notes FROM jobs WHERE id=?').get('existing').transcript, 'Keep the existing words.');
  assert.ok(runtime.DB.migrationBackup);
});

test('bootstrap-token upgrade revokes prototype devices while preserving the migrated library', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-phone-bootstrap-upgrade-'));
  const schema = join(directory, 'schema'); await mkdir(schema);
  for (const name of await readdir(migrations)) if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 11) await writeFile(join(schema, name), await readFile(join(migrations, name)));
  const dataDir = join(directory, 'data');
  let runtime = initializeRuntime({ dataDir, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: schema });
  seed({ DB: runtime.DB }, 'preserved', { transcript: 'Preserve all existing words and notes.', notes: 'Preserve this note.' });
  runtime.DB.connection.prepare('INSERT INTO phone_sync_devices(id,token_hash,created_at,expires_at,paired_at) VALUES(?,?,?,?,?)').run(randomUUID(), rowHash('prototype-fixture-token'), 1, 2, 1);
  runtime.close();
  runtime = initializeRuntime({ dataDir, engineKey: 'synthetic-test-engine-key-000000000000', migrationsDir: migrations });
  t.after(async () => { runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const device = runtime.DB.connection.prepare('SELECT revoked_at,bootstrap_hash FROM phone_sync_devices').get();
  assert.notEqual(device.revoked_at, null); assert.equal(device.bootstrap_hash, null);
  const job = runtime.DB.connection.prepare('SELECT transcript,notes FROM jobs WHERE id=?').get('preserved');
  assert.equal(job.transcript, 'Preserve all existing words and notes.'); assert.equal(job.notes, 'Preserve this note.');
  assert.ok(runtime.DB.migrationBackup);
});

test('largest supported legacy backup metadata cannot block the phone reading copy or later changes', async t => {
  const context = await sandbox(t); await context.enable(); const capsule = await context.pair();
  const text = '界'.repeat(250_000), notes = '考'.repeat(50_000);
  const item = { id: 'large-legacy', url: 'https://youtu.be/abcdefghijk', status: 'completed', title: 'Synthetic large legacy item',
    transcript: text, edited_transcript: text, notes, content_kind: 'video', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    segments: JSON.stringify(Array.from({ length: 3000 }, (_, index) => ({ start: index, end: index + 1, text: '界'.repeat(2000) }))),
    highlights: JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: 'highlight-' + index, quote: '界'.repeat(10_000), note: '考'.repeat(10_000) }))) };
  const backup = { format: 'cliptext-backup', version: 1, createdAt: '2026-01-01T00:00:00.000Z', collections: [], items: [item], assets: [] };
  assert.ok(Buffer.byteLength(JSON.stringify(backup)) < 32 * 1024 * 1024);
  const normalized = validateBackup(backup).items[0]; seed(context, normalized.id, normalized);
  assert.ok(Buffer.byteLength(JSON.stringify(serializeJob(context.DB.connection.prepare('SELECT * FROM jobs WHERE id=?').get(normalized.id)))) > 24 * 1024 * 1024);
  seed(context, 'afterlarge');
  const response = await context.request('/api/phone/sync?cursor=0&limit=50', { token: capsule.token });
  assert.equal(response.status, 200); assert.ok(response.bytes < 8 * 1024 * 1024); assert.equal(response.value.hasMore, false);
  assert.equal(response.value.changes.length, 2);
  const projected = response.value.changes[0].job;
  assert.equal(projected.transcript, text); assert.equal(projected.notes, notes);
  for (const omitted of ['segments', 'highlights', 'originalTranscript', 'originalPages', 'suggestions']) assert.equal(projected[omitted], undefined);
  assert.equal(response.value.changes[1].job.id, 'afterlarge');
});

test('closing phone sync also drains clients stalled before the TLS handshake', async t => {
  const context = await sandbox(t); await context.enable();
  const socket = await new Promise((resolve, reject) => {
    const client = connect(context.phone.configuration().port, '127.0.0.1', () => resolve(client));
    client.on('error', reject);
  });
  const closing = context.phone.close();
  let timer;
  const completed = await Promise.race([closing.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 3000); })]);
  clearTimeout(timer); socket.destroy(); await closing;
  assert.equal(completed, true, 'An incomplete TLS handshake must not hold the Mac app open.');
});

test('disabling while a link body is arriving reports unavailability instead of revoking its valid phone', async t => {
  const context = await sandbox(t); await context.enable(); const capsule = await context.pair();
  let authenticated, disabled;
  const reachedBody = new Promise(resolve => { authenticated = resolve; });
  const stoppedAccepting = new Promise(resolve => { disabled = resolve; });
  const original = context.DB.connection.prepare;
  context.DB.connection.prepare = function(sql) {
    const result = original.call(this, sql);
    if (sql.includes('FROM phone_sync_devices WHERE token_hash=?')) queueMicrotask(authenticated);
    if (sql === 'UPDATE phone_sync_settings SET enabled=0 WHERE id=1') queueMicrotask(disabled);
    return result;
  };
  const body = Buffer.from(JSON.stringify({ requestId: randomUUID(), url: 'https://youtu.be/abcdefghijk' }));
  let request;
  const response = new Promise((resolve, reject) => {
    request = httpsRequest({ hostname: '127.0.0.1', port: context.phone.configuration().port, path: '/api/phone/links', method: 'POST', rejectUnauthorized: false, agent: false,
      headers: { Authorization: 'Bearer ' + capsule.token, 'Content-Type': 'application/json', 'Content-Length': body.length } }, result => {
      result.resume(); result.on('end', () => resolve(result.statusCode));
    });
    request.setTimeout(5000, () => request.destroy(new Error('Slow-body test timed out.')));
    request.on('error', reject); request.write(body.subarray(0, 1));
  });
  await Promise.race([reachedBody, response.then(() => { throw new Error('Expected an authenticated partial body.'); })]);
  const disabling = context.admin('disable'); await stoppedAccepting;
  context.DB.connection.prepare = original;
  assert.equal(context.phone.configuration().enabled, false);
  request.end(body.subarray(1));
  assert.equal(await response, 503); await disabling;
  await context.enable();
  assert.equal((await context.request('/api/phone/sync', { token: capsule.token })).status, 200);
});
