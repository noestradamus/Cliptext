import { api, ApiError, body, dateNow, db, engineRequest, json } from '../../../../../lib/server';
import { frameBucket, readFrameJpeg } from '../../../../../lib/frame';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };
const lostLease = () => new ApiError(409, 'This video preview lease is no longer active.');

export async function PUT(request: Request, context: Context) {
  return api(async () => {
    engineRequest(request);
    const { id } = await context.params;
    const token = request.headers.get('X-Cliptext-Frame-Lease');
    if (!token || token.length > 100) throw new ApiError(403, 'Missing video preview lease.');
    const kind = request.headers.get('X-Cliptext-Preview-Kind') || 'first_frame';
    if (kind !== 'thumbnail' && kind !== 'first_frame') throw new ApiError(400, 'Unknown video preview kind.');
    const prior = await db().prepare(`SELECT job_frames.* FROM job_frames JOIN jobs ON jobs.id=job_frames.job_id
      WHERE jobs.id=? AND jobs.owner_id='owner' AND jobs.trashed_at IS NULL AND jobs.duplicate_of IS NULL AND jobs.status='completed' AND job_frames.lease_token=?`).bind(id, token).first();
    // Retrying an accepted upload must not allocate another R2 object.
    if (prior?.status === 'ready') return json({ ok: true });
    if (prior?.status !== 'processing' || typeof prior.lease_expires_at !== 'string' || prior.lease_expires_at <= dateNow()) throw lostLease();
    const frame = await readFrameJpeg(request);
    const bucket = frameBucket();
    const key = `private/frames/${encodeURIComponent(id)}/${crypto.randomUUID()}.jpg`;
    try {
      await bucket.put(key, frame.bytes, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' } });
    } catch (error) {
      // An ambiguous R2 response may still have created the object; no DB row references it yet.
      await bucket.delete(key);
      throw error;
    }
    let row: Record<string, unknown> | null;
    try {
      row = await db().prepare(`UPDATE job_frames SET status='ready',image_key=?,width=?,height=?,kind=?,
        lease_expires_at=NULL,updated_at=? WHERE job_id=? AND status='processing' AND lease_token=?
        AND lease_expires_at>? AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=job_frames.job_id
          AND jobs.owner_id='owner' AND jobs.trashed_at IS NULL AND jobs.duplicate_of IS NULL AND jobs.status='completed') RETURNING job_id`)
        .bind(key, frame.width, frame.height, kind, dateNow(), id, token, dateNow()).first();
    } catch (error) {
      // A transport error can follow a committed CAS. Never delete a referenced image.
      const accepted = await db().prepare('SELECT job_id FROM job_frames WHERE job_id=? AND image_key=? AND status=\'ready\'').bind(id, key).first();
      if (accepted) return json({ ok: true });
      await bucket.delete(key);
      throw error;
    }
    if (!row) {
      // Delete/cancel/reclaim can win while R2 is uploading. This immutable key belongs only to this attempt.
      await bucket.delete(key);
      throw lostLease();
    }
    return json({ ok: true });
  });
}

export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    engineRequest(request);
    const { id } = await context.params;
    const input = await body(request);
    if (input.status !== 'unavailable') throw new ApiError(400, 'Unknown video preview status.');
    if (typeof input.leaseToken !== 'string' || !input.leaseToken || input.leaseToken.length > 100) throw new ApiError(403, 'Missing video preview lease.');
    const row = await db().prepare(`UPDATE job_frames SET status='unavailable',lease_expires_at=NULL,updated_at=?
      WHERE job_id=? AND status='processing' AND lease_token=? AND lease_expires_at>?
      AND EXISTS (SELECT 1 FROM jobs WHERE jobs.id=job_frames.job_id AND jobs.owner_id='owner' AND jobs.trashed_at IS NULL AND jobs.duplicate_of IS NULL AND jobs.status='completed') RETURNING job_id`)
      .bind(dateNow(), id, input.leaseToken, dateNow()).first();
    if (!row) {
      const prior = await db().prepare(`SELECT job_frames.status FROM job_frames JOIN jobs ON jobs.id=job_frames.job_id
        WHERE job_frames.job_id=? AND job_frames.lease_token=? AND jobs.owner_id='owner' AND jobs.trashed_at IS NULL AND jobs.duplicate_of IS NULL AND jobs.status='completed'`).bind(id, input.leaseToken).first();
      if (prior?.status === 'unavailable') return json({ ok: true });
      throw lostLease();
    }
    return json({ ok: true });
  });
}
