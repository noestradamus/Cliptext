import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalApp } from '../dist/server/main.mjs';

test('built main isolates authenticated web administration and reopens only its persisted companion listener', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cliptext-web-main-test-'));
  const clientDir = join(directory, 'client'), webClientDir = join(directory, 'pwa'), dataDir = join(directory, 'data');
  for (const path of [clientDir, webClientDir]) { await mkdir(path); await writeFile(join(path, 'index.html'), '<!doctype html><title>Synthetic Cliptext shell</title>'); }
  const options = { clientDir, webClientDir, dataDir, migrationsDir: fileURLToPath(new URL('../../drizzle/', import.meta.url)), engineBundle: join(directory, 'missing-engine'), modelsDir: join(directory, 'missing-models'), port: 0, phonePort: 0, webPort: 0, autoStartEngine: false };
  let app = await createLocalApp(options);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal((await fetch(app.origin + '/api/local/web')).status, 401);
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const connected = await fetch(app.origin + '/api/local/session', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = connected.headers.get('set-cookie').split(';')[0];
  const admin = async (body) => {
    const response = await fetch(app.origin + '/api/local/web', { headers: { Origin: app.origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, value: await response.json() };
  };
  const initial = await admin(); assert.equal(initial.status, 200); assert.equal(initial.value.enabled, false);
  const enabled = await admin({ action: 'enable', origin: 'https://fixture.private-tailnet.ts.net' });
  assert.equal(enabled.status, 200); assert.equal(enabled.value.error, undefined);
  const throughProxy = path => new Promise((resolve, reject) => {
    const outgoing = request({ hostname: '127.0.0.1', port: enabled.value.port, path, agent: false, headers: { Host: 'fixture.private-tailnet.ts.net', 'X-Forwarded-Proto': 'https', Cookie: cookie } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    outgoing.on('error', reject); outgoing.end();
  });
  assert.equal(await throughProxy('/'), 200);
  for (const path of ['/api/local/web', '/api/jobs', '/api/worker/claim']) assert.equal(await throughProxy(path), 404);
  assert.equal(await throughProxy('/api/pwa/session'), 401, 'The desktop owner cookie must not authorize phone reading.');
  const id = enabled.value.libraryId;
  await app.close(); app = await createLocalApp(options);
  const row = app.runtime.DB.connection.prepare('SELECT enabled,library_id FROM web_companion_settings WHERE id=1').get();
  assert.equal(row.enabled, 1); assert.equal(row.library_id, id); assert.equal(app.engine.running, false);
  const nextToken = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const nextSession = await fetch(app.origin + '/api/local/session', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: nextToken }) });
  const nextConfig = await fetch(app.origin + '/api/local/web', { headers: { Cookie: nextSession.headers.get('set-cookie').split(';')[0] } });
  const restored = await nextConfig.json(); assert.equal(restored.enabled, true); assert.equal(restored.error, undefined); assert.ok(restored.port > 0);
});
