import { resolve } from 'node:path';
import { FileBucket, LocalDatabase } from './storage';

export type RuntimeOptions = { dataDir: string; engineKey: string; migrationsDir?: string };
export const env: { DB?: LocalDatabase; BUCKET?: FileBucket; CLIPTEXT_ENGINE_SECRET?: string;
  CLIPTEXT_NATIVE_TRANSPORT_TOKEN?: string } = {};
let active: ReturnType<typeof createRuntime> | null = null;

function createRuntime(options: RuntimeOptions) {
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(options.engineKey)) throw new Error('Use a valid private local engine key.');
  const dataDir = resolve(options.dataDir);
  const DB = new LocalDatabase(dataDir, options.migrationsDir);
  let BUCKET: FileBucket;
  try { BUCKET = new FileBucket(dataDir); }
  catch (error) { DB.close(); throw error; }
  return { DB, BUCKET, dataDir, databasePath: DB.databasePath,
    close() { DB.close(); } };
}

export function initializeRuntime(options: RuntimeOptions) {
  if (active) throw new Error('The local runtime is already initialized. Close it before opening another.');
  const runtime = createRuntime(options);
  active = runtime;
  env.DB = runtime.DB;
  env.BUCKET = runtime.BUCKET;
  env.CLIPTEXT_ENGINE_SECRET = options.engineKey;
  // Cloud transport credentials are deliberately absent in a local runtime.
  delete env.CLIPTEXT_NATIVE_TRANSPORT_TOKEN;
  return { ...runtime, close() {
    if (active !== runtime) return;
    runtime.close();
    active = null;
    delete env.DB;
    delete env.BUCKET;
    delete env.CLIPTEXT_ENGINE_SECRET;
  } };
}
