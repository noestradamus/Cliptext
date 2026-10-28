import { api, ApiError, body, dateNow, db, engineRequest, json } from '../../../../../lib/server';
import { frameBucket, frameLeaseExpiry } from '../../../../../lib/frame';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(async () => {
    engineRequest(request);
    frameBucket();
    const input = await body(request);
    if ('jobId' in input && (typeof input.jobId !== 'string' || !input.jobId || input.jobId.length > 100)) throw new ApiError(400, 'Choose a completed video.');
    const jobId = typeof input.jobId === 'string' ? input.jobId : null;
    const now = dateNow();
    const row = await db().prepare(`INSERT INTO job_frames
      (job_id,status,lease_token,lease_expires_at,image_key,width,height,kind,updated_at)
      SELECT jobs.id,'processing',?,?,NULL,NULL,NULL,'first_frame',?
      FROM jobs LEFT JOIN job_frames ON job_frames.job_id=jobs.id
      WHERE jobs.owner_id='owner' AND jobs.trashed_at IS NULL AND jobs.duplicate_of IS NULL AND jobs.status='completed' AND (? IS NULL OR jobs.id=?)
        AND (job_frames.job_id IS NULL OR job_frames.status='pending'
          OR (job_frames.status='processing' AND job_frames.lease_expires_at < ?))
      ORDER BY jobs.created_at ASC, jobs.id ASC LIMIT 1
      ON CONFLICT(job_id) DO UPDATE SET status='processing',lease_token=excluded.lease_token,
        lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at
      WHERE job_frames.status='pending' OR (job_frames.status='processing' AND job_frames.lease_expires_at < ?)
      RETURNING job_id,lease_token,(SELECT url FROM jobs WHERE jobs.id=job_frames.job_id) AS url`)
      .bind(crypto.randomUUID(), frameLeaseExpiry(), now, jobId, jobId, now, now).first();
    return json({ job: row ? { id: row.job_id, url: row.url, leaseToken: row.lease_token } : null });
  });
}
