import {api,ApiError,body,db,engineRequest,json} from '../../../../../lib/server';
import {checkedInsights,checkedText} from '../../../../../lib/library-upgrade';
import {normalizeTags} from '../../../../../lib/library-query';
import {checkedGeneratedTitle} from '../../../../../lib/generated-title';
import {limitedSuggestedTags} from '../../../../../lib/suggestions';
import {relevantCollectionId} from '../../../../../lib/collection-suggestions';
export const dynamic='force-dynamic';
export async function PATCH(request:Request,context:{params:Promise<{id:string}>}){return api(async()=>{
  engineRequest(request);const {id}=await context.params,input=await body(request);
  if(!['completed','failed'].includes(String(input.status))||typeof input.leaseToken!=='string'||!Number.isSafeInteger(input.sourceRevision))throw new ApiError(400,'Check the summary result.');
  const row=await db().prepare("SELECT * FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL AND insight_lease=? AND revision=?").bind(id,input.leaseToken,input.sourceRevision).first();
  if(!row)throw new ApiError(409,'This summary lease is no longer active.');
  if(row.insight_status===input.status)return json({ok:true});
  if(row.insight_status!=='processing')throw new ApiError(409,'This summary lease is no longer active.');
  let insights=null,suggestions=null,engine=null,error=null,title=null;
  try{
    if(input.status==='completed'){
      if(input.title!==undefined)title=checkedGeneratedTitle(input.title);
      insights=checkedInsights(input.insights,String(row.edited_transcript??row.transcript??''));
      engine=checkedText(input.engine,100,'Summary engine',false);
      const s=input.suggestions as {collectionId:unknown;tags:unknown};
      if(!s||typeof s!=='object')throw new Error('Organization suggestions are required.');
      let collectionId=s.collectionId??null;
      if(collectionId!==null){if(typeof collectionId!=='string')throw new Error('Suggest an existing collection.');const collection=await db().prepare("SELECT id,name FROM collections WHERE id=? AND owner_id='owner'").bind(collectionId).first();if(!collection)throw new Error('Suggest an existing collection.');collectionId=relevantCollectionId(collectionId,collection,row.edited_transcript??row.transcript);}
      suggestions={collectionId,tags:limitedSuggestedTags(normalizeTags(s.tags))};
    }else error=checkedText(input.error??'The local summary could not be generated.',1000,'Summary error');
  }catch(e){throw new ApiError(400,e instanceof Error?e.message:'Check the summary result.');}
  const updated=await db().prepare("UPDATE jobs SET insight_status=?,insights=?,suggestions=?,insight_model=?,insight_error=?,generated_title=COALESCE(?,generated_title),insight_lease_expires_at=NULL WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL AND insight_lease=? AND revision=? AND insight_status='processing' RETURNING id").bind(input.status,insights?JSON.stringify(insights):null,suggestions?JSON.stringify(suggestions):null,engine,error,title,id,input.leaseToken,input.sourceRevision).first();
  if(!updated)throw new ApiError(409,'This summary lease is no longer active.');return json({ok:true});
});}
