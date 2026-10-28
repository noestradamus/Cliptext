import { env } from 'cloudflare:workers';
import { getChatGPTUser } from '../app/chatgpt-auth';
import { shortSummary } from './library-upgrade';
import { limitedSuggestions } from './suggestions';
import { relevantCollectionId } from './collection-suggestions';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function db() {
  if (!env.DB) throw new ApiError(503, 'The transcript library is not ready. Please try again shortly.');
  return env.DB;
}

export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', 'Vary': 'Cookie' } });
}

export async function api(action: () => Promise<Response>) {
  try { return await action(); }
  catch (error) {
    if (error instanceof ApiError) return json({ error: error.message }, error.status);
    console.error('Cliptext API failed', error instanceof Error ? error.name : 'UnknownError');
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}

export async function owner() {
  const user = await getChatGPTUser();
  if (!user) throw new ApiError(401, 'Please sign in to your private transcript library.');
  // The standalone Mac owns one local library. Paired phone submissions enter
  // that same library through the separately authenticated phone transport.
  return 'owner';
}

export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new ApiError(403, 'Open Cliptext to add a link.');
  }
}

/** The loopback dispatcher checks the private engine bearer and key before
 * these routes run. Paired phones have a separate, restricted TLS dispatcher
 * that never exposes worker operations or desktop session credentials.
 */
export function engineRequest(request: Request) {
  if (request.headers.get('X-Cliptext-Engine') !== '1') throw new ApiError(403, 'This endpoint is for the local transcription engine.');
  const expected = env.CLIPTEXT_ENGINE_SECRET;
  if (!expected) throw new ApiError(503, 'The local engine connection is not configured.');
  const supplied = request.headers.get('X-Cliptext-Engine-Key') ?? '';
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
  if (difference !== 0) throw new ApiError(403, 'This endpoint is for the local transcription engine.');
  sameOrigin(request);
}

export async function body(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text();
  if (raw.length > 1_500_000) throw new ApiError(413, 'The submitted result is too large.');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new ApiError(400, 'The request could not be read.'); }
}

export function serializeJob(row: Record<string, unknown>) {
  let segments: unknown[] = [];
  try { segments = JSON.parse(String(row.segments || '[]')); } catch { /* Empty if legacy data is malformed. */ }
  const contentKind = row.content_kind === 'image' || row.content_kind === 'carousel' ? row.content_kind : 'video';
  let pages: { index: number; text: string; allText?: string }[] | null = null;
  if (contentKind !== 'video' && typeof row.pages === 'string') {
    try {
      const value = JSON.parse(row.pages);
      if (Array.isArray(value)) pages = value;
    } catch { /* Missing if legacy data is malformed. */ }
  }
  const pageCount = typeof row.page_count === 'number' ? row.page_count : pages?.length ?? 0;
  let tags:string[]=[];
  try {const value=JSON.parse(String(row.tags||'[]'));if(Array.isArray(value))tags=value.filter(x=>typeof x==='string');}catch{/* Legacy empty tags. */}
  const parse = (value: unknown, fallback: unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : fallback; } catch { return fallback; } };
  const originalPages = pages;
  const editedPages = parse(row.edited_pages, null);
  if (Array.isArray(editedPages)) pages = editedPages;
  const savedInsights = parse(row.insights, null);
  const insights = savedInsights && typeof savedInsights === 'object' && !Array.isArray(savedInsights)
    ? {...savedInsights, summary: shortSummary(typeof savedInsights.summary === 'string' ? savedInsights.summary : '')} : null;
  return {
    id: row.id, url: row.url, status: row.status, progress: row.progress,
    title: row.edited_title ?? row.generated_title ?? row.title, creator: row.creator, transcript: row.edited_transcript ?? row.transcript,
    originalTitle: row.title, generatedTitle: row.generated_title ?? null, editedTitle: row.edited_title ?? null, originalTranscript: row.transcript,
    ...('pages' in row ? { originalPages } : {}),
    notes: row.notes ?? '', highlights: parse(row.highlights, []), reviewedAt: row.reviewed_at ?? null, trashedAt: row.trashed_at ?? null,
    revision: row.revision ?? 0, insights, suggestions: limitedSuggestions(parse(row.suggestions, null)),
    insightStatus: row.insight_status ?? 'queued', insightError: row.insight_error ?? null, insightModel: row.insight_model ?? null,
    canonicalId: row.canonical_id ?? null, duplicateOf: row.duplicate_of ?? null,
    segments, language: row.language, durationSeconds: row.duration_seconds,
    contentKind, pageCount,
    ...('pages' in row ? { pages } : {}),
    ocrEngine: typeof row.ocr_engine === 'string' ? row.ocr_engine : null,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
    platform:row.platform||'tiktok',favorite:!!row.favorite,tags,collectionId:row.collection_id||null,preview:typeof row.preview==='string'?row.preview:'',
    // List and detail queries include compact frame metadata without storage keys.
    ...('frame_status' in row ? {
      frameStatus: row.frame_status || 'pending',
      frameUrl: row.frame_status === 'ready' ? `/api/jobs/${encodeURIComponent(String(row.id))}/frame` : null,
      frameWidth: row.frame_status === 'ready' ? row.frame_width : null,
      frameHeight: row.frame_status === 'ready' ? row.frame_height : null,
      frameKind: row.frame_status === 'ready' ? row.frame_kind || 'first_frame' : null,
    } : {}),
  };
}

/** Full jobs sent to the library share the same legacy proposal guard. */
export async function serializeFullJob(row: Record<string, unknown>, ownerId: string) {
  const result = serializeJob(row);
  if (result.suggestions?.collectionId) {
    const collection = await db().prepare('SELECT id,name FROM collections WHERE id=? AND owner_id=?').bind(result.suggestions.collectionId, ownerId).first();
    result.suggestions.collectionId = relevantCollectionId(result.suggestions.collectionId, collection, result.transcript);
  }
  return result;
}

export const dateNow = () => new Date().toISOString();
export const leaseExpiry = () => new Date(Date.now() + 30 * 60 * 1000).toISOString();

export function boundedText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.slice(0, maximum) : null;
}
