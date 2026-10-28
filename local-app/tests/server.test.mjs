import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { createServer as tcpServer } from 'node:net';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { createLocalApp } from '../dist/server/main.mjs';

const localRoot = fileURLToPath(new URL('../', import.meta.url));
const clientDir = join(localRoot, 'dist/client');
const migrationsDir = join(localRoot, 'dist/migrations');
const serverMain = join(localRoot, 'dist/server/main.mjs');

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-http-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function options(directory, overrides = {}) {
  return { dataDir: join(directory, 'data'), clientDir, migrationsDir, port: 0,
    engineBundle: join(directory, 'absent-engine'), modelsDir: join(directory, 'absent-models'),
    autoStartEngine: false, ...overrides };
}

async function openApp(t, directory, overrides = {}) {
  const app = await createLocalApp(options(directory, overrides));
  let closed = false;
  const close = async () => { if (!closed) { await app.close(); closed = true; } };
  t.after(close);
  const response = await fetch(app.origin + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null, 'Public HTML must not authorize arbitrary local users.');
  await response.text();
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  assert.ok(token, 'The owner launch address must carry its private connection capability.');
  const connected = await fetch(app.origin + '/api/local/session', { method: 'POST',
    headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(connected.status, 200);
  const cookie = connected.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'A valid owner capability must establish the private HTTP session.');
  assert.match(connected.headers.get('set-cookie'), /HttpOnly/);
  assert.match(connected.headers.get('set-cookie'), /SameSite=Strict/);
  await connected.text();
  const json = async (path, method = 'GET', payload, extra = {}) => {
    const response = await fetch(app.origin + path, { method, headers: { Cookie: cookie,
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
    const value = await response.json();
    return { response, value };
  };
  const worker = async (path, method = 'POST', payload = {}) => {
    const key = app.engine.options.engineKey;
    return json(path, method, payload, { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': key, Authorization: 'Bearer ' + key });
  };
  return { app, cookie, json, worker, close };
}

function raw(origin, path, headers = {}) {
  return new Promise((accept, reject) => {
    const url = new URL(origin);
    const request = httpRequest({ host: '127.0.0.1', port: url.port, path, headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => accept({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function child(args, timeout = 20_000) {
  const process = spawn(globalThis.process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', chunk => { stdout += chunk; });
  process.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => process.kill('SIGKILL'), timeout);
  return new Promise((accept, reject) => {
    process.once('error', error => { clearTimeout(timer); reject(error); });
    process.once('exit', (code, signal) => { clearTimeout(timer); accept({ code, signal, stdout, stderr }); });
  });
}

async function completedVideo(context, url = 'https://www.youtube.com/watch?v=abcdefghijk') {
  const created = await context.json('/api/jobs', 'POST', { url });
  assert.equal(created.response.status, 201);
  const claimed = await context.worker('/api/worker/claim');
  assert.equal(claimed.response.status, 200);
  assert.equal(claimed.value.job.id, created.value.job.id);
  const id = created.value.job.id;
  const result = await context.worker(`/api/worker/jobs/${id}`, 'PATCH', {
    leaseToken: claimed.value.job.leaseToken, status: 'completed', contentKind: 'video',
    title: 'Original caption', creator: 'sample_creator', durationSeconds: 12, language: 'en',
    transcript: 'Good pricing connects customer value with clear positioning.',
    segments: [{ start: 0, end: 12, text: 'Good pricing connects customer value with clear positioning.' }],
  });
  assert.equal(result.response.status, 200);
  return id;
}

test('local HTTP session, origin and Host boundaries protect the library and worker', async t => {
  const directory = await temporary(t);
  const context = await openApp(t, directory);
  const { app, cookie, json } = context;
  assert.equal((await fetch(app.origin + '/api/jobs')).status, 401);
  assert.equal((await fetch(app.origin + '/api/local/config')).status, 401);
  assert.equal((await fetch(app.origin + '/api/local/session')).status, 401);
  for (const payload of [{}, { token: 'invalid-owner-capability' }]) {
    const refused = await fetch(app.origin + '/api/local/session', { method: 'POST',
      headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get('set-cookie'), null);
  }
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const wrongOrigin = await fetch(app.origin + '/api/local/session', { method: 'POST',
    headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(wrongOrigin.status, 403);
  assert.equal(wrongOrigin.headers.get('set-cookie'), null);
  const absentOrigin = await fetch(app.origin + '/api/local/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(absentOrigin.status, 403);
  assert.equal(absentOrigin.headers.get('set-cookie'), null);
  assert.equal((await fetch(app.origin + '/api/local/session', { headers: { Cookie: cookie } })).status, 200);
  const publicPage = await fetch(app.origin + '/');
  assert.equal(publicPage.headers.get('set-cookie'), null);
  assert.equal((await publicPage.text()).includes(token), false);
  assert.equal((await fetch(app.origin + '/api/jobs')).status, 401, 'Fetching public HTML alone must not authorize the library.');
  assert.equal((await fetch(app.origin + '/api/jobs', { headers: { Cookie: cookie, Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(app.origin + '/api/jobs', { headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await raw(app.origin, '/api/jobs', { Host: 'rebound.example', Cookie: cookie })).status, 403);
  assert.equal((await json('/api/worker/claim', 'POST', {})).response.status, 401);
  assert.equal((await json('/api/worker/claim', 'POST', {}, { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': 'invalid', Authorization: 'Bearer invalid' })).response.status, 401);
  assert.equal((await json('/api/jobs', 'GET', undefined, { 'X-Cliptext-Engine': '1' })).response.status, 403);
  assert.equal((await fetch(app.origin + '/downloads/cliptext-share.apk')).status, 404);
  const traversal = await raw(app.origin, '/%2e%2e/%2e%2e/etc/passwd', { Cookie: cookie });
  assert.ok([403, 404].includes(traversal.status));
  const local = await json('/api/local/config');
  assert.equal(local.response.status, 200);
  assert.equal(local.value.phoneSharing, false);
  assert.equal(local.value.worker.running, false);
  assert.equal(JSON.stringify(local.value).includes(app.engine.options.engineKey), false);
  const response = await fetch(app.origin + '/setup');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('jobs, collections, transcript edits, notes, tags, review and trash use local SQLite', async t => {
  const directory = await temporary(t);
  const context = await openApp(t, directory);
  const collection = await context.json('/api/collections', 'POST', { name: 'Ideas' });
  assert.equal(collection.response.status, 201);
  const collectionId = collection.value.collection.id;
  const id = await completedVideo(context);
  let update = await context.json(`/api/jobs/${id}`, 'PATCH', { title: 'Useful pricing ideas', notes: 'Test audience segments.',
    tags: ['Pricing', 'value'], collectionId, favorite: true, reviewed: true });
  assert.equal(update.response.status, 200);
  assert.deepEqual(update.value.job.tags, ['pricing', 'value']);
  assert.equal(update.value.job.notes, 'Test audience segments.');
  assert.ok(update.value.job.reviewedAt);
  const oldRevision = update.value.job.revision;
  update = await context.json(`/api/jobs/${id}`, 'PATCH', { expectedRevision: oldRevision, transcript: 'Edited transcript about customer positioning.' });
  assert.equal(update.response.status, 200);
  assert.equal(update.value.job.transcript, 'Edited transcript about customer positioning.');
  assert.equal((await context.json(`/api/jobs/${id}`, 'PATCH', { expectedRevision: oldRevision, notes: 'Stale write' })).response.status, 409);
  const results = await context.json('/api/jobs?q=positioning&view=reviewed&tag=pricing&favorite=1&collectionId=' + collectionId);
  assert.equal(results.response.status, 200);
  assert.deepEqual(results.value.jobs.map(job => job.id), [id]);
  const library = await context.json('/api/library');
  assert.equal(library.value.stats.total, 1);
  assert.equal(library.value.stats.reviewed, 1);
  assert.equal(library.value.collections[0].name, 'Ideas');
  const renamed = await context.json('/api/collections/' + collectionId, 'PATCH', { name: 'Research' });
  assert.equal(renamed.value.collection.name, 'Research');
  assert.equal((await context.json(`/api/jobs/${id}`, 'DELETE')).response.status, 200);
  assert.equal((await context.json('/api/jobs')).value.total, 0);
  assert.equal((await context.json('/api/jobs?view=trash')).value.total, 1);
  assert.equal((await context.json(`/api/jobs/${id}`, 'PATCH', { restore: true })).response.status, 200);
  assert.equal((await context.json('/api/jobs')).value.total, 1);
  assert.equal((await context.json('/api/collections/' + collectionId, 'DELETE')).response.status, 200);
  assert.equal((await context.json(`/api/jobs/${id}`)).value.job.collectionId, null);
});

test('custom themes/fonts, notes and completed transcripts survive a local server restart', async t => {
  const directory = await temporary(t);
  let context = await openApp(t, directory);
  const id = await completedVideo(context);
  await context.json(`/api/jobs/${id}`, 'PATCH', { notes: 'Persistent note.' });
  const created = await context.json('/api/themes', 'POST', { name: 'My Latte', accent: '#FF8E3C', background: '#FFFAEE', foreground: '#502E1A', font: 'dm-sans' });
  assert.equal(created.response.status, 201);
  const themeId = created.value.theme.id;
  assert.equal((await context.json('/api/themes/' + themeId, 'PATCH', { name: 'Warm Latte' })).response.status, 200);
  assert.equal((await context.json('/api/themes', 'PATCH', { activeThemeId: themeId })).response.status, 200);
  const oldCookie = context.cookie;
  const oldBootstrap = new URLSearchParams(new URL(context.app.launchUrl).hash.slice(1)).get('connect');
  await context.close();
  context = await openApp(t, directory);
  assert.equal((await fetch(context.app.origin + '/api/jobs', { headers: { Cookie: oldCookie } })).status, 401);
  const staleConnection = await fetch(context.app.origin + '/api/local/session', { method: 'POST',
    headers: { Origin: context.app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: oldBootstrap }) });
  assert.equal(staleConnection.status, 401);
  assert.equal(staleConnection.headers.get('set-cookie'), null);
  const themes = await context.json('/api/themes');
  assert.equal(themes.value.activeThemeId, themeId);
  assert.equal(themes.value.themes[0].name, 'Warm Latte');
  assert.equal(themes.value.themes[0].font, 'dm-sans');
  assert.equal((await context.json(`/api/jobs/${id}`)).value.job.notes, 'Persistent note.');
  assert.equal((await context.json('/api/themes', 'PATCH', { activePresetId: 'midnight' })).response.status, 200);
  assert.equal((await context.json('/api/themes/' + themeId, 'DELETE')).response.status, 200);
});

test('CSV/Excel, saved binary images and backup restore round-trip through HTTP', async t => {
  const directory = await temporary(t);
  let context = await openApp(t, directory);
  const collection = await context.json('/api/collections', 'POST', { name: 'Ideas' });
  const id = await completedVideo(context);
  await context.json(`/api/jobs/${id}`, 'PATCH', { title: 'Pricing guide', collectionId: collection.value.collection.id, notes: 'A saved note.' });
  // Minimal server-validator JPEG structure; actual decoding is tested by the
  // packaged engine integration, not claimed by this transport/storage test.
  const jpeg = Uint8Array.from([255,216,255,192,0,11,8,0,180,1,64,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
  const key = 'private/test/frame.jpg';
  await context.app.runtime.BUCKET.put(key, jpeg, { httpMetadata: { contentType: 'image/jpeg' } });
  await context.app.runtime.DB.prepare("INSERT INTO job_frames(job_id,status,image_key,width,height,kind,updated_at) VALUES(?,'ready',?,320,180,'thumbnail',?)")
    .bind(id, key, new Date().toISOString()).run();
  const image = await fetch(context.app.origin + `/api/jobs/${id}/frame`, { headers: { Cookie: context.cookie } });
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), jpeg);
  const csv = await fetch(context.app.origin + '/api/export?format=csv&scope=all', { headers: { Cookie: context.cookie } });
  assert.equal(csv.status, 200);
  const csvText = await csv.text();
  assert.match(csvText, /"Collection","Title"/);
  assert.match(csvText, /"Ideas","Pricing guide"/);
  assert.match(csvText, /A saved note/);
  const selected = await fetch(context.app.origin + '/api/export?format=csv&scope=collection&collectionId=' + collection.value.collection.id, { headers: { Cookie: context.cookie } });
  assert.equal(selected.status, 200);
  assert.match(await selected.text(), /"Ideas","Pricing guide"/);
  const filtered = await fetch(context.app.origin + '/api/export?format=csv&scope=filtered&q=missingword', { headers: { Cookie: context.cookie } });
  assert.equal(filtered.status, 200);
  assert.equal((await filtered.text()).includes('Pricing guide'), false);
  const excel = await fetch(context.app.origin + '/api/export?format=xlsx&scope=all', { headers: { Cookie: context.cookie } });
  assert.equal(excel.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await excel.arrayBuffer()));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), ['All items', 'Ideas', 'Unsorted']);
  assert.equal(workbook.getWorksheet('Ideas').getCell('B2').value, 'Pricing guide');
  const backup = await context.json('/api/backup');
  assert.equal(backup.response.status, 200);
  assert.equal(backup.value.items.length, 1);
  assert.equal(backup.value.assets.length, 1);
  await context.close();
  context = await openApp(t, directory, { dataDir: join(directory, 'restored') });
  const restored = await context.json('/api/backup', 'POST', backup.value);
  assert.equal(restored.response.status, 200);
  assert.equal(restored.value.restored, 1);
  assert.equal((await context.json(`/api/jobs/${id}`)).value.job.notes, 'A saved note.');
  const restoredImage = await fetch(context.app.origin + `/api/jobs/${id}/frame`, { headers: { Cookie: context.cookie } });
  assert.deepEqual(new Uint8Array(await restoredImage.arrayBuffer()), jpeg);
  const duplicate = await context.json('/api/backup', 'POST', backup.value);
  assert.equal(duplicate.value.restored, 0);
  assert.equal(duplicate.value.skipped, 1);
});

test('ordered carousel text and slide images remain editable and readable through local routes', async t => {
  const directory = await temporary(t);
  const context = await openApp(t, directory);
  const created = await context.json('/api/jobs', 'POST', { url: 'https://www.instagram.com/p/CarouselFixture/' });
  assert.equal(created.response.status, 201);
  const id = created.value.job.id;
  const claim = await context.worker('/api/worker/claim');
  const token = claim.value.job.leaseToken;
  const key = context.app.engine.options.engineKey;
  const jpeg = Uint8Array.from([255,216,255,192,0,11,8,0,180,1,64,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
  for (const index of [1, 2]) {
    const uploaded = await fetch(context.app.origin + `/api/worker/jobs/${id}/slides/${index}`, {
      method: 'PUT', headers: { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': key,
        Authorization: 'Bearer ' + key, 'X-Cliptext-Lease-Token': token, 'Content-Type': 'image/jpeg' }, body: jpeg });
    assert.equal(uploaded.status, 200, await uploaded.text());
  }
  const completed = await context.worker(`/api/worker/jobs/${id}`, 'PATCH', { leaseToken: token,
    status: 'completed', contentKind: 'carousel', ocrEngine: 'Apple Vision',
    pages: [{ index: 1, text: 'First slide heading', allText: 'First slide heading and screenshot detail.' },
      { index: 2, text: 'Second slide explanation', allText: 'Second slide explanation with small text.' }] });
  assert.equal(completed.response.status, 200);
  const detail = await context.json(`/api/jobs/${id}`);
  assert.equal(detail.value.job.contentKind, 'carousel');
  assert.deepEqual(detail.value.job.pages.map(page => page.index), [1, 2]);
  assert.equal(detail.value.job.pages[0].imageUrl, `/api/jobs/${id}/slides/1`);
  const edit = await context.json(`/api/jobs/${id}`, 'PATCH', { pages: [{ index: 1, text: 'Edited slide heading' },
    { index: 2, text: 'Second slide explanation' }] });
  assert.equal(edit.response.status, 200);
  assert.match(edit.value.job.transcript, /Edited slide heading/);
  assert.match(edit.value.job.originalPages[0].allText, /screenshot detail/);
  assert.equal((await context.json('/api/jobs?q=Edited')).value.total, 1);
  const image = await fetch(context.app.origin + `/api/jobs/${id}/slides/2`, { headers: { Cookie: context.cookie } });
  assert.equal(image.status, 200);
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), jpeg);
});

test('a second process cannot open or migrate an active local library', async t => {
  const directory = await temporary(t);
  const context = await openApp(t, directory);
  const upgrade = join(directory, 'upgrade-migrations');
  await cp(migrationsDir, upgrade, { recursive: true });
  await writeFile(join(upgrade, '0013_active_library_test.sql'), 'CREATE TABLE active_library_must_not_be_migrated(id TEXT);');
  const result = await child([serverMain, '--data-dir', context.app.runtime.dataDir,
    '--client-dir', clientDir, '--migrations-dir', upgrade, '--engine-bundle', join(directory, 'missing'),
    '--models-dir', join(directory, 'missing'), '--port', '0', '--no-engine']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /already|another|locked|open/i);
  assert.equal(await context.app.runtime.DB.prepare("SELECT name FROM sqlite_master WHERE name='active_library_must_not_be_migrated'").first(), null);
});

test('failed startup releases state so the same process can start a valid local app', async t => {
  const directory = await temporary(t);
  const input = options(directory);
  const script = `import { createLocalApp } from ${JSON.stringify(pathToFileURL(serverMain).href)};
    const options=${JSON.stringify(input)};
    let rejected=false;
    try { await createLocalApp({...options,clientDir:options.clientDir+'/does-not-exist'}); }
    catch { rejected=true; }
    if(!rejected) throw new Error('Invalid startup unexpectedly succeeded');
    const app=await createLocalApp(options);
    await app.close();
    console.log('startup-recovery-ok');`;
  const result = await child(['--input-type=module', '-e', script]);
  assert.equal(result.code, 0, 'Startup failure left local state locked: ' + result.stderr);
  assert.match(result.stdout, /startup-recovery-ok/);
});

test('CLI readiness publication failure exits promptly and releases its listening port', async t => {
  const directory = await temporary(t);
  const dataDir = join(directory, 'data');
  const result = await child([serverMain, '--data-dir', dataDir, '--client-dir', clientDir,
    '--migrations-dir', migrationsDir, '--engine-bundle', join(directory, 'absent-engine'),
    '--models-dir', join(directory, 'absent-models'), '--port', '0', '--no-engine',
    '--ready-file', join(directory, 'missing-parent', 'ready.json')], 5000);
  assert.equal(result.signal, null, 'Readiness failure must exit itself rather than requiring the timeout kill.');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ENOENT|no such file/i);
  const published = JSON.parse(await readFile(join(dataDir, 'launch.json'), 'utf8'));
  const port = Number(new URL(published.origin).port);
  assert.ok(port > 0);
  const listener = tcpServer();
  await new Promise((accept, reject) => { listener.once('error', reject); listener.listen(port, '127.0.0.1', accept); });
  await new Promise((accept, reject) => listener.close(error => error ? reject(error) : accept()));
});

test('paired phone delivery and offline-library changes survive a real Mac server restart', async t => {
  const directory = await temporary(t);
  let context = await openApp(t, directory, { phonePort: 0 });
  assert.equal((await fetch(context.app.origin + '/api/local/phone')).status, 401);
  const enabled = await context.json('/api/local/phone', 'POST', { action: 'enable' });
  assert.equal(enabled.response.status, 200);
  assert.equal(enabled.value.error, undefined);
  assert.equal(enabled.value.enabled, true);
  const originalPin = enabled.value.fingerprint;
  const identity = JSON.parse(await readFile(join(directory, 'data', 'phone-sync', 'identity.json'), 'utf8'));
  const paired = await context.json('/api/local/phone', 'POST', { action: 'pair' });
  assert.equal(paired.response.status, 200);
  const capability = JSON.parse(Buffer.from(paired.value.code, 'base64url').toString());
  assert.equal(capability.fingerprint, originalPin);
  let port = enabled.value.port;
  const phone = (path, payload, token = capability.token) => new Promise((accept, reject) => {
    const request = httpsRequest({ hostname: '127.0.0.1', port, path,
      method: payload === undefined ? 'GET' : 'POST', ca: identity.cert,
      checkServerIdentity: (_hostname, certificate) => certificate.fingerprint256.replaceAll(':', '').toLowerCase() === originalPin ? undefined : new Error('Wrong Mac certificate'),
      headers: { Authorization: 'Bearer ' + token, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => accept({ status: response.statusCode, value: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    request.on('error', reject);
    request.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  assert.equal((await phone('/api/phone/sync')).status, 401, 'A pending pairing code cannot read the library.');
  const bootstrapToken = capability.token;
  const connected = await phone('/api/phone/pair', { name: 'Test phone' });
  assert.equal(connected.status, 200);
  assert.match(connected.value.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(connected.value.token, bootstrapToken);
  capability.token = connected.value.token;
  assert.equal((await phone('/api/phone/sync', undefined, bootstrapToken)).status, 401, 'The QR bootstrap cannot read transcripts after pairing.');
  assert.equal((await phone('/api/worker/claim', {})).status, 404);
  assert.equal((await phone('/api/local/phone')).status, 404);
  const requestId = randomUUID();
  const submission = { requestId, url: 'https://youtu.be/klmnopqrstU' };
  const delivered = await phone('/api/phone/links', submission);
  assert.equal(delivered.status, 200);
  const id = delivered.value.jobId;
  assert.equal((await phone('/api/phone/links', submission)).value.jobId, id, 'An acknowledgement retry must not duplicate a link.');
  const claim = await context.worker('/api/worker/claim');
  assert.equal(claim.value.job.id, id);
  assert.equal((await context.worker('/api/worker/jobs/' + id, 'PATCH', {
    leaseToken: claim.value.job.leaseToken, status: 'completed', contentKind: 'video',
    title: 'Offline reading', transcript: 'This transcript stays on the phone after synchronization.',
    segments: [{ start: 0, end: 5, text: 'This transcript stays on the phone after synchronization.' }],
  })).response.status, 200);
  const synced = await phone('/api/phone/sync?cursor=0&limit=50');
  assert.equal(synced.status, 200);
  assert.ok(synced.value.changes.some(change => change.id === id && change.job?.transcript.includes('stays on the phone')));
  const cursor = synced.value.cursor;
  await context.close();
  await assert.rejects(phone('/api/phone/sync?cursor=' + cursor), /ECONNREFUSED|socket hang up|ECONNRESET/);
  context = await openApp(t, directory, { phonePort: 0 });
  const resumed = await context.json('/api/local/phone');
  assert.equal(resumed.value.enabled, true);
  assert.equal(resumed.value.fingerprint, originalPin);
  port = resumed.value.port;
  assert.equal((await phone('/api/phone/links', submission)).value.jobId, id);
  assert.equal((await context.json('/api/jobs')).value.total, 1);
  assert.equal((await context.json('/api/jobs/' + id, 'PATCH', { notes: 'Readable offline too.' })).response.status, 200);
  let changes = await phone('/api/phone/sync?cursor=' + cursor);
  assert.ok(changes.value.changes.some(change => change.job?.notes === 'Readable offline too.'));
  assert.equal((await context.json('/api/jobs/' + id, 'DELETE')).response.status, 200);
  changes = await phone('/api/phone/sync?cursor=' + changes.value.cursor);
  assert.ok(changes.value.changes.some(change => change.id === id && change.deleted));
  await context.json('/api/local/phone', 'POST', { action: 'revoke', deviceId: capability.deviceId });
  assert.equal((await phone('/api/phone/sync')).status, 401);
  await context.json('/api/local/phone', 'POST', { action: 'disable' });
  await assert.rejects(phone('/api/phone/sync'), /ECONNREFUSED|socket hang up|ECONNRESET/);
});
