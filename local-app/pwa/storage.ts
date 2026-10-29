import type { Collection, LibrarySnapshot, OutboxLink, PhoneJob, SyncPage } from './types';
import { EMPTY_SNAPSHOT } from './types';

const DATABASE = 'cliptext-phone-v1';
const VERSION = 1;
type Meta = { key: 'active'; libraryId: string; cursor: number; lastSync: number | null; collections: Collection[] };
type SavedJob = { key: string; libraryId: string; job: PhoneJob };
type SavedLink = OutboxLink & { key: string; libraryId: string };

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error ?? new Error('Phone storage is unavailable.')); });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error ?? new Error('The phone copy could not be saved.')); transaction.onerror = () => {}; });
}

/** Reject invalid pages before a transaction can replace data or advance its cursor. */
export function checkedSyncPage(input: unknown, cursor: number): SyncPage {
  if (!input || typeof input !== 'object') throw new Error('The Mac sent an unreadable sync page.');
  const page = input as Record<string, unknown>;
  if (!Array.isArray(page.changes) || !Array.isArray(page.collections) || !Number.isSafeInteger(page.cursor) || Number(page.cursor) < cursor || typeof page.hasMore !== 'boolean') throw new Error('The Mac sent an invalid sync cursor.');
  let previous = cursor;
  for (const value of page.changes) {
    if (!value || typeof value !== 'object') throw new Error('The Mac sent an invalid library change.');
    const change = value as Record<string, unknown>;
    if (!Number.isSafeInteger(change.seq) || Number(change.seq) <= previous || Number(change.seq) > Number(page.cursor) || typeof change.id !== 'string' || !change.id || typeof change.deleted !== 'boolean') throw new Error('The Mac sent an invalid library change.');
    if (!change.deleted) {
      const job = change.job as Record<string, unknown> | undefined;
      if (!job || job.id !== change.id || typeof job.url !== 'string' || !['queued', 'downloading', 'transcribing', 'completed', 'failed'].includes(String(job.status)) || !(job.transcript === null || typeof job.transcript === 'string') || !Array.isArray(job.tags)) throw new Error('The Mac sent an incomplete transcript.');
    }
    previous = Number(change.seq);
  }
  // A cursor may only acknowledge a change actually included in the response.
  if (previous !== page.cursor || page.hasMore && !page.changes.length) throw new Error('The Mac skipped a library change.');
  for (const value of page.collections) if (!value || typeof value.id !== 'string' || typeof value.name !== 'string') throw new Error('The Mac sent an invalid collection.');
  return input as SyncPage;
}

export class PhoneStorage {
  private database: Promise<IDBDatabase>;
  constructor(factory: IDBFactory = indexedDB, name = DATABASE) {
    this.database = new Promise((resolve, reject) => {
      const request = factory.open(name, VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore('meta', { keyPath: 'key' });
        database.createObjectStore('jobs', { keyPath: 'key' }).createIndex('libraryId', 'libraryId');
        database.createObjectStore('outbox', { keyPath: 'key' }).createIndex('libraryId', 'libraryId');
      };
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error ?? new Error('Phone storage is unavailable.'));
      request.onblocked = () => reject(new Error('Close other Cliptext windows and reopen.'));
    });
  }
  async snapshot(): Promise<LibrarySnapshot> {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'jobs', 'outbox'], 'readonly');
    const done = completed(transaction);
    const [meta, jobs, outbox] = await Promise.all([
      result<Meta | undefined>(transaction.objectStore('meta').get('active')),
      result<SavedJob[]>(transaction.objectStore('jobs').getAll()),
      result<SavedLink[]>(transaction.objectStore('outbox').getAll()),
    ]);
    await done;
    if (!meta) return { ...EMPTY_SNAPSHOT };
    return { libraryId: meta.libraryId, cursor: meta.cursor, lastSync: meta.lastSync, collections: meta.collections,
      jobs: jobs.filter(row => row.libraryId === meta.libraryId).map(row => row.job).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      outbox: outbox.filter(row => row.libraryId === meta.libraryId).map(({ key: _key, libraryId: _libraryId, ...link }) => link).sort((a, b) => a.createdAt - b.createdAt) };
  }
  async connect(libraryId: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(libraryId)) throw new Error('The Mac sent an invalid library identity.');
    const database = await this.database;
    const transaction = database.transaction(['meta', 'jobs', 'outbox'], 'readwrite');
    const done = completed(transaction);
    const request = transaction.objectStore('meta').get('active');
    request.onsuccess = () => {
      const current = request.result as Meta | undefined;
      transaction.objectStore('meta').delete('disconnected');
      if (current?.libraryId === libraryId) return;
      // An explicit new pairing replaces the old phone copy. Never send another
      // Mac's pending links to this library, even if its origin was reused.
      transaction.objectStore('jobs').clear(); transaction.objectStore('outbox').clear();
      transaction.objectStore('meta').put({ key: 'active', libraryId, cursor: 0, lastSync: null, collections: [] } satisfies Meta);
    };
    await done;
  }
  async applyPage(libraryId: string, cursor: number, input: unknown): Promise<void> {
    const page = checkedSyncPage(input, cursor);
    const database = await this.database;
    const transaction = database.transaction(['meta', 'jobs'], 'readwrite');
    const done = completed(transaction);
    const request = transaction.objectStore('meta').get('active');
    request.onsuccess = () => {
      const meta = request.result as Meta | undefined;
      if (!meta || meta.libraryId !== libraryId || meta.cursor !== cursor) { transaction.abort(); return; }
      for (const change of page.changes) {
        const key = `${libraryId}:${change.id}`;
        if (change.deleted) transaction.objectStore('jobs').delete(key);
        else transaction.objectStore('jobs').put({ key, libraryId, job: change.job! } satisfies SavedJob);
      }
      transaction.objectStore('meta').put({ ...meta, cursor: page.cursor, collections: page.collections, lastSync: Date.now() } satisfies Meta);
    };
    await done;
  }
  async resetHistory(libraryId: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'jobs'], 'readwrite');
    const done = completed(transaction);
    const request = transaction.objectStore('meta').get('active');
    request.onsuccess = () => {
      const meta = request.result as Meta | undefined;
      if (meta?.libraryId !== libraryId) { transaction.abort(); return; }
      transaction.objectStore('jobs').clear();
      transaction.objectStore('meta').put({ ...meta, cursor: 0, collections: [], lastSync: null } satisfies Meta);
    };
    await done;
  }
  async enqueue(libraryId: string, url: string, requestId = crypto.randomUUID()): Promise<OutboxLink> {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'outbox'], 'readwrite');
    const done = completed(transaction);
    const entry = { requestId, url, createdAt: Date.now() };
    const request = transaction.objectStore('meta').get('active');
    request.onsuccess = () => {
      if ((request.result as Meta | undefined)?.libraryId !== libraryId) { transaction.abort(); return; }
      transaction.objectStore('outbox').put({ ...entry, key: `${libraryId}:${requestId}`, libraryId } satisfies SavedLink);
    };
    await done;
    return entry;
  }
  async acknowledge(libraryId: string, requestId: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('outbox', 'readwrite'); const done = completed(transaction);
    transaction.objectStore('outbox').delete(`${libraryId}:${requestId}`);
    await done;
  }
  async markError(libraryId: string, requestId: string, error: string): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction('outbox', 'readwrite'); const done = completed(transaction);
    const request = transaction.objectStore('outbox').get(`${libraryId}:${requestId}`);
    request.onsuccess = () => { if (request.result) transaction.objectStore('outbox').put({ ...request.result, error }); };
    await done;
  }
  async isDisconnected(): Promise<boolean> {
    const database = await this.database;
    const transaction = database.transaction('meta', 'readonly'); const done = completed(transaction);
    const marker = await result(transaction.objectStore('meta').get('disconnected'));
    await done; return !!marker;
  }
  async forget(): Promise<void> {
    const database = await this.database;
    const transaction = database.transaction(['meta', 'jobs', 'outbox'], 'readwrite'); const done = completed(transaction);
    for (const name of ['meta', 'jobs', 'outbox']) transaction.objectStore(name).clear();
    transaction.objectStore('meta').put({ key: 'disconnected' });
    await done;
  }
  async close(): Promise<void> { (await this.database).close(); }
}
