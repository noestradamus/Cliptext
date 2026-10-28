import {api,ApiError,body,dateNow,db,json,owner,sameOrigin} from '../../../lib/server';
export const dynamic='force-dynamic';
export async function GET(){return api(async()=>{const ownerId=await owner();const rows=await db().prepare('SELECT c.id,c.name,COUNT(j.id) AS count FROM collections c LEFT JOIN jobs j ON j.collection_id=c.id AND j.owner_id=c.owner_id WHERE c.owner_id=? GROUP BY c.id ORDER BY c.name COLLATE NOCASE').bind(ownerId).all();return json({collections:rows.results});});}
export async function POST(request:Request){return api(async()=>{
  sameOrigin(request);const ownerId=await owner();const input=await body(request);const name=typeof input.name==='string'?input.name.trim():'';
  if(!name||name.length>64||/[\u0000-\u001f]/.test(name))throw new ApiError(400,'Use a collection name with 1–64 characters.');
  const existing=await db().prepare('SELECT id,name FROM collections WHERE owner_id=? AND name=? COLLATE NOCASE').bind(ownerId,name).first();if(existing)return json({collection:existing});
  const total=await db().prepare('SELECT COUNT(*) AS total FROM collections WHERE owner_id=?').bind(ownerId).first<{total:number}>();if((total?.total??0)>=100)throw new ApiError(429,'Your library has 100 collections. Reuse or remove an existing one.');
  const id=crypto.randomUUID();await db().prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').bind(id,ownerId,name,dateNow()).run();return json({collection:{id,name}},201);
});}
