import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Row = Record<string, any>;
type SqlValue = string | number | bigint | null | Uint8Array;
export type LocalResult<T = Row> = {
  success: true;
  results: T[];
  meta: { changes: number; last_row_id: number; duration: number; rows_read: number; rows_written: number };
};

function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!statSync(path).isDirectory()) throw new Error('The local storage path must be a directory.');
  chmodSync(path, 0o700);
}

function sqlValue(value: unknown): SqlValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'bigint' || value instanceof Uint8Array) return value;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new TypeError('Unsupported SQLite binding. Use a string, finite number, bytes, or null.');
}

export class LocalStatement {
  readonly database: LocalDatabase;
  readonly sql: string;
  readonly values: SqlValue[];
  constructor(database: LocalDatabase, sql: string, values: SqlValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]) { return new LocalStatement(this.database, this.sql, values.map(sqlValue)); }

  private statement() { return this.database.connection.prepare(this.sql); }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.statement().get(...this.values) as Row | undefined;
    if (!row) return null;
    if (column !== undefined) {
      if (!Object.hasOwn(row, column)) throw new Error('The selected SQLite column does not exist.');
      return row[column] as T;
    }
    return { ...row } as T;
  }

  execute<T = Row>(): LocalResult<T> {
    const started = performance.now();
    const results = this.statement().all(...this.values).map(row => ({ ...row })) as T[];
    const state = this.database.connection.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get()!;
    const changes = Number(state.changes);
    return { success: true, results, meta: { changes, last_row_id: Number(state.last_row_id),
      duration: performance.now() - started, rows_read: results.length, rows_written: changes } };
  }

  async all<T = Row>() { return this.execute<T>(); }
  async run<T = Row>() { return this.execute<T>(); }
  async raw<T = unknown[]>(options: { columnNames?: boolean } = {}): Promise<T[]> {
    const statement = this.statement();
    statement.setReturnArrays(true);
    const rows = statement.all(...this.values) as unknown as T[];
    return options.columnNames ? [statement.columns().map(column => column.name) as unknown as T, ...rows] : rows;
  }
}

export class LocalDatabase {
  readonly connection: DatabaseSync;
  readonly databasePath: string;
  readonly migrationBackup: string | null;

  constructor(dataDir: string, migrationsDir = fileURLToPath(new URL('../../drizzle/', import.meta.url))) {
    dataDir = resolve(dataDir);
    privateDirectory(dataDir);
    this.databasePath = join(dataDir, 'library.sqlite');
    this.connection = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    this.connection.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    try {
      this.migrationBackup = this.migrate(resolve(migrationsDir));
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  private migrate(directory: string): string | null {
    const files = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error('No local database migrations were provided.');
    const knownTables = this.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const managed = knownTables.some(row => row.name === 'schema_migrations');
    if (!managed && knownTables.length) throw new Error('This SQLite file has no Cliptext migration history. Import the library into a new local data directory.');
    this.connection.exec('CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY NOT NULL,sha256 TEXT NOT NULL,applied_at TEXT NOT NULL)');
    const recorded = new Map(this.connection.prepare('SELECT name,sha256 FROM schema_migrations ORDER BY name').all()
      .map(row => [String(row.name), String(row.sha256)]));
    const migrations = files.map(name => {
      const sql = readFileSync(join(directory, name), 'utf8');
      return { name, sql, sha256: createHash('sha256').update(sql).digest('hex') };
    });
    for (const [name, hash] of recorded) {
      if (!migrations.some(item => item.name === name && item.sha256 === hash)) throw new Error('Applied database migrations differ from this application. Use a compatible version or restore a backup.');
    }
    const pending = migrations.filter(item => !recorded.has(item.name));
    if (!pending.length) return null;
    let backup: string | null = null;
    if (recorded.size) {
      const directory = join(dirname(this.databasePath), 'migration-backups');
      privateDirectory(directory);
      backup = join(directory, `library-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.sqlite`);
      this.connection.prepare('VACUUM main INTO ?').run(backup);
      chmodSync(backup, 0o600);
    }
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      for (const migration of pending) {
        this.connection.exec(migration.sql);
        this.connection.prepare('INSERT INTO schema_migrations(name,sha256,applied_at) VALUES(?,?,?)')
          .run(migration.name, migration.sha256, new Date().toISOString());
      }
      this.connection.exec('COMMIT');
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
    return backup;
  }

  prepare(sql: string) { return new LocalStatement(this, sql); }

  async batch<T = Row>(statements: LocalStatement[]): Promise<LocalResult<T>[]> {
    if (statements.some(statement => statement.database !== this)) throw new Error('A transaction must use one local database.');
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.execute<T>());
      this.connection.exec('COMMIT');
      return results;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string) {
    const started = performance.now();
    this.connection.exec(sql);
    return { count: 1, duration: performance.now() - started };
  }

  close() { this.connection.close(); }
}

type ObjectMetadata = { contentType?: string; contentLanguage?: string; contentDisposition?: string;
  contentEncoding?: string; cacheControl?: string; cacheExpiry?: Date | string };
type StoredHeader = { key: string; etag: string; uploaded: string; metadata: ObjectMetadata };
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;

function objectKey(key: string): string {
  if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024) throw new TypeError('Invalid local image key.');
  return createHash('sha256').update(key).digest('hex');
}

function normalizeMetadata(input: ObjectMetadata = {}): ObjectMetadata {
  const output: ObjectMetadata = {};
  for (const name of ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl', 'cacheExpiry'] as const) {
    const value = input[name];
    if (value === undefined) continue;
    const text = value instanceof Date ? value.toISOString() : value;
    if (typeof text !== 'string' || text.length > 4096 || /[\r\n]/.test(text)) throw new TypeError('Invalid local image metadata.');
    output[name] = text;
  }
  return output;
}

async function objectBytes(input: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string): Promise<Buffer> {
  if (typeof input === 'string') return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) return Buffer.from(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  const reader = input instanceof Blob ? input.stream().getReader() : input.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_OBJECT_BYTES) { await reader.cancel(); throw new Error('The local image exceeds its storage limit.'); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export class FileBucket {
  readonly directory: string;
  constructor(dataDir: string) {
    this.directory = join(resolve(dataDir), 'assets');
    privateDirectory(this.directory);
  }

  private path(key: string) { return join(this.directory, objectKey(key) + '.asset'); }
  private async syncDirectory() {
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async put(key: string, input: ArrayBuffer | ArrayBufferView | Blob | ReadableStream | string,
            options: { httpMetadata?: ObjectMetadata } = {}) {
    const path = this.path(key);
    const bytes = await objectBytes(input);
    if (bytes.byteLength > MAX_OBJECT_BYTES) throw new Error('The local image exceeds its storage limit.');
    const header: StoredHeader = { key, etag: createHash('sha256').update(bytes).digest('hex'),
      uploaded: new Date().toISOString(), metadata: normalizeMetadata(options.httpMetadata) };
    const encoded = Buffer.from(JSON.stringify(header));
    if (encoded.byteLength > MAX_HEADER_BYTES) throw new Error('The local image metadata exceeds its storage limit.');
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(encoded.byteLength);
    const temporary = path + '.' + randomUUID() + '.partial';
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(Buffer.concat([prefix, encoded, bytes])); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
      await this.syncDirectory();
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    return { key, size: bytes.byteLength, etag: header.etag, httpEtag: `"${header.etag}"`, uploaded: new Date(header.uploaded), httpMetadata: header.metadata };
  }

  async get(key: string) {
    const path = this.path(key);
    let stored: Buffer;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_OBJECT_BYTES + MAX_HEADER_BYTES + 4) throw new Error('The local image file is invalid.');
      stored = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (stored.byteLength < 4) throw new Error('The local image header is invalid.');
    const length = stored.readUInt32BE(0);
    if (length > MAX_HEADER_BYTES || length + 4 > stored.byteLength) throw new Error('The local image header is invalid.');
    const header = JSON.parse(stored.subarray(4, length + 4).toString('utf8')) as StoredHeader;
    const bytes = stored.subarray(length + 4);
    if (header.key !== key || createHash('sha256').update(bytes).digest('hex') !== header.etag) throw new Error('The local image integrity check failed.');
    const httpMetadata = normalizeMetadata(header.metadata);
    return { key, size: bytes.byteLength, etag: header.etag, httpEtag: `"${header.etag}"`, uploaded: new Date(header.uploaded),
      httpMetadata,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(bytes)); controller.close(); } }),
      async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
      writeHttpMetadata(headers: Headers) {
        const names = { contentType: 'Content-Type', contentLanguage: 'Content-Language', contentDisposition: 'Content-Disposition',
          contentEncoding: 'Content-Encoding', cacheControl: 'Cache-Control', cacheExpiry: 'Expires' };
        for (const [name, value] of Object.entries(httpMetadata)) if (value !== undefined) headers.set(names[name as keyof typeof names], String(value));
      } };
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await unlink(this.path(key)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await this.syncDirectory();
  }
}
