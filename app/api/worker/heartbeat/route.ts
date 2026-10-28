import { api, ApiError, body, boundedText, dateNow, db, engineRequest, json, leaseExpiry } from '../../../../lib/server';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(async () => {
    engineRequest(request);
    const input = await body(request);
    if (!['idle', 'busy', 'loading'].includes(String(input.status))) throw new ApiError(400, 'Unknown engine status.');
    const activeId = boundedText(input.activeJobId, 80);
    await db().prepare("INSERT INTO engine(id,status,model,active_job_id,last_seen) VALUES('local',?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,model=excluded.model,active_job_id=excluded.active_job_id,last_seen=excluded.last_seen").bind(input.status, boundedText(input.engine, 80) || 'local-whisper', activeId, dateNow()).run();
    if (activeId && typeof input.activeLeaseToken === 'string') {
      await db().prepare("UPDATE jobs SET lease_expires_at=? WHERE id=? AND lease_token=? AND status IN ('downloading','transcribing')").bind(leaseExpiry(), activeId, input.activeLeaseToken).run();
    }
    return json({ ok: true });
  });
}
