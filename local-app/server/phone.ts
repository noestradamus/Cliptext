import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { ApiError, serializeJob } from '../../lib/server';
import { submitJob } from '../../lib/submit';
import { extractVideoUrl } from '../../lib/video';
import type { LocalDatabase } from './storage';
import { phoneIdentity, type PhoneIdentity } from './phone-certificate';

export type PhoneConfiguration = {
  enabled: boolean; port: number; endpoints: string[]; fingerprint: string | null; address: string | null;
  devices: { id: string; name: string; lastSeen: string | null }[]; error?: string;
};
export type PhoneSyncOptions = { DB: LocalDatabase; dataDir: string; port?: number };
export type PhoneSync = {
  configuration(): PhoneConfiguration;
  /** Only the authenticated loopback HTTP router may call this administrative handler. */
  handleAdmin(request: Request): Promise<Response>;
  close(): Promise<void>;
};

const DEFAULT_PORT = 47322;
const PAIR_LIFETIME = 10 * 60_000;
const MAX_REQUEST = 8_192;
const PAGE_BYTES = 8 * 1024 * 1024;
const SINGLE_CHANGE_BYTES = 24 * 1024 * 1024;
const OWNER = 'owner';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Device = { id: string; name: string; paired_at: number | null; expires_at: number; revoked_at: number | null };

function privateIPv4(value: string) {
  const parts = value.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 10 || parts[0] === 192 && parts[1] === 168 ||
    parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31 ||
    parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function phoneEndpoints(port: number): string[] {
  const addresses = Object.values(networkInterfaces()).flatMap(values => values ?? [])
    .filter(value => !value.internal && value.family === 'IPv4' && privateIPv4(value.address))
    .map(value => `https://${value.address}:${port}`).sort();
  const localName = hostname().toLowerCase();
  if (/^[a-z0-9][a-z0-9.-]*\.local$/.test(localName)) addresses.push(`https://${localName}:${port}`);
  return [...new Set(addresses)];
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function object(text: string): Record<string, unknown> {
  if (Buffer.byteLength(text) > MAX_REQUEST) throw new ApiError(413, 'The phone request is too large.');
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'The phone request could not be read.'); }
}

/** Transfer the effective reading copy, without source duplicates or Mac-only tools. */
export function phoneJob(row: Record<string, unknown>) {
  const job = serializeJob(row);
  const insights = job.insights ? {
    summary: job.insights.summary,
    takeaways: Array.isArray(job.insights.takeaways) ? job.insights.takeaways.filter((value: unknown): value is string => typeof value === 'string').slice(0, 20).map((value: string) => value.slice(0, 2000)) : [],
  } : null;
  return {
    id: job.id, url: job.url, title: job.title, creator: job.creator, platform: job.platform,
    status: job.status, progress: job.progress, transcript: job.transcript,
    pages: Array.isArray(job.pages) ? job.pages.map(page => ({ index: page.index, text: page.text })) : null,
    notes: job.notes, insights, tags: job.tags, collectionId: job.collectionId,
    favorite: job.favorite, reviewedAt: job.reviewedAt, createdAt: job.createdAt, updatedAt: job.updatedAt,
    revision: job.revision, error: job.error, contentKind: job.contentKind, pageCount: job.pageCount,
    language: job.language, durationSeconds: job.durationSeconds,
  };
}

function safeAddress(input: unknown, port: number): string | null {
  if (input === '' || input === null) return null;
  if (typeof input !== 'string' || input.length > 300) throw new ApiError(400, 'Enter an HTTPS Mac or Tailscale address.');
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new ApiError(400, 'Enter an HTTPS Mac or Tailscale address.'); }
  const host = url.hostname.toLowerCase();
  const privateName = /^[a-z0-9][a-z0-9.-]*\.(?:local|ts\.net)$/.test(host);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      Number(url.port || 443) !== port || !(privateIPv4(host) || privateName)) {
    throw new ApiError(400, `Use a private HTTPS Mac address on port ${port}.`);
  }
  return url.origin;
}

/** A separate, explicitly enabled TLS surface; library and worker routes stay loopback-only. */
export async function startPhoneSync({ DB, dataDir, port }: PhoneSyncOptions): Promise<PhoneSync> {
  const connection = DB.connection;
  const settings = connection.prepare('SELECT enabled,port,addresses FROM phone_sync_settings WHERE id=1').get()!;
  let enabled = settings.enabled === 1;
  const configuredPort = port ?? Number(settings.port) ?? DEFAULT_PORT;
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) throw new Error('Invalid phone sync port.');
  if (port !== undefined && port > 0) connection.prepare('UPDATE phone_sync_settings SET port=? WHERE id=1').run(port);
  let identity: PhoneIdentity | null = null;
  let server: Server | null = null;
  let sockets = new Set<Duplex>();
  let activePort = configuredPort;
  let error: string | undefined;
  let closed = false;
  let operations: Promise<unknown> = Promise.resolve();
  const sequence = <T>(action: () => Promise<T>): Promise<T> => {
    const result = operations.then(action, action);
    operations = result.catch(() => undefined);
    return result;
  };
  const configuredAddresses = () => {
    try {
      const row = connection.prepare('SELECT addresses FROM phone_sync_settings WHERE id=1').get()!;
      const parsed = JSON.parse(String(row.addresses));
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch { return []; }
  };
  const endpoints = () => enabled ? [...new Set([...configuredAddresses(), ...phoneEndpoints(activePort)])] : [];
  const configuration = (): PhoneConfiguration => ({
    enabled, port: activePort, endpoints: endpoints(), fingerprint: identity?.fingerprint ?? null, address: configuredAddresses()[0] ?? null,
    devices: connection.prepare('SELECT id,name,last_seen FROM phone_sync_devices WHERE paired_at IS NOT NULL AND revoked_at IS NULL ORDER BY paired_at,id').all()
      .map(value => ({ id: String(value.id), name: String(value.name), lastSeen: value.last_seen == null ? null : new Date(Number(value.last_seen)).toISOString() })),
    ...(error ? { error } : {}),
  });

  function authenticate(request: IncomingMessage, pending = false): Device {
    if (!enabled || closed) throw new ApiError(503, 'Phone sharing is stopped. Try again when the Mac is available.');
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw new ApiError(401, 'Connect this phone to Cliptext again.');
    const hash = createHash('sha256').update(authorization.slice(7)).digest('hex');
    const device = connection.prepare(`SELECT id,name,paired_at,expires_at,revoked_at FROM phone_sync_devices WHERE ${pending ? 'bootstrap_hash' : 'token_hash'}=?`).get(hash) as Device | undefined;
    // The QR capability is always time-limited, including after activation.
    // Only the different durable device capability may access links or sync.
    if (!device || device.revoked_at !== null || (pending ? device.expires_at <= Date.now() : device.paired_at === null)) throw new ApiError(401, 'Connect this phone to Cliptext again.');
    return device;
  }

  async function readBody(request: IncomingMessage) {
    if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Send this request as JSON.');
    const length = request.headers['content-length'];
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST)) throw new ApiError(413, 'The phone request is too large.');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_REQUEST) throw new ApiError(413, 'The phone request is too large.');
      chunks.push(bytes);
    }
    return object(Buffer.concat(chunks).toString('utf8'));
  }

  function sync(url: URL) {
    if (url.searchParams.getAll('cursor').length > 1 || url.searchParams.getAll('limit').length > 1) throw new ApiError(400, 'Invalid sync cursor.');
    const rawCursor = url.searchParams.get('cursor') ?? '0', rawLimit = url.searchParams.get('limit') ?? '50';
    const cursor = Number(rawCursor), limit = Number(rawLimit);
    if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor) || !/^\d+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new ApiError(400, 'Choose a valid sync cursor and a limit from 1 to 50.');
    const maximum = Number(connection.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM phone_sync_changes WHERE owner_id=?').get(OWNER)!.seq);
    if (cursor > maximum) return json({ error: 'This library has a different sync history.', resetRequired: true }, 409);
    const rows = connection.prepare('SELECT seq,job_id,deleted FROM phone_sync_changes WHERE owner_id=? AND seq>? ORDER BY seq LIMIT ?').all(OWNER, cursor, limit + 1);
    const collections = connection.prepare('SELECT id,name FROM collections WHERE owner_id=? ORDER BY name COLLATE NOCASE,id').all(OWNER).map(row => ({ id: String(row.id), name: String(row.name) }));
    const changes: { seq: number; id: string; deleted: boolean; job?: ReturnType<typeof phoneJob> }[] = [];
    let next = cursor, size = Buffer.byteLength(JSON.stringify(collections)) + 256;
    for (const row of rows.slice(0, limit)) {
      const job = connection.prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').get(String(row.job_id), OWNER);
      const deleted = !!row.deleted || !job || job.trashed_at !== null || job.duplicate_of !== null;
      const change = { seq: Number(row.seq), id: String(row.job_id), deleted, ...(!deleted && job ? { job: phoneJob(job) } : {}) };
      const bytes = Buffer.byteLength(JSON.stringify(change));
      if (bytes > SINGLE_CHANGE_BYTES) throw new ApiError(413, 'One library item is too large to sync to this phone.');
      if (changes.length && size + bytes > PAGE_BYTES) break;
      changes.push(change); size += bytes; next = change.seq;
    }
    return json({ changes, cursor: next, hasMore: rows.some(row => Number(row.seq) > next), collections });
  }

  async function receive(request: IncomingMessage): Promise<Response> {
    if (request.headers.origin !== undefined || request.headers.referer !== undefined || Object.keys(request.headers).some(name => name.startsWith('sec-fetch-')) || request.method === 'OPTIONS') throw new ApiError(403, 'Phone sync accepts native app requests only.');
    if (!request.url?.startsWith('/') || request.url.startsWith('//') || !request.headers.host) throw new ApiError(400, 'Invalid phone request.');
    let url: URL;
    try { url = new URL(request.url, `https://${request.headers.host}`); } catch { throw new ApiError(400, 'Invalid phone request.'); }
    // The phone can learn a stable MagicDNS/mDNS address after initial pairing.
    // Trust comes from the certificate pin + bearer, not the Mac's IP inventory.
    const host = url.hostname.toLowerCase();
    const privateHost = privateIPv4(host) || /^[a-z0-9][a-z0-9.-]*\.(?:local|ts\.net)$/.test(host);
    if (!(privateHost || host === '127.0.0.1' || host === 'localhost') || Number(url.port || 443) !== activePort) throw new ApiError(403, 'Use a private Mac address on the phone sync port.');
    const isPair = url.pathname === '/api/phone/pair' && request.method === 'POST';
    if (!isPair && !(url.pathname === '/api/phone/links' && request.method === 'POST') && !(url.pathname === '/api/phone/sync' && request.method === 'GET')) throw new ApiError(404, 'Phone endpoint not found.');
    const device = authenticate(request, isPair);
    if (isPair) {
      const input = await readBody(request);
      if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) throw new ApiError(400, 'Choose a phone name under 80 characters.');
      // A response can be lost after activation. Retrying the same token is safe.
      const current = authenticate(request, true);
      if (current.paired_at !== null && current.name !== input.name.trim()) throw new ApiError(409, 'This phone is already connected with a different name.');
      // A private, persistent HMAC secret makes lost-response retries return the
      // same device capability without storing that capability in plaintext.
      const token = createHmac('sha256', Buffer.from(identity!.pairingSecret, 'base64url'))
        .update('cliptext-phone-device-v1\0').update(device.id).update('\0').update(request.headers.authorization!.slice(7)).digest('base64url');
      if (current.paired_at === null) connection.prepare('UPDATE phone_sync_devices SET name=?,paired_at=?,last_seen=?,token_hash=? WHERE id=? AND paired_at IS NULL AND revoked_at IS NULL')
        .run(input.name.trim(), Date.now(), Date.now(), createHash('sha256').update(token).digest('hex'), device.id);
      return json({ deviceId: device.id, token });
    }
    if (url.pathname === '/api/phone/links') {
      const input = await readBody(request);
      if (typeof input.requestId !== 'string' || !UUID.test(input.requestId) || typeof input.url !== 'string' || input.url.length > 4096) throw new ApiError(400, 'Send a link with a valid request ID.');
      const canonical = extractVideoUrl(input.url);
      if (!canonical) throw new ApiError(400, 'Share a supported TikTok, YouTube, or Instagram post link.');
      // submitJob performs only local SQLite operations. Its already-resolved
      // awaits complete before another HTTP callback can run; the receipt and
      // canonical duplicate handling commit together, including after a retry.
      connection.exec('BEGIN IMMEDIATE');
      try {
        authenticate(request);
        const receipt = connection.prepare('SELECT request_url,job_id FROM phone_sync_receipts WHERE device_id=? AND request_id=?').get(device.id, input.requestId.toLowerCase());
        let jobId: string;
        if (receipt) {
          if (receipt.request_url !== canonical) throw new ApiError(409, 'This request ID was already used for another link.');
          jobId = String(receipt.job_id);
        } else {
          const job = await submitJob(canonical, OWNER);
          jobId = String(job.id);
          connection.prepare('INSERT INTO phone_sync_receipts(device_id,request_id,request_url,job_id,created_at) VALUES(?,?,?,?,?)').run(device.id, input.requestId.toLowerCase(), canonical, jobId, Date.now());
        }
        connection.prepare('UPDATE phone_sync_devices SET last_seen=? WHERE id=?').run(Date.now(), device.id);
        connection.exec('COMMIT');
        return json({ jobId });
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
    }
    const response = sync(url);
    connection.prepare('UPDATE phone_sync_devices SET last_seen=? WHERE id=?').run(Date.now(), device.id);
    return response;
  }

  async function send(request: IncomingMessage, response: ServerResponse) {
    let result: Response;
    try { result = await receive(request); }
    catch (error) { result = json({ error: error instanceof ApiError ? error.message : 'Phone sync could not complete this request.' }, error instanceof ApiError ? error.status : 500); }
    response.writeHead(result.status, { ...Object.fromEntries(result.headers), Connection: 'close' });
    response.end(Buffer.from(await result.arrayBuffer()));
    request.resume();
  }

  async function stop() {
    const current = server; server = null;
    const clients = sockets; sockets = new Set();
    if (!current) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        current.closeAllConnections();
        // HTTPS also owns raw TCP clients that have not finished a TLS handshake.
        // They are outside HTTP's connection tracker and must share this deadline.
        for (const socket of clients) socket.destroy();
      }, 2000);
      timer.unref();
      current.close(() => { clearTimeout(timer); resolve(); });
      current.closeIdleConnections();
    });
  }
  async function listen() {
    if (server || !enabled || closed) return;
    try {
      identity = await phoneIdentity(dataDir);
      const next = createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, (request, response) => { void send(request, response).catch(() => response.destroy()); });
      const clients = new Set<Duplex>();
      next.on('connection', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
      next.requestTimeout = 15_000; next.headersTimeout = 10_000; next.keepAliveTimeout = 1000; next.maxRequestsPerSocket = 100;
      next.on('error', () => { error = 'Phone sharing could not listen on this port. Check whether another app is using it.'; });
      await new Promise<void>((resolve, reject) => { next.once('error', reject); next.listen(configuredPort, '0.0.0.0', () => { next.removeListener('error', reject); resolve(); }); });
      server = next; sockets = clients; activePort = (next.address() as AddressInfo).port; error = undefined;
    } catch { error = 'Phone sharing could not start. Check the Mac network and try enabling it again.'; }
  }

  const handleAdmin = (request: Request) => sequence(async () => {
    try {
      if (closed) throw new ApiError(503, 'Phone sharing has stopped.');
      if (new URL(request.url).pathname !== '/api/local/phone') throw new ApiError(404, 'Phone settings not found.');
      if (request.method === 'GET') return json(configuration());
      if (request.method !== 'POST') throw new ApiError(405, 'Use GET or POST for phone settings.');
      const input = object(await request.text());
      if (input.action === 'enable') {
        enabled = true; connection.prepare('UPDATE phone_sync_settings SET enabled=1 WHERE id=1').run();
        await listen(); return json(configuration());
      }
      if (input.action === 'disable') {
        enabled = false; connection.prepare('UPDATE phone_sync_settings SET enabled=0 WHERE id=1').run();
        connection.prepare('DELETE FROM phone_sync_devices WHERE paired_at IS NULL').run();
        await stop(); error = undefined; return json(configuration());
      }
      if (input.action === 'address') {
        const address = safeAddress(input.address, activePort || DEFAULT_PORT);
        connection.prepare('UPDATE phone_sync_settings SET addresses=? WHERE id=1').run(JSON.stringify(address ? [address] : []));
        return json(configuration());
      }
      if (input.action === 'revoke') {
        if (typeof input.deviceId !== 'string' || !UUID.test(input.deviceId)) throw new ApiError(400, 'Choose a connected phone.');
        const result = connection.prepare('UPDATE phone_sync_devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(Date.now(), input.deviceId);
        if (!result.changes) throw new ApiError(404, 'Connected phone not found.');
        return json(configuration());
      }
      if (input.action === 'pair') {
        if (!enabled || !server || !identity) throw new ApiError(409, 'Enable phone sharing first.');
        const urls = endpoints();
        if (!urls.length) throw new ApiError(409, 'Connect the Mac to Wi-Fi or Tailscale first.');
        connection.prepare('DELETE FROM phone_sync_devices WHERE paired_at IS NULL AND (expires_at<=? OR revoked_at IS NOT NULL)').run(Date.now());
        const count = connection.prepare('SELECT COUNT(*) AS count FROM phone_sync_devices WHERE revoked_at IS NULL').get()!;
        if (Number(count.count) >= 20) throw new ApiError(429, 'Remove an old phone or wait for a pairing code to expire.');
        const pending = connection.prepare('SELECT COUNT(*) AS count FROM phone_sync_devices WHERE paired_at IS NULL AND revoked_at IS NULL').get()!;
        if (Number(pending.count) >= 10) throw new ApiError(429, 'Wait for an unused pairing code to expire.');
        const deviceId = randomUUID(), token = randomBytes(32).toString('base64url'), expires = Date.now() + PAIR_LIFETIME;
        const hash = createHash('sha256').update(token).digest('hex');
        connection.prepare('INSERT INTO phone_sync_devices(id,token_hash,bootstrap_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(deviceId, hash, hash, Date.now(), expires);
        const code = Buffer.from(JSON.stringify({ v: 1, endpoints: urls, fingerprint: identity.fingerprint, deviceId, token })).toString('base64url');
        return json({ ...configuration(), code, expiresAt: new Date(expires).toISOString() });
      }
      throw new ApiError(400, 'Choose a phone sharing action.');
    } catch (error) { return json({ error: error instanceof ApiError ? error.message : 'Phone settings could not be updated.' }, error instanceof ApiError ? error.status : 500); }
  });
  await listen();
  return { configuration, handleAdmin, close: () => sequence(async () => { closed = true; await stop(); }) };
}
