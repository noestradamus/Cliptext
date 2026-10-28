-- Existing normalized full links can be identified without fetching their media.
-- OR IGNORE preserves every prior item if two legacy links name the same post.
UPDATE OR IGNORE jobs SET canonical_id = CASE
 WHEN platform='youtube' AND instr(url,'watch?v=')>0 THEN 'youtube:' || substr(url,instr(url,'watch?v=')+8,11)
 WHEN platform='instagram' AND instr(url,'/p/')>0 THEN 'instagram:' || trim(substr(url,instr(url,'/p/')+3),'/')
 WHEN platform='instagram' AND instr(url,'/reel/')>0 THEN 'instagram:' || trim(substr(url,instr(url,'/reel/')+6),'/')
 WHEN platform='tiktok' AND instr(url,'/video/')>0 THEN 'tiktok:' || trim(substr(url,instr(url,'/video/')+7),'/')
 WHEN platform='tiktok' AND instr(url,'/photo/')>0 THEN 'tiktok:' || trim(substr(url,instr(url,'/photo/')+7),'/')
 ELSE NULL END
 WHERE canonical_id IS NULL AND duplicate_of IS NULL;
