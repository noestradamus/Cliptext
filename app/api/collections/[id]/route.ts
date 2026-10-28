import {api,ApiError,body,db,json,owner,sameOrigin} from '../../../../lib/server';
export const dynamic='force-dynamic';
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
  sameOrigin(request);const ownerId=await owner();const {id}=await context.params;const input=await body(request);const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>64||/[\u0000-\u001f]/.test(name))throw new ApiError(400,'Use a collection name with 1–64 characters.');
  const duplicate=await db().prepare('SELECT id FROM collections WHERE owner_id=? AND name=? COLLATE NOCASE AND id<>?').bind(ownerId,name,id).first();if(duplicate)throw new ApiError(409,'A collection already has this name.');
  const row=await db().prepare('UPDATE collections SET name=? WHERE id=? AND owner_id=? RETURNING id,name').bind(name,id,ownerId).first();if(!row)throw new ApiError(404,'Collection not found.');return json({collection:row});
});}
export async function DELETE(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
  sameOrigin(request);const ownerId=await owner();const {id}=await context.params;
  const found=await db().prepare('SELECT id FROM collections WHERE id=? AND owner_id=?').bind(id,ownerId).first();if(!found)throw new ApiError(404,'Collection not found.');
  await db().batch([db().prepare('UPDATE jobs SET collection_id=NULL WHERE collection_id=? AND owner_id=?').bind(id,ownerId),db().prepare('DELETE FROM collections WHERE id=? AND owner_id=?').bind(id,ownerId)]);return json({deleted:true});
});}
