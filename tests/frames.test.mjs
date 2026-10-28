import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtureKey = Symbol.for('cliptext.frames.test');
const fixture = { signedIn: true, env: { CLIPTEXT_ENGINE_SECRET: 'synthetic-engine-key' }, afterPut: null };
globalThis[fixtureKey] = fixture;
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const lookup = "globalThis[Symbol.for('cliptext.frames.test')]";
const modules = new Map();
async function moduleFor(path) {
  if (modules.has(path)) return modules.get(path);
  const source = await readFile(path, 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const dependencies = new Map();
  for (const match of compiled.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    let target;
    if (specifier === 'cloudflare:workers') target = moduleUrl(`export const env=${lookup}.env;`);
    else if (specifier.endsWith('/chatgpt-auth')) target = moduleUrl(`export async function getChatGPTUser(){return ${lookup}.signedIn?{id:'synthetic-user'}:null;}`);
    else {
      assert.ok(specifier.startsWith('.'), 'Unexpected test import: ' + specifier);
      const file = resolve(dirname(path), specifier);
      target = await moduleFor(/\.[mc]?tsx?$/.test(file) ? file : file + '.ts');
    }
    dependencies.set(specifier, target);
  }
  const result = moduleUrl(compiled.replace(/from\s+(['"])([^'"]+)\1/g, (_match, _quote, specifier) => 'from ' + JSON.stringify(dependencies.get(specifier))));
  modules.set(path, result);
  return result;
}
const load = async path => import(await moduleFor(resolve(root, path)));
const claims = await load('app/api/worker/frames/claim/route.ts');
const uploads = await load('app/api/worker/frames/[id]/route.ts');
const images = await load('app/api/jobs/[id]/frame/route.ts');
const jobs = await load('app/api/jobs/[id]/route.ts');
const { FRAME_MAX_BYTES, jpegDimensions } = await load('lib/frame.ts');
const migrations = await Promise.all((await readdir(resolve(root, 'drizzle'))).filter(name => name.endsWith('.sql')).sort().map(name => readFile(resolve(root, 'drizzle', name), 'utf8')));
let sqlite;
let objects;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true;
  fixture.afterPut = null;
  objects = new Map();
  fixture.env.BUCKET = {
    async put(key, bytes, options) { objects.set(key, { bytes: new Uint8Array(bytes), options }); await fixture.afterPut?.(); },
    async get(key) { const object = objects.get(key); return object ? { body: object.bytes, size: object.bytes.length } : null; },
    async head(key) { const object = objects.get(key); return object ? { size: object.bytes.length } : null; },
    async delete(key) { for (const item of Array.isArray(key) ? key : [key]) objects.delete(item); },
  };
  fixture.env.DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const query = values => ({
        async first() { const row = statement.get(...values); return row ? { ...row } : null; },
        async all() { return { results: statement.all(...values).map(row => ({ ...row })), success: true }; },
        async run() { return { meta: statement.run(...values), success: true }; },
      });
      return { ...query([]), bind: (...values) => query(values) };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
});
afterEach(() => sqlite.close());
after(() => { delete globalThis[fixtureKey]; });

const context = id => ({ params: Promise.resolve({ id }) });
function seed(id, status = 'completed', owner = 'owner') {
  sqlite.prepare('INSERT INTO jobs(id,owner_id,url,status,transcript,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, owner, `https://www.youtube.com/watch?v=${id}`, status, 'Keep this transcript.', '2026-10-26T00:00:00Z', '2026-10-26T00:00:00Z');
}
function request(path, method = 'POST', body = {}, headers = {}, engine = true) {
  return new Request('https://cliptext.example' + path, { method, headers: {
    ...(engine ? { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': fixture.env.CLIPTEXT_ENGINE_SECRET } : {}),
    'Content-Type': body instanceof Uint8Array ? 'image/jpeg' : 'application/json', ...headers,
  }, ...(method === 'GET' ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }) });
}
async function claim(id) {
  const response = await claims.POST(request('/api/worker/frames/claim', 'POST', id ? { jobId: id } : {}));
  assert.equal(response.status, 200);
  return (await response.json()).job;
}
// Minimal SOF+SOS fixture exercises the server's JPEG structure validator; actual
// image decoding is covered by the worker's ffmpeg integration checks.
function jpeg(width = 320, height = 180) {
  return Uint8Array.from([255,216,255,192,0,11,8,height>>8,height&255,width>>8,width&255,1,1,17,0,255,218,0,8,1,1,0,0,63,0,1,255,217]);
}
function upload(job, bytes = jpeg(), headers = {}) {
  return uploads.PUT(request(`/api/worker/frames/${job.id}`, 'PUT', bytes, { 'X-Cliptext-Frame-Lease': job.leaseToken, 'X-Cliptext-Preview-Kind': 'thumbnail', ...headers }), context(job.id));
}
const readJob = async id => (await (await jobs.GET(request('/api/jobs/' + id, 'GET'), context(id))).json()).job;

test('claims only completed owned videos and does not duplicate an active preview lease', async () => {
  seed('queued', 'queued'); seed('foreign', 'completed', 'foreign'); seed('completed');
  const job = await claim(); assert.equal(job.id, 'completed'); assert.ok(job.leaseToken);
  assert.equal(await claim(), null);
  assert.equal((await readJob(job.id)).frameStatus, 'processing');
});

test('expired leases can be reclaimed; stale uploads cannot overwrite the new lease', async () => {
  seed('clip'); const first = await claim();
  sqlite.prepare("UPDATE job_frames SET lease_expires_at='2000-01-01' WHERE job_id='clip'").run();
  const second = await claim(); assert.notEqual(first.leaseToken, second.leaseToken);
  assert.equal((await upload(first)).status, 409); assert.equal(objects.size, 0);
  assert.equal((await upload(second)).status, 200);
});

test('JPEG is stored privately with verified dimensions, thumbnail kind and no leaked bucket key', async () => {
  seed('clip'); const job = await claim(); assert.equal((await upload(job)).status, 200);
  const detail = await readJob('clip');
  assert.equal(detail.frameStatus, 'ready'); assert.equal(detail.frameKind, 'thumbnail');
  assert.equal(detail.frameWidth, 320); assert.equal(detail.frameHeight, 180);
  assert.match(detail.frameUrl, /^\/api\/jobs\/clip\/frame/);
  assert.ok(!JSON.stringify(detail).includes('private/frames/'));
  const response = await images.GET(request('/api/jobs/clip/frame', 'GET'), context('clip'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/jpeg');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg());
  assert.equal((await upload(job)).status, 200); assert.equal(objects.size, 1, 'upload retries are idempotent');
});

test('preview read requires sign-in, owner access and an existing image', async () => {
  seed('clip'); const job = await claim(); await upload(job);
  fixture.signedIn = false;
  assert.equal((await images.GET(request('/api/jobs/clip/frame', 'GET'), context('clip'))).status, 401);
  fixture.signedIn = true; sqlite.prepare("UPDATE jobs SET owner_id='foreign' WHERE id='clip'").run();
  assert.equal((await images.GET(request('/api/jobs/clip/frame', 'GET'), context('clip'))).status, 404);
});

test('invalid, oversized or wrong-kind uploads leave the transcript and storage unchanged', async () => {
  seed('clip'); const job = await claim();
  for (const [bytes, headers, expected] of [
    [new Uint8Array([1,2,3]), {}, 400], [jpeg(641, 200), {}, 400],
    [new Uint8Array(FRAME_MAX_BYTES + 1), {}, 413],
    [jpeg(), {'Content-Type':'image/png'}, 415], [jpeg(), {'X-Cliptext-Preview-Kind':'arbitrary'}, 400],
  ]) assert.equal((await upload(job, bytes, headers)).status, expected);
  assert.equal(objects.size, 0); assert.equal((await readJob('clip')).transcript, 'Keep this transcript.');
  assert.throws(() => jpegDimensions(jpeg().slice(0, -2)));
});

test('engine authorization and same-origin checks precede frame writes', async () => {
  seed('clip');
  assert.equal((await claims.POST(request('/api/worker/frames/claim', 'POST', {}, {}, false))).status, 403);
  assert.equal((await claims.POST(request('/api/worker/frames/claim', 'POST', {}, { Origin:'https://foreign.example' }))).status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM job_frames').get().total, 0);
});

test('unavailable previews can be retried without retranscribing or changing saved metadata', async () => {
  seed('clip'); const job = await claim();
  const unavailable = () => uploads.PATCH(request('/api/worker/frames/clip', 'PATCH', {leaseToken:job.leaseToken,status:'unavailable'}), context('clip'));
  assert.equal((await unavailable()).status, 200); assert.equal((await unavailable()).status, 200);
  assert.equal(await claim(), null);
  const retry = await images.POST(request('/api/jobs/clip/frame', 'POST', {}, {}, false), context('clip'));
  assert.equal(retry.status, 200); assert.equal((await retry.json()).job.frameStatus, 'pending');
  assert.ok(await claim()); assert.equal((await readJob('clip')).transcript, 'Keep this transcript.');
  assert.equal(sqlite.prepare("SELECT status FROM jobs WHERE id='clip'").get().status, 'completed');
});

test('retry requires signed-in owner and a completed video', async () => {
  seed('queued', 'queued'); seed('foreign', 'completed', 'foreign');
  const retry = (id, headers = {}) => images.POST(request('/api/jobs/' + id + '/frame', 'POST', {}, headers, false), context(id));
  assert.equal((await retry('queued')).status, 409); assert.equal((await retry('foreign')).status, 404);
  assert.equal((await retry('queued', { Origin:'https://foreign.example' })).status, 403);
  fixture.signedIn = false; assert.equal((await retry('queued')).status, 401);
});

test('Trash retains the preview and permanent deletion removes its private object', async () => {
  seed('clip'); const job = await claim(); await upload(job);
  assert.equal(objects.size, 1);
  assert.equal((await jobs.DELETE(request('/api/jobs/clip', 'DELETE', {}, {}, false), context('clip'))).status, 200);
  assert.equal(objects.size, 1);
  assert.equal((await jobs.DELETE(request('/api/jobs/clip?permanent=1', 'DELETE', {}, {}, false), context('clip'))).status, 200);
  assert.equal(objects.size, 0); assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM job_frames').get().total, 0);
  assert.equal((await upload(job)).status, 409);
});

test('deletion while R2 is uploading cannot resurrect the image or transcript', async () => {
  seed('clip'); const job = await claim();
  fixture.afterPut = async () => { assert.equal((await jobs.DELETE(request('/api/jobs/clip', 'DELETE', {}, {}, false), context('clip'))).status, 200); };
  assert.equal((await upload(job)).status, 409); assert.equal(objects.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM jobs WHERE trashed_at IS NULL').get().total, 0);
});

test('metadata edits preserve the available preview', async () => {
  seed('clip'); await upload(await claim());
  const response = await jobs.PATCH(request('/api/jobs/clip', 'PATCH', {tags:['saved']}, {}, false), context('clip'));
  const detail = (await response.json()).job;
  assert.equal(response.status, 200); assert.equal(detail.frameStatus, 'ready'); assert.deepEqual(detail.tags, ['saved']);
});
