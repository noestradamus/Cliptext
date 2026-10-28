import { api, ApiError, body, boundedText, dateNow, db, engineRequest, json, leaseExpiry, serializeJob } from '../../../../../lib/server';

export const dynamic = 'force-dynamic';

type ContentKind = 'video' | 'image' | 'carousel';
type OcrPage = { index: number; text: string; allText?: string };
const MAX_TEXT_LENGTH = 250_000;

function imageResult(input: Record<string, unknown>, contentKind: 'image' | 'carousel') {
  if (!Array.isArray(input.pages) || input.pages.length < (contentKind === 'image' ? 1 : 2) || input.pages.length > 35 || (contentKind === 'image' && input.pages.length !== 1)) {
    throw new ApiError(400, 'An image needs one page and a carousel needs 2–35 ordered pages.');
  }
  let length = 0;
  let allTextLength = 0;
  const pages: OcrPage[] = input.pages.map((page, offset) => {
    if (!page || typeof page !== 'object' || Array.isArray(page) || page.index !== offset + 1 || typeof page.text !== 'string') {
      throw new ApiError(400, 'Each page needs its consecutive index and text.');
    }
    length += page.text.length;
    if (length > MAX_TEXT_LENGTH) throw new ApiError(413, 'The extracted text is too large.');
    if ('allText' in page) {
      if (typeof page.allText !== 'string') throw new ApiError(400, 'A page’s full OCR text must be text.');
      allTextLength += page.allText.length;
      if (allTextLength > MAX_TEXT_LENGTH) throw new ApiError(413, 'The full extracted text is too large.');
    }
    return { index: offset + 1, text: page.text, ...('allText' in page ? { allText: page.allText } : {}) };
  });
  if (typeof input.ocrEngine !== 'string' || !input.ocrEngine.trim() || input.ocrEngine.length > 100) {
    throw new ApiError(400, 'An image result needs an OCR engine name of 1–100 characters.');
  }
  const transcript = contentKind === 'image' ? pages[0].text : pages.map(page => `Slide ${page.index}\n${page.text}`).join('\n\n');
  return { pages, transcript, ocrEngine: input.ocrEngine };
}

export async function GET(request: Request, context: { params: Promise<{id:string}> }) {
  return api(async () => {
    engineRequest(request);
    const {id} = await context.params;
    const row = await db().prepare("SELECT * FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL").bind(id).first();
    if (!row) throw new ApiError(404, 'Transcript not found.');
    return json({job: serializeJob(row)});
  });
}

export async function PATCH(request: Request, context: { params: Promise<{id:string}> }) {
  return api(async () => {
    engineRequest(request);
    const { id } = await context.params;
    const input = await body(request);
    const status = String(input.status);
    if (!['downloading', 'transcribing', 'completed', 'failed'].includes(status)) throw new ApiError(400, 'Unknown job status.');
    if (typeof input.leaseToken !== 'string') throw new ApiError(403, 'Missing job lease.');
    if (input.contentKind !== undefined && (typeof input.contentKind !== 'string' || !['video', 'image', 'carousel'].includes(input.contentKind))) throw new ApiError(400, 'Unknown content kind.');
    const contentKind: ContentKind = (input.contentKind ?? 'video') as ContentKind;
    const image = status === 'completed' && contentKind !== 'video' ? imageResult(input, contentKind) : null;
    let transcript = image?.transcript ?? null;
    if (!image && input.transcript !== undefined && input.transcript !== null) {
      if (typeof input.transcript !== 'string') throw new ApiError(400, 'A transcript must be text.');
      if (input.transcript.length > MAX_TEXT_LENGTH) throw new ApiError(413, 'The transcript is too large.');
      transcript = input.transcript;
    }
    if (status === 'completed' && contentKind === 'video') {
      if (!transcript?.trim()) throw new ApiError(400, 'A completed video needs a transcript.');
      if (input.pages != null || input.ocrEngine != null) throw new ApiError(400, 'Video results cannot contain image pages or an OCR engine.');
    }
    const segments = Array.isArray(input.segments) ? input.segments.slice(0, 3000).map(segment => ({
      start: Math.max(0, Number(segment?.start) || 0), end: Math.max(0, Number(segment?.end) || 0), text: boundedText(segment?.text, 2000) || '',
    })) : null;
    const progress = status === 'completed' ? 100 : Math.max(0, Math.min(99, Number(input.progress) || 0));
    const terminal = status === 'completed' || status === 'failed';
    const updates = ['status=?', 'progress=?', 'title=COALESCE(?,title)', 'creator=COALESCE(?,creator)', 'language=COALESCE(?,language)', 'transcript=COALESCE(?,transcript)', 'error=?', 'updated_at=?', 'lease_expires_at=?'];
    const values: unknown[] = [
      status, progress, boundedText(input.title, 500), boundedText(input.creator, 200), boundedText(input.language, 20), transcript,
      status === 'failed' ? boundedText(input.error, 1000) || 'The video or post could not be processed. Try the link again.' : null,
      dateNow(), terminal ? null : leaseExpiry(),
    ];
    if (image) updates.push('duration_seconds=NULL', 'segments=NULL');
    else {
      updates.push('duration_seconds=COALESCE(?,duration_seconds)', 'segments=COALESCE(?,segments)');
      values.push(typeof input.durationSeconds === 'number' ? input.durationSeconds : null, segments ? JSON.stringify(segments) : null);
    }
    if (status === 'completed') {
      updates.push('content_kind=?', 'pages=?', 'ocr_engine=?', "insight_status='queued'", 'insight_lease=NULL', 'insight_lease_expires_at=NULL');
      values.push(contentKind, image ? JSON.stringify(image.pages) : null, image?.ocrEngine ?? null);
    } else if (status === 'transcribing' && input.contentKind !== undefined) {
      updates.push('content_kind=?');
      values.push(contentKind);
    }
    const row = await db().prepare(`UPDATE jobs SET ${updates.join(',')} WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL AND lease_token=? AND status IN ('downloading','transcribing') RETURNING id`).bind(...values, id, input.leaseToken).first();
    // Retried completion after a transient response loss is idempotent for this lease.
    if (!row) {
      const prior = await db().prepare("SELECT status,lease_token FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL").bind(id).first();
      if (prior?.lease_token === input.leaseToken && prior.status === status && terminal) return json({ ok: true });
      throw new ApiError(409, 'This job lease is no longer active.');
    }
    return json({ ok: true });
  });
}
