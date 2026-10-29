import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { LocalDatabase } from './storage';
import { ApiError } from '../../lib/server';
import { submitJob } from '../../lib/submit';
import { extractVideoUrl } from '../../lib/video';
import { phoneJob } from './phone';

export type WebConfiguration = {
  enabled: boolean; origin: string | null; port: number; libraryId: string; shortcutDownloads: boolean;
  devices: { id: string; name: string; kind: 'browser' | 'shortcut'; lastSeen: string | null }[];
  error?: string;
};
export type WebCompanionOptions = { DB: LocalDatabase; clientDir: string; port?: number };
export type WebCompanion = { configuration(): WebConfiguration; handleAdmin(request: Request): Promise<Response>; close(): Promise<void> };
type Device = { id: string; kind: 'browser' | 'shortcut'; name: string; paired_at: number | null; expires_at: number | null; revoked_at: number | null };
const COOKIE = '__Host-cliptext_pwa';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const JSON_LIMIT = 8192, SHORTCUT_LIMIT = 65_536, PAGE_BYTES = 8 * 1024 * 1024;
const MIMES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.ico': 'image/x-icon', '.shortcut': 'application/x-apple-shortcut' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equal(a: string, b: string) { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function trustedOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 300) throw new ApiError(400, 'Enter the Mac’s HTTPS Tailscale address.');
  let url: URL; try { url = new URL(value.trim()); } catch { throw new ApiError(400, 'Enter the Mac’s HTTPS Tailscale address.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.ts\.net$/.test(url.hostname) || url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new ApiError(400, 'Use an HTTPS .ts.net address without a path or custom port.');
  return url.origin;
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
function object(text: string, limit = JSON_LIMIT): Record<string, unknown> {
  if (Buffer.byteLength(text) > limit) throw new ApiError(413, 'The request is too large.');
  try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new ApiError(400, 'The request could not be read.'); }
}
function name(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new ApiError(400, 'Use a name under 80 characters.');
  return value.trim();
}

/** Only Tailscale Serve may expose this loopback listener, never the desktop API. */
export async function startWebCompanion({ DB, clientDir, port }: WebCompanionOptions): Promise<WebCompanion> {
  const connection = DB.connection;
  const saved = connection.prepare('SELECT * FROM web_companion_settings WHERE id=1').get()!;
  const libraryId = String(saved.library_id), secret = Buffer.from(String(saved.auth_secret), 'hex');
  let enabled = saved.enabled === 1, origin = saved.origin === null ? null : trustedOrigin(saved.origin);
  const configuredPort = port ?? Number(saved.port);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('Invalid web companion port.');
  if (port !== undefined && port > 0) connection.prepare('UPDATE web_companion_settings SET port=? WHERE id=1').run(port);
  let activePort = configuredPort, server: Server | null = null, sockets = new Set<Duplex>();
  let error: string | undefined, closed = false, operations: Promise<unknown> = Promise.resolve();
  const sequence = <T>(action: () => Promise<T>) => { const result = operations.then(action, action); operations = result.catch(() => undefined); return result; };
  const derive = (domain: string, id: string, capability: string) => createHmac('sha256', secret).update(domain + '\0').update(id).update('\0').update(capability).digest('base64url');
  const shortcutDownloads = () => ['Save to Cliptext.shortcut', 'Sync Cliptext.shortcut'].every(file => existsSync(join(clientDir, 'shortcuts', file)) && statSync(join(clientDir, 'shortcuts', file)).isFile());
  const configuration = (): WebConfiguration => ({ enabled, origin, port: activePort, libraryId, shortcutDownloads: shortcutDownloads(),
    devices: connection.prepare('SELECT id,name,kind,last_seen FROM web_companion_devices WHERE paired_at IS NOT NULL AND revoked_at IS NULL ORDER BY created_at,id').all()
      .map(row => ({ id: String(row.id), name: String(row.name), kind: row.kind as Device['kind'], lastSeen: row.last_seen == null ? null : new Date(Number(row.last_seen)).toISOString() })), ...(error ? { error } : {}) });
  const unavailable = () => { if (!enabled || closed || !origin) throw new ApiError(503, 'The Mac companion is unavailable. Try again later.'); };
  const session = (device: Device, token: string) => ({ connected: true, libraryId, deviceId: device.id, csrfToken: derive('cliptext-pwa-csrf-v1', device.id, token), shortcutDownloads: shortcutDownloads() });
  const clearCookie = () => `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
  const cookie = (token: string) => `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000`;

  function credential(request: IncomingMessage, kind: Device['kind']) {
    unavailable(); let token: string;
    if (kind === 'shortcut') {
      const authorization = request.headers.authorization ?? '';
      if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new ApiError(401, 'Reconnect this Shortcut from your Mac.');
      token = authorization.slice(7);
    } else {
      if (request.headers.authorization !== undefined) throw new ApiError(401, 'Pair this browser with your Mac.');
      const values = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
      token = values.length === 1 ? values[0].slice(COOKIE.length + 1) : '';
      if (!TOKEN.test(token)) throw new ApiError(401, 'Pair this browser with your Mac.');
    }
    const device = connection.prepare('SELECT id,kind,name,paired_at,expires_at,revoked_at FROM web_companion_devices WHERE token_hash=? AND kind=?').get(hash(token), kind) as Device | undefined;
    if (!device || device.paired_at === null || device.revoked_at !== null) throw new ApiError(401, kind === 'browser' ? 'Pair this browser with your Mac.' : 'Reconnect this Shortcut from your Mac.');
    return { device, token };
  }
  function browserRequest(request: IncomingMessage, mutation: boolean) {
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && !(site === 'none' && !mutation)) throw new ApiError(403, 'Open the companion from its Mac address.');
    if (request.headers.origin !== undefined && request.headers.origin !== origin || mutation && request.headers.origin !== origin) throw new ApiError(403, 'Open the companion from its Mac address.');
    if (request.headers.referer) {
      try { if (new URL(request.headers.referer).origin !== origin) throw new Error(); }
      catch { throw new ApiError(403, 'Open the companion from its Mac address.'); }
    }
  }
  function csrf(request: IncomingMessage, device: Device, token: string) {
    if (!equal(String(request.headers['x-cliptext-csrf'] ?? ''), derive('cliptext-pwa-csrf-v1', device.id, token))) throw new ApiError(403, 'Refresh the companion before trying again.');
  }
  async function body(request: IncomingMessage, maximum = JSON_LIMIT) {
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Send this request as JSON.');
    const declared = request.headers['content-length'];
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new ApiError(413, 'The request is too large.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length; if (size > maximum) throw new ApiError(413, 'The request is too large.'); chunks.push(bytes); }
    return object(Buffer.concat(chunks).toString('utf8'), maximum);
  }
  function touch(deviceId: string) { connection.prepare('UPDATE web_companion_devices SET last_seen=? WHERE id=?').run(Date.now(), deviceId); }

  async function receipt(device: Device, requestId: unknown, input: unknown, verify: () => void) {
    if (typeof requestId !== 'string' || !UUID.test(requestId) || typeof input !== 'string' || input.length > 4096) throw new ApiError(400, 'Send a supported link with a valid request ID.');
    const url = extractVideoUrl(input); if (!url) throw new ApiError(400, 'Share a TikTok, YouTube, or Instagram post link.');
    connection.exec('BEGIN IMMEDIATE');
    try {
      verify();
      const prior = connection.prepare('SELECT request_url,job_id FROM web_companion_receipts WHERE device_id=? AND request_id=?').get(device.id, requestId.toLowerCase());
      let jobId: string;
      if (prior) { if (prior.request_url !== url) throw new ApiError(409, 'This request ID was already used for another link.'); jobId = String(prior.job_id); }
      else {
        // submitJob awaits only already-resolved SQLite operations, so the job
        // and receipt commit together before another network callback can run.
        const job = await submitJob(url, 'owner'); jobId = String(job.id);
        connection.prepare('INSERT INTO web_companion_receipts(device_id,request_id,request_url,job_id,created_at) VALUES(?,?,?,?,?)').run(device.id, requestId.toLowerCase(), url, jobId, Date.now());
      }
      touch(device.id); connection.exec('COMMIT'); return { jobId };
    } catch (error) { connection.exec('ROLLBACK'); throw error; }
  }

  function sync(url: URL) {
    const raw = url.searchParams.get('cursor') ?? '0', rawLimit = url.searchParams.get('limit') ?? '50';
    const cursor = Number(raw), limit = Number(rawLimit);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(cursor) || !/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 50 || url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) throw new ApiError(400, 'Invalid library sync cursor.');
    const max = Number(connection.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM phone_sync_changes WHERE owner_id='owner'").get()!.seq);
    if (cursor > max) return json({ error: 'The library has a different sync history.', resetRequired: true, libraryId }, 409);
    const rows = connection.prepare("SELECT seq,job_id,deleted FROM phone_sync_changes WHERE owner_id='owner' AND seq>? ORDER BY seq LIMIT ?").all(cursor, limit + 1);
    const collections = connection.prepare("SELECT id,name FROM collections WHERE owner_id='owner' ORDER BY name COLLATE NOCASE,id").all().map(row => ({ id: String(row.id), name: String(row.name) }));
    const changes: { seq: number; id: string; deleted: boolean; job?: ReturnType<typeof phoneJob> }[] = [];
    let next = cursor, size = Buffer.byteLength(JSON.stringify(collections)) + 256;
    for (const row of rows.slice(0, limit)) {
      const job = connection.prepare("SELECT * FROM jobs WHERE id=? AND owner_id='owner'").get(String(row.job_id));
      const deleted = !!row.deleted || !job || job.trashed_at !== null || job.duplicate_of !== null;
      const change = { seq: Number(row.seq), id: String(row.job_id), deleted, ...(!deleted && job ? { job: phoneJob(job) } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(change));
      if (bytes > 24 * 1024 * 1024) throw new ApiError(413, 'One legacy library item is too large to sync.');
      if (changes.length && size + bytes > PAGE_BYTES) break;
      changes.push(change); size += bytes; next = change.seq;
    }
    return json({ libraryId, changes, cursor: next, hasMore: rows.some(row => Number(row.seq) > next), collections });
  }

  async function receive(request: IncomingMessage): Promise<Response> {
    unavailable();
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || request.headers.host !== new URL(origin!).host) throw new ApiError(403, 'Use the configured HTTPS companion address.');
    if (request.headers['x-forwarded-proto'] !== undefined && request.headers['x-forwarded-proto'] !== 'https') throw new ApiError(403, 'Use HTTPS to open the companion.');
    const url = new URL(request.url, origin!);
    if (url.origin !== origin) throw new ApiError(403, 'Use the configured HTTPS companion address.');
    const method = request.method ?? 'GET';
    if (url.pathname === '/api/shortcut/links') {
      if (method !== 'POST') throw new ApiError(405, 'This endpoint accepts link submissions only.');
      if (request.headers.origin !== undefined || request.headers.referer !== undefined || request.headers.cookie !== undefined || Object.keys(request.headers).some(header => header.startsWith('sec-fetch-'))) throw new ApiError(403, 'Use the Save to Cliptext Shortcut.');
      const { device } = credential(request, 'shortcut');
      const input = await body(request, SHORTCUT_LIMIT);
      if (!Array.isArray(input.links) || !input.links.length || input.links.length > 20) throw new ApiError(400, 'Submit from 1 to 20 queued links.');
      const receipts = [];
      for (const entry of input.links) {
        const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
        try { const result = await receipt(device, item.requestId, item.url, () => { credential(request, 'shortcut'); }); receipts.push({ requestId: item.requestId, ...result }); }
        catch (error) {
          const status = error instanceof ApiError ? error.status : 500;
          if (status === 401 || status === 503) throw error;
          receipts.push({ requestId: typeof item.requestId === 'string' ? item.requestId : null, error: error instanceof ApiError ? error.message : 'The Mac could not save this link.', status, retryable: status === 429 || status >= 500 });
        }
      }
      return json({ libraryId, receipts });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!url.pathname.startsWith('/api/pwa/')) throw new ApiError(404, 'Companion endpoint not found.');
      browserRequest(request, !['GET', 'HEAD'].includes(method));
      if (url.pathname === '/api/pwa/pair' && method === 'POST') {
        const input = await body(request), deviceName = name(input.name, 'iPhone');
        let capsule: Record<string, unknown>;
        try { if (typeof input.code !== 'string' || input.code.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.code)) throw new Error(); capsule = JSON.parse(Buffer.from(input.code, 'base64url').toString('utf8')); }
        catch { throw new ApiError(401, 'Create a new pairing code on your Mac.'); }
        if (capsule.v !== 1 || capsule.origin !== origin || capsule.libraryId !== libraryId || typeof capsule.deviceId !== 'string' || !UUID.test(capsule.deviceId) || typeof capsule.token !== 'string' || !TOKEN.test(capsule.token)) throw new ApiError(401, 'Create a new pairing code on your Mac.');
        const device = connection.prepare("SELECT id,kind,name,paired_at,expires_at,revoked_at FROM web_companion_devices WHERE id=? AND kind='browser' AND bootstrap_hash=?").get(capsule.deviceId, hash(capsule.token)) as Device | undefined;
        if (!device || device.revoked_at !== null || !device.expires_at || device.expires_at <= Date.now()) throw new ApiError(401, 'Create a new pairing code on your Mac.');
        if (device.paired_at !== null && device.name !== deviceName) throw new ApiError(409, 'This code was already used with a different browser name.');
        unavailable();
        const token = derive('cliptext-pwa-device-v1', device.id, capsule.token);
        if (device.paired_at === null) connection.prepare('UPDATE web_companion_devices SET name=?,token_hash=?,paired_at=?,last_seen=? WHERE id=?').run(deviceName, hash(token), Date.now(), Date.now(), device.id);
        return json(session(device, token), 200, { 'Set-Cookie': cookie(token) });
      }
      const { device, token } = credential(request, 'browser');
      if (url.pathname === '/api/pwa/session' && method === 'GET') { touch(device.id); return json(session(device, token)); }
      if (url.pathname === '/api/pwa/sync' && method === 'GET') { const result = sync(url); touch(device.id); return result; }
      if (url.pathname === '/api/pwa/links' && method === 'POST') {
        csrf(request, device, token); const input = await body(request);
        return json(await receipt(device, input.requestId, input.url, () => { credential(request, 'browser'); }));
      }
      if (url.pathname === '/api/pwa/disconnect' && method === 'POST') {
        csrf(request, device, token); await body(request); credential(request, 'browser');
        connection.prepare('UPDATE web_companion_devices SET revoked_at=? WHERE id=?').run(Date.now(), device.id);
        return json({ disconnected: true, libraryId }, 200, { 'Set-Cookie': clearCookie() });
      }
      throw new ApiError(404, 'Companion endpoint not found.');
    }
    if (!['GET', 'HEAD'].includes(method)) throw new ApiError(405, 'Open the companion to use this action.');
    // The public app shell may be opened from a camera, message, or Home Screen.
    // Private API requests above still require exact-origin browser metadata.
    let path: string; try { path = decodeURIComponent(url.pathname); } catch { throw new ApiError(400, 'Invalid companion path.'); }
    if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) throw new ApiError(403, 'Invalid companion path.');
    const shortcut = ['/shortcuts/Save to Cliptext.shortcut', '/shortcuts/Sync Cliptext.shortcut'].includes(path);
    const allowed = shortcut || path === '/' || /^\/(?:index\.html|theme-bootstrap\.js|sw\.js|manifest\.webmanifest|favicon\.svg|app-icon\.svg|icon-(?:192|512)\.png)$/.test(path) || /^\/(?:assets|fonts|icons)\/[A-Za-z0-9_./-]+$/.test(path);
    if (!allowed || !MIMES[extname(path === '/' ? 'index.html' : path)]) throw new ApiError(404, 'Companion file not found.');
    // Installers must be generic: credentials are configured on the phone and
    // must never be embedded in these public, signed Shortcut definitions.
    const base = realpathSync(clientDir), target = resolve(base, '.' + (path === '/' ? '/index.html' : path));
    if (!target.startsWith(base + sep) || !existsSync(target) || !statSync(target).isFile()) throw new ApiError(404, 'Companion file not found.');
    const actual = realpathSync(target); if (!actual.startsWith(base + sep)) throw new ApiError(403, 'Companion file not found.');
    return new Response(method === 'HEAD' ? null : readFileSync(actual), { headers: { 'Content-Type': MIMES[extname(actual)], 'Cache-Control': shortcut ? 'private, no-store' : 'no-cache', ...(path === '/sw.js' ? { 'Service-Worker-Allowed': '/' } : {}) } });
  }

  async function send(request: IncomingMessage, outgoing: ServerResponse) {
    let response: Response;
    try { response = await receive(request); }
    catch (error) {
      const status = error instanceof ApiError ? error.status : 500;
      const clear = status === 401 && request.url?.startsWith('/api/pwa/') && !request.url.startsWith('/api/pwa/pair');
      response = json({ error: error instanceof ApiError ? error.message : 'The Mac companion could not complete this request.', libraryId,
        ...(request.url?.startsWith('/api/pwa/session') && status === 401 ? { connected: false, shortcutDownloads: shortcutDownloads() } : {}) }, status, clear ? { 'Set-Cookie': clearCookie() } : {});
    }
    response.headers.set('X-Content-Type-Options', 'nosniff'); response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    outgoing.writeHead(response.status, { ...Object.fromEntries(response.headers), Connection: 'close' });
    outgoing.end(Buffer.from(await response.arrayBuffer())); request.resume();
  }
  async function stop() {
    const current = server; server = null; const clients = sockets; sockets = new Set();
    if (!current) return;
    await new Promise<void>(accept => { const deadline = setTimeout(() => { current.closeAllConnections(); for (const socket of clients) socket.destroy(); }, 2000); deadline.unref();
      current.close(() => { clearTimeout(deadline); accept(); }); current.closeIdleConnections(); });
  }
  async function listen() {
    if (!enabled || closed || server || !origin) return;
    try {
      const base = realpathSync(clientDir); if (!statSync(join(base, 'index.html')).isFile()) throw new Error();
      const next = createServer({ maxHeaderSize: 8192 }, (request, response) => { void send(request, response).catch(() => response.destroy()); });
      const clients = new Set<Duplex>(); next.on('connection', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
      next.headersTimeout = 10_000; next.requestTimeout = 15_000; next.keepAliveTimeout = 1000;
      next.on('error', () => { error = 'The companion could not listen on its local port.'; });
      await new Promise<void>((accept, reject) => { next.once('error', reject); next.listen(configuredPort, '127.0.0.1', () => { next.removeListener('error', reject); accept(); }); });
      server = next; sockets = clients; activePort = (next.address() as AddressInfo).port; error = undefined;
    } catch { error = 'The web companion could not start. Check its built files and local port.'; }
  }
  function setOrigin(input: unknown) {
    const next = trustedOrigin(input);
    if (next !== origin) connection.prepare("UPDATE web_companion_devices SET revoked_at=? WHERE kind='browser' AND paired_at IS NULL").run(Date.now());
    origin = next; connection.prepare('UPDATE web_companion_settings SET origin=? WHERE id=1').run(origin);
  }
  const handleAdmin = (request: Request) => sequence(async () => {
    try {
      if (closed) throw new ApiError(503, 'The companion has stopped.');
      if (new URL(request.url).pathname !== '/api/local/web') throw new ApiError(404, 'Companion settings not found.');
      if (request.method === 'GET') return json(configuration());
      if (request.method !== 'POST') throw new ApiError(405, 'Use GET or POST for companion settings.');
      const input = object(await request.text());
      if (input.action === 'enable') { if ('origin' in input) setOrigin(input.origin); if (!origin) throw new ApiError(400, 'Set the HTTPS Tailscale address first.'); enabled = true; connection.prepare('UPDATE web_companion_settings SET enabled=1 WHERE id=1').run(); await listen(); return json(configuration()); }
      if (input.action === 'disable') { enabled = false; connection.prepare('UPDATE web_companion_settings SET enabled=0 WHERE id=1').run(); connection.prepare("UPDATE web_companion_devices SET revoked_at=? WHERE kind='browser' AND paired_at IS NULL").run(Date.now()); await stop(); error = undefined; return json(configuration()); }
      if (input.action === 'origin') { setOrigin(input.origin); return json(configuration()); }
      if (input.action === 'revoke') { if (typeof input.deviceId !== 'string' || !UUID.test(input.deviceId)) throw new ApiError(400, 'Choose a companion device.'); const result = connection.prepare('UPDATE web_companion_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), input.deviceId); if (!result.changes) throw new ApiError(404, 'Companion device not found.'); return json(configuration()); }
      if (input.action === 'pair' || input.action === 'shortcut') {
        unavailable(); if (!server) throw new ApiError(503, 'The companion is not listening.');
        connection.prepare("DELETE FROM web_companion_devices WHERE paired_at IS NULL AND (expires_at<=? OR revoked_at IS NOT NULL)").run(Date.now());
        const total = Number(connection.prepare('SELECT COUNT(*) AS total FROM web_companion_devices WHERE revoked_at IS NULL').get()!.total);
        if (total >= 30) throw new ApiError(429, 'Remove an old companion device before adding another.');
        const id = randomUUID(), token = randomBytes(32).toString('base64url'), created = Date.now();
        if (input.action === 'shortcut') {
          const deviceName = name(input.name, 'Save to Cliptext');
          connection.prepare("INSERT INTO web_companion_devices(id,kind,name,token_hash,created_at,paired_at) VALUES(?,'shortcut',?,?,?,?)").run(id, deviceName, hash(token), created, created);
          return json({ ...configuration(), shortcut: { v: 1, origin, libraryId, deviceId: id, token } });
        }
        const pending = Number(connection.prepare('SELECT COUNT(*) AS total FROM web_companion_devices WHERE paired_at IS NULL AND revoked_at IS NULL').get()!.total);
        if (pending >= 10) throw new ApiError(429, 'Wait for an unused pairing code to expire.');
        const expires = created + 10 * 60_000;
        connection.prepare("INSERT INTO web_companion_devices(id,kind,name,bootstrap_hash,created_at,expires_at) VALUES(?,'browser',?,?,?,?)").run(id, name(input.name, 'iPhone'), hash(token), created, expires);
        const code = Buffer.from(JSON.stringify({ v: 1, origin, libraryId, deviceId: id, token })).toString('base64url');
        return json({ ...configuration(), code, url: `${origin}/#pair=${code}`, expiresAt: new Date(expires).toISOString() });
      }
      throw new ApiError(400, 'Choose a companion action.');
    } catch (error) { return json({ error: error instanceof ApiError ? error.message : 'The companion settings could not be updated.' }, error instanceof ApiError ? error.status : 500); }
  });
  await listen();
  return { configuration, handleAdmin, close: () => sequence(async () => { closed = true; await stop(); }) };
}
