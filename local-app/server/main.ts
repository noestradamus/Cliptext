import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { initializeRuntime } from './bindings';
import { dispatchRoute } from './routes';
import { EngineSupervisor } from './engine';
import { startPhoneSync } from './phone';
import { startWebCompanion } from './web-companion';
export { EngineSupervisor };

const VERSION = '0.4.1';
const MIMES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
export type AppOptions = { dataDir: string; clientDir: string; webClientDir?: string; migrationsDir: string; engineBundle: string; modelsDir: string; engineScript?: string; port?: number; phonePort?: number; webPort?: number; autoStartEngine?: boolean };

function equal(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function fail(message: string, status = 400) { return Response.json({ error: message }, { status }); }

export async function createLocalApp(options: AppOptions) {
  process.umask(0o077);
  const dataDir = resolve(options.dataDir);
  realpathSync(options.clientDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // Hold an OS-backed SQLite lock BEFORE the library constructor can migrate.
  // A separate tiny lock DB releases automatically after a process crash.
  const lock = new DatabaseSync(join(dataDir, 'instance.lock.sqlite3'));
  try { lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); }
  catch (error) { lock.close(); throw new Error('This local library is already open or unavailable.'); }
  let runtime: ReturnType<typeof initializeRuntime> | undefined;
  let released = false;
  const release = () => { if (released) return; released = true; try { lock.exec('ROLLBACK'); } finally { lock.close(); } };
  try { return await createOwnedApp(options, release, value => { runtime = value; }); }
  catch (error) { runtime?.close(); release(); throw error; }
}

async function createOwnedApp(options: AppOptions, release: () => void, initialized: (runtime: ReturnType<typeof initializeRuntime>) => void) {
  const dataDir = resolve(options.dataDir);
  const engineKey = randomBytes(32).toString('base64url');
  const runtime = initializeRuntime({ dataDir, engineKey, migrationsDir: options.migrationsDir });
  initialized(runtime);
  const DB = runtime.DB;
  // A previous local process has ended. Expire its leases; durable checkpoints
  // are reused with fresh claims rather than waiting for a hosted lease timeout.
  const recoverLeases = () => DB.batch([
    DB.prepare("UPDATE jobs SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE status IN ('downloading','transcribing')"),
    DB.prepare("UPDATE jobs SET insight_lease_expires_at='1970-01-01T00:00:00.000Z' WHERE insight_status='processing'"),
    DB.prepare("UPDATE jobs SET slide_lease_expires_at='1970-01-01T00:00:00.000Z' WHERE slide_status='processing'"),
    DB.prepare("UPDATE job_frames SET lease_expires_at='1970-01-01T00:00:00.000Z' WHERE status='processing'"),
  ]);
  await recoverLeases();
  const session = randomBytes(32).toString('base64url');
  const bootstrap = randomBytes(32).toString('base64url');
  let origin = '';
  let cookieName = '';
  let engine: EngineSupervisor;
  let closing = false;
  let engineControls: Promise<void> = Promise.resolve();
  const clientRoot = realpathSync(options.clientDir);

  function sessionAuthorized(request: IncomingMessage) {
    const cookies = (request.headers.cookie ?? '').split(';').map(item => item.trim());
    const value = cookies.find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1) ?? '';
    return equal(value, session);
  }
  function workerAuthorized(request: IncomingMessage) {
    return request.headers['x-cliptext-engine'] === '1'
      && equal(String(request.headers['x-cliptext-engine-key'] ?? ''), engineKey)
      && equal(String(request.headers.authorization ?? ''), 'Bearer ' + engineKey);
  }
  async function body(request: IncomingMessage, maximum: number) {
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maximum) throw Object.assign(new Error('The submitted file is too large.'), { status: 413 });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > maximum) throw Object.assign(new Error('The submitted file is too large.'), { status: 413 });
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  async function status() {
    const row = await DB.prepare("SELECT * FROM engine WHERE id='local'").first();
    const recent = !!row && Date.now() - Date.parse(String(row.last_seen)) < 60_000;
    return Response.json({ online: engine.running && recent && row?.status !== 'loading',
      worker: row ? { engine: row.model, status: row.status, activeJobId: row.active_job_id, lastSeen: row.last_seen } : null });
  }
  function configuration() {
    return Response.json({ version: VERSION, dataDir, databasePath: runtime.databasePath,
      engineBundle: resolve(options.engineBundle), modelsDir: resolve(options.modelsDir), ...engine.readiness(),
      worker: { running: engine.running, error: engine.error }, phoneSharing: phone.configuration().enabled,
      webSharing: web.configuration().enabled });
  }
  function controlEngine(action: 'start' | 'stop') {
    const operation = engineControls.then(async () => {
      if (closing) throw Object.assign(new Error('Cliptext is stopping.'), { status: 503 });
      if (action === 'stop') { await engine.stop(); await recoverLeases(); }
      else { if (!engine.running) await recoverLeases(); await engine.start(); }
    });
    engineControls = operation.catch(() => {});
    return operation;
  }
  async function handle(request: IncomingMessage): Promise<Response> {
    if (request.headers.host !== new URL(origin).host) return fail('Open Cliptext using its local address.', 403);
    let url: URL;
    try { url = new URL(request.url ?? '/', origin); } catch { return fail('The address is invalid.'); }
    if (url.origin !== origin) return fail('The address is invalid.', 403);
    const method = request.method ?? 'GET';
    if (url.pathname === '/health' && method === 'GET') return Response.json({ app: 'cliptext-local', version: VERSION, ready: !closing,
      libraryId: createHash('sha256').update(realpathSync(dataDir)).digest('hex').slice(0, 24) });
    if (url.pathname.startsWith('/api/')) {
      if (closing) return fail('Cliptext is stopping. Try again shortly.', 503);
      const isWorker = url.pathname.startsWith('/api/worker/');
      if (request.headers.origin && request.headers.origin !== origin) return fail('Open Cliptext to use this action.', 403);
      if (request.headers['sec-fetch-site'] === 'cross-site') return fail('Open Cliptext to use this action.', 403);
      if (url.pathname === '/api/local/session') {
        if (method === 'GET') return sessionAuthorized(request) ? Response.json({ connected: true }) : fail('Open Cliptext from its Mac app.', 401);
        if (method !== 'POST') return fail('This action is not available.', 405);
        if (request.headers.origin !== origin) return fail('Open Cliptext from its Mac app.', 403);
        let token: unknown;
        try { token = JSON.parse((await body(request, 1024)).toString('utf8')).token; } catch { return fail('Open Cliptext from its Mac app.', 401); }
        if (typeof token !== 'string' || !equal(token, bootstrap)) return fail('Open Cliptext from its Mac app.', 401);
        const connected = Response.json({ connected: true });
        connected.headers.set('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        return connected;
      }
      if (isWorker ? !workerAuthorized(request) : !sessionAuthorized(request)) return fail('Open Cliptext to connect to this local library.', 401);
      if (!isWorker && request.headers['x-cliptext-engine']) return fail('This action is for the local library.', 403);
      const bytes = ['GET', 'HEAD'].includes(method) ? undefined : await body(request, url.pathname === '/api/backup' ? 32 * 1024 * 1024 : 8 * 1024 * 1024);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const webRequest = new Request(url, { method, headers, ...(bytes ? { body: bytes } : {}) });
      if (url.pathname === '/api/status' && method === 'GET') return status();
      if (url.pathname === '/api/local/config' && method === 'GET') return configuration();
      if (url.pathname === '/api/local/phone') return phone.handleAdmin(webRequest);
      if (url.pathname === '/api/local/web') return web.handleAdmin(webRequest);
      if (url.pathname === '/api/local/engine' && method === 'POST') {
        let action: unknown;
        try { action = (await webRequest.json()).action; } catch { return fail('Choose an engine action.'); }
        if (action === 'start' || action === 'stop') { await controlEngine(action); return configuration(); }
        return fail('Choose start or stop.');
      }
      return dispatchRoute(webRequest);
    }
    if (!['GET', 'HEAD'].includes(method)) return fail('This action is not available.', 405);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return fail('The address is invalid.'); }
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) return fail('The address is invalid.', 403);
    if (pathname.startsWith('/downloads/')) return fail('This hosted helper is not part of the local application.', 404);
    const target = ['/', '/setup', '/setup/'].includes(pathname) ? join(clientRoot, 'index.html') : resolve(clientRoot, '.' + pathname);
    if (!target.startsWith(clientRoot + sep)) return fail('The address is invalid.', 403);
    if (!existsSync(target) || !statSync(target).isFile()) return fail('File not found.', 404);
    const actual = realpathSync(target);
    if (!actual.startsWith(clientRoot + sep)) return fail('The address is invalid.', 403);
    const response = new Response(method === 'HEAD' ? null : readFileSync(actual), { headers: { 'Content-Type': MIMES[extname(actual)] ?? 'application/octet-stream' } });
    return response;
  }
  const phone = await startPhoneSync({ DB, dataDir, port: options.phonePort });
  const web = await startWebCompanion({ DB, clientDir: options.webClientDir ?? join(dirname(options.clientDir), 'pwa'), port: options.webPort })
    .catch(async error => { await phone.close(); throw error; });
  const server = createServer(async (request, outgoing) => {
    try {
      const response = await handle(request);
      response.headers.set('Cache-Control', 'private, no-store');
      response.headers.set('X-Content-Type-Options', 'nosniff');
      response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      response.headers.set('Referrer-Policy', 'no-referrer');
      response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as never), outgoing);
      else outgoing.end();
    } catch (error) {
      if (outgoing.headersSent) { outgoing.destroy(); return; }
      const status = typeof (error as {status?: number}).status === 'number' ? (error as {status:number}).status : 500;
      outgoing.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ error: status === 413 ? 'The submitted file is too large.' : 'Cliptext could not complete this action. Try again.' }));
      console.error(JSON.stringify({ event: 'local_request_error', type: error instanceof Error ? error.name : 'Error' }));
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 47321, '127.0.0.1', accept); }).catch(async error => {
    await web.close();
    await phone.close();
    runtime.close(); throw error;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The local server did not start.');
  origin = `http://127.0.0.1:${address.port}`;
  cookieName = `cliptext_local_${address.port}`;
  engine = new EngineSupervisor({ bundleDir: resolve(options.engineBundle), modelsDir: resolve(options.modelsDir),
    dataDir, engineKey, origin, scriptPath: options.engineScript });
  let closeTask: Promise<void> | null = null;
  const close = () => {
    if (closeTask) return closeTask;
    closing = true;
    closeTask = (async () => {
      try {
        await engineControls;
        await engine.stop();
        await web.close();
        await phone.close();
        server.closeIdleConnections();
        const drain = setTimeout(() => server.closeAllConnections(), 3000);
        drain.unref();
        try { await new Promise<void>(accept => server.close(() => accept())); }
        finally { clearTimeout(drain); }
      } finally { runtime.close(); release(); }
    })();
    return closeTask;
  };
  if (options.autoStartEngine !== false) {
    try { await engine.start(); }
    catch { engine.error = 'The packaged engine or local models are unavailable. Check Sharing setup.'; }
  }
  return { server, origin, launchUrl: origin + '/#connect=' + bootstrap, engine, runtime, close };
}

function argument(name: string) { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
async function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, '..');
  const dataDir = resolve(argument('--data-dir') ?? join(homedir(), 'Library', 'Application Support', 'Cliptext'));
  const engineBundle = resolve(argument('--engine-bundle') ?? join(appRoot, 'engine'));
  const modelsDir = resolve(argument('--models-dir') ?? join(appRoot, 'models'));
  const requestedPort = Number(argument('--port') ?? 47321);
  const openBrowser = (url: string) => { execFile('/usr/bin/open', [url], error => { if (error) console.error('Open the printed local address in your browser.'); }); };
  if (process.argv.includes('--open') && existsSync(dataDir) && requestedPort > 0) {
    try {
      const address = `http://127.0.0.1:${requestedPort}`;
      const response = await fetch(address + '/health', { signal: AbortSignal.timeout(1000) });
      const existing = await response.json() as {app?:string;libraryId?:string;ready?:boolean};
      const wanted = createHash('sha256').update(realpathSync(dataDir)).digest('hex').slice(0, 24);
      if (existing.app === 'cliptext-local' && existing.libraryId === wanted && existing.ready) {
        const connection = JSON.parse(readFileSync(join(dataDir, 'launch.json'), 'utf8')) as {url?:string;origin?:string};
        if (connection.origin === address && typeof connection.url === 'string' && connection.url.startsWith(address + '/#connect=')) { openBrowser(connection.url); return; }
      }
    } catch { /* Start this library normally when no matching local app exists. */ }
  }
  const app = await createLocalApp({ dataDir, engineBundle, modelsDir,
    clientDir: resolve(argument('--client-dir') ?? join(appRoot, 'client')),
    webClientDir: resolve(argument('--web-client-dir') ?? join(appRoot, 'pwa')),
    migrationsDir: resolve(argument('--migrations-dir') ?? join(appRoot, 'migrations')),
    engineScript: argument('--engine-script'), port: requestedPort, autoStartEngine: !process.argv.includes('--no-engine') });
  const ready = { app: 'cliptext-local', version: VERSION, url: app.launchUrl, origin: app.origin, databasePath: app.runtime.databasePath, pid: process.pid };
  const connectionFile = join(dataDir, 'launch.json');
  try {
    writeFileSync(connectionFile, JSON.stringify(ready), { mode: 0o600 }); chmodSync(connectionFile, 0o600);
    if (argument('--ready-file')) { const path = resolve(argument('--ready-file')!); writeFileSync(path, JSON.stringify(ready), { mode: 0o600 }); chmodSync(path, 0o600); }
  } catch (error) {
    // Publishing readiness is part of startup: a failed native handshake must
    // release the listener, library lock and owned engine before reporting it.
    await app.close();
    throw error;
  }
  console.log(JSON.stringify({ ...ready, url: app.origin }));
  if (process.argv.includes('--open')) openBrowser(app.launchUrl);
  let stopping = false;
  let parentWatch: NodeJS.Timeout | undefined;
  const stop = async () => { if (stopping) return; stopping = true; if (parentWatch) clearInterval(parentWatch); await app.close(); process.exit(0); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const supervisorPid = Number(argument('--supervisor-pid') ?? 0);
  if (supervisorPid > 0 && Number.isSafeInteger(supervisorPid)) {
    parentWatch = setInterval(() => { if (process.ppid !== supervisorPid) void stop(); }, 2000);
    parentWatch.unref();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Cliptext could not start.'); process.exitCode = 1; });
}
