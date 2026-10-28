import {api,body,json,owner,sameOrigin} from '../../../../lib/server';
import {changeJob,jobDetail,purgeJob,trashJob} from '../../../../lib/job-library';
export const dynamic='force-dynamic';
type Context={params:Promise<{id:string}>};
export async function GET(_request:Request,context:Context){return api(async()=>{const ownerId=await owner();const {id}=await context.params;return json({job:await jobDetail(id,ownerId)});});}
export async function DELETE(request:Request,context:Context){return api(async()=>{sameOrigin(request);const ownerId=await owner();const {id}=await context.params;if(new URL(request.url).searchParams.get('permanent')==='1'){await purgeJob(id,ownerId);return json({deleted:true,permanent:true});}await trashJob(id,ownerId);return json({deleted:true,trashed:true});});}
export async function PATCH(request:Request,context:Context){return api(async()=>{sameOrigin(request);const ownerId=await owner();const {id}=await context.params;return json({job:await changeJob(id,ownerId,await body(request))});});}
