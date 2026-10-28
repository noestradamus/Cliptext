// Fresh-source acceptance only. No fixture, backup or checkpoint is imported.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync, execFile } from 'node:child_process';
import { chmod, copyFile, lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const root = resolve(argument('--root'));
const appRoot = join(root, 'Cliptext Local');
const suppliedUrl = argument('--url');
if (!suppliedUrl) throw new Error('Pass --url with the public TikTok video to test.');
const requested = new URL(suppliedUrl);
assert.equal(requested.protocol, 'https:');
assert.ok(['www.tiktok.com', 'tiktok.com', 'm.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com'].includes(requested.hostname));
assert.ok(!requested.username && !requested.password && !requested.port);
requested.search = ''; requested.hash = '';
const sourceUrl = requested.href;
const expectedId = requested.pathname.match(/\/video\/(\d{10,25})\/?$/)?.[1];
const run = promisify(execFile);
const started = Date.now();
const report = { format: 'cliptext-fresh-retrieval-verification', version: 1, passed: false, sourceUrl,
  freshPlatformRetrieval: true, fixturesUsed: false, checkpointSeeding: false, existingMediaUsed: false,
  physicalCleanMacTest: false, inputDelivery: 'real browser submission',
  isolation: { publicSourceNetwork: 'allowed for fresh retrieval', developerTools: 'OS-denied',
    originalProfilesAndWorkspaces: 'OS-denied', applicationWrites: 'OS-denied' }, checks: [] };
let app;
const delay = milliseconds => new Promise(accept => setTimeout(accept, milliseconds));
async function privateJson(name, value) {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await chmod(path, 0o600);
}
function check(name, metadata = {}) {
  report.checks.push({ name, passed: true, seconds: (Date.now() - started) / 1000, ...metadata });
  console.log(JSON.stringify({ check: name, ...metadata }));
}
async function until(test, description, timeout = 900_000, interval = 1000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(interval); }
  throw new Error('Timed out waiting for ' + description);
}
async function profile() {
  assert.ok(root.startsWith('/private/tmp/'), 'Use an isolated directory under /private/tmp.');
  const blocked = ['/opt/homebrew', '/usr/local', '/Library/Developer', '/Applications/Xcode.app', '/Applications/Codex.app',
    '/Library/Frameworks/Python.framework', join(homedir(), 'Documents'), join(homedir(), '.cache'),
    join(homedir(), '.codex'), join(homedir(), '.local'), join(homedir(), 'Library', 'Python'),
    join(homedir(), 'Library', 'Keychains'), join(homedir(), 'Library', 'Application Support', 'Cliptext'),
    '/private/tmp/cliptext-engine-milestone1', '/private/tmp/cliptext-engine-milestone1-final',
    '/private/tmp/cliptext-local-app-milestone2', '/private/tmp/cliptext-retrieval-fix'];
  for (const name of await readdir('/private/tmp')) {
    const path = join('/private/tmp', name);
    if (name.startsWith('cliptext-tiktok-') && path !== root) blocked.push(path);
  }
  assert.ok(!blocked.some(path => root === path || root.startsWith(path + sep)), 'The fresh workspace must be separate from old test data.');
  const text = `(version 1)
(allow default)
(deny file-write* (subpath ${JSON.stringify(appRoot)}))
(deny file-read* ${[...new Set(blocked)].map(path => '(subpath ' + JSON.stringify(path) + ')').join('\n')})
(deny process-exec (literal "/usr/bin/xcrun") (literal "/usr/bin/swiftc") (literal "/usr/bin/clang") (literal "/usr/bin/security"))
`;
  await writeFile(join(root, 'isolation.sb'), text);
  console.log(JSON.stringify({ profile: join(root, 'isolation.sb'), network: 'allowed', blockedRoots: blocked.length }));
}

if (process.argv.includes('--write-profile')) {
  await profile();
} else try {
  let existing = [];
  try { existing = await readdir(join(root, 'data')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(existing.length, 0, 'Fresh acceptance requires an empty local data directory.');
  try { assert.equal((await readdir(join(root, 'fixtures'))).length, 0, 'No fixture directory may contain test media.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  check('empty-data-no-fixtures');
  await assert.rejects(readFile('/opt/homebrew/bin/node'), error => ['EPERM', 'EACCES'].includes(error.code));
  const compiler = spawnSync('/usr/bin/xcrun', ['--version']);
  assert.ok(compiler.error && ['EPERM', 'EACCES'].includes(compiler.error.code));
  await assert.rejects(writeFile(join(appRoot, '.write-control'), 'denied'), error => ['EPERM', 'EACCES'].includes(error.code));
  check('developer-tools-and-application-write-denial');

  const { createLocalApp } = await import(pathToFileURL(join(appRoot, 'server', 'main.mjs')));
  app = await createLocalApp({ dataDir: join(root, 'data'), clientDir: join(appRoot, 'client'),
    migrationsDir: join(appRoot, 'migrations'), engineBundle: join(appRoot, 'engine'), modelsDir: join(appRoot, 'models'),
    port: Number(argument('--port') ?? 47323), autoStartEngine: true });
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const session = await fetch(app.origin + '/api/local/session', { method: 'POST', headers: {
    Origin: app.origin, 'Content-Type': 'application/json',
  }, body: JSON.stringify({ token }) });
  assert.equal(session.status, 200);
  const cookie = session.headers.get('set-cookie').split(';')[0]; await session.text();
  async function api(path) {
    const response = await fetch(app.origin + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200); return response.json();
  }
  assert.equal((await api('/api/jobs')).total, 0);
  await privateJson('ready.json', { url: app.launchUrl, origin: app.origin, waitingForBrowserLink: true, sourceUrl });
  console.log(JSON.stringify({ waitingForBrowserLink: true, url: app.origin, sourceUrl }));
  const job = await until(async () => {
    const list = await api('/api/jobs');
    assert.ok(list.total <= 1, 'The fresh library must contain only the requested user link.');
    return list.jobs.length === 1 ? list.jobs[0] : null;
  }, 'the requested link submitted in the actual interface');
  assert.equal(job.url, sourceUrl); assert.equal(job.platform, 'tiktok');
  check('requested-link-submitted-by-browser', { jobId: job.id, sourceUrl });

  const directory = join(root, 'data', 'engine', 'jobs', job.id);
  const media = await until(async () => {
    const current = (await api('/api/jobs/' + job.id)).job;
    if (current.status === 'failed') throw new Error('Fresh retrieval failed: ' + current.error);
    let state;
    try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!state.media) return null;
    assert.equal(basename(state.media), state.media); assert.ok(!isAbsolute(state.media));
    assert.equal(extname(state.media).toLowerCase(), '.mp4');
    const path = join(directory, state.media);
    assert.equal((await lstat(path)).isSymbolicLink(), false);
    assert.ok((await realpath(path)).startsWith((await realpath(directory)) + sep));
    const info = await stat(path);
    assert.ok(info.size > 0 && info.size <= 80 * 1024 * 1024);
    // yt-dlp may preserve the CDN's Last-Modified timestamp. Local creation/
    // metadata-change times establish freshness without confusing upload time.
    assert.ok(info.birthtimeMs >= started - 2000 || info.ctimeMs >= started - 2000);
    await copyFile(path, join(root, 'retrieved.mp4'));
    return { bytes: info.size, mediaName: state.media, birthtimeMs: info.birthtimeMs, ctimeMs: info.ctimeMs, mtimeMs: info.mtimeMs };
  }, 'newly downloaded media in the fresh worker checkpoint', 300_000, 100);
  const tools = join(appRoot, 'engine', 'bin');
  const probe = JSON.parse((await run(join(tools, 'ffprobe'), ['-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', join(root, 'retrieved.mp4')], { timeout: 20_000 })).stdout);
  const duration = Number(probe.format?.duration);
  assert.ok(duration > 0 && duration <= 1200);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
  await run(join(tools, 'ffmpeg'), ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file,pipe',
    '-i', join(root, 'retrieved.mp4'), '-map', '0:a:0', '-map', '0:v:0', '-f', 'null', '-'], { timeout: 180_000, maxBuffer: 1024 * 1024 });
  const hash = createHash('sha256').update(await readFile(join(root, 'retrieved.mp4'))).digest('hex');
  check('fresh-media-downloaded-and-fully-decoded', { ...media, durationSeconds: duration, streams: probe.streams, sha256: hash });

  let previous = '';
  const completed = await until(async () => {
    const row = (await api('/api/jobs/' + job.id)).job;
    const status = `${row.status}/${row.insightStatus}/${row.frameStatus}`;
    if (status !== previous) { console.log(JSON.stringify({ processing: status })); previous = status; }
    if (row.status === 'failed') throw new Error('Fresh processing failed: ' + row.error);
    return row.status === 'completed' && row.insightStatus === 'completed' && row.frameStatus === 'ready' ? row : null;
  }, 'fresh transcription, real local Qwen analysis, and preview');
  assert.equal(completed.url, sourceUrl);
  if (expectedId) assert.equal(completed.canonicalId, 'tiktok:' + expectedId);
  assert.ok(completed.transcript?.trim() && completed.segments.length > 0);
  assert.equal(completed.insightModel, 'Qwen3 4B Instruct 2507 · local MLX');
  assert.ok(completed.generatedTitle && completed.generatedTitle.length <= 70);
  const summary = completed.insights?.summary;
  assert.ok(summary && summary.length <= 100 && summary.split(/\s+/).length <= 16 && !summary.includes('\n'));
  const preview = await fetch(app.origin + completed.frameUrl, { headers: { Cookie: cookie } });
  assert.equal(preview.status, 200); assert.equal(preview.headers.get('content-type'), 'image/jpeg');
  await writeFile(join(root, 'fresh-preview.jpg'), Buffer.from(await preview.arrayBuffer()));
  await privateJson('completed-item.json', completed);
  check('fresh-real-engine-result', { jobId: job.id, canonicalId: completed.canonicalId, title: completed.title,
    summary, transcriptCharacters: completed.transcript.length, insightModel: completed.insightModel });
  const backup = await api('/api/backup');
  assert.equal(backup.items.length, 1); assert.ok(backup.assets.some(asset => asset.kind === 'frame'));
  await privateJson('library-backup.json', backup);
  check('fresh-library-backup', { items: 1, assets: backup.assets.length });
  report.passed = true;
  await privateJson('verification.json', report);
  console.log(JSON.stringify({ passed: true, url: app.origin, report: join(root, 'verification.json'), freshPlatformRetrieval: true }));
  if (argument('--keep-open') === 'yes') {
    await privateJson('ready.json', { url: app.launchUrl, origin: app.origin, verified: true, sourceUrl });
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); process.exit(0); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  } else await app.close();
} catch (error) {
  report.failure = String(error instanceof Error ? error.message : error).replace(/https?:\/\/\S+/g, '[address]');
  await privateJson('verification.json', report);
  console.error(JSON.stringify({ failed: report.failure }));
  await app?.close(); process.exitCode = 1;
}
