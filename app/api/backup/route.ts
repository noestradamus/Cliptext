import {api,ApiError,dateNow,db,json,owner,sameOrigin} from '../../../lib/server';
import {frameBucket} from '../../../lib/frame';
import {BACKUP_FIELDS,BACKUP_MAX_BYTES,BACKUP_MAX_ITEMS,decodeAsset,encodeBase64,validateBackup,type Backup,type BackupAsset} from '../../../lib/backup';
import {canonicalIdentity,parsed} from '../../../lib/library-upgrade';
export const dynamic='force-dynamic';
export async function GET(){return api(async()=>{
  const ownerId=await owner();
  const totals=await db().prepare(`SELECT COUNT(*) AS total,COALESCE(SUM(length(CAST(json_object(${BACKUP_FIELDS.map(field=>`'${field}',${field}`).join(',')}) AS BLOB))),0) AS bytes FROM jobs WHERE owner_id=? AND duplicate_of IS NULL`).bind(ownerId).first<{total:number;bytes:number}>();
  if((totals?.total??0)>BACKUP_MAX_ITEMS)throw new ApiError(413,`Backups support up to ${BACKUP_MAX_ITEMS} items.`);
  if((totals?.bytes??0)>BACKUP_MAX_BYTES-65536)throw new ApiError(413,'This backup exceeds 32 MiB. No partial backup was downloaded.');
  const [jobs,collections,images]=await db().batch<Record<string,unknown>>([
    db().prepare(`SELECT ${BACKUP_FIELDS.join(',')} FROM jobs WHERE owner_id=? AND duplicate_of IS NULL ORDER BY created_at,id LIMIT ?`).bind(ownerId,BACKUP_MAX_ITEMS+1),
    db().prepare('SELECT id,name,created_at AS createdAt FROM collections WHERE owner_id=? ORDER BY id').bind(ownerId),
    db().prepare("SELECT j.id AS jobId,0 AS pageIndex,'frame' AS kind,f.image_key,f.kind AS previewKind FROM jobs j JOIN job_frames f ON f.job_id=j.id WHERE j.owner_id=? AND j.duplicate_of IS NULL AND f.status='ready' UNION ALL SELECT j.id,s.page_index,'slide',s.image_key,NULL FROM jobs j JOIN job_slides s ON s.job_id=j.id WHERE j.owner_id=? AND j.duplicate_of IS NULL").bind(ownerId,ownerId),
  ]);
  if(jobs.results.length>BACKUP_MAX_ITEMS)throw new ApiError(413,`Backups support up to ${BACKUP_MAX_ITEMS} items.`);
  const data:Backup={format:'cliptext-backup',version:1,createdAt:dateNow(),collections:collections.results as Backup['collections'],items:jobs.results,assets:[]};
  let size=new TextEncoder().encode(JSON.stringify(data)).length;
  if(size>BACKUP_MAX_BYTES)throw new ApiError(413,'This backup exceeds 32 MiB. No data was downloaded.');
  for(const image of images.results){const object=await frameBucket().get(String(image.image_key));if(!object)throw new ApiError(409,'A saved image is unavailable. Try the backup again.');if(size+Math.ceil(object.size/3)*4+400>BACKUP_MAX_BYTES)throw new ApiError(413,'This backup exceeds 32 MiB including images. No partial backup was downloaded.');const asset:BackupAsset={jobId:String(image.jobId),index:Number(image.pageIndex),kind:image.kind as 'frame'|'slide',data:encodeBase64(new Uint8Array(await object.arrayBuffer())),...(image.kind==='frame'?{previewKind:image.previewKind==='thumbnail'?'thumbnail':'first_frame'}:{})};size+=new TextEncoder().encode(JSON.stringify(asset)).length+1;data.assets.push(asset);}
  const serialized=JSON.stringify(data);
  return new Response(serialized,{headers:{'Content-Type':'application/json','Content-Disposition':`attachment; filename="cliptext-backup-${dateNow().slice(0,10)}.json"`,'Cache-Control':'private, no-store','Vary':'Cookie','X-Content-Type-Options':'nosniff'}});
});}
async function readBackup(request:Request){
  if(!request.body)throw new ApiError(400,'Choose a Cliptext backup file.');
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,text='';
  try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>BACKUP_MAX_BYTES){await reader.cancel();throw new ApiError(413,'Backups must be at most 32 MiB.');}text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
  catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,'This backup is not valid UTF-8 text.');}finally{reader.releaseLock();}
  try{return validateBackup(JSON.parse(text));}catch(e){throw new ApiError(400,e instanceof Error?e.message:'This backup could not be read.');}
}

export async function POST(request:Request){return api(async()=>{
  sameOrigin(request);const ownerId=await owner(),backup=await readBackup(request);
  const collectionMap=new Map<string,string>(),existingCollections=await db().prepare('SELECT id,name FROM collections WHERE owner_id=?').bind(ownerId).all();
  const statements:D1PreparedStatement[]=[];
  for(const c of backup.collections){const existing=existingCollections.results.find(x=>x.name===c.name);const id=existing?String(existing.id):crypto.randomUUID();collectionMap.set(c.id,id);if(!existing){statements.push(db().prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').bind(id,ownerId,c.name,c.createdAt));existingCollections.results.push({id,name:c.name});}}
  const current=await db().prepare('SELECT id,url,canonical_id FROM jobs WHERE owner_id=?').bind(ownerId).all();
  const occupiedIds=new Set((await db().prepare('SELECT id FROM jobs').bind().all()).results.map(row=>row.id));
  const ids=new Set(current.results.map(r=>r.id)),urls=new Set(current.results.map(r=>r.url)),canonicalIds=new Set(current.results.map(r=>r.canonical_id));
  const restored=new Set<string>();const idMap=new Map<string,string>();let skipped=0;
  for(const item of backup.items){const canonical=canonicalIdentity(String(item.platform),String(item.url));if(ids.has(item.id)||urls.has(item.url)||(canonical&&canonicalIds.has(canonical))){skipped++;continue;}const id=String(item.id);const newId=occupiedIds.has(id)?crypto.randomUUID():id;occupiedIds.add(newId);idMap.set(id,newId);restored.add(id);const suggestion=parsed<{collectionId:string|null;tags:string[]}|null>(item.suggestions,null);const row={...item,id:newId,owner_id:ownerId,collection_id:item.collection_id?collectionMap.get(String(item.collection_id))??null:null,suggestions:suggestion?JSON.stringify({...suggestion,collectionId:suggestion.collectionId?collectionMap.get(suggestion.collectionId)??null:null}):null,canonical_id:canonical};statements.push(db().prepare(`INSERT INTO jobs(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(()=>'?').join(',')})`).bind(...Object.values(row)));ids.add(item.id);urls.add(item.url);if(canonical)canonicalIds.add(canonical);}
  const bucket=backup.assets.length?frameBucket():null,createdKeys:string[]=[];
  try{
    for(const asset of backup.assets){if(!restored.has(asset.jobId))continue;const decoded=decodeAsset(asset),jobId=idMap.get(asset.jobId)!,key=`private/restored/${crypto.randomUUID()}.jpg`;createdKeys.push(key);await bucket!.put(key,decoded.bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'private, no-store'}});if(asset.kind==='frame')statements.push(db().prepare("INSERT INTO job_frames(job_id,status,image_key,width,height,kind,updated_at) VALUES(?,'ready',?,?,?,?,?)").bind(jobId,key,decoded.width,decoded.height,asset.previewKind??'first_frame',dateNow()));else statements.push(db().prepare('INSERT INTO job_slides(id,job_id,page_index,image_key,width,height,updated_at) VALUES(?,?,?,?,?,?,?)').bind(crypto.randomUUID(),jobId,asset.index,key,decoded.width,decoded.height,dateNow()));}
    if(statements.length)await db().batch(statements);
  }catch(e){
    // A lost response may follow a committed transaction: clean up only unreferenced objects.
    for(const key of createdKeys){const used=await db().prepare('SELECT job_id FROM job_frames WHERE image_key=? UNION ALL SELECT job_id FROM job_slides WHERE image_key=? LIMIT 1').bind(key,key).first();if(!used)await bucket!.delete(key);}
    throw e;
  }
  return json({restored:restored.size,skipped,collections:backup.collections.length});
});}
