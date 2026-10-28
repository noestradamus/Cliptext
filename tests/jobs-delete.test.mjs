import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Execute the actual route and server code against disposable SQLite. Only the
// Cloudflare binding and sign-in provider are replaced; no network is involved.
const fixtureKey = Symbol.for('cliptext.jobs-delete.test');
const fixture = { env: { CLIPTEXT_ENGINE_SECRET: 'synthetic-test-engine-key' }, signedIn: true };
globalThis[fixtureKey] = fixture;
const moduleUrl = (source) => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const loadedModules = new Map();
async function sourceModule(path, dependencies = {}) {
  if (loadedModules.has(path)) return loadedModules.get(path);
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  let output = outputText;
  for (const match of outputText.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    let mapped = dependencies[specifier];
    if (!mapped && specifier.startsWith('.')) {
      const base = new URL('../', import.meta.url);
      const target = new URL(specifier.endsWith('.ts') ? specifier : specifier + '.ts', new URL(path, base));
      mapped = await sourceModule(target.pathname.slice(base.pathname.length));
    }
    assert.ok(mapped, 'Unmapped test dependency: ' + specifier);
    output = output.replace(match[0], 'from ' + JSON.stringify(mapped));
  }
  const result = moduleUrl(output); loadedModules.set(path, result); return result;
}

const fixtureLookup = "globalThis[Symbol.for('cliptext.jobs-delete.test')]";
const server = await sourceModule('lib/server.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  '../app/chatgpt-auth': moduleUrl(`export async function getChatGPTUser() { return ${fixtureLookup}.signedIn ? {id: 'synthetic-user'} : null; }`),
});
const frame = await sourceModule('lib/frame.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  './server': server,
});
const jobs = await import(await sourceModule('app/api/jobs/[id]/route.ts', {
  '../../../../lib/server': server,
  '../../../../lib/library-query': await sourceModule('lib/library-query.ts'),
  '../../../../lib/frame': frame,
}));
const workerJobs = await import(await sourceModule('app/api/worker/jobs/[id]/route.ts', { '../../../../../lib/server': server }));
const workerClaim = await import(await sourceModule('app/api/worker/claim/route.ts', { '../../../../lib/server': server }));
const workerHeartbeat = await import(await sourceModule('app/api/worker/heartbeat/route.ts', { '../../../../lib/server': server }));
const { submitJob } = await import(await sourceModule('lib/submit.ts', {
  './server': server,
  './video': await sourceModule('lib/video.ts', { './tiktok.ts': await sourceModule('lib/tiktok.ts') }),
}));
const migrationsDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationsDirectory), 'utf8')));
let sqlite;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true;
  fixture.env.DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { const row = statement.get(...values); return row ? { ...row } : null; },
            async run() { return { success: true, meta: statement.run(...values) }; },
            async all() { return { success: true, results: statement.all(...values).map(row => ({ ...row })) }; },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
});
afterEach(() => sqlite.close());
after(() => { delete globalThis[fixtureKey]; });

function seedJob(id, overrides = {}) {
  const row = {
    id, owner_id: 'owner', url: 'https://www.youtube.com/watch?v=' + id,
    status: 'completed', progress: 100, title: 'Synthetic video', creator: 'Synthetic creator',
    transcript: 'Synthetic transcript', segments: '[{"start":0,"end":1,"text":"Synthetic transcript"}]',
    language: 'en', duration_seconds: 1, favorite: 1, tags: '["synthetic"]',
    created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z',
    lease_token: 'synthetic-lease-' + id, lease_expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
  sqlite.prepare(`INSERT INTO jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return row;
}
const context = (id) => ({ params: Promise.resolve({ id }) });
async function deleteJob(id, headers = {}) {
  const trashed = await jobs.DELETE(new Request('https://cliptext.example/api/jobs/' + encodeURIComponent(id), { method: 'DELETE', headers }), context(id));
  if (trashed.status !== 200) return trashed;
  return jobs.DELETE(new Request('https://cliptext.example/api/jobs/' + encodeURIComponent(id) + '?permanent=1', {method:'DELETE',headers}), context(id));
}
function engineRequest(path, method, payload) {
  return new Request('https://cliptext.example/api/worker/' + path, {
    method,
    headers: { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': fixture.env.CLIPTEXT_ENGINE_SECRET, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
const countJobs = () => sqlite.prepare('SELECT COUNT(*) AS count FROM jobs').get().count;

test('deleting a saved video removes its transcript, tags and metadata while retaining other items and its collection', async () => {
  sqlite.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').run('collection', 'owner', 'Synthetic collection', '2026-10-26');
  seedJob('delete-me', { collection_id: 'collection' });
  seedJob('keep-me', { collection_id: 'collection' });
  const response = await deleteJob('delete-me', { Origin: 'https://cliptext.example' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true, permanent: true });
  assert.equal(sqlite.prepare('SELECT * FROM jobs WHERE id=?').get('delete-me'), undefined);
  assert.equal((await jobs.GET(new Request('https://cliptext.example'), context('delete-me'))).status, 404);
  assert.equal(sqlite.prepare('SELECT transcript FROM jobs WHERE id=?').get('keep-me').transcript, 'Synthetic transcript');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM collections').get().count, 1);
});

test('queued, downloading, transcribing and failed videos can be removed', async () => {
  for (const status of ['queued', 'downloading', 'transcribing', 'failed']) {
    seedJob(status, { status });
    assert.equal((await deleteJob(status)).status, 200, status);
    assert.equal(countJobs(), 0, status);
  }
});

test('missing, already deleted and foreign-owned IDs return the same 404 without deleting foreign items', async () => {
  seedJob('foreign', { owner_id: 'another-owner' });
  seedJob('own');
  assert.equal((await deleteJob('own')).status, 200);
  for (const id of ['missing', 'own', 'foreign']) {
    const response = await deleteJob(id);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Transcript not found.' });
  }
  assert.equal(countJobs(), 1);
  assert.equal(sqlite.prepare('SELECT owner_id FROM jobs').get().owner_id, 'another-owner');
});

test('cross-origin deletion is rejected before changing the library', async () => {
  seedJob('keep-me');
  for (const headers of [{ Origin: 'https://unrelated.example' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    assert.equal((await deleteJob('keep-me', headers)).status, 403);
    assert.equal(countJobs(), 1);
  }
});

test('deleting requires a signed-in owner', async () => {
  seedJob('keep-me');
  fixture.signedIn = false;
  assert.equal((await deleteJob('keep-me')).status, 401);
  assert.equal(countJobs(), 1);
});

test('job IDs are bound values rather than executable SQL', async () => {
  seedJob('keep-me');
  assert.equal((await deleteJob("' OR 1=1 --")).status, 404);
  assert.equal(countJobs(), 1);
});

test('a deleted queued video cannot be claimed by the worker', async () => {
  seedJob('deleted-queue', { status: 'queued' });
  assert.equal((await deleteJob('deleted-queue')).status, 200);
  const empty = await workerClaim.POST(engineRequest('claim', 'POST', {}));
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { job: null });
  seedJob('next-queue', { status: 'queued' });
  const next = await workerClaim.POST(engineRequest('claim', 'POST', {}));
  assert.equal((await next.json()).job.id, 'next-queue');
});

test('late progress, results and heartbeat callbacks cannot recreate a deleted in-flight video', async () => {
  for (const initialStatus of ['downloading', 'transcribing']) {
    const row = seedJob(initialStatus, { status: initialStatus });
    assert.equal((await deleteJob(row.id)).status, 200);
    for (const status of ['downloading', 'transcribing', 'completed', 'failed']) {
      const result = await workerJobs.PATCH(engineRequest('jobs/' + row.id, 'PATCH', {
        status, leaseToken: row.lease_token, transcript: 'Late synthetic result', progress: 100,
      }), context(row.id));
      assert.equal(result.status, 409, `${initialStatus} -> ${status}`);
      assert.equal(countJobs(), 0);
    }
    const heartbeat = await workerHeartbeat.POST(engineRequest('heartbeat', 'POST', {
      status: 'busy', engine: 'synthetic-model', activeJobId: row.id, activeLeaseToken: row.lease_token,
    }));
    assert.equal(heartbeat.status, 200);
    assert.equal(countJobs(), 0);
  }
});

test('a retried completion cannot resurrect a deleted result or alter a newly saved copy of its URL', async () => {
  const original = seedJob('original', { status: 'transcribing', url: 'https://www.youtube.com/watch?v=synthetic01' });
  const payload = { status: 'completed', leaseToken: original.lease_token, transcript: 'Original synthetic result' };
  const complete = () => workerJobs.PATCH(engineRequest('jobs/original', 'PATCH', payload), context('original'));
  assert.equal((await complete()).status, 200);
  assert.equal((await complete()).status, 200);
  assert.equal((await deleteJob('original')).status, 200);
  const newCopy = await submitJob(original.url);
  assert.notEqual(newCopy.id, original.id);
  assert.equal(newCopy.status, 'queued');
  assert.equal((await complete()).status, 409);
  assert.equal(countJobs(), 1);
  const replacement = sqlite.prepare('SELECT id,status,transcript FROM jobs').get();
  assert.deepEqual({ ...replacement }, { id: newCopy.id, status: 'queued', transcript: null });
});
