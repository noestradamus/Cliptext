import { ApiError, dateNow, db, serializeFullJob } from './server';
import { extractVideoUrl, platformForUrl } from './video';
import { canonicalIdentity } from './library-upgrade';
export async function submitJob(input:unknown,ownerId='owner') {
  const url=extractVideoUrl(typeof input==='string'?input:'');
  if(!url)throw new ApiError(400,'Paste a TikTok video or photo post, YouTube/Shorts, or Instagram video or post link.');
  const platform=platformForUrl(url),canonicalId=canonicalIdentity(platform??'tiktok',url);
  let existing=await db().prepare('SELECT * FROM jobs WHERE owner_id=? AND (url=? OR (canonical_id=? AND duplicate_of IS NULL)) ORDER BY duplicate_of IS NOT NULL LIMIT 1').bind(ownerId,url,canonicalId).first();
  if(existing?.duplicate_of)existing=await db().prepare('SELECT * FROM jobs WHERE id=? AND owner_id=?').bind(existing.duplicate_of,ownerId).first();
  if(existing){
    if(existing.status==='failed'||existing.trashed_at){
      const retry=existing.status!=='completed';
      existing=await db().prepare(`UPDATE jobs SET trashed_at=NULL,${retry?"status='queued',progress=0,error=NULL,lease_token=NULL,lease_expires_at=NULL,":''}updated_at=? WHERE id=? AND owner_id=? RETURNING *`).bind(dateNow(),existing.id,ownerId).first();
    }
    return serializeFullJob(existing!,ownerId);
  }
  const active=await db().prepare("SELECT COUNT(*) AS total FROM jobs WHERE owner_id=? AND trashed_at IS NULL AND duplicate_of IS NULL AND status IN ('queued','downloading','transcribing')").bind(ownerId).first<{total:number}>();
  if((active?.total??0)>=30)throw new ApiError(429,'Your queue has 30 links. Let a few finish before adding more.');
  const now=dateNow();
  await db().prepare("INSERT OR IGNORE INTO jobs(id,owner_id,url,platform,canonical_id,status,progress,created_at,updated_at) VALUES(?,?,?,?,?,'queued',0,?,?)").bind(crypto.randomUUID(),ownerId,url,platform,canonicalId,now,now).run();
  const row=await db().prepare('SELECT * FROM jobs WHERE owner_id=? AND (url=? OR (canonical_id=? AND duplicate_of IS NULL)) LIMIT 1').bind(ownerId,url,canonicalId).first();
  if(!row)throw new ApiError(409,'That link is being added. Try again.');
  return serializeFullJob(row,ownerId);
}
