import { api, dateNow, db, engineRequest, json, leaseExpiry } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(async () => {
    engineRequest(request);
    const now = dateNow();
    const token = crypto.randomUUID();
    const row = await db().prepare("UPDATE jobs SET status='downloading',progress=3,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=(SELECT id FROM jobs WHERE owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL AND (status='queued' OR (status IN ('downloading','transcribing') AND lease_expires_at < ?)) ORDER BY created_at ASC LIMIT 1) RETURNING id,url,lease_token").bind(token, leaseExpiry(), now, now).first();
    return json({ job: row ? { id: row.id, url: row.url, leaseToken: row.lease_token } : null });
  });
}
