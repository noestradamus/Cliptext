import { api, body, db, json, owner, sameOrigin, serializeJob } from '../../../lib/server';
import { submitJob } from '../../../lib/submit';
import { libraryWhere,parseLibraryFilters,searchMatch } from '../../../lib/library-query';
export const dynamic = 'force-dynamic';
export async function GET(request:Request) {
  return api(async () => {
    const ownerId=await owner(),filters=parseLibraryFilters(new URL(request.url).searchParams),where=libraryWhere(filters,ownerId);
    const count=await db().prepare(`SELECT COUNT(*) AS total FROM jobs j WHERE ${where.sql}`).bind(...where.values).first<{total:number}>();
    const total=count?.total??0,totalPages=Math.max(1,Math.ceil(total/filters.pageSize)),page=Math.min(filters.page,totalPages);
    const match=searchMatch(filters);
    const rank=match?'(SELECT bm25(jobs_fts,5,2,1,1,3) FROM jobs_fts WHERE rowid=j.rowid AND jobs_fts MATCH ?) ASC,':'';
    const rows=await db().prepare(`SELECT j.id,j.url,j.platform,j.status,j.progress,j.title,j.generated_title,j.edited_title,j.creator,j.language,j.duration_seconds,j.content_kind,json_array_length(j.pages) AS page_count,j.ocr_engine,j.error,j.created_at,j.updated_at,j.favorite,j.tags,j.collection_id,j.reviewed_at,j.trashed_at,j.revision,j.insight_status,f.status AS frame_status,f.width AS frame_width,f.height AS frame_height,f.kind AS frame_kind,substr(COALESCE(j.edited_transcript,j.transcript,''),max(1,instr(lower(COALESCE(j.edited_transcript,j.transcript,'')),lower(?))-50),220) AS preview FROM jobs j LEFT JOIN job_frames f ON f.job_id=j.id WHERE ${where.sql} ORDER BY ${rank}j.created_at DESC,j.id DESC LIMIT ? OFFSET ?`).bind(filters.terms[0]??'',...where.values,...(match?[match]:[]),filters.pageSize,(page-1)*filters.pageSize).all();
    return json({jobs:rows.results.map(row=>{const {transcript,segments,originalTranscript,insights,notes,highlights,suggestions,...summary}=serializeJob(row);return summary;}),page,pageSize:filters.pageSize,total,totalPages});
  });
}
export async function POST(request:Request) {return api(async()=>{sameOrigin(request);const ownerId=await owner();const input=await body(request);return json({job:await submitJob(input.url,ownerId)},201);});}
