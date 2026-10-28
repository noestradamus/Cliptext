import {api,ApiError,body,dateNow,db,engineRequest,json} from '../../../../../../lib/server';
import {canonicalIdentity,parsed} from '../../../../../../lib/library-upgrade';
import {extractVideoUrl} from '../../../../../../lib/video';
export const dynamic='force-dynamic';
export async function POST(request:Request,context:{params:Promise<{id:string}>}) {return api(async()=>{
  engineRequest(request);const {id}=await context.params,input=await body(request);
  const url=extractVideoUrl(typeof input.canonicalUrl==='string'?input.canonicalUrl:'');
  const platform=String(input.platform),postId=String(input.postId);
  const canonicalId=url?canonicalIdentity(platform,url):null;
  if(!canonicalId||canonicalId!==`${platform}:${postId}`)throw new ApiError(400,'The resolved post identity is invalid.');
  const prior=await db().prepare("SELECT * FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND lease_token=? AND status IN ('downloading','transcribing','completed')").bind(id,input.leaseToken??'').first();
  if(!prior)throw new ApiError(409,'This job lease is no longer active.');
  if(prior.duplicate_of){
    const target=await db().prepare("SELECT id FROM jobs WHERE id=? AND owner_id='owner' AND trashed_at IS NULL AND duplicate_of IS NULL").bind(prior.duplicate_of).first();
    if(!target)throw new ApiError(409,'The original item is no longer available.');
    return json({canonicalId,duplicateJobId:target.id});
  }
  if(prior.platform!==platform)throw new ApiError(400,'The resolved platform does not match the saved link.');
  const existing=await db().prepare("SELECT * FROM jobs WHERE owner_id='owner' AND canonical_id=? AND duplicate_of IS NULL AND id<>?").bind(canonicalId,id).first();
  if(!existing){
    try{
      const changed=await db().prepare("UPDATE jobs SET canonical_id=? WHERE id=? AND owner_id='owner' AND lease_token=? AND revision=? AND trashed_at IS NULL AND duplicate_of IS NULL RETURNING id").bind(canonicalId,id,input.leaseToken,prior.revision).first();
      if(!changed)throw new ApiError(409,'The item changed. Retry this resolution.');
    }catch(error){if(error instanceof ApiError)throw error;throw new ApiError(409,'The post identity changed. Retry this resolution.');}
    return json({canonicalId,duplicateJobId:null});
  }
  const tags=[...new Set([...parsed<string[]>(existing.tags,[]),...parsed<string[]>(prior.tags,[])])];
  const notes=[existing.notes,prior.notes].filter(Boolean).join('\n\n');
  // A duplicate with independent user work remains a separate, visible item if
  // that work cannot fit the destination without losing information.
  const mergeConflict=existing.trashed_at?'original_in_trash':
    tags.length>12?'tag_limit':notes.length>50_000?'notes_limit':
    prior.collection_id&&existing.collection_id&&prior.collection_id!==existing.collection_id?'different_collections':
    prior.edited_title!==null||prior.edited_transcript!==null||prior.edited_pages!==null||parsed<unknown[]>(prior.highlights,[]).length>0?'independent_edits':
    prior.transcript&&prior.transcript!==existing.transcript?'different_extraction':null;
  if(mergeConflict)return json({canonicalId,duplicateJobId:null,mergeConflict});
  // Materialize eligibility before either row changes. This single statement
  // merges metadata and creates its receipt alias atomically, only while both
  // revisions, the source lease and the destination's live identity still match.
  const changed=await db().prepare(`WITH eligible AS MATERIALIZED (
    SELECT source.id AS source_id,target.id AS target_id FROM jobs source JOIN jobs target ON target.id=?
    WHERE source.id=? AND source.owner_id='owner' AND target.owner_id='owner'
      AND source.revision=? AND target.revision=? AND source.lease_token=?
      AND source.trashed_at IS NULL AND target.trashed_at IS NULL
      AND source.duplicate_of IS NULL AND target.duplicate_of IS NULL
      AND source.status IN ('downloading','transcribing','completed') AND target.canonical_id=?
  ) UPDATE jobs SET
    favorite=CASE WHEN id=(SELECT target_id FROM eligible) THEN max(favorite,?) ELSE favorite END,
    tags=CASE WHEN id=(SELECT target_id FROM eligible) THEN ? ELSE tags END,
    notes=CASE WHEN id=(SELECT target_id FROM eligible) THEN ? ELSE notes END,
    collection_id=CASE WHEN id=(SELECT target_id FROM eligible) THEN COALESCE(collection_id,?) ELSE collection_id END,
    reviewed_at=CASE WHEN id=(SELECT target_id FROM eligible) THEN COALESCE(reviewed_at,?) ELSE reviewed_at END,
    canonical_id=CASE WHEN id=(SELECT source_id FROM eligible) THEN ? ELSE canonical_id END,
    duplicate_of=CASE WHEN id=(SELECT source_id FROM eligible) THEN (SELECT target_id FROM eligible) ELSE duplicate_of END,
    status=CASE WHEN id=(SELECT source_id FROM eligible) THEN 'completed' WHEN status='failed' THEN 'queued' ELSE status END,
    progress=CASE WHEN id=(SELECT source_id FROM eligible) THEN 100 ELSE progress END,
    lease_expires_at=CASE WHEN id=(SELECT source_id FROM eligible) THEN NULL ELSE lease_expires_at END,
    insight_lease=CASE WHEN insight_status='processing' THEN NULL ELSE insight_lease END,
    insight_lease_expires_at=CASE WHEN insight_status='processing' THEN NULL ELSE insight_lease_expires_at END,
    insight_status=CASE WHEN insight_status='processing' THEN 'queued' ELSE insight_status END,
    revision=revision+1,updated_at=?
    WHERE id IN (SELECT source_id FROM eligible UNION ALL SELECT target_id FROM eligible) RETURNING id`)
    .bind(existing.id,id,prior.revision,existing.revision,input.leaseToken,canonicalId,
      prior.favorite,JSON.stringify(tags),notes,prior.collection_id,prior.reviewed_at,canonicalId,dateNow()).all();
  if(changed.results.length!==2)throw new ApiError(409,'An item changed while resolving this duplicate. Retry this resolution.');
  return json({canonicalId,duplicateJobId:existing.id});
});}
