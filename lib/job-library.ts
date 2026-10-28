import {ApiError,dateNow,db,serializeFullJob} from './server';
import {FRAME_DETAIL_SELECT,frameBucket} from './frame';
import {normalizeTags} from './library-query';
import {checkedHighlights,checkedPages,checkedText,MAX_TEXT,pagesTranscript,parsed} from './library-upgrade';
import {limitedSuggestions,visibleSuggestedTags} from './suggestions';
import {relevantCollectionId} from './collection-suggestions';
export async function jobDetail(id:string,ownerId:string) {
  let row=await db().prepare(`${FRAME_DETAIL_SELECT} WHERE jobs.id=? AND jobs.owner_id=?`).bind(id,ownerId).first();
  if(row?.duplicate_of)row=await db().prepare(`${FRAME_DETAIL_SELECT} WHERE jobs.id=? AND jobs.owner_id=?`).bind(row.duplicate_of,ownerId).first();
  if(!row)throw new ApiError(404,'Transcript not found.');
  const slides=await db().prepare('SELECT page_index,width,height FROM job_slides WHERE job_id=? ORDER BY page_index').bind(row.id).all();
  const result=await serializeFullJob(row,ownerId);
  const addImage=(pages:unknown)=>Array.isArray(pages)?pages.map(page=>{const slide=slides.results.find(s=>s.page_index===page.index);return {...page,imageUrl:slide?`/api/jobs/${encodeURIComponent(String(row!.id))}/slides/${page.index}`:null,...(slide?{imageWidth:slide.width,imageHeight:slide.height}:{})};}):pages;
  return {...result,pages:addImage(result.pages),originalPages:addImage(result.originalPages)};
}
export async function changeJob(id:string,ownerId:string,input:Record<string,unknown>) {
  const prior=await db().prepare('SELECT * FROM jobs WHERE id=? AND owner_id=? AND duplicate_of IS NULL').bind(id,ownerId).first();
  if(!prior)throw new ApiError(404,'Transcript not found.');
  if(input.expectedRevision!==undefined && input.expectedRevision!==prior.revision)throw new ApiError(409,'This item changed in another tab. Reload it before saving.');
  const updates:string[]=[],values:unknown[]=[];let sourceChanged=false,textChanged=false;
  const set=(column:string,value:unknown)=>{updates.push(`${column}=?`);values.push(value);};
  try {
    if('favorite'in input){if(typeof input.favorite!=='boolean')throw new Error('Choose whether this item is a favourite.');set('favorite',input.favorite?1:0);}
    if('tags'in input)set('tags',JSON.stringify(normalizeTags(input.tags)));
    if('collectionId'in input){if(input.collectionId!==null&&(typeof input.collectionId!=='string'||input.collectionId.length>100))throw new Error('Choose a collection.');if(input.collectionId!==null){const c=await db().prepare('SELECT id FROM collections WHERE id=? AND owner_id=?').bind(input.collectionId,ownerId).first();if(!c)throw new ApiError(404,'Collection not found.');}set('collection_id',input.collectionId);}
    if('title'in input)set('edited_title',input.title===null?null:checkedText(input.title,500,'Title',false).trim());
    if('transcript'in input){if(prior.status!=='completed')throw new Error('Wait for extraction before editing the text.');if(prior.content_kind!=='video' && input.transcript!==null)throw new Error('Edit the image text one slide at a time.');set('edited_transcript',input.transcript===null?null:checkedText(input.transcript,MAX_TEXT,'Transcript'));sourceChanged=true;textChanged=true;}
    if('pages'in input){if(prior.status!=='completed'||prior.content_kind==='video')throw new Error('This item has no editable image slides.');const pages=input.pages===null?null:checkedPages(input.pages,parsed(prior.pages,[]));set('edited_pages',pages?JSON.stringify(pages):null);set('edited_transcript',pages?pagesTranscript(pages,String(prior.content_kind)):null);sourceChanged=true;textChanged=true;}
    if(input.resetEdits===true){set('edited_title',null);set('edited_transcript',null);set('edited_pages',null);textChanged=prior.edited_transcript!==null||prior.edited_pages!==null;sourceChanged=textChanged;}
    if('notes'in input)set('notes',checkedText(input.notes,50_000,'Notes'));
    if('highlights'in input){const highlights=checkedHighlights(input.highlights);const source=String(input.transcript??prior.edited_transcript??prior.transcript??'');if(highlights.some(h=>!source.includes(h.quote)))throw new Error('A highlight must quote text from this transcript.');set('highlights',JSON.stringify(highlights));}
    if('reviewed'in input){if(typeof input.reviewed!=='boolean')throw new Error('Choose Inbox or Reviewed.');set('reviewed_at',input.reviewed?dateNow():null);}
    if(input.restore===true){set('trashed_at',null);if(['downloading','transcribing'].includes(String(prior.status))){set('status','queued');set('progress',0);set('lease_token',null);set('lease_expires_at',null);}}
    if(input.acceptSuggestions===true){const suggestions=limitedSuggestions(parsed(prior.suggestions,null));if(!suggestions)throw new Error('No suggestions to accept.');if(suggestions.collectionId){const c=await db().prepare('SELECT id,name FROM collections WHERE id=? AND owner_id=?').bind(suggestions.collectionId,ownerId).first();const collectionId=relevantCollectionId(suggestions.collectionId,c,prior.edited_transcript??prior.transcript);if(collectionId)set('collection_id',collectionId);}const saved=parsed<unknown>(prior.tags,[]);const tags=Array.isArray(saved)?saved.filter((tag):tag is string=>typeof tag==='string'):[];set('tags',JSON.stringify([...tags,...visibleSuggestedTags(suggestions.tags,tags)]));set('suggestions',null);}
    if(textChanged)set('generated_title',null);
    if(sourceChanged||input.regenerateInsights===true){set('insight_status','queued');set('insight_error',null);set('insight_lease',null);set('insight_lease_expires_at',null);if(sourceChanged){set('insights',null);set('suggestions',null);}}
    else if(prior.insight_status==='processing'&&updates.length){set('insight_status','queued');set('insight_lease',null);set('insight_lease_expires_at',null);}
  }catch(e){if(e instanceof ApiError)throw e;throw new ApiError(400,e instanceof Error?e.message:'Check your changes.');}
  if(!updates.length)throw new ApiError(400,'Choose something to update.');
  // Deduplicate fields if resetEdits is combined with values; the last explicit update wins.
  const fields=new Map<string,unknown>();updates.forEach((u,i)=>fields.set(u.slice(0,-2),values[i]));
  const row=await db().prepare(`UPDATE jobs SET ${[...fields.keys()].map(k=>k+'=?').join(',')},revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=? RETURNING id`).bind(...fields.values(),dateNow(),id,ownerId,prior.revision).first();
  if(!row)throw new ApiError(409,'This item changed in another tab. Reload it before saving.');
  return jobDetail(id,ownerId);
}
export async function trashJob(id:string,ownerId:string) {
  const row=await db().prepare('UPDATE jobs SET trashed_at=?,lease_token=NULL,lease_expires_at=NULL,insight_lease=NULL,insight_lease_expires_at=NULL,slide_lease=NULL,slide_lease_expires_at=NULL,slide_status=CASE WHEN slide_status=\'processing\' THEN \'pending\' ELSE slide_status END,insight_status=CASE WHEN insight_status=\'processing\' THEN \'queued\' ELSE insight_status END,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND trashed_at IS NULL AND duplicate_of IS NULL RETURNING id').bind(dateNow(),dateNow(),id,ownerId).first();
  if(!row)throw new ApiError(404,'Transcript not found.');
}
export async function purgeJob(id:string,ownerId:string) {
  const [frames,slides,deleted]=await db().batch<Record<string,unknown>>([
    db().prepare('SELECT f.image_key FROM job_frames f JOIN jobs j ON j.id=f.job_id WHERE j.id=? AND j.owner_id=? AND j.trashed_at IS NOT NULL').bind(id,ownerId),
    db().prepare('SELECT s.image_key FROM job_slides s JOIN jobs j ON j.id=s.job_id WHERE j.id=? AND j.owner_id=? AND j.trashed_at IS NOT NULL').bind(id,ownerId),
    db().prepare('DELETE FROM jobs WHERE id=? AND owner_id=? AND trashed_at IS NOT NULL RETURNING id').bind(id,ownerId),
  ]);
  if(!deleted.results.length)throw new ApiError(409,'Move the item to Trash before deleting it permanently.');
  await db().prepare('DELETE FROM jobs WHERE duplicate_of=? AND owner_id=?').bind(id,ownerId).run();
  const keys=[...frames.results,...slides.results].map(x=>x.image_key).filter((x):x is string=>typeof x==='string');
  if(keys.length)await frameBucket().delete(keys);
}
