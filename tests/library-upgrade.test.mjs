import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Run the actual route SQL and serialization against all generated migrations.
const fixtureKey = Symbol.for('cliptext.library-upgrade.test');
const fixture = { env: { CLIPTEXT_ENGINE_SECRET: 'synthetic-test-engine-key' }, signedIn: true, queries: [] };
globalThis[fixtureKey] = fixture;
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const loadedModules = new Map();
async function sourceModule(path, dependencies = {}) {
  if (loadedModules.has(path)) return loadedModules.get(path);
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  let output = outputText;
  for (const match of outputText.matchAll(/from\s+(['"])([^'"]+)\1/g)) {
    const specifier = match[2];
    let mapped = dependencies[specifier];
    if (!mapped && specifier.startsWith('.')) {
      const base = new URL('../', import.meta.url);
      const target = new URL(specifier.endsWith('.ts') ? specifier : specifier + '.ts', new URL(path, base));
      mapped = await sourceModule(target.pathname.slice(base.pathname.length));
    }
    assert.ok(mapped, 'Unmapped test dependency: ' + specifier);
    output = output.replace(match[0], 'from ' + JSON.stringify(mapped));
  }
  const result = moduleUrl(output); loadedModules.set(path, result); return result;
}

const fixtureLookup = "globalThis[Symbol.for('cliptext.library-upgrade.test')]";
const server = await sourceModule('lib/server.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  '../app/chatgpt-auth': moduleUrl(`export async function getChatGPTUser() { return ${fixtureLookup}.signedIn ? {id: 'synthetic-user'} : null; }`),
});
const library = await sourceModule('lib/library-query.ts');
const submit = await sourceModule('lib/submit.ts', {
  './server': server,
  './video': await sourceModule('lib/video.ts', { './tiktok.ts': await sourceModule('lib/tiktok.ts') }),
});
const frame = await sourceModule('lib/frame.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${fixtureLookup}.env;`),
  './server': server,
});
const jobs = await import(await sourceModule('app/api/jobs/route.ts', {
  '../../../lib/server': server, '../../../lib/submit': submit, '../../../lib/library-query': library,
}));
const jobDetail = await import(await sourceModule('app/api/jobs/[id]/route.ts', {
  '../../../../lib/server': server, '../../../../lib/library-query': library, '../../../../lib/frame': frame,
}));
const workerJobs = await import(await sourceModule('app/api/worker/jobs/[id]/route.ts', { '../../../../../lib/server': server }));
const workerClaim = await import(await sourceModule('app/api/worker/claim/route.ts', { '../../../../lib/server': server }));
const migrationsDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationsDirectory), 'utf8')));
let sqlite;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true;
  fixture.queries = [];
  fixture.env.DB = {
    prepare(sql) {
      fixture.queries.push(sql);
      const statement = sqlite.prepare(sql);
      return {
        bind(...values) {
          return {
            async first() { const row = statement.get(...values); return row ? { ...row } : null; },
            async run() { return { success: true, meta: statement.run(...values) }; },
            async all() { return { success: true, results: statement.all(...values).map(row => ({ ...row })) }; },
          };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
});
afterEach(() => sqlite.close());
after(() => { delete globalThis[fixtureKey]; });

function seedJob(id, overrides = {}) {
  const row = {
    id, owner_id: 'owner', url: 'https://www.instagram.com/p/' + id + '/',
    status: 'transcribing', progress: 25, title: 'Synthetic post',
    transcript: 'Old audio transcript', segments: '[{"start":0,"end":1,"text":"Old audio transcript"}]',
    duration_seconds: 123, created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z',
    lease_token: 'synthetic-lease-' + id, lease_expires_at: '2999-01-01T00:00:00.000Z',
    ...overrides,
  };
  sqlite.prepare(`INSERT INTO jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return row;
}
const context = id => ({ params: Promise.resolve({ id }) });
const detail = id => jobDetail.GET(new Request('https://cliptext.example/api/jobs/' + id), context(id));
const stored = id => ({ ...sqlite.prepare('SELECT * FROM jobs WHERE id=?').get(id) });
function complete(id, extra = {}, headers = {}) {
  return workerJobs.PATCH(new Request('https://cliptext.example/api/worker/jobs/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Cliptext-Engine': '1', 'X-Cliptext-Engine-Key': fixture.env.CLIPTEXT_ENGINE_SECRET, ...headers },
    body: JSON.stringify({ status: 'completed', leaseToken: 'synthetic-lease-' + id, contentKind: 'image', pages: [{ index: 1, text: 'Synthetic OCR' }], ocrEngine: 'SyntheticOCR', ...extra }),
  }), context(id));
}

const batchJobs=await import(await sourceModule('app/api/jobs/batch/route.ts'));
const backupRoutes=await import(await sourceModule('app/api/backup/route.ts'));
const insightsClaim=await import(await sourceModule('app/api/worker/insights/claim/route.ts'));
const insightsComplete=await import(await sourceModule('app/api/worker/insights/[id]/route.ts'));
const identity=await import(await sourceModule('app/api/worker/jobs/[id]/identity/route.ts'));
const slidesClaim=await import(await sourceModule('app/api/worker/slides/claim/route.ts'));
const slidesUpload=await import(await sourceModule('app/api/worker/jobs/[id]/slides/[index]/route.ts'));
const slidesFinish=await import(await sourceModule('app/api/worker/slides/[id]/route.ts'));
const images=new Map();
beforeEach(()=>{images.clear();fixture.env.BUCKET={async put(key,data){images.set(key,new Uint8Array(data));},async get(key){const data=images.get(key);return data?{size:data.length,body:new Blob([data]).stream(),arrayBuffer:async()=>data.slice().buffer}:null;},async delete(keys){for(const key of Array.isArray(keys)?keys:[keys])images.delete(key);}};});
const userRequest=(path,method,payload)=>new Request('https://cliptext.example'+path,{method,headers:{'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});
const engineRequest=(path,method,payload)=>new Request('https://cliptext.example'+path,{method,headers:{'Content-Type':'application/json','X-Cliptext-Engine':'1','X-Cliptext-Engine-Key':fixture.env.CLIPTEXT_ENGINE_SECRET},body:JSON.stringify(payload)});
const edit=(id,payload)=>jobDetail.PATCH(userRequest('/api/jobs/'+id,'PATCH',payload),context(id));
const list=async query=>{const response=await jobs.GET(new Request('https://cliptext.example/api/jobs?'+query));assert.equal(response.status,200,await response.clone().text());return response.json();};
const jpeg=new Uint8Array([255,216,255,192,0,11,8,0,2,0,2,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);

test('generated title migration preserves existing summaries and source titles while revoking old leases',()=>{
 const database=new DatabaseSync(':memory:');
 try{
  const migrationIndex=migrationFiles.indexOf('0008_generated_library_titles.sql');assert.ok(migrationIndex>=0);
  for(const migration of migrations.slice(0,migrationIndex))database.exec(migration);
  const insights=JSON.stringify({summary:'Keep the current summary.',takeaways:[],resources:[]});
  database.prepare("INSERT INTO jobs(id,owner_id,url,status,title,edited_title,insights,insight_status,insight_lease,insight_revision,created_at,updated_at) VALUES('saved','owner','https://youtu.be/abcdefghijk','completed','Original source','Manual heading',?,'processing','old-lease',2,'2026-10-27','2026-10-27')").run(insights);
  database.exec(migrations[migrationIndex]);
  const saved=database.prepare("SELECT * FROM jobs WHERE id='saved'").get();
  assert.equal(saved.title,'Original source');assert.equal(saved.edited_title,'Manual heading');assert.equal(saved.generated_title,null);assert.equal(saved.insights,insights);
  assert.equal(saved.insight_status,'queued');assert.equal(saved.insight_lease,null);assert.equal(saved.insight_revision,null);
  assert.equal(database.prepare("SELECT title FROM jobs_fts").get().title,'Manual heading');
 }finally{database.close();}
});

test('leased generated titles reach detail, lists and search while manual titles remain authoritative',async()=>{
 seedJob('generated',{status:'completed',title:'Original source caption',transcript:'Source text about effective study.'});
 const claimed=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 assert.equal(claimed.job.originalTitle,'Original source caption');assert.equal(claimed.job.generatedTitle,null);
 const payload={leaseToken:claimed.leaseToken,sourceRevision:claimed.sourceRevision,status:'completed',title:'🔥 日本語 study methods #learning https://example.com',engine:'Local model',insights:{summary:'Study effectively.',takeaways:[],resources:[]},suggestions:{collectionId:null,tags:[]}};
 let response=await insightsComplete.PATCH(engineRequest('/api/worker/insights/generated','PATCH',payload),context('generated'));assert.equal(response.status,200,await response.clone().text());
 let job=(await (await detail('generated')).json()).job;
 assert.equal(job.title,'日本語 study methods');assert.equal(job.generatedTitle,'日本語 study methods');assert.equal(job.originalTitle,'Original source caption');assert.equal(job.editedTitle,null);
 assert.equal((await list('q=study')).jobs[0].title,'日本語 study methods');assert.equal((await list('q='+encodeURIComponent('日本'))).total,1);assert.equal((await list('q=caption')).total,0);
 job=(await (await edit('generated',{title:'My manual heading',expectedRevision:0})).json()).job;
 assert.equal(job.title,'My manual heading');assert.equal(job.generatedTitle,'日本語 study methods');assert.equal(job.originalTitle,'Original source caption');
 assert.equal((await list('q=study')).total,1,'Transcript remains searchable');assert.equal((await list('q=methods')).total,0,'Hidden generated titles do not match');
 job=(await (await edit('generated',{title:null,expectedRevision:1})).json()).job;assert.equal(job.title,'日本語 study methods');
 await edit('generated',{title:'Second manual heading',expectedRevision:2});
 job=(await (await edit('generated',{resetEdits:true,expectedRevision:3})).json()).job;assert.equal(job.title,'日本語 study methods','Resetting only a manual title restores generated fallback');
 await edit('generated',{regenerateInsights:true,expectedRevision:4});
 const newer=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 await edit('generated',{transcript:'Changed source text',expectedRevision:5});
 response=await insightsComplete.PATCH(engineRequest('/api/worker/insights/generated','PATCH',{...payload,title:'Stale replacement',leaseToken:newer.leaseToken,sourceRevision:newer.sourceRevision}),context('generated'));
 assert.equal(response.status,409);job=(await (await detail('generated')).json()).job;assert.equal(job.generatedTitle,null);assert.equal(job.title,'Original source caption');assert.equal(job.originalTranscript,'Source text about effective study.');
});

test('title-only edits and resets preserve summaries and suggestions but revoke active insight leases',async()=>{
 const insights={summary:'Keep this summary.',takeaways:['Keep this takeaway.'],resources:[]};
 const suggestions={collectionId:null,tags:['keep']};
 for(const state of ['completed','processing'])for(const input of [{title:'My astronomy heading'},{title:null},{resetEdits:true}]){
  sqlite.exec('DELETE FROM jobs');
  seedJob('title-only',{status:'completed',title:'Long source caption',generated_title:'Compact generated label',edited_title:'Previous owner heading',insights:JSON.stringify(insights),suggestions:JSON.stringify(suggestions),insight_status:state,insight_lease:state==='processing'?'in-flight-lease':null,insight_lease_expires_at:state==='processing'?'2999-01-01T00:00:00Z':null});
  const response=await edit('title-only',{...input,expectedRevision:0});assert.equal(response.status,200,await response.clone().text());
  const job=(await response.json()).job,saved=stored('title-only'),manual=typeof input.title==='string';
  assert.equal(job.title,manual?'My astronomy heading':'Compact generated label');assert.equal(job.generatedTitle,'Compact generated label');assert.equal(job.originalTitle,'Long source caption');
  assert.deepEqual(job.insights,insights);assert.deepEqual(job.suggestions,suggestions);assert.equal(saved.insights,JSON.stringify(insights));assert.equal(saved.suggestions,JSON.stringify(suggestions));
  assert.equal((await list('q=astronomy')).total,manual?1:0);assert.equal((await list('q=generated')).total,manual?0:1);
  assert.equal(saved.revision,1);assert.equal(saved.insight_status,state==='processing'?'queued':'completed');assert.equal(saved.insight_lease,null);assert.equal(saved.insight_lease_expires_at,null);
  if(state==='processing'){
   const stale=await insightsComplete.PATCH(engineRequest('/api/worker/insights/title-only','PATCH',{leaseToken:'in-flight-lease',sourceRevision:0,status:'completed',title:'Stale title',engine:'Local model',insights:{...insights,summary:'Stale replacement.'},suggestions}),context('title-only'));
   assert.equal(stale.status,409);assert.equal(stored('title-only').insights,JSON.stringify(insights));assert.equal(stored('title-only').generated_title,'Compact generated label');
  }
 }
});

test('older insight workers may omit titles and generated titles never replace manual titles',async()=>{
 seedJob('old-worker',{status:'completed',title:'Source caption',generated_title:'Existing compact title',edited_title:'Owner title'});
 let claim=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 const payload={leaseToken:claim.leaseToken,sourceRevision:claim.sourceRevision,status:'completed',engine:'Old local model',insights:{summary:'Keep the summary.',takeaways:[],resources:[]},suggestions:{collectionId:null,tags:[]}};
 assert.equal((await insightsComplete.PATCH(engineRequest('/api/worker/insights/old-worker','PATCH',payload),context('old-worker'))).status,200);
 assert.equal(stored('old-worker').generated_title,'Existing compact title');
 await edit('old-worker',{regenerateInsights:true});claim=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 assert.equal((await insightsComplete.PATCH(engineRequest('/api/worker/insights/old-worker','PATCH',{...payload,leaseToken:claim.leaseToken,sourceRevision:claim.sourceRevision,title:'A new compact title'}),context('old-worker'))).status,200);
 const job=(await (await detail('old-worker')).json()).job;assert.equal(job.title,'Owner title');assert.equal(job.generatedTitle,'A new compact title');assert.equal(job.originalTitle,'Source caption');
});

test('editing preserves originals, detects stale edits, searches edited text and resets source',async()=>{
 seedJob('edit',{status:'completed',transcript:'Original words 日本語',title:'Original title'});
 let response=await edit('edit',{title:'My corrected title',transcript:'Corrected words 日本語',notes:'Personal note',highlights:[{id:'h1',quote:'Corrected words',note:'Useful'}],expectedRevision:0});
 assert.equal(response.status,200,await response.clone().text());let job=(await response.json()).job;
 assert.equal(job.originalTranscript,'Original words 日本語');assert.equal(job.transcript,'Corrected words 日本語');assert.equal(job.originalTitle,'Original title');assert.equal(job.title,'My corrected title');assert.equal(job.revision,1);
 assert.equal((await edit('edit',{notes:'Lost update',expectedRevision:0})).status,409);
 assert.equal((await list('q=corrected')).total,1);assert.equal((await list('q=Personal')).total,1);assert.equal((await list('q=日本')).total,1);assert.equal((await list('q=本語')).total,1);assert.equal((await list('q=Original')).total,0);
 job=(await (await edit('edit',{resetEdits:true,expectedRevision:1})).json()).job;assert.equal(job.transcript,'Original words 日本語');assert.equal(job.notes,'Personal note');assert.equal(job.insightStatus,'queued');
});
test('Trash hides items, blocks worker callbacks, restores extraction and requires Trash before purge',async()=>{
 seedJob('trash',{status:'completed'});assert.equal((await jobDetail.DELETE(userRequest('/api/jobs/trash?permanent=1','DELETE'),context('trash'))).status,409);
 assert.equal((await jobDetail.DELETE(userRequest('/api/jobs/trash','DELETE'),context('trash'))).status,200);assert.equal((await list('')).total,0);assert.equal((await list('view=trash')).total,1);assert.equal((await complete('trash')).status,409);
 assert.equal((await edit('trash',{restore:true})).status,200);assert.equal((await list('')).total,1);assert.equal(stored('trash').transcript,'Old audio transcript');
 await jobDetail.DELETE(userRequest('/api/jobs/trash','DELETE'),context('trash'));assert.equal((await jobDetail.DELETE(userRequest('/api/jobs/trash?permanent=1','DELETE'),context('trash'))).status,200);assert.equal((await detail('trash')).status,404);
});
test('Inbox review and batch tags preserve existing values and owner boundaries',async()=>{
 seedJob('one',{status:'completed',tags:'["old"]'});seedJob('two',{status:'completed'});seedJob('foreign',{owner_id:'foreign',status:'completed'});
 assert.equal((await list('view=inbox')).total,2);
 let response=await batchJobs.PATCH(userRequest('/api/jobs/batch','PATCH',{ids:['one','two'],action:'tag',tags:['new']}));assert.equal(response.status,200);assert.equal((await response.json()).updated,2);assert.deepEqual(JSON.parse(stored('one').tags),['old','new']);
 response=await batchJobs.PATCH(userRequest('/api/jobs/batch','PATCH',{ids:['one','two'],action:'review',reviewed:true}));assert.equal(response.status,200);assert.equal((await list('view=inbox')).total,0);assert.equal((await list('view=reviewed')).total,2);
 response=await batchJobs.PATCH(userRequest('/api/jobs/batch','PATCH',{ids:['one','foreign'],action:'trash'}));assert.equal(response.status,404);assert.equal(stored('one').trashed_at,null);
});
test('indexed search ranks title matches, handles literal operators and stays in current view',async()=>{
 seedJob('body',{status:'completed',transcript:'learning astronomy methods',title:'Other'});seedJob('title',{status:'completed',transcript:'methods',title:'astronomy'});seedJob('literal',{status:'completed',transcript:'100% foo_ complete "quoted"'});
 assert.deepEqual((await list('q=astronomy')).jobs.map(j=>j.id),['title','body']);assert.equal((await list('q='+encodeURIComponent('100%'))).total,1);assert.equal((await list('q='+encodeURIComponent('"quoted"'))).total,1);assert.equal((await list('q='+encodeURIComponent("' OR 1=1 --"))).total,0);
 await jobDetail.DELETE(userRequest('/api/jobs/title','DELETE'),context('title'));assert.deepEqual((await list('q=astronomy')).jobs.map(j=>j.id),['body']);assert.equal((await list('q=astronomy&view=trash')).total,1);
});
test('local summaries validate resources and stale revisions and suggestion acceptance is explicit',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('learn','owner','Learning','2026-10-27');seedJob('summary',{status:'completed',transcript:'Learning from a free course. Read https://example.com/course for free.'});
 let claimed=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();assert.equal(claimed.job.id,'summary');
 let payload={leaseToken:claimed.leaseToken,sourceRevision:claimed.sourceRevision,status:'completed',engine:'Local test model',insights:{summary:'A course.\nA second sentence should not be stored.',takeaways:['A free course.'],resources:[{label:'Course',url:'https://invented.example/'}]},suggestions:{collectionId:'learn',tags:['learning']}};
 assert.equal((await insightsComplete.PATCH(engineRequest('/api/worker/insights/summary','PATCH',payload),context('summary'))).status,400);
 payload.insights.resources[0].url='https://example.com/course';assert.equal((await insightsComplete.PATCH(engineRequest('/api/worker/insights/summary','PATCH',payload),context('summary'))).status,200);assert.equal(stored('summary').collection_id,null);
 assert.equal(JSON.parse(stored('summary').insights).summary,'A course.');
 assert.equal((await edit('summary',{acceptSuggestions:true})).status,200);assert.equal(stored('summary').collection_id,'learn');assert.deepEqual(JSON.parse(stored('summary').tags),['learning']);
 await edit('summary',{regenerateInsights:true});claimed=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();await edit('summary',{transcript:'Changed source'});payload={...payload,leaseToken:claimed.leaseToken,sourceRevision:claimed.sourceRevision};assert.equal((await insightsComplete.PATCH(engineRequest('/api/worker/insights/summary','PATCH',payload),context('summary'))).status,409);
});
test('legacy summaries become one short line without rewriting original extraction or takeaways',async()=>{
 const cases=[
  ['sentences','• A useful first sentence.\nDo not include the second sentence.','A useful first sentence.'],
  ['cjk','無料講座を紹介します。次の説明は表示しません。','無料講座を紹介します。'],
  ['words',Array.from({length:40},()=> 'word').join('\n'),null],
  ['characters','日本語'.repeat(100),null],
 ];
 for(const [id,summary,expected] of cases){
  seedJob(id,{status:'completed',insights:JSON.stringify({summary,takeaways:['Keep this optional detail.'],resources:[]})});
  const job=(await (await detail(id)).json()).job;
  assert.ok(Array.from(job.insights.summary).length<=100);
  assert.ok(job.insights.summary.split(/\s+/u).length<=16);
  assert.doesNotMatch(job.insights.summary,/[\r\n]/u);
  if(expected)assert.equal(job.insights.summary,expected);
  assert.deepEqual(job.insights.takeaways,['Keep this optional detail.']);
  assert.equal(job.originalTranscript,'Old audio transcript');
  assert.equal(JSON.parse(stored(id).insights).summary,summary);
 }
});
test('legacy suggestions expose and apply only the same three proposals with case-insensitive saved-tag matching',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('learn','owner','Learning','2026-10-27');
 const saved=['Python','OwnerTag','third','fourth'];
 const suggestion={collectionId:'learn',tags:['PYTHON','new-one','new-two','hidden-fourth','hidden-fifth']};
 seedJob('legacy-suggestions',{status:'completed',transcript:'Learning Python from useful examples.',tags:JSON.stringify(saved),suggestions:JSON.stringify(suggestion)});
 const job=(await (await detail('legacy-suggestions')).json()).job;
 assert.deepEqual(job.tags,saved);assert.deepEqual(job.suggestions.tags,['python','new-one','new-two']);
 assert.equal(stored('legacy-suggestions').suggestions,JSON.stringify(suggestion));
 const response=await edit('legacy-suggestions',{acceptSuggestions:true});assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(JSON.parse(stored('legacy-suggestions').tags),[...saved,'new-one','new-two']);
 assert.equal(stored('legacy-suggestions').collection_id,'learn');assert.equal(stored('legacy-suggestions').suggestions,null);
});
test('suggestion acceptance uses only remaining tag slots and preserves all existing manual tags',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('learn','owner','Learning','2026-10-27');
 for(const count of [10,11,12]){
  const id=`capacity-${count}`,saved=Array.from({length:count},(_,i)=>`Owner-${i}`);
  seedJob(id,{status:'completed',transcript:'Learning Python from useful examples.',tags:JSON.stringify(saved),suggestions:JSON.stringify({collectionId:'learn',tags:['new','NEW','second','third','hidden']})});
  const response=await edit(id,{acceptSuggestions:true});assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(JSON.parse(stored(id).tags),[...saved,...['new','second','third'].slice(0,12-count)]);
  assert.equal(stored(id).collection_id,'learn');
 }
});
test('worker suggestion normalization caps unique proposals without reducing saved tags',async()=>{
 const saved=Array.from({length:8},(_,i)=>`saved-${i}`);
 seedJob('worker-suggestions',{status:'completed',tags:JSON.stringify(saved)});
 const claim=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 const payload={leaseToken:claim.leaseToken,sourceRevision:claim.sourceRevision,status:'completed',engine:'Local test model',insights:{summary:'A short summary.',takeaways:[],resources:[]},suggestions:{collectionId:null,tags:['AI','ai','Python','Research','hidden','another-hidden']}};
 const response=await insightsComplete.PATCH(engineRequest('/api/worker/insights/worker-suggestions','PATCH',payload),context('worker-suggestions'));
 assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(JSON.parse(stored('worker-suggestions').suggestions).tags,['ai','python','research']);
 assert.deepEqual(JSON.parse(stored('worker-suggestions').tags),saved);
});
test('backup imports cap legacy proposals while preserving the twelve-tag library capacity',async()=>{
 const saved=Array.from({length:9},(_,i)=>`saved-${i}`);
 const suggestion={collectionId:null,tags:['one','two','three','four','five']};
 seedJob('backup-suggestions',{status:'completed',tags:JSON.stringify(saved),suggestions:JSON.stringify(suggestion)});
 const backup=await (await backupRoutes.GET()).json();
 assert.deepEqual(JSON.parse(backup.items[0].suggestions),suggestion);
 sqlite.exec('DELETE FROM jobs');
 const response=await backupRoutes.POST(userRequest('/api/backup','POST',backup));assert.equal(response.status,200,await response.clone().text());
 assert.deepEqual(JSON.parse(stored('backup-suggestions').tags),saved);
 assert.deepEqual(JSON.parse(stored('backup-suggestions').suggestions).tags,['one','two','three']);
});
test('resolved platform identity deduplicates short links without losing receipt IDs',async()=>{
 seedJob('canonical',{platform:'tiktok',status:'completed',url:'https://www.tiktok.com/@test/video/1234567890123456789',canonical_id:'tiktok:1234567890123456789'});seedJob('short',{platform:'tiktok',url:'https://vt.tiktok.com/abc/',tags:'["keep"]'});
 const response=await identity.POST(engineRequest('/api/worker/jobs/short/identity','POST',{leaseToken:'synthetic-lease-short',platform:'tiktok',postId:'1234567890123456789',canonicalUrl:'https://www.tiktok.com/@test/video/1234567890123456789'}),context('short'));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).duplicateJobId,'canonical');assert.equal((await list('')).total,1);assert.equal((await (await detail('short')).json()).job.id,'canonical');assert.deepEqual(JSON.parse(stored('canonical').tags),['keep']);
});
test('backfill slides store private images with independent leases without changing transcript',async()=>{
 seedJob('slides',{status:'completed',content_kind:'image',pages:'[{"index":1,"text":"Original slide"}]',transcript:'Original slide'});
 const claimed=await (await slidesClaim.POST(engineRequest('/api/worker/slides/claim','POST',{}))).json();assert.equal(claimed.job.id,'slides');
 const request=new Request('https://cliptext.example/api/worker/jobs/slides/slides/1',{method:'PUT',headers:{'Content-Type':'image/jpeg','X-Cliptext-Engine':'1','X-Cliptext-Engine-Key':fixture.env.CLIPTEXT_ENGINE_SECRET,'X-Cliptext-Lease-Token':claimed.job.leaseToken},body:jpeg});
 const response=await slidesUpload.PUT(request,{params:Promise.resolve({id:'slides',index:'1'})});assert.equal(response.status,200,await response.clone().text());assert.equal(images.size,1);assert.equal(stored('slides').transcript,'Original slide');assert.match((await (await detail('slides')).json()).job.pages[0].imageUrl,/\/slides\/1$/);
 assert.equal((await slidesFinish.PATCH(engineRequest('/api/worker/slides/slides','PATCH',{leaseToken:claimed.job.leaseToken,status:'completed'}),context('slides'))).status,200);assert.equal(stored('slides').slide_status,'ready');
});
test('full backup restores collections, edits, notes, Trash and JPEG assets without overwriting existing items',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('collection','owner','Learning','2026-10-27');seedJob('saved',{platform:'instagram',status:'completed',collection_id:'collection',title:'Original source title',generated_title:'Compact generated title',edited_title:'Owner title',transcript:'Source text',edited_transcript:'Corrected text',notes:'My notes',trashed_at:'2026-10-27T00:00:00Z',highlights:'[{"id":"h","quote":"Corrected","note":"keep"}]'});
 images.set('source-image',jpeg);sqlite.prepare("INSERT INTO job_frames(job_id,status,image_key,width,height,kind,updated_at) VALUES('saved','ready','source-image',2,2,'thumbnail','2026-10-27')").run();
 const exported=await backupRoutes.GET();assert.equal(exported.status,200,await exported.clone().text());const backup=await exported.json();assert.equal(backup.items.length,1);assert.equal(backup.assets.length,1);assert.equal(backup.items[0].lease_token,undefined);assert.equal(backup.items[0].generated_title,'Compact generated title');assert.equal(backup.items[0].highlights,'[{"id":"h","quote":"Corrected","note":"keep"}]');
 sqlite.exec('DELETE FROM jobs; DELETE FROM collections;');images.clear();
 let response=await backupRoutes.POST(userRequest('/api/backup','POST',backup));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).restored,1);assert.equal(images.size,1);let restoredId=sqlite.prepare('SELECT id FROM jobs').get().id;let job=(await (await detail(restoredId)).json()).job;assert.equal(job.transcript,'Corrected text');assert.equal(job.originalTranscript,'Source text');assert.equal(job.notes,'My notes');assert.equal(job.title,'Owner title');assert.equal(job.generatedTitle,'Compact generated title');assert.equal(job.originalTitle,'Original source title');assert.deepEqual(job.highlights,[{id:'h',quote:'Corrected',note:'keep'}]);assert.ok(job.trashedAt);assert.equal(sqlite.prepare('SELECT name FROM collections').get().name,'Learning');
 response=await backupRoutes.POST(userRequest('/api/backup','POST',backup));assert.equal(response.status,200);assert.equal((await response.json()).skipped,1);assert.equal(images.size,1);
 backup.items[0].url='https://evil.example/';assert.equal((await backupRoutes.POST(userRequest('/api/backup','POST',backup))).status,400);assert.equal(images.size,1);
});

test('older backups without generated titles restore existing summaries and queue the missing title',async()=>{
 const insights=JSON.stringify({summary:'Existing summary.',takeaways:['Keep this detail.'],resources:[]});
 seedJob('legacy-backup',{status:'completed',title:'Original caption',insights,insight_status:'completed',highlights:'[{"id":"old","quote":"Old audio","note":"Historical"}]'});
 const backup=await (await backupRoutes.GET()).json();delete backup.items[0].generated_title;
 sqlite.exec('DELETE FROM jobs');
 const response=await backupRoutes.POST(userRequest('/api/backup','POST',backup));assert.equal(response.status,200,await response.clone().text());
 const saved=stored('legacy-backup');assert.equal(saved.title,'Original caption');assert.equal(saved.generated_title,null);assert.equal(saved.insights,insights);assert.equal(saved.insight_status,'queued');assert.equal(JSON.parse(saved.highlights)[0].note,'Historical');
});

test('duplicate resolution keeps both records when notes or tags cannot merge losslessly',async()=>{
  const resolve=async(id,postId)=>identity.POST(engineRequest(`/api/worker/jobs/${id}/identity`,'POST',{leaseToken:'synthetic-lease-'+id,platform:'tiktok',postId,canonicalUrl:`https://www.tiktok.com/@test/video/${postId}`}),context(id));
  const postId='1234567890123456789';
  seedJob('notes-original',{platform:'tiktok',status:'completed',url:`https://www.tiktok.com/@test/video/${postId}`,canonical_id:'tiktok:'+postId,notes:'A'.repeat(30_000)});
  seedJob('notes-new',{platform:'tiktok',url:'https://vt.tiktok.com/notes/',notes:'B'.repeat(30_000)});
  let response=await resolve('notes-new',postId);assert.equal(response.status,200);assert.equal((await response.json()).mergeConflict,'notes_limit');
  assert.equal(stored('notes-original').notes,'A'.repeat(30_000));assert.equal(stored('notes-new').notes,'B'.repeat(30_000));assert.equal(stored('notes-new').duplicate_of,null);assert.equal(stored('notes-new').canonical_id,null);assert.equal(stored('notes-new').status,'transcribing');
  const otherId='1234567890123456790',oldTags=Array.from({length:12},(_,i)=>'tag'+i);
  seedJob('tags-original',{platform:'tiktok',status:'completed',url:`https://www.tiktok.com/@test/video/${otherId}`,canonical_id:'tiktok:'+otherId,tags:JSON.stringify(oldTags)});
  seedJob('tags-new',{platform:'tiktok',url:'https://vt.tiktok.com/tags/',tags:'["extra"]'});
  response=await resolve('tags-new',otherId);assert.equal(response.status,200);assert.equal((await response.json()).mergeConflict,'tag_limit');assert.deepEqual(JSON.parse(stored('tags-original').tags),oldTags);assert.deepEqual(JSON.parse(stored('tags-new').tags),['extra']);assert.equal(stored('tags-new').duplicate_of,null);
});

test('lossless duplicate merge increments both revisions and revokes an active summary lease',async()=>{
  const postId='1234567890123456789';
  seedJob('merge-original',{platform:'tiktok',status:'completed',url:`https://www.tiktok.com/@test/video/${postId}`,canonical_id:'tiktok:'+postId,revision:7,notes:'Existing note',insight_status:'processing',insight_lease:'old-summary-lease',insight_lease_expires_at:'2999-01-01T00:00:00Z'});
  seedJob('merge-new',{platform:'tiktok',url:'https://vt.tiktok.com/merge/',notes:'Incoming note'});
  const response=await identity.POST(engineRequest('/api/worker/jobs/merge-new/identity','POST',{leaseToken:'synthetic-lease-merge-new',platform:'tiktok',postId,canonicalUrl:`https://www.tiktok.com/@test/video/${postId}`}),context('merge-new'));
  assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).duplicateJobId,'merge-original');
  const target=stored('merge-original');assert.equal(target.notes,'Existing note\n\nIncoming note');assert.equal(target.revision,8);assert.equal(target.insight_status,'queued');assert.equal(target.insight_lease,null);assert.equal(target.insight_lease_expires_at,null);assert.equal(stored('merge-new').revision,1);assert.equal(stored('merge-new').duplicate_of,'merge-original');
  assert.equal((await edit('merge-original',{notes:'A stale edit',expectedRevision:7})).status,409);assert.equal(stored('merge-original').notes,'Existing note\n\nIncoming note');
});

test('duplicate resolution rejects concurrent destination edits, Trash or deletion atomically',async()=>{
  for(const race of ['edit','trash','delete']){
    sqlite.exec('DELETE FROM jobs');const postId='1234567890123456789';
    seedJob('race-original',{platform:'tiktok',status:'completed',url:`https://www.tiktok.com/@test/video/${postId}`,canonical_id:'tiktok:'+postId,notes:'Original note'});
    seedJob('race-new',{platform:'tiktok',url:'https://vt.tiktok.com/race/',notes:'Incoming note'});
    const originalPrepare=fixture.env.DB.prepare;let injected=false;
    fixture.env.DB.prepare=function(sql){if(!injected&&sql.includes('WITH eligible AS MATERIALIZED')){injected=true;if(race==='edit')sqlite.prepare("UPDATE jobs SET notes='Concurrent edit',revision=revision+1 WHERE id='race-original'").run();if(race==='trash')sqlite.prepare("UPDATE jobs SET trashed_at='2026-10-27T00:00:00Z' WHERE id='race-original'").run();if(race==='delete')sqlite.prepare("DELETE FROM jobs WHERE id='race-original'").run();}return originalPrepare.call(this,sql);};
    let response;try{response=await identity.POST(engineRequest('/api/worker/jobs/race-new/identity','POST',{leaseToken:'synthetic-lease-race-new',platform:'tiktok',postId,canonicalUrl:`https://www.tiktok.com/@test/video/${postId}`}),context('race-new'));}finally{fixture.env.DB.prepare=originalPrepare;}
    assert.equal(response.status,409,race);assert.ok(injected,race);assert.equal(stored('race-new').duplicate_of,null,race);assert.equal(stored('race-new').notes,'Incoming note',race);assert.equal(stored('race-new').status,'transcribing',race);assert.equal(stored('race-new').revision,0,race);
    if(race!=='delete')assert.equal(stored('race-original').notes,race==='edit'?'Concurrent edit':'Original note',race);
  }
});


test('unsupported legacy collection proposals stay hidden and cannot move an item on Apply',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('design','owner','Design','2026-10-27');
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('marketing','owner','Marketing','2026-10-27');
 const suggestion={collectionId:'design',tags:['value','pricing','quality']};
 seedJob('baker',{status:'completed',title:'Design is only an original caption',transcript:'A baker doubles his prices, works half the time, and improves quality. The price you charge signals the value of your work.',collection_id:'marketing',suggestions:JSON.stringify(suggestion)});
 const job=(await (await detail('baker')).json()).job;
 assert.equal(job.suggestions.collectionId,null);assert.equal(job.collectionId,'marketing');
 assert.equal(stored('baker').suggestions,JSON.stringify(suggestion));
 assert.equal((await edit('baker',{acceptSuggestions:true})).status,200);
 assert.equal(stored('baker').collection_id,'marketing');assert.deepEqual(JSON.parse(stored('baker').tags),['value','pricing','quality']);
});

test('new worker results and supported legacy proposals use extracted topic evidence',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('design','owner','Design','2026-10-27');
 seedJob('fresh-pricing',{status:'completed',transcript:'A baker doubles his prices. The price you charge signals the value of your work.'});
 let claim=await (await insightsClaim.POST(engineRequest('/api/worker/insights/claim','POST',{}))).json();
 const payload={leaseToken:claim.leaseToken,sourceRevision:claim.sourceRevision,status:'completed',engine:'Local test model',insights:{summary:'Price signals value.',takeaways:[],resources:[]},suggestions:{collectionId:'design',tags:['pricing']}};
 let response=await insightsComplete.PATCH(engineRequest('/api/worker/insights/fresh-pricing','PATCH',payload),context('fresh-pricing'));
 assert.equal(response.status,200,await response.clone().text());assert.equal(JSON.parse(stored('fresh-pricing').suggestions).collectionId,null);
 seedJob('real-design',{status:'completed',transcript:'Design rule: make one element the hero. Use size and hierarchy to improve messy design.',suggestions:JSON.stringify({collectionId:'design',tags:['hierarchy']})});
 assert.equal((await (await detail('real-design')).json()).job.suggestions.collectionId,'design');
 assert.equal((await edit('real-design',{acceptSuggestions:true})).status,200);assert.equal(stored('real-design').collection_id,'design');
});

test('pasting existing items individually or in a batch cannot bypass legacy collection filtering',async()=>{
 sqlite.prepare('INSERT INTO collections VALUES(?,?,?,?)').run('design','owner','Design','2026-10-27');
 const url='https://www.instagram.com/p/ExistingBaker/';
 const proposal={collectionId:'design',tags:['pricing']};
 seedJob('existing-baker',{status:'completed',url,transcript:'A baker doubles his prices and improves the quality of his work.',suggestions:JSON.stringify(proposal)});
 const single=await jobs.POST(userRequest('/api/jobs','POST',{url}));assert.equal(single.status,201,await single.clone().text());
 assert.equal((await single.json()).job.suggestions.collectionId,null);
 const batch=await batchJobs.POST(userRequest('/api/jobs/batch','POST',{urls:[url]}));assert.equal(batch.status,201,await batch.clone().text());
 assert.equal((await batch.json()).results[0].job.suggestions.collectionId,null);
 assert.equal(stored('existing-baker').suggestions,JSON.stringify(proposal));assert.equal(stored('existing-baker').collection_id,null);
});
