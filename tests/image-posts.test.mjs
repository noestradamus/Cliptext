import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Run the actual route SQL and serialization against all generated migrations.
const fixtureKey = Symbol.for('cliptext.image-posts.test');
const fixture = { env: { CLIPTEXT_ENGINE_SECRET: 'synthetic-test-engine-key' }, signedIn: true, queries: [] };
globalThis[fixtureKey] = fixture;
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
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

const fixtureLookup = "globalThis[Symbol.for('cliptext.image-posts.test')]";
const server = await sourceModule('lib/server.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  '../app/chatgpt-auth': moduleUrl(`export async function getChatGPTUser() { return ${fixtureLookup}.signedIn ? {id: 'synthetic-user'} : null; }`),
});
const library = await sourceModule('lib/library-query.ts');
const submit = await sourceModule('lib/submit.ts', {
  './server': server,
  './video': await sourceModule('lib/video.ts', { './tiktok.ts': await sourceModule('lib/tiktok.ts') }),
});
const frame = await sourceModule('lib/frame.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  './server': server,
});
const jobs = await import(await sourceModule('app/api/jobs/route.ts', {
  '../../../lib/server': server, '../../../lib/submit': submit, '../../../lib/library-query': library,
}));
const jobDetail = await import(await sourceModule('app/api/jobs/[id]/route.ts', {
  '../../../../lib/server': server, '../../../../lib/library-query': library, '../../../../lib/frame': frame,
}));
const workerJobs = await import(await sourceModule('app/api/worker/jobs/[id]/route.ts', { '../../../../../lib/server': server }));
const workerClaim = await import(await sourceModule('app/api/worker/claim/route.ts', { '../../../../lib/server': server }));
const migrationsDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationsDirectory), 'utf8')));
let sqlite;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true;
  fixture.queries = [];
  fixture.env.DB = {
    prepare(sql) {
      fixture.queries.push(sql);
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
    id, owner_id: 'owner', url: 'https://www.instagram.com/p/' + id + '/',
    status: 'transcribing', progress: 25, title: 'Synthetic post',
    transcript: 'Old audio transcript', segments: '[{"start":0,"end":1,"text":"Old audio transcript"}]',
    duration_seconds: 123, created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z',
    lease_token: 'synthetic-lease-' + id, lease_expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
  sqlite.prepare(`INSERT INTO jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return row;
}
const context = id => ({ params: Promise.resolve({ id }) });
const detail = id => jobDetail.GET(new Request('https://cliptext.example/api/jobs/' + id), context(id));
const stored = id => ({ ...sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(id) });
function complete(id, extra = {}, headers = {}) {
  return workerJobs.PATCH(new Request('https://cliptext.example/api/worker/jobs/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': fixture.env.CLIPTEXT_ENGINE_SECRET, ...headers },
    body: JSON.stringify({ status: 'completed', leaseToken: 'synthetic-lease-' + id, contentKind: 'image', pages: [{ index: 1, text: 'Synthetic OCR' }], ocrEngine: 'SyntheticOCR', ...extra }),
  }), context(id));
}

test('generated migration gives existing audio jobs video metadata without changing their transcript', async () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    for (const migration of migrations.slice(0, 4)) legacy.exec(migration);
    legacy.prepare('INSERT INTO jobs(id,owner_id,url,transcript,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('legacy', 'owner', 'https://example.invalid/', 'Saved speech', '2026-10-25', '2026-10-25');
    for (const migration of migrations.slice(4)) legacy.exec(migration);
    assert.deepEqual({ ...legacy.prepare('SELECT content_kind,pages,ocr_engine,transcript FROM jobs').get() }, { content_kind: 'video', pages: null, ocr_engine: null, transcript: 'Saved speech' });
  } finally { legacy.close(); }
  seedJob('video');
  const { job } = await (await detail('video')).json();
  assert.equal(job.contentKind, 'video');
  assert.equal(job.pageCount, 0);
  assert.equal(job.pages, null);
  assert.equal(job.ocrEngine, null);
});

test('image completion derives the transcript from OCR and clears stale audio timing', async () => {
  seedJob('image');
  const text = '  日本語の文字\nSecond line\n';
  assert.equal((await complete('image', { pages: [{ index: 1, text }], transcript: 'Untrusted duplicate transcript', durationSeconds: 900, segments: [{ start: 0, end: 900, text: 'wrong' }] })).status, 200);
  const row = stored('image');
  assert.equal(row.transcript, text);
  assert.equal(row.duration_seconds, null);
  assert.equal(row.segments, null);
  assert.equal(row.status, 'completed');
  assert.equal(row.progress, 100);
  assert.equal(row.lease_expires_at, null);
  const { job } = await (await detail('image')).json();
  assert.deepEqual(job.pages.map(({imageUrl,...page})=>page), [{ index: 1, text }]);
  assert.equal(job.contentKind, 'image');
  assert.equal(job.pageCount, 1);
  assert.equal(job.ocrEngine, 'SyntheticOCR');
  assert.deepEqual(job.segments, []);
  assert.equal(job.durationSeconds, null);
});

test('valid transcribing metadata identifies image processing before pages are ready', async () => {
  seedJob('reading-images', { status: 'downloading' });
  assert.equal((await complete('reading-images', { status: 'transcribing', contentKind: 'carousel', pages: undefined, ocrEngine: undefined, progress: 45 })).status, 200);
  const { job } = await (await detail('reading-images')).json();
  assert.equal(job.status, 'transcribing');
  assert.equal(job.contentKind, 'carousel');
  assert.equal(job.pageCount, 0);
  assert.equal(job.pages, null);
  assert.equal((await complete('reading-images', { status: 'transcribing', contentKind: ['image'] })).status, 400);
  assert.equal(stored('reading-images').content_kind, 'carousel');
});

test('carousel completion preserves slide order and empty pages in authoritative text', async () => {
  seedJob('carousel');
  const pages = [{ index: 1, text: 'First page' }, { index: 2, text: '' }, { index: 3, text: '最後のページ' }];
  assert.equal((await complete('carousel', { contentKind: 'carousel', pages })).status, 200);
  assert.equal(stored('carousel').transcript, 'Slide 1\nFirst page\n\nSlide 2\n\n\nSlide 3\n最後のページ');
  const { job } = await (await detail('carousel')).json();
  assert.deepEqual(job.pages.map(({imageUrl,...page})=>page), pages);
  assert.equal(job.pageCount, 3);
  assert.equal(job.contentKind, 'carousel');
});

test('full OCR text is preserved for detail review while the transcript and library search use main text', async () => {
  seedJob('selected-text');
  const pages = [{ index: 1, text: 'Main headline', allText: 'Main headline\nbackgroundonlyword' }, { index: 2, text: '', allText: 'Another background screenshot' }];
  assert.equal((await complete('selected-text', { contentKind: 'carousel', pages })).status, 200);
  assert.equal(stored('selected-text').transcript, 'Slide 1\nMain headline\n\nSlide 2\n');
  const { job } = await (await detail('selected-text')).json();
  assert.deepEqual(job.pages.map(({imageUrl,...page})=>page), pages);
  const response = await jobs.GET(new Request('https://cliptext.example/api/jobs?q=backgroundonlyword'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).total, 0);
});

test('images and carousels with no recognized text still complete', async () => {
  seedJob('empty-image');
  assert.equal((await complete('empty-image', { pages: [{ index: 1, text: '' }] })).status, 200);
  assert.equal(stored('empty-image').transcript, '');
  seedJob('empty-carousel');
  assert.equal((await complete('empty-carousel', { contentKind: 'carousel', pages: [{ index: 1, text: '' }, { index: 2, text: '' }] })).status, 200);
  assert.equal(stored('empty-carousel').transcript, 'Slide 1\n\n\nSlide 2\n');
});

test('malformed image results are rejected atomically without truncating or repairing pages', async () => {
  seedJob('invalid');
  const before = stored('invalid');
  const cases = [
    { contentKind: 'unknown' }, { contentKind: ['image'] }, { contentKind: null },
    { pages: null }, { pages: [] }, { pages: {} }, { pages: [null] }, { pages: [[]] },
    { pages: [{ index: 0, text: '' }] }, { pages: [{ index: '1', text: '' }] },
    { pages: [{ index: 1 }] }, { pages: [{ index: 1, text: null }] }, { pages: [{ index: 1, text: 3 }] },
    { pages: [{ index: 1, text: '', allText: null }] }, { pages: [{ index: 1, text: '', allText: 3 }] },
    { pages: [{ index: 1, text: '' }, { index: 2, text: '' }] },
    { contentKind: 'carousel', pages: [{ index: 1, text: '' }] },
    { contentKind: 'carousel', pages: [{ index: 1, text: '' }, { index: 1, text: '' }] },
    { contentKind: 'carousel', pages: [{ index: 2, text: '' }, { index: 1, text: '' }] },
    { contentKind: 'carousel', pages: Array.from({ length: 36 }, (_, index) => ({ index: index + 1, text: '' })) },
    { ocrEngine: null }, { ocrEngine: '' }, { ocrEngine: ' ' }, { ocrEngine: 4 }, { ocrEngine: 'x'.repeat(101) },
  ];
  for (const payload of cases) {
    assert.equal((await complete('invalid', payload)).status, 400, JSON.stringify(payload));
    assert.deepEqual(stored('invalid'), before);
  }
});

test('full OCR backup has its own aggregate size limit and retains the exact accepted boundary', async () => {
  seedJob('all-text');
  assert.equal((await complete('all-text', { contentKind: 'carousel', pages: [{ index: 1, text: 'Heading', allText: 'x'.repeat(125_000) }, { index: 2, text: '', allText: 'y'.repeat(125_001) }] })).status, 413);
  assert.equal(stored('all-text').status, 'transcribing');
  const pages = [{ index: 1, text: 'x'.repeat(250_000), allText: 'y'.repeat(250_000) }];
  assert.equal((await complete('all-text', { pages })).status, 200);
  assert.deepEqual(JSON.parse(stored('all-text').pages), pages);
  assert.equal(stored('all-text').transcript, pages[0].text);
});

test('combined OCR text is bounded and exact boundary results preserve all text', async () => {
  seedJob('oversized');
  for (const payload of [
    { pages: [{ index: 1, text: 'x'.repeat(250_001) }] },
    { contentKind: 'carousel', pages: [{ index: 1, text: 'x'.repeat(125_000) }, { index: 2, text: 'y'.repeat(125_001) }] },
  ]) {
    assert.equal((await complete('oversized', payload)).status, 413);
    assert.equal(stored('oversized').status, 'transcribing');
  }
  const pages = Array.from({ length: 35 }, (_, index) => ({ index: index + 1, text: index ? '' : 'x'.repeat(250_000) }));
  assert.equal((await complete('oversized', { contentKind: 'carousel', pages })).status, 200);
  assert.deepEqual(JSON.parse(stored('oversized').pages), pages);
  assert.equal(stored('oversized').transcript, pages.map(page => `Slide ${page.index}\n${page.text}`).join('\n\n'));
});

test('video completion remains compatible with old workers and requires nonempty bounded speech', async () => {
  seedJob('video');
  const payload = { contentKind: undefined, pages: undefined, ocrEngine: undefined };
  for (const transcript of ['', ' \n ', null, 3]) assert.equal((await complete('video', { ...payload, transcript })).status, 400);
  assert.equal((await complete('video', { ...payload, transcript: 'x'.repeat(250_001) })).status, 413);
  assert.equal((await complete('video', { ...payload, transcript: 'Speech result' })).status, 200);
  assert.equal(stored('video').content_kind, 'video');
  assert.equal(stored('video').transcript, 'Speech result');
  assert.equal(stored('video').duration_seconds, 123);
  assert.equal(stored('video').pages, null);
  seedJob('mixed');
  assert.equal((await complete('mixed', { contentKind: 'video', transcript: 'Speech result' })).status, 400);
});

test('library lists compact image metadata without loading pages or returning transcript bodies', async () => {
  seedJob('carousel');
  const pages = [{ index: 1, text: 'x'.repeat(1000) }, { index: 2, text: '' }];
  assert.equal((await complete('carousel', { contentKind: 'carousel', pages })).status, 200);
  seedJob('foreign', { owner_id: 'someone-else' });
  fixture.queries = [];
  const response = await jobs.GET(new Request('https://cliptext.example/api/jobs'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 1);
  assert.equal(body.jobs.length, 1);
  const summary = body.jobs[0];
  assert.equal(summary.contentKind, 'carousel');
  assert.equal(summary.pageCount, 2);
  assert.equal(summary.ocrEngine, 'SyntheticOCR');
  for (const field of ['pages', 'segments', 'transcript']) assert.equal(field in summary, false, field);
  assert.ok(summary.preview.length <= 220);
  const listQuery = fixture.queries.find(sql => sql.includes('LEFT JOIN job_frames'));
  assert.match(listQuery, /json_array_length\(j\.pages\) AS page_count/);
  assert.doesNotMatch(listQuery.replace('json_array_length(j.pages)', ''), /\bj\.pages\b/);
  assert.doesNotMatch(listQuery, /SELECT\s+(?:j\.)?\*/);
});

test('detail and list require sign-in and foreign image details remain private', async () => {
  seedJob('foreign', { owner_id: 'someone-else', content_kind: 'image', pages: '[{"index":1,"text":"private"}]' });
  assert.equal((await detail('foreign')).status, 404);
  fixture.signedIn = false;
  assert.equal((await detail('foreign')).status, 401);
  assert.equal((await jobs.GET(new Request('https://cliptext.example/api/jobs'))).status, 401);
});

test('image updates respect the engine boundary, owner and active lease', async () => {
  seedJob('image');
  const before = stored('image');
  assert.equal((await complete('image', {}, { 'X-Cliptext-Engine-Key': 'wrong-key' })).status, 403);
  assert.equal((await complete('image', {}, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await complete('image', { leaseToken: undefined })).status, 403);
  assert.equal((await complete('image', { leaseToken: 'old-lease' })).status, 409);
  assert.deepEqual(stored('image'), before);
  seedJob('foreign', { owner_id: 'someone-else' });
  assert.equal((await complete('foreign')).status, 409);
  assert.equal(stored('foreign').status, 'transcribing');
  seedJob('foreign-completed', { owner_id: 'someone-else', status: 'completed' });
  assert.equal((await complete('foreign-completed')).status, 409);
});

test('worker claims skip foreign queued and expired jobs', async () => {
  seedJob('foreign-queued', { owner_id: 'someone-else', status: 'queued', created_at: '2000-01-01' });
  seedJob('foreign-expired', { owner_id: 'someone-else', lease_expires_at: '2000-01-01', created_at: '2000-01-01' });
  seedJob('own-queued', { status: 'queued' });
  const claim = () => workerClaim.POST(new Request('https://cliptext.example/api/worker/claim', {
    method: 'POST', headers: { 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': fixture.env.CLIPTEXT_ENGINE_SECRET },
  }));
  const first = await claim();
  assert.equal(first.status, 200);
  assert.equal((await first.json()).job.id, 'own-queued');
  assert.deepEqual(await (await claim()).json(), { job: null });
  assert.equal(stored('foreign-queued').status, 'queued');
  assert.equal(stored('foreign-expired').lease_token, 'synthetic-lease-foreign-expired');
});

test('replayed image completion is idempotent and late completion cannot recreate a deleted job', async () => {
  seedJob('image');
  assert.equal((await complete('image')).status, 200);
  const first = stored('image');
  assert.equal((await complete('image', { pages: [{ index: 1, text: 'Changed retry payload' }] })).status, 200);
  assert.deepEqual(stored('image'), first);
  assert.equal((await complete('image', { leaseToken: 'different' })).status, 409);
  const removed = await jobDetail.DELETE(new Request('https://cliptext.example/api/jobs/image', { method: 'DELETE' }), context('image'));
  assert.equal(removed.status, 200);
  assert.equal((await complete('image')).status, 409);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM jobs WHERE trashed_at IS NULL').get().total, 0);
});

test('metadata edits preserve image result metadata in their response', async () => {
  seedJob('image');
  assert.equal((await complete('image')).status, 200);
  const response = await jobDetail.PATCH(new Request('https://cliptext.example/api/jobs/image', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }),
  }), context('image'));
  assert.equal(response.status, 200);
  const { job } = await response.json();
  assert.equal(job.favorite, true);
  assert.equal(job.contentKind, 'image');
  assert.equal(job.pageCount, 1);
  assert.deepEqual(job.pages.map(({imageUrl,...page})=>page), [{ index: 1, text: 'Synthetic OCR' }]);
});

test('TikTok photo submissions normalize links and start with compatible video metadata', async () => {
  const response = await jobs.POST(new Request('https://cliptext.example/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'Photo post https://www.tiktok.com/@creator/photo/7000000000000000001?photo_id=123' }),
  }));
  assert.equal(response.status, 201);
  const { job } = await response.json();
  assert.equal(job.url, 'https://www.tiktok.com/@creator/photo/7000000000000000001');
  assert.equal(job.platform, 'tiktok');
  assert.equal(job.status, 'queued');
  assert.equal(job.contentKind, 'video');
  assert.equal(job.pages, null);
  assert.equal(job.pageCount, 0);
});
