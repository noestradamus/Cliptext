import {api,ApiError,db,owner} from '../../../../../../lib/server';
import {frameBucket} from '../../../../../../lib/frame';
import {slideIndex} from '../../../../../../lib/slides';
export const dynamic='force-dynamic';
export async function GET(_request:Request,context:{params:Promise<{id:string;index:string}>}){return api(async()=>{const ownerId=await owner(),{id,index:rawIndex}=await context.params,index=slideIndex(rawIndex);const row=await db().prepare('SELECT s.image_key FROM job_slides s JOIN jobs j ON j.id=s.job_id WHERE j.id=? AND j.owner_id=? AND s.page_index=?').bind(id,ownerId,index).first();if(!row)throw new ApiError(404,'Slide image not found.');const object=await frameBucket().get(String(row.image_key));if(!object)throw new ApiError(404,'Slide image not found.');return new Response(object.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});});}
