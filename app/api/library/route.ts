import {api,db,json,owner} from '../../../lib/server';
export const dynamic='force-dynamic';
export async function GET(){return api(async()=>{
  const ownerId=await owner();
  const [tags,collections,stats]=await Promise.all([
    db().prepare('SELECT t.value AS name,COUNT(DISTINCT j.id) AS count FROM jobs j,json_each(j.tags) t WHERE j.owner_id=? AND j.trashed_at IS NULL AND j.duplicate_of IS NULL GROUP BY t.value ORDER BY count DESC,name').bind(ownerId).all(),
    db().prepare('SELECT c.id,c.name,COUNT(j.id) AS count FROM collections c LEFT JOIN jobs j ON j.collection_id=c.id AND j.owner_id=c.owner_id AND j.trashed_at IS NULL AND j.duplicate_of IS NULL WHERE c.owner_id=? GROUP BY c.id ORDER BY c.name COLLATE NOCASE').bind(ownerId).all(),
    db().prepare("SELECT COALESCE(SUM(trashed_at IS NULL),0) AS total,COALESCE(SUM(status='completed' AND trashed_at IS NULL),0) AS completed,COALESCE(SUM(favorite=1 AND trashed_at IS NULL),0) AS favorites,COALESCE(SUM(reviewed_at IS NULL AND trashed_at IS NULL),0) AS inbox,COALESCE(SUM(reviewed_at IS NOT NULL AND trashed_at IS NULL),0) AS reviewed,COALESCE(SUM(trashed_at IS NOT NULL),0) AS trash FROM jobs WHERE owner_id=? AND duplicate_of IS NULL").bind(ownerId).first(),
  ]);return json({tags:tags.results,collections:collections.results,stats:stats??{total:0,completed:0,favorites:0,inbox:0,reviewed:0,trash:0}});
});}
