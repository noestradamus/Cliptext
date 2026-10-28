import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalApp, EngineSupervisor } from '../dist/server/main.mjs';

const localRoot = fileURLToPath(new URL('../', import.meta.url));
const turn = () => new Promise(accept => setImmediate(accept));

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-engine-control-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('an interpreter that closes stdin during startup rejects without an unhandled EPIPE', async t => {
  const directory = await temporary(t);
  const bundle = join(directory, 'engine');
  const bin = join(bundle, 'python', 'bin');
  await mkdir(bin, { recursive: true });
  // A real short-lived process, not a mocked stream: the large configuration
  // cannot fit in the pipe before this interpreter surrogate closes it.
  await writeFile(join(bin, 'python3.11'), '#!/bin/sh\nexec /usr/bin/true\n', { mode: 0o755 });
  const engine = new EngineSupervisor({ bundleDir: bundle, modelsDir: join(directory, 'models'),
    dataDir: join(directory, 'data'), origin: 'http://127.0.0.1:4477', engineKey: 'x'.repeat(4 * 1024 * 1024) });
  engine.readiness = () => ({ engineReady: true, speechModelReady: true, insightsModelReady: true });
  t.after(() => engine.stop());
  await assert.rejects(engine.start(), /EPIPE|broken pipe|configuration|closed|write/i);
  // The write callback can precede the stream's error event by one turn.
  await turn();
  assert.ok(engine.error, 'Startup pipe failure must remain inspectable.');
  await engine.stop();
  assert.equal(engine.running, false);
});

test('a failed interpreter spawn leaves the supervisor stopped and recoverable', async t => {
  const directory = await temporary(t);
  const engine = new EngineSupervisor({ bundleDir: join(directory, 'missing'), modelsDir: join(directory, 'models'),
    dataDir: join(directory, 'data'), origin: 'http://127.0.0.1:4477', engineKey: 'local-test-key-12345678901234567890' });
  engine.readiness = () => ({ engineReady: true, speechModelReady: true, insightsModelReady: true });
  await assert.rejects(engine.start(), /ENOENT|spawn/);
  assert.equal(engine.running, false);
  assert.ok(engine.error);
  await engine.stop();
});

test('concurrent stop/start controls preserve leases acquired by the replacement worker', async t => {
  const directory = await temporary(t);
  const app = await createLocalApp({ dataDir: join(directory, 'data'),
    clientDir: join(localRoot, 'dist/client'), migrationsDir: join(localRoot, 'dist/migrations'),
    engineBundle: join(directory, 'no-real-engine'), modelsDir: join(directory, 'no-models'),
    port: 0, autoStartEngine: false });
  t.after(() => app.close());
  const entry = await fetch(app.origin + '/');
  assert.equal(entry.status, 200);
  assert.equal(entry.headers.get('set-cookie'), null);
  await entry.text();
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  assert.ok(token, 'The launcher must provide a private connection token.');
  const session = await fetch(app.origin + '/api/local/session', { method: 'POST', headers: {
    Origin: app.origin, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ token }) });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0]; await session.text();
  async function json(path, payload) {
    const response = await fetch(app.origin + path, { method: 'POST', headers: {
      Cookie: cookie, Origin: app.origin, 'Content-Type': 'application/json',
    }, body: JSON.stringify(payload) });
    assert.equal(response.status, path === '/api/jobs' ? 201 : 200);
    return response.json();
  }
  const id = (await json('/api/jobs', { url: 'https://www.youtube.com/watch?v=abcdefghijk' })).job.id;
  const future = '2999-12-31T00:00:00.000Z';
  await app.runtime.DB.prepare("UPDATE jobs SET status='downloading',lease_token='old-worker',lease_expires_at=? WHERE id=?")
    .bind(future, id).run();

  let releaseStop, enteredStop;
  const stopping = new Promise(accept => { releaseStop = accept; });
  const stopEntered = new Promise(accept => { enteredStop = accept; });
  let running = true, starts = 0;
  const originalStop = app.engine.stop.bind(app.engine);
  Object.defineProperty(app.engine, 'running', { configurable: true, get: () => running });
  app.engine.stop = async () => { enteredStop(); await stopping; running = false; };
  app.engine.start = async () => {
    starts++;
    await app.runtime.DB.prepare("UPDATE jobs SET status='downloading',lease_token='replacement-worker',lease_expires_at=? WHERE id=?")
      .bind(future, id).run();
    running = true;
  };
  let requests = 0, bodyReceived;
  const secondBody = new Promise(accept => { bodyReceived = accept; });
  const observe = request => {
    if (request.url === '/api/local/engine' && ++requests === 2) request.once('end', bodyReceived);
  };
  app.server.on('request', observe);
  let stopResponse, startResponse;
  try {
    stopResponse = json('/api/local/engine', { action: 'stop' });
    await stopEntered;
    startResponse = json('/api/local/engine', { action: 'start' });
    // The next action is fully received while stopping is deliberately held.
    // Its side effect must wait for the stop + lease-recovery operation.
    await secondBody;
    await turn();
    assert.equal(starts, 0);
    releaseStop();
    await Promise.all([stopResponse, startResponse]);
    const lease = await app.runtime.DB.prepare('SELECT lease_token,lease_expires_at FROM jobs WHERE id=?').bind(id).first();
    assert.equal(starts, 1);
    assert.equal(lease.lease_token, 'replacement-worker');
    assert.equal(lease.lease_expires_at, future, 'Stop recovery must not expire the replacement worker’s lease.');
  } finally {
    releaseStop();
    await Promise.allSettled([stopResponse, startResponse].filter(Boolean));
    app.server.off('request', observe);
    app.engine.stop = originalStop;
  }
});
