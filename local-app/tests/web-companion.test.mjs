import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../../', import.meta.url)), origin = 'https://test-mac.private-tailnet.ts.net';
const bundle = await build({ stdin: { contents: "export {startWebCompanion} from './local-app/server/web-companion.ts'; export {initializeRuntime} from './local-app/server/bindings.ts';", resolveDir: root },
  bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm',
  plugins: [{ name: 'web-test-bindings', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: join(root, 'local-app/server/bindings.ts') }));
    builder.onResolve({ filter: /(?:^|\/)app\/chatgpt-auth$/ }, () => ({ path: join(root, 'local-app/server/auth.ts') }));
  } }],
});
const { startWebCompanion, initializeRuntime } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

async function sandbox(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-web-test-')), clientDir = join(directory, 'pwa');
  let dataDir = join(directory, 'data');
  await mkdir(join(clientDir, 'assets'), { recursive: true });
  await writeFile(join(clientDir, 'index.html'), '<!doctype html><title>Cliptext PWA fixture</title>');
  await writeFile(join(clientDir, 'assets/app.js'), 'console.log("Synthetic app shell");');
  await writeFile(join(clientDir, 'sw.js'), 'self.addEventListener("fetch",()=>{});');
  const options = () => ({ dataDir, engineKey: 'synthetic-web-test-engine-key-00000000', migrationsDir: join(root, 'drizzle') });
  let runtime = initializeRuntime(options()), web = await startWebCompanion({ DB: runtime.DB, clientDir, port: 0 });
  t.after(async () => { await web.close(); runtime.close(); await rm(directory, { recursive: true, force: true }); });
  const context = {
    directory, clientDir, get DB() { return runtime.DB; }, get web() { return web; },
    async restart(move = false) {
      await web.close(); runtime.close();
      if (move) { const next = join(directory, 'moved-data'); await rename(dataDir, next); dataDir = next; }
      runtime = initializeRuntime(options()); web = await startWebCompanion({ DB: runtime.DB, clientDir, port: 0 });
    },
    async admin(action, extra = {}) {
      const response = await web.handleAdmin(new Request('http://127.0.0.1:47321/api/local/web', action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) } : {}));
      return { status: response.status, value: await response.json() };
    },
    async enable() { const result = await this.admin('enable', { origin }); assert.equal(result.status, 200); assert.equal(result.value.error, undefined); },
    call(path, { method = 'GET', body, headers = {}, cookie, csrf, native = false } = {}) {
      const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
      return new Promise((resolve, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port: web.configuration().port, method, path, agent: false,
          headers: { Host: new URL(origin).host, 'X-Forwarded-Proto': 'https', ...(!native ? { 'Sec-Fetch-Site': 'same-origin', ...(method === 'POST' ? { Origin: origin } : {}) } : {}),
            ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Cliptext-CSRF': csrf } : {}), ...headers } }, response => {
          const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8'); let value; try { value = JSON.parse(text); } catch { value = text; }
            resolve({ status: response.statusCode, headers: response.headers, value, bytes: Buffer.byteLength(text) });
          });
        });
        outgoing.setTimeout(5000, () => outgoing.destroy(new Error('Web companion test timed out.'))); outgoing.on('error', reject); outgoing.end(bytes);
      });
    },
    async pair(name = 'Test iPhone') {
      const offered = await this.admin('pair'); assert.equal(offered.status, 200);
      const paired = await this.call('/api/pwa/pair', { method: 'POST', body: { code: offered.value.code, name } });
      assert.equal(paired.status, 200);
      return { code: offered.value.code, cookie: paired.headers['set-cookie'][0].split(';')[0], csrf: paired.value.csrfToken, deviceId: paired.value.deviceId, libraryId: paired.value.libraryId, response: paired };
    },
    async shortcut() { const result = await this.admin('shortcut'); assert.equal(result.status, 200); return result.value.shortcut; },
  };
  return context;
}
function seed(context, id, extra = {}) {
  const values = { id, owner_id: 'owner', url: `https://www.youtube.com/watch?v=${id.padEnd(11, 'x').slice(0, 11)}`, platform: 'youtube', status: 'completed', title: 'Synthetic title', transcript: 'Synthetic text', created_at: '2026-01-01', updated_at: '2026-01-01', ...extra };
  context.DB.connection.prepare(`INSERT INTO jobs(${Object.keys(values).join(',')}) VALUES(${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values));
}

test('companion requires explicit opt-in, trusted origin and serves only its PWA directory', async t => {
  const context = await sandbox(t);
  assert.equal(context.web.configuration().enabled, false); assert.equal(context.web.configuration().origin, null);
  assert.equal(context.web.configuration().shortcutDownloads, false);
  assert.equal((await context.admin('pair')).status, 503);
  for (const value of ['http://test.ts.net', 'https://example.com', 'https://test.ts.net:47323', 'https://test.ts.net/path', 'https://user:secret@test.ts.net']) assert.equal((await context.admin('origin', { origin: value })).status, 400);
  await context.enable();
  assert.match(context.web.configuration().libraryId, /^lib_[a-f0-9]{32}$/);
  assert.equal((await context.call('/')).status, 200);
  assert.equal((await context.call('/assets/app.js')).status, 200);
  const sw = await context.call('/sw.js'); assert.equal(sw.status, 200); assert.equal(sw.headers['service-worker-allowed'], '/');
  for (const path of ['/api/jobs', '/api/local/web', '/api/worker/claim', '/server/main.mjs', '/assets/../../private.json', '/downloads/cliptext-share.apk']) assert.notEqual((await context.call(path)).status, 200);
  await writeFile(join(context.directory, 'private.js'), 'private synthetic fixture'); await symlink(join(context.directory, 'private.js'), join(context.clientDir, 'assets/private.js'));
  assert.equal((await context.call('/assets/private.js')).status, 403);
  for (const headers of [{ Host: 'attacker.invalid' }, { 'X-Forwarded-Proto': 'http' }, { Origin: 'https://attacker.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { Referer: 'https://attacker.invalid/' }]) assert.equal((await context.call('/api/pwa/session', { headers })).status, 403);
  assert.equal((await context.call('/', { headers: { 'Sec-Fetch-Site': 'cross-site', Referer: 'https://example.invalid/' } })).status, 200);
  const session = await context.call('/api/pwa/session'); assert.equal(session.status, 401); assert.equal(session.value.connected, false);
  assert.equal(session.headers['cache-control'], 'private, no-store'); assert.equal(session.headers['access-control-allow-origin'], undefined);
  await writeFile(join(context.clientDir, 'theme-bootstrap.js'), '/* Synthetic theme bootstrap */');
  assert.equal((await context.call('/theme-bootstrap.js')).status, 200);
  await mkdir(join(context.clientDir, 'fonts')); await writeFile(join(context.clientDir, 'fonts/example.woff'), 'synthetic font fixture');
  assert.equal((await context.call('/fonts/example.woff')).headers['content-type'], 'font/woff');
  await mkdir(join(context.clientDir, 'shortcuts'));
  for (const file of ['Save to Cliptext.shortcut', 'Sync Cliptext.shortcut']) await writeFile(join(context.clientDir, 'shortcuts', file), 'generic installer fixture without credentials');
  assert.equal(context.web.configuration().shortcutDownloads, true);
  const download = await context.call('/shortcuts/Save%20to%20Cliptext.shortcut');
  assert.equal(download.status, 200); assert.equal(download.headers['content-type'], 'application/x-apple-shortcut'); assert.equal(download.headers['cache-control'], 'private, no-store');
  assert.equal((await context.call('/shortcuts/arbitrary.shortcut')).status, 404);
});

test('browser pairing exchanges an expiring bootstrap for an HttpOnly cookie, persists and revokes', async t => {
  const context = await sandbox(t); await context.enable(); const paired = await context.pair();
  assert.match(paired.response.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict/);
  const capsule = JSON.parse(Buffer.from(paired.code, 'base64url').toString('utf8'));
  const token = paired.cookie.split('=')[1]; assert.notEqual(token, capsule.token); assert.equal(paired.response.value.token, undefined);
  const stored = context.DB.connection.prepare('SELECT * FROM web_companion_devices WHERE id=?').get(paired.deviceId);
  assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex')); assert.equal(stored.bootstrap_hash, createHash('sha256').update(capsule.token).digest('hex'));
  const replay = await context.call('/api/pwa/pair', { method: 'POST', body: { code: paired.code, name: 'Test iPhone' } });
  assert.equal(replay.status, 200); assert.equal(replay.headers['set-cookie'][0].split(';')[0], paired.cookie);
  assert.equal((await context.call('/api/pwa/pair', { method: 'POST', body: { code: paired.code, name: 'Different browser' } })).status, 409);
  context.DB.connection.prepare('UPDATE web_companion_devices SET expires_at=? WHERE id=?').run(Date.now() - 1, paired.deviceId);
  const expired = await context.call('/api/pwa/pair', { method: 'POST', body: { code: paired.code }, cookie: paired.cookie });
  assert.equal(expired.status, 401); assert.equal(expired.headers['set-cookie'], undefined);
  assert.equal((await context.call('/api/pwa/session', { cookie: paired.cookie })).status, 200);
  const id = context.web.configuration().libraryId;
  await context.restart(true);
  assert.equal(context.web.configuration().libraryId, id); assert.equal(context.web.configuration().enabled, true);
  const restored = await context.call('/api/pwa/session', { cookie: paired.cookie }); assert.equal(restored.status, 200); assert.equal(restored.value.csrfToken, paired.csrf);
  assert.equal((await context.admin('revoke', { deviceId: paired.deviceId })).status, 200);
  assert.equal((await context.call('/api/pwa/session', { cookie: paired.cookie })).status, 401);
});

test('browser mutations require exact origin plus CSRF; link receipts are atomic and durable', async t => {
  const context = await sandbox(t); await context.enable(); const paired = await context.pair();
  const input = { requestId: randomUUID(), url: 'https://youtu.be/abcdefghijk' };
  const submit = (extra = {}, body = input) => context.call('/api/pwa/links', { method: 'POST', body, cookie: paired.cookie, csrf: paired.csrf, ...extra });
  assert.equal((await submit({ csrf: undefined })).status, 403);
  assert.equal((await submit({ headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await submit({ native: true })).status, 403);
  const results = await Promise.all([submit(), submit()]); assert.equal(results[0].status, 200); assert.equal(results[1].value.jobId, results[0].value.jobId);
  assert.equal((await submit({}, { requestId: input.requestId, url: 'https://youtu.be/lmnopqrstuv' })).status, 409);
  await context.restart(); assert.equal((await submit()).value.jobId, results[0].value.jobId);
  context.DB.connection.exec("CREATE TRIGGER fail_web_receipt BEFORE INSERT ON web_companion_receipts BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END;");
  assert.equal((await submit({}, { requestId: randomUUID(), url: 'https://youtu.be/lmnopqrstuv' })).status, 500);
  assert.equal(context.DB.connection.prepare('SELECT COUNT(*) AS total FROM jobs').get().total, 1);
  context.DB.connection.exec('DROP TRIGGER fail_web_receipt');
  assert.equal((await context.call('/api/pwa/disconnect', { method: 'POST', body: {}, cookie: paired.cookie, csrf: paired.csrf })).status, 200);
  assert.equal((await context.call('/api/pwa/sync', { cookie: paired.cookie })).status, 401);
});

test('Shortcut capability submits idempotent partial batches and cannot browse, sync, pair or administer', async t => {
  const context = await sandbox(t); await context.enable(); const shortcut = await context.shortcut(); const paired = await context.pair();
  const send = links => context.call('/api/shortcut/links', { method: 'POST', native: true, headers: { Authorization: 'Bearer ' + shortcut.token }, body: { links } });
  const good = { requestId: randomUUID(), url: 'https://youtu.be/abcdefghijk' }, bad = { requestId: randomUUID(), url: 'https://example.invalid/private' };
  const first = await send([good, bad]); assert.equal(first.status, 200); assert.equal(first.value.libraryId, shortcut.libraryId);
  assert.ok(first.value.receipts[0].jobId); assert.equal(first.value.receipts[1].status, 400); assert.equal(first.value.receipts[1].retryable, false);
  const repeated = await send([good]); assert.equal(repeated.value.receipts[0].jobId, first.value.receipts[0].jobId);
  assert.equal((await send([{ ...good, url: 'https://youtu.be/lmnopqrstuv' }])).value.receipts[0].status, 409);
  for (const path of ['/api/pwa/session', '/api/pwa/sync', '/api/pwa/pair', '/api/local/web', '/api/jobs', '/api/worker/claim']) assert.notEqual((await context.call(path, { native: true, headers: { Authorization: 'Bearer ' + shortcut.token } })).status, 200);
  assert.equal((await context.call('/api/shortcut/links', { method: 'POST', headers: { Authorization: 'Bearer ' + shortcut.token }, body: { links: [good] } })).status, 403);
  assert.equal((await context.call('/api/shortcut/links', { method: 'POST', native: true, cookie: paired.cookie, body: { links: [good] } })).status, 403);
  assert.equal((await context.admin('revoke', { deviceId: shortcut.deviceId })).status, 200);
  assert.equal((await send([good])).status, 401);
  assert.equal((await context.call('/api/pwa/session', { cookie: paired.cookie })).status, 200);
});

test('web sync uses full effective reading fields, private-owner changes and durable tombstones', async t => {
  const context = await sandbox(t); await context.enable(); const paired = await context.pair();
  seed(context, 'video', { transcript: 'Original words', edited_transcript: 'Edited words', notes: 'A note', insights: '{"summary":"A short summary.","takeaways":["An idea"]}', tags: '["ideas"]', lease_token: 'private-engine-fixture' });
  seed(context, 'slides', { content_kind: 'carousel', pages: '[{"index":1,"text":"Original slide","allText":"Screenshot details"}]', edited_pages: '[{"index":1,"text":"Edited slide","allText":"Screenshot details"}]' });
  seed(context, 'hidden', { owner_id: 'other-owner' });
  const sync = cursor => context.call('/api/pwa/sync?cursor=' + cursor + '&limit=1', { cookie: paired.cookie });
  let result = await sync(0); assert.equal(result.value.libraryId, paired.libraryId); assert.equal(result.value.hasMore, true);
  const job = result.value.changes[0].job; assert.equal(job.transcript, 'Edited words'); assert.equal(job.notes, 'A note'); assert.deepEqual(job.tags, ['ideas']);
  assert.equal(job.insights.summary, 'A short summary.'); assert.equal(JSON.stringify(result.value).includes('private-engine-fixture'), false); assert.equal(job.originalTranscript, undefined);
  result = await sync(result.value.cursor); assert.deepEqual(result.value.changes[0].job.pages, [{ index: 1, text: 'Edited slide' }]); assert.equal(result.value.hasMore, false);
  let cursor = result.value.cursor;
  context.DB.connection.prepare('UPDATE jobs SET trashed_at=? WHERE id=?').run('2026-01-02', 'video');
  result = await sync(cursor); assert.equal(result.value.changes[0].deleted, true); cursor = result.value.cursor;
  context.DB.connection.prepare('UPDATE jobs SET trashed_at=NULL WHERE id=?').run('video'); result = await sync(cursor); assert.equal(result.value.changes[0].deleted, false); cursor = result.value.cursor;
  context.DB.connection.prepare('DELETE FROM jobs WHERE id=?').run('video'); await context.restart(); result = await sync(cursor); assert.equal(result.value.changes[0].deleted, true);
  const ahead = await sync(999999); assert.equal(ahead.status, 409); assert.equal(ahead.value.resetRequired, true);
  assert.equal((await context.call('/api/pwa/sync?cursor=-1', { cookie: paired.cookie })).status, 400);
  assert.equal((await context.call('/api/pwa/sync?limit=51', { cookie: paired.cookie })).status, 400);
});

test('disabled companion stays unavailable across restart and preserves credentials for re-enable', async t => {
  const context = await sandbox(t); await context.enable(); const paired = await context.pair();
  const id = context.web.configuration().libraryId;
  await context.admin('disable'); await context.restart(); assert.equal(context.web.configuration().enabled, false); assert.equal(context.web.configuration().libraryId, id);
  await context.enable(); assert.equal((await context.call('/api/pwa/session', { cookie: paired.cookie })).status, 200);
});

test('web sync byte budget keeps unsent cursors pending and rejects oversized request bodies', async t => {
  const context = await sandbox(t); await context.enable(); const paired = await context.pair();
  for (let index = 0; index < 16; index++) seed(context, 'large' + index, { transcript: '界'.repeat(250_000) });
  const first = await context.call('/api/pwa/sync?cursor=0&limit=50', { cookie: paired.cookie });
  assert.equal(first.status, 200); assert.ok(first.bytes < 8 * 1024 * 1024); assert.equal(first.value.hasMore, true);
  assert.equal(first.value.cursor, first.value.changes.at(-1).seq);
  const second = await context.call('/api/pwa/sync?cursor=' + first.value.cursor, { cookie: paired.cookie });
  assert.equal(first.value.changes.length + second.value.changes.length, 16); assert.equal(second.value.hasMore, false);
  const oversized = await context.call('/api/pwa/links', { method: 'POST', cookie: paired.cookie, csrf: paired.csrf, body: { requestId: randomUUID(), url: 'x'.repeat(10_000) } });
  assert.equal(oversized.status, 413);
  const shortcut = await context.shortcut();
  assert.equal((await context.call('/api/shortcut/links', { method: 'POST', native: true, headers: { Authorization: 'Bearer ' + shortcut.token }, body: { links: Array.from({ length: 21 }, () => ({ requestId: randomUUID(), url: 'https://youtu.be/abcdefghijk' })) } })).status, 400);
  assert.equal((await context.call('/api/shortcut/links', { method: 'POST', native: true, headers: { Authorization: 'Bearer ' + shortcut.token }, body: { links: [{ requestId: randomUUID(), url: 'x'.repeat(70_000) }] } })).status, 413);
});
