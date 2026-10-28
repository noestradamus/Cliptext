import {checkedHighlights,checkedInsights,checkedPages,checkedText,MAX_TEXT,parsed} from './library-upgrade';
import {checkedGeneratedTitle} from './generated-title';
import {normalizeTags} from './library-query';
import {limitedSuggestedTags} from './suggestions';
import {extractVideoUrl,platformForUrl} from './video';
import {jpegDimensions,FRAME_MAX_BYTES,FRAME_MAX_DIMENSION} from './frame';
import {SLIDE_MAX_BYTES,SLIDE_MAX_DIMENSION} from './slides';
export const BACKUP_MAX_BYTES=32*1024*1024;
export const BACKUP_MAX_ITEMS=1000;
export const BACKUP_FIELDS=['id','url','platform','favorite','tags','collection_id','status','progress','title','generated_title','creator','transcript','segments','content_kind','pages','ocr_engine','language','duration_seconds','error','created_at','updated_at','edited_title','edited_transcript','edited_pages','notes','highlights','reviewed_at','trashed_at','revision','insights','suggestions','insight_status','insight_error','insight_model'] as const;
export type BackupAsset={jobId:string;index:number;kind:'frame'|'slide';data:string;previewKind?:'thumbnail'|'first_frame'};
export type Backup={format:'cliptext-backup';version:1;createdAt:string;collections:{id:string;name:string;createdAt:string}[];items:Record<string,unknown>[];assets:BackupAsset[]};
export function encodeBase64(bytes:Uint8Array){let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);}
export function decodeAsset(asset:BackupAsset){
  const maximum=asset.kind==='frame'?FRAME_MAX_BYTES:SLIDE_MAX_BYTES;
  if(typeof asset.data!=='string'||asset.data.length>Math.ceil(maximum/3)*4||(asset.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)))throw new Error('A backup image is invalid.');
  const binary=atob(asset.data),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
  if(bytes.length>maximum)throw new Error('A backup image is too large.');
  return {bytes,...jpegDimensions(bytes,asset.kind==='frame'?FRAME_MAX_DIMENSION:SLIDE_MAX_DIMENSION)};
}
function date(value:unknown,label:string){const s=checkedText(value,40,label,false);if(Number.isNaN(Date.parse(s)))throw new Error(`Check the ${label.toLowerCase()}.`);return new Date(s).toISOString();}
function id(value:unknown){const s=checkedText(value,100,'Item ID',false);if(!/^[\w-]+$/.test(s))throw new Error('A backup ID is invalid.');return s;}
function nullableText(v:unknown,max:number,label:string){return v==null?null:checkedText(v,max,label);}
function readPages(value:unknown,kind:string){
  if(kind==='video'){if(value!=null)throw new Error('A video cannot contain image slides.');return null;}
  const pages=typeof value==='string'?parsed<unknown>(value,null):value;
  if(!Array.isArray(pages)||pages.length<(kind==='image'?1:2)||pages.length>35||(kind==='image'&&pages.length!==1))throw new Error('Check the saved image slides.');
  let length=0,fullLength=0;
  return pages.map((p,i)=>{if(!p||p.index!==i+1)throw new Error('Keep slide order in the backup.');const text=checkedText(p.text,MAX_TEXT,'Slide text');length+=text.length;const allText=p.allText===undefined?undefined:checkedText(p.allText,MAX_TEXT,'Full slide text');fullLength+=allText?.length??0;if(length>MAX_TEXT||fullLength>MAX_TEXT)throw new Error('The saved image text is too large.');return {index:i+1,text,...(allText===undefined?{}:{allText})};});
}
export function validateBackup(input:unknown):Backup {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Choose a Cliptext backup file.');
  const v=input as Backup;
  if(v.format!=='cliptext-backup'||v.version!==1)throw new Error('This backup format is not supported.');
  if(!Array.isArray(v.collections)||v.collections.length>500||!Array.isArray(v.items)||v.items.length>BACKUP_MAX_ITEMS||!Array.isArray(v.assets)||v.assets.length>36*BACKUP_MAX_ITEMS)throw new Error('This backup exceeds the supported library size.');
  const collectionIds=new Set<string>(),jobIds=new Set<string>();
  const collections=v.collections.map(c=>{if(!c||typeof c!=='object')throw new Error('Check the collections.');const cid=id(c.id);if(collectionIds.has(cid))throw new Error('Duplicate collection ID.');collectionIds.add(cid);return {id:cid,name:checkedText(c.name,60,'Collection name',false).trim(),createdAt:date(c.createdAt,'Collection date')};});
  const items=v.items.map(j=>{
    if(!j||typeof j!=='object'||Array.isArray(j))throw new Error('Check the saved items.');
    const jid=id(j.id);if(jobIds.has(jid))throw new Error('Duplicate item ID.');jobIds.add(jid);
    const url=extractVideoUrl(checkedText(j.url,4000,'Source URL',false));if(!url)throw new Error('A backup source URL is invalid.');
    const kind=String(j.content_kind??'video');if(!['video','image','carousel'].includes(kind))throw new Error('Unknown saved content type.');
    const status=['completed','failed'].includes(String(j.status))?String(j.status):'queued';
    const pages=status==='completed'?readPages(j.pages,kind):null;
    const editedPages=j.edited_pages==null?null:checkedPages(parsed(j.edited_pages,null),pages??[]);
    const transcript=nullableText(j.transcript,MAX_TEXT,'Transcript'),editedTranscript=nullableText(j.edited_transcript,MAX_TEXT,'Edited transcript');
    const collectionId=j.collection_id==null?null:id(j.collection_id);if(collectionId&&!collectionIds.has(collectionId))throw new Error('An item references a missing collection.');
    const segments=parsed<unknown>(j.segments,[]);if(!Array.isArray(segments)||segments.length>3000)throw new Error('Check the transcript timestamps.');
    const cleanSegments=segments.map(s=>{if(!s||typeof s!=='object'||!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<0||s.end<s.start)throw new Error('Check the transcript timestamps.');return {start:s.start,end:s.end,text:checkedText(s.text,2000,'Timestamp text')};});
    const generatedTitle=j.generated_title==null?null:checkedGeneratedTitle(j.generated_title);
    const insights=j.insights==null?null:checkedInsights(parsed(j.insights,null),editedTranscript??transcript??'');
    const suggestion=parsed<{collectionId:string|null;tags:unknown}|null>(j.suggestions,null);
    const suggestions=suggestion?{collectionId:suggestion.collectionId&&collectionIds.has(suggestion.collectionId)?suggestion.collectionId:null,tags:limitedSuggestedTags(normalizeTags(suggestion.tags))}:null;
    const duration=j.duration_seconds==null?null:Number(j.duration_seconds);if(duration!==null&&(!Number.isFinite(duration)||duration<0||duration>86400))throw new Error('Check the saved duration.');
    return {id:jid,url,platform:platformForUrl(url),favorite:j.favorite?1:0,tags:JSON.stringify(normalizeTags(parsed(j.tags,[]))),collection_id:collectionId,status,progress:status==='completed'?100:0,title:nullableText(j.title,500,'Title'),generated_title:generatedTitle,creator:nullableText(j.creator,200,'Creator'),transcript,segments:JSON.stringify(cleanSegments),content_kind:kind,pages:pages?JSON.stringify(pages):null,ocr_engine:nullableText(j.ocr_engine,100,'OCR engine'),language:nullableText(j.language,20,'Language'),duration_seconds:duration,error:status==='failed'?nullableText(j.error,1000,'Extraction error'):null,created_at:date(j.created_at,'Saved date'),updated_at:date(j.updated_at,'Updated date'),edited_title:nullableText(j.edited_title,500,'Edited title'),edited_transcript:editedTranscript,edited_pages:editedPages?JSON.stringify(editedPages):null,notes:checkedText(j.notes??'',50_000,'Notes'),highlights:JSON.stringify(checkedHighlights(parsed(j.highlights,[]))),reviewed_at:j.reviewed_at==null?null:date(j.reviewed_at,'Reviewed date'),trashed_at:j.trashed_at==null?null:date(j.trashed_at,'Trash date'),revision:0,insights:insights?JSON.stringify(insights):null,suggestions:suggestions?JSON.stringify(suggestions):null,insight_status:insights&&generatedTitle?'completed':'queued',insight_error:null,insight_model:nullableText(j.insight_model,100,'Summary model')};
  });
  const assetKeys=new Set<string>();
  const assets=v.assets.map(a=>{if(!a||typeof a!=='object'||!jobIds.has(a.jobId)||!['frame','slide'].includes(a.kind)||!Number.isInteger(a.index)||(a.kind==='frame'?a.index!==0:a.index<1||a.index>35))throw new Error('A backup image reference is invalid.');const key=`${a.jobId}:${a.kind}:${a.index}`;if(assetKeys.has(key))throw new Error('Duplicate backup image.');assetKeys.add(key);decodeAsset(a);return {jobId:a.jobId,index:a.index,kind:a.kind,data:a.data,previewKind:a.previewKind==='thumbnail'?'thumbnail' as const:'first_frame' as const};});
  return {format:'cliptext-backup',version:1,createdAt:date(v.createdAt,'Backup date'),collections,items,assets};
}
