export const PAGE_SIZE = 20;
export type LibraryFilters={q:string;terms:string[];platform:string;favorite:boolean;tag:string;collectionId:string;page:number;pageSize:number;view?:string;ids?:string[]};
export function parseLibraryFilters(params:URLSearchParams):LibraryFilters {
  const q=(params.get('q')??'').trim().slice(0,200);
  const platform=params.get('platform')??'';
  const page=Number(params.get('page')??1),size=Number(params.get('pageSize')??PAGE_SIZE);
  const view=params.get('view')??'all';
  const ids=[...new Set((params.get('ids')??'').split(',').filter(x=>/^[\w-]{1,100}$/.test(x)))].slice(0,100);
  return {q,terms:q.split(/\s+/).filter(Boolean).slice(0,8),platform:['tiktok','youtube','instagram'].includes(platform)?platform:'',favorite:params.get('favorite')==='1',tag:(params.get('tag')??'').trim().slice(0,32),collectionId:(params.get('collectionId')??'').slice(0,100),page:Number.isSafeInteger(page)&&page>0?page:1,pageSize:Number.isSafeInteger(size)?Math.max(1,Math.min(50,size)):PAGE_SIZE,view:['all','inbox','reviewed','trash'].includes(view)?view:'all',ids};
}
export function literalLike(value:string) {return value.replace(/[\\%_]/g,'\\$&');}
export function searchMatch(filters:LibraryFilters) {
  return filters.terms.filter(term=>[...term].length>=3).map(term=>'"'+term.replace(/"/g,'""')+'"').join(' AND ');
}
export function libraryWhere(filters:LibraryFilters,ownerId:string) {
  const clauses=['j.owner_id=?','j.duplicate_of IS NULL',filters.view==='trash'?'j.trashed_at IS NOT NULL':'j.trashed_at IS NULL'];const values:unknown[]=[ownerId];
  const match=searchMatch(filters);
  if(match){clauses.push('j.rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)');values.push(match);}
  for(const term of filters.terms.filter(term=>[...term].length<3)) {
    clauses.push("(COALESCE(j.edited_title,j.generated_title,j.title,'') LIKE ? ESCAPE '\\' OR COALESCE(j.creator,'') LIKE ? ESCAPE '\\' OR COALESCE(j.edited_transcript,j.transcript,'') LIKE ? ESCAPE '\\' OR j.notes LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(j.tags) tag WHERE tag.value LIKE ? ESCAPE '\\'))");
    values.push(...Array(5).fill('%'+literalLike(term)+'%'));
  }
  if(filters.view==='inbox')clauses.push('j.reviewed_at IS NULL');
  if(filters.view==='reviewed')clauses.push('j.reviewed_at IS NOT NULL');
  if(filters.ids?.length){clauses.push(`j.id IN (${filters.ids.map(()=>'?').join(',')})`);values.push(...filters.ids);}
  if(filters.platform){clauses.push('j.platform=?');values.push(filters.platform);}
  if(filters.favorite)clauses.push('j.favorite=1');
  if(filters.tag){clauses.push('EXISTS (SELECT 1 FROM json_each(j.tags) t WHERE t.value=?)');values.push(filters.tag);}
  if(filters.collectionId==='none')clauses.push('j.collection_id IS NULL');
  else if(filters.collectionId){clauses.push('j.collection_id=?');values.push(filters.collectionId);}
  return {sql:clauses.join(' AND '),values};
}
export function normalizeTags(value:unknown):string[] {
  if(!Array.isArray(value)||value.length>12)throw new Error('Use up to 12 tags.');
  const tags:string[]=[];
  for(const item of value) {
    if(typeof item!=='string')throw new Error('Tags must be text.');
    const tag=item.trim().replace(/^#+/,'').normalize('NFKC').toLocaleLowerCase();
    if(!tag||tag.length>32||/[\u0000-\u001f\u007f,]/.test(tag))throw new Error('Use tags with 1–32 characters and no commas.');
    if(!tags.includes(tag))tags.push(tag);
  }
  return tags;
}
