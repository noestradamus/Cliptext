import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({ stdin: { contents: "export {PhoneSyncClient} from './local-app/pwa/sync.ts'; export {checkedSyncPage} from './local-app/pwa/storage.ts';", resolveDir: root }, bundle: true, write: false, platform: 'node', target: 'node22', format: 'esm' });
const { PhoneSyncClient, checkedSyncPage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const libraryId = 'synthetic-library-id-000001';
const job = { id: 'item-1', url: 'https://www.tiktok.com/@test/video/7700726918810848533', title: 'Saved transcript', status: 'completed', transcript: 'Works offline.', tags: [], createdAt: '2026-10-29T01:00:00Z' };
const queued = { requestId: 'ca1c3e91-10a1-4c02-845a-cf493cd45b0c', url: job.url, createdAt: 1 };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const session = () => json({ connected: true, libraryId, deviceId: 'test-browser', csrfToken: 'test-csrf' });
const page = (changes = [], cursor = 0, hasMore = false) => ({ libraryId, changes, cursor, hasMore, collections: [] });
function setup(fetcher, initial = {}) {
  let snapshot = { libraryId, cursor: 1, lastSync: 1, jobs: [structuredClone(job)], collections: [], outbox: [], ...structuredClone(initial) };
  let disconnected = false;
  const events = [], calls = [];
  const storage = {
    snapshot: async () => structuredClone(snapshot),
    isDisconnected: async () => disconnected,
    connect: async id => { disconnected = false; if (id !== snapshot.libraryId) snapshot = { libraryId: id, cursor: 0, jobs: [], collections: [], outbox: [], lastSync: null }; },
    applyPage: async (id, cursor, input) => { assert.equal(id, snapshot.libraryId); const value = checkedSyncPage(input, cursor); for (const change of value.changes) { snapshot.jobs = snapshot.jobs.filter(item => item.id !== change.id); if (!change.deleted) snapshot.jobs.push(change.job); } snapshot.cursor = value.cursor; snapshot.collections = value.collections; snapshot.lastSync = 2; },
    resetHistory: async id => { assert.equal(id, snapshot.libraryId); snapshot.jobs = []; snapshot.cursor = 0; },
    acknowledge: async (_id, id) => { snapshot.outbox = snapshot.outbox.filter(link => link.requestId !== id); },
    markError: async (_id, id, error) => { snapshot.outbox.find(link => link.requestId === id).error = error; },
    forget: async () => { disconnected = true; snapshot = { libraryId: null, cursor: 0, jobs: [], collections: [], outbox: [], lastSync: null }; },
  };
  const client = new PhoneSyncClient(storage, { changed: value => events.push(['changed', value]), state: (...state) => events.push(['state', ...state]) }, async (url, init) => { calls.push({ url, init }); return fetcher(url, init); });
  return { client, events, calls, snapshot: () => structuredClone(snapshot) };
}

test('sync pages cannot skip changes or advance after a malformed item', () => {
  const valid = page([{ seq: 2, id: job.id, deleted: false, job }], 2);
  assert.equal(checkedSyncPage(valid, 1), valid);
  for (const value of [page([], 2), page([], 1, true), page([{ seq: 1, id: job.id, deleted: true }], 1), page([{ seq: 2, id: job.id, deleted: false, job: { ...job, id: 'other' } }], 2)]) assert.throws(() => checkedSyncPage(value, 1));
  assert.doesNotThrow(() => checkedSyncPage(page([{ seq: 2, id: job.id, deleted: true }], 2), 1));
});

test('lost delivery response keeps the same request ID queued until a receipt arrives', async () => {
  let reachable = false;
  const test = setup((url) => {
    if (url.endsWith('/session')) return session();
    if (url.endsWith('/links')) { if (!reachable) throw new TypeError('network response lost'); return json({ jobId: job.id }); }
    return json(page([], 1));
  }, { outbox: [queued] });
  await test.client.sync();
  assert.equal(test.snapshot().outbox.length, 1);
  assert.equal(test.events.at(-1)[1], 'offline');
  reachable = true; await test.client.sync();
  assert.equal(test.snapshot().outbox.length, 0);
  const uploads = test.calls.filter(call => call.url.endsWith('/links'));
  assert.equal(uploads.length, 2); assert.equal(JSON.parse(uploads[0].init.body).requestId, JSON.parse(uploads[1].init.body).requestId);
  assert.equal(uploads[0].init.headers['X-Cliptext-CSRF'], 'test-csrf');
});

test('deletion tombstones remove the offline item and pages resume at the last saved cursor', async () => {
  const test = setup(url => url.endsWith('/session') ? session() : url.includes('cursor=1') ? json(page([{ seq: 2, id: job.id, deleted: true }], 2, true)) : json(page([{ seq: 3, id: 'item-2', deleted: false, job: { ...job, id: 'item-2' } }], 3)));
  await test.client.sync();
  assert.deepEqual(test.snapshot().jobs.map(item => item.id), ['item-2']); assert.equal(test.snapshot().cursor, 3);
  assert.equal(test.calls.filter(call => call.url.includes('/sync')).length, 2);
});

test('unauthorized browser keeps cached transcripts and explicitly requests reconnect', async () => {
  const test = setup(() => json({ error: 'Pair this browser again.' }, 401), { outbox: [queued] });
  await test.client.sync();
  assert.equal(test.events.at(-1)[1], 'reconnect');
  assert.equal(test.snapshot().jobs[0].transcript, job.transcript); assert.equal(test.snapshot().outbox.length, 1);
});

test('a different library identity cannot receive another Mac’s queued links', async () => {
  const test = setup(() => json({ connected: true, libraryId: 'different-library-0000001', deviceId: 'browser', csrfToken: 'csrf' }), { outbox: [queued] });
  await test.client.sync();
  assert.equal(test.calls.length, 1); assert.equal(test.snapshot().libraryId, libraryId); assert.equal(test.snapshot().outbox.length, 1);
  assert.equal(test.events.at(-1)[1], 'reconnect');
});

test('an upload rate limit still permits downloading completed transcripts', async () => {
  const test = setup(url => url.endsWith('/session') ? session() : url.endsWith('/links') ? json({ error: 'Queue full' }, 429) : json(page([{ seq: 2, id: job.id, deleted: false, job: { ...job, transcript: 'Updated while queue full.' } }], 2)), { outbox: [queued] });
  await test.client.sync();
  assert.equal(test.snapshot().outbox.length, 1); assert.equal(test.snapshot().jobs[0].transcript, 'Updated while queue full.');
  assert.equal(test.events.at(-1)[1], 'synced');
});

test('invalid receipt does not discard an outgoing link', async () => {
  const test = setup(url => url.endsWith('/session') ? session() : json({}), { outbox: [queued] });
  await test.client.sync();
  assert.equal(test.snapshot().outbox.length, 1); assert.equal(test.events.at(-1)[1], 'error');
});

test('malformed cursor is surfaced without changing cached text or cursor', async () => {
  const test = setup(url => url.endsWith('/session') ? session() : json(page([], 99)));
  await test.client.sync();
  assert.equal(test.snapshot().cursor, 1); assert.equal(test.snapshot().jobs[0].transcript, job.transcript); assert.equal(test.events.at(-1)[1], 'error');
});

test('forget removes the phone copy even if the Mac is unreachable', async () => {
  const test = setup(() => { throw new TypeError('offline'); }, { outbox: [queued] });
  await test.client.forget();
  assert.equal(test.snapshot().libraryId, null); assert.equal(test.snapshot().jobs.length, 0); assert.equal(test.snapshot().outbox.length, 0);
});

test('concurrent foreground sync requests share a single operation', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const test = setup(async url => { if (url.endsWith('/session')) { await wait; return session(); } return json(page([], 1)); });
  const first = test.client.sync(), second = test.client.sync();
  assert.equal(first, second); release(); await first;
  assert.equal(test.calls.filter(call => call.url.endsWith('/session')).length, 1);
});

test('cancellation during a network request cannot acknowledge queued data', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const test = setup(async url => url.endsWith('/session') ? session() : (await wait, json({ jobId: job.id })), { outbox: [queued] });
  const operation = test.client.sync();
  await new Promise(resolve => setImmediate(resolve)); test.client.cancel(); release(); await operation;
  assert.equal(test.snapshot().outbox.length, 1);
});


test('an offline disconnect cannot silently restore the phone copy with an old cookie', async () => {
  const test = setup(() => { throw new TypeError('offline'); });
  await test.client.forget();
  const calls = test.calls.length;
  await test.client.sync();
  assert.equal(test.calls.length, calls); assert.equal(test.snapshot().libraryId, null);
  assert.equal(test.events.at(-1)[1], 'reconnect');
});
