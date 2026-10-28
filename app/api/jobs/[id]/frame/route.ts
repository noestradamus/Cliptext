import { api, ApiError, dateNow, db, json, owner, sameOrigin, serializeJob } from '../../../../../lib/server';
import { FRAME_DETAIL_SELECT, frameBucket } from '../../../../../lib/frame';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  return api(async () => {
    const ownerId = await owner();
    const { id } = await context.params;
    const row = await db().prepare(`SELECT job_frames.image_key FROM jobs JOIN job_frames ON job_frames.job_id=jobs.id
      WHERE jobs.id=? AND jobs.owner_id=? AND job_frames.status='ready'`).bind(id, ownerId).first();
    if (!row || typeof row.image_key !== 'string') throw new ApiError(404, 'Video preview not available.');
    const image = await frameBucket().get(row.image_key);
    if (!image) throw new ApiError(404, 'Video preview not available.');
    return new Response(image.body, { headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(image.size),
      'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
    } });
  });
}

/** Explicit retries are owner-driven; failed preview fetches never loop automatically. */
export async function POST(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const ownerId = await owner();
    const { id } = await context.params;
    const row = await db().prepare('SELECT status FROM jobs WHERE id=? AND owner_id=?').bind(id, ownerId).first();
    if (!row) throw new ApiError(404, 'Transcript not found.');
    if (row.status !== 'completed') throw new ApiError(409, 'Wait for transcription to finish before requesting a video preview.');
    await db().prepare(`UPDATE job_frames SET status='pending',lease_token=NULL,lease_expires_at=NULL,updated_at=?
      WHERE job_id=? AND status='unavailable' AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=job_frames.job_id AND jobs.owner_id=? AND jobs.status='completed')`)
      .bind(dateNow(), id, ownerId).run();
    const job = await db().prepare(`${FRAME_DETAIL_SELECT} WHERE jobs.id=? AND jobs.owner_id=?`).bind(id, ownerId).first();
    if (!job) throw new ApiError(404, 'Transcript not found.');
    return json({ job: serializeJob(job) });
  });
}
