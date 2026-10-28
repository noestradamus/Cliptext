import {api,ApiError,dateNow,db,engineRequest,json} from '../../../../../../../lib/server';
import {frameBucket} from '../../../../../../../lib/frame';
import {slideIndex,slideJpeg} from '../../../../../../../lib/slides';
export const dynamic='force-dynamic';
export async function PUT(request:Request,context:{params:Promise<{id:string;index:string}>}){return api(async()=>{
  engineRequest(request);const {id,index:rawIndex}=await context.params,index=slideIndex(rawIndex),token=request.headers.get('X-Cliptext-Lease-Token');
  if(!token||token.length>100)throw new ApiError(403,'Missing post lease.');
  const valid="SELECT id FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL AND ((lease_token=? AND (status='completed' OR (status IN ('downloading','transcribing') AND lease_expires_at>?))) OR (slide_lease=? AND slide_status='processing' AND slide_lease_expires_at>? AND status='completed'))";
  if(!await db().prepare(valid).bind(id,token,dateNow(),token,dateNow()).first())throw new ApiError(409,'This post lease is no longer active.');
  const existing=await db().prepare('SELECT image_key FROM job_slides WHERE job_id=? AND page_index=?').bind(id,index).first();
  if(existing)return json({ok:true});
  const frame=await slideJpeg(request),bucket=frameBucket(),key=`private/slides/${encodeURIComponent(id)}/${index}-${crypto.randomUUID()}.jpg`;
  try{await bucket.put(key,frame.bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'private, no-store'}});}catch(e){await bucket.delete(key);throw e;}
  try{
    const row=await db().prepare(`INSERT INTO job_slides(id,job_id,page_index,image_key,width,height,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (${valid}) ON CONFLICT(job_id,page_index) DO NOTHING RETURNING id`).bind(crypto.randomUUID(),id,index,key,frame.width,frame.height,dateNow(),id,token,dateNow(),token,dateNow()).first();
    if(!row){await bucket.delete(key);const accepted=await db().prepare('SELECT id FROM job_slides WHERE job_id=? AND page_index=?').bind(id,index).first();if(accepted)return json({ok:true});throw new ApiError(409,'This post lease is no longer active.');}
  }catch(e){const accepted=await db().prepare('SELECT id FROM job_slides WHERE image_key=?').bind(key).first();if(accepted)return json({ok:true});await bucket.delete(key);throw e;}
  return json({ok:true});
});}
