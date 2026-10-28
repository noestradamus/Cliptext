import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Execute the production export code and route. SQLite replaces D1 and the
// owner-private sign-in provider is stubbed; neither export implementation is mocked.
const fixtureKey = Symbol.for('cliptext.export.test');
const fixture = { env: {}, signedIn: true };
globalThis[fixtureKey] = fixture;
const fixtureLookup = "globalThis[Symbol.for('cliptext.export.test')]";
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const overrides = new Map([
  ['cloudflare:workers', moduleUrl(`export const env = ${fixtureLookup}.env;`)],
  [new URL('../app/chatgpt-auth', import.meta.url).href, moduleUrl(`export async function getChatGPTUser() { return ${fixtureLookup}.signedIn ? {id: 'synthetic-user'} : null; }`)],
]);
const compiled = new Map();
async function sourceModule(path) {
  const url = path instanceof URL ? path : new URL('../' + path, import.meta.url);
  if (compiled.has(url.href)) return compiled.get(url.href);
  const source = await readFile(url, 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  const imports = [...outputText.matchAll(/(?:from\s+|import\s*\()(['"])([^'"]+)\1/g)];
  const resolved = new Map();
  for (const [, , specifier] of imports) {
    if (resolved.has(specifier)) continue;
    const dependency = specifier.startsWith('.') ? new URL(specifier, url) : null;
    if (overrides.has(specifier) || (dependency && overrides.has(dependency.href))) {
      resolved.set(specifier, overrides.get(specifier) ?? overrides.get(dependency.href));
    } else if (dependency) {
      if (!dependency.pathname.endsWith('.ts')) dependency.pathname += '.ts';
      resolved.set(specifier, await sourceModule(dependency));
    } else resolved.set(specifier, import.meta.resolve(specifier));
  }
  const transformed = outputText.replace(/(from\s+|import\s*\()(['"])([^'"]+)\2/g, (_match, prefix, _quote, specifier) => prefix + JSON.stringify(resolved.get(specifier)));
  const result = moduleUrl(transformed);
  compiled.set(url.href, result);
  return result;
}
const exports = await import(await sourceModule('lib/export.ts'));
test('exports apply the one-line summary limit to saved legacy results',()=>{
 const item=exports.toExportRecord({insights:JSON.stringify({summary:'A concise idea.\nMore explanation should not appear in the export.'})});
 assert.equal(item.summary,'A concise idea.');
 const long=exports.toExportRecord({insights:JSON.stringify({summary:'日本語'.repeat(100)})});
 assert.equal(Array.from(long.summary).length,100);
 assert.ok(long.summary.endsWith('…'));
});
const route = await import(await sourceModule('app/api/export/route.ts'));
const migrationsDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationsDirectory), 'utf8')));
let sqlite;
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true;
  fixture.loadedTranscripts = 0;
  fixture.env.DB = {
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      function bound(values) {
        return {
          async first() { const row = statement.get(...values); return row ? { ...row } : null; },
          async all() {
            const results = statement.all(...values).map(row => ({ ...row }));
            fixture.loadedTranscripts += results.filter(row => Object.hasOwn(row, 'transcript')).length;
            return { success: true, results };
          },
          async run() { return { success: true, meta: statement.run(...values) }; },
        };
      }
      return { ...bound([]), bind: (...values) => bound(values) };
    },
  };
});
afterEach(() => sqlite.close());
after(() => { delete globalThis[fixtureKey]; });

function seedCollection(id, name = id, ownerId = 'owner') {
  sqlite.prepare('INSERT INTO collections(id,owner_id,name,created_at) VALUES(?,?,?,?)').run(id, ownerId, name, '2026-10-26T00:00:00.000Z');
}
function seedJob(id, overrides = {}) {
  const row = {
    id, owner_id: 'owner', url: 'https://www.youtube.com/watch?v=' + id,
    status: 'completed', progress: 100, title: 'Synthetic video ' + id, creator: 'Synthetic creator',
    transcript: 'Full synthetic transcript ' + id, language: 'en', duration_seconds: 1,
    favorite: 0, tags: '[]', platform: 'youtube',
    created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:00:00.000Z', ...overrides,
  };
  sqlite.prepare(`INSERT INTO jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  return row;
}
const download = params => route.GET(new Request('https://cliptext.example/api/export?' + new URLSearchParams(params)));
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { row.push(value); value = ''; }
    else if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(value); rows.push(row); row = []; value = '';
    } else value += char;
  }
  assert.equal(quoted, false, 'CSV has balanced quotes');
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}
async function csvResponse(response) {
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], 'UTF-8 BOM supports spreadsheet import');
  const [headers, ...rows] = parseCsv(bytes.toString('utf8'));
  assert.deepEqual(headers, ['Collection', 'Title', 'Creator', 'Platform', 'Tags', 'Saved at (UTC)', 'Source URL', 'Transcript', 'Status', 'Item ID', 'Notes', 'Summary', 'Reviewed at (UTC)']);
  assert.ok(rows.every(row => row.length === headers.length));
  return rows.map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
}
function record(id, overrides = {}) {
  return { id, title: 'Title ' + id, creator: 'Creator', platform: 'youtube', tags: ['日本語', 'research'], createdAt: '2026-10-26T00:00:00.000Z', url: 'https://www.youtube.com/watch?v=' + id, status: 'completed', transcript: 'Full transcript ' + id, collectionId: null, collectionName: 'Unsorted', ...overrides };
}

// Read the generated ZIP and OOXML with Python's standard library, independently
// from ExcelJS. Decode ST_Xstring in a single pass so literal _xNNNN_ text survives.
const inspectWorkbookScript = String.raw`
import io,json,posixpath,re,sys,zipfile,xml.etree.ElementTree as ET
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
rid='{'+ns['r']+'}id'
def root(path): return ET.fromstring(z.read(path))
def decode(text): return re.sub(r'_x([0-9A-Fa-f]{4})_',lambda m:chr(int(m[1],16)),text or '')
def texts(node): return decode(''.join(t.text or '' for t in node.findall('.//m:t',ns)))
shared=[texts(si) for si in root('xl/sharedStrings.xml').findall('m:si',ns)] if 'xl/sharedStrings.xml' in z.namelist() else []
rels={r.attrib['Id']:r.attrib['Target'] for r in root('xl/_rels/workbook.xml.rels')}
styles=root('xl/styles.xml').find('m:cellXfs',ns)
style_info=[{'wrap': x.find('m:alignment',ns) is not None and x.find('m:alignment',ns).get('wrapText')=='1'} for x in styles]
result=[]
for sheet in root('xl/workbook.xml').findall('m:sheets/m:sheet',ns):
 target=rels[sheet.attrib[rid]]
 path=target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl',target))
 data=root(path)
 relationship_path=posixpath.join(posixpath.dirname(path),'_rels',posixpath.basename(path)+'.rels')
 links={r.attrib['Id']:r.attrib['Target'] for r in root(relationship_path)} if relationship_path in z.namelist() else {}
 rows=[]
 for row in data.findall('m:sheetData/m:row',ns):
  cells=[]
  for c in row.findall('m:c',ns):
   v=c.find('m:v',ns)
   value=v.text if v is not None else ''
   if c.get('t')=='s': value=shared[int(value)]
   elif c.get('t')=='inlineStr': value=texts(c)
   elif c.get('t')=='str': value=decode(value)
   cells.append({'ref':c.get('r'),'type':c.get('t'),'value':value,'formula':c.find('m:f',ns) is not None,'style':int(c.get('s','0'))})
  rows.append(cells)
 pane=data.find('m:sheetViews/m:sheetView/m:pane',ns)
 auto=data.find('m:autoFilter',ns)
 result.append({'name':sheet.get('name'),'rows':rows,'pane':dict(pane.attrib) if pane is not None else None,'autoFilter':auto.get('ref') if auto is not None else None,'columns':[dict(c.attrib) for c in data.findall('m:cols/m:col',ns)],'links':[{'ref':h.get('ref'),'target':links.get(h.get(rid),h.get('location'))} for h in data.findall('m:hyperlinks/m:hyperlink',ns)]})
print(json.dumps({'sheets':result,'styles':style_info},ensure_ascii=True))
`;
function inspectWorkbook(bytes) {
  const result = spawnSync('python3', ['-c', inspectWorkbookScript], { input: Buffer.from(bytes), maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}
function sheetRows(sheet) {
  const headers = sheet.rows[0].map(cell => cell.value);
  return sheet.rows.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index]?.value ?? ''])));
}

test('whole-library CSV exports every matching row across pages and isolates the owner', async () => {
  seedCollection('personal', 'Personal');
  seedCollection('foreign', 'Foreign collection', 'another-owner');
  for (let index = 0; index < 61; index++) seedJob('video-' + index, { collection_id: index % 2 ? 'personal' : null, status: index === 0 ? 'queued' : 'completed' });
  seedJob('foreign-video', { owner_id: 'another-owner', collection_id: 'foreign', transcript: 'NEVER EXPORT THIS' });
  const response = await download({ format: 'csv', scope: 'all', page: '3', pageSize: '1', q: 'no matches', platform: 'tiktok', favorite: '1', tag: 'absent', collectionId: 'foreign' });
  assert.match(response.headers.get('content-type'), /^text\/csv/);
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.csv/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('vary'), /Cookie/i);
  const rows = await csvResponse(response);
  assert.equal(rows.length, 61);
  assert.equal(new Set(rows.map(row => row['Item ID'])).size, 61);
  assert.ok(rows.every(row => row['Item ID'] !== 'foreign-video'));
  assert.ok(rows.slice(0, 30).every(row => row.Collection === 'Personal'));
  assert.ok(rows.slice(30).every(row => row.Collection === 'Unsorted'));
  assert.equal(rows.find(row => row['Item ID'] === 'video-0').Status, 'queued');
});

test('CSV and Excel use generated titles, manual overrides and effective-title search in every scope', async () => {
  seedCollection('learning','Learning');
  seedJob('generated',{title:'Original caption',generated_title:'Compact astronomy title',collection_id:'learning'});
  seedJob('manual',{title:'Source caption',generated_title:'Hidden astronomy label',edited_title:'Owner heading',collection_id:'learning'});
  for(const selection of [{scope:'all'},{scope:'collection',collectionId:'learning'},{scope:'filtered',q:'astronomy'}]){
    const response=await download({format:'csv',...selection});const rows=await csvResponse(response);
    assert.equal(rows.find(row=>row['Item ID']==='generated').Title,'Compact astronomy title');
    if(selection.scope==='filtered')assert.equal(rows.length,1);else assert.equal(rows.find(row=>row['Item ID']==='manual').Title,'Owner heading');
    const workbook=inspectWorkbook(await (await download({format:'xlsx',...selection})).arrayBuffer());
    assert.equal(sheetRows(workbook.sheets[0]).find(row=>row['Item ID']==='generated').Title,'Compact astronomy title');
    assert.ok(workbook.sheets.every(sheet=>!sheet.rows[0].some(cell=>cell.value==='Highlights')));
  }
});

test('CSV preserves full Unicode, multiline and quoted transcripts beyond library preview length', async () => {
  const transcript = '日本語 🎥, "quoted"\r\n' + 'This is the entire saved transcript. '.repeat(40) + '\n最後';
  seedCollection('collection', '研究, "work"');
  seedJob('full', { title: '動画, "one"', creator: '作者 🎬', transcript, tags: JSON.stringify(['日本語', 'x"y']), collection_id: 'collection' });
  const rows = await csvResponse(await download({ format: 'csv', scope: 'all' }));
  assert.equal(rows[0].Transcript, transcript);
  assert.equal(rows[0].Title, '動画, "one"');
  assert.equal(rows[0].Creator, '作者 🎬');
  assert.equal(rows[0].Collection, '研究, "work"');
  assert.equal(rows[0].Tags, '日本語, x"y');
});

test('CSV neutralizes spreadsheet formula prefixes in every text column', () => {
  for (const payload of ['=1+1', '+SUM(1,2)', '-1+2', '@SUM(A1)', '\t=HYPERLINK("https://example.invalid")', '\r=1', '\n=1', '  =1']) {
    const input = record(payload, { title: payload, creator: payload, platform: payload, tags: [payload], createdAt: payload, url: payload, status: payload, transcript: payload, collectionId: 'collection', collectionName: payload, notes: payload, summary: payload, highlights: payload, reviewedAt: payload });
    const rows = parseCsv(exports.exportCsv([input]));
    assert.equal(rows[1].length, 13);
    assert.ok(rows[1].every(value => value === "'" + payload), JSON.stringify(payload));
  }
});

test('collection and Unsorted exports ignore unrelated filters and include all selected videos', async () => {
  seedCollection('wanted', 'Chosen collection');
  seedCollection('other', 'Other collection');
  for (let index = 0; index < 27; index++) seedJob('chosen-' + index, { collection_id: 'wanted' });
  seedJob('other', { collection_id: 'other' });
  seedJob('unsorted');
  for (const [collectionId, ids] of [['wanted', Array.from({ length: 27 }, (_, index) => 'chosen-' + index)], ['none', ['unsorted']]]) {
    const rows = await csvResponse(await download({ format: 'csv', scope: 'collection', collectionId, q: 'absent', favorite: '1', tag: 'missing', platform: 'tiktok', page: '9', pageSize: '1' }));
    assert.deepEqual(rows.map(row => row['Item ID']).sort(), ids.sort());
  }
});

test('filtered export uses the actual library AND/search/tag/platform/favorite/collection semantics across every page', async () => {
  seedCollection('chosen');
  seedCollection('other');
  const matching = { title: 'Alpha project', creator: 'Creator', transcript: 'Beta in complete transcript', tags: '["research","日本語"]', platform: 'youtube', favorite: 1, collection_id: 'chosen' };
  for (let index = 0; index < 35; index++) seedJob('match-' + index, matching);
  const nearMisses = [{ title: 'Only unrelated text' }, { transcript: 'No second term' }, { tags: '["researcher"]' }, { platform: 'tiktok' }, { favorite: 0 }, { collection_id: 'other' }, { owner_id: 'another-owner' }];
  nearMisses.forEach((change, index) => seedJob('miss-' + index, { ...matching, ...change }));
  const rows = await csvResponse(await download({ format: 'csv', scope: 'filtered', q: 'Alpha Beta', tag: 'research', platform: 'youtube', favorite: '1', collectionId: 'chosen', page: '2', pageSize: '1' }));
  assert.equal(rows.length, 35);
  assert.ok(rows.every(row => row['Item ID'].startsWith('match-')));
});

test('filtered exports treat LIKE wildcards and SQL-looking query text literally', async () => {
  seedJob('literal', { title: "100% foo_bar ' OR 1=1 --" });
  seedJob('near', { title: '1000 fooXbar' });
  seedJob('unrelated', { title: 'unrelated' });
  for (const q of ['100%', 'foo_bar', "' OR 1=1 --"]) {
    const rows = await csvResponse(await download({ format: 'csv', scope: 'filtered', q }));
    assert.deepEqual(rows.map(row => row['Item ID']), ['literal']);
  }
});

test('empty libraries and empty owned collections produce a usable header-only CSV', async () => {
  seedCollection('empty');
  for (const query of [{ scope: 'all' }, { scope: 'collection', collectionId: 'empty' }, { scope: 'collection', collectionId: 'none' }]) {
    assert.deepEqual(await csvResponse(await download({ format: 'csv', ...query })), []);
  }
});

test('missing and foreign collections are indistinguishable and never disclose foreign collection names', async () => {
  seedCollection('foreign', 'PRIVATE FOREIGN NAME', 'another-owner');
  seedJob('foreign', { owner_id: 'another-owner', collection_id: 'foreign' });
  const missing = await download({ format: 'csv', scope: 'collection', collectionId: 'missing' });
  const foreign = await download({ format: 'csv', scope: 'collection', collectionId: 'foreign' });
  assert.equal(missing.status, 404);
  assert.equal(foreign.status, 404);
  assert.deepEqual(await missing.json(), await foreign.json());
  assert.equal(foreign.headers.get('content-disposition'), null);
});

test('invalid export format and scope fail clearly before returning an attachment', async () => {
  for (const query of [{ format: 'pdf' }, { format: 'CSV' }, { scope: 'page' }, { scope: 'collection' }, { scope: 'collection', collectionId: '' }, { scope: 'collection', collectionId: 'a'.repeat(101) }]) {
    const response = await download(query);
    assert.equal(response.status, 400, JSON.stringify(query));
    assert.equal(response.headers.get('content-disposition'), null);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('export requires sign-in and keeps its error response private', async () => {
  seedJob('private');
  fixture.signedIn = false;
  for (const format of ['csv', 'xlsx']) {
    const response = await download({ format, scope: 'all' });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('cache-control'), /private.*no-store/);
    assert.match(response.headers.get('vary'), /Cookie/i);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match((await response.json()).error, /sign in/i);
  }
});

test('record limits return a clear 413 JSON error instead of a truncated file', async () => {
  const insert = sqlite.prepare('INSERT INTO jobs(id,owner_id,url,status,created_at,updated_at) VALUES(?,?,?,?,?,?)');
  sqlite.exec('BEGIN');
  for (let index = 0; index <= 5000; index++) insert.run('many-' + index, 'owner', 'https://example.invalid/' + index, 'completed', '2026-10-26', '2026-10-26');
  sqlite.exec('COMMIT');
  for (const format of ['csv', 'xlsx']) {
    const response = await download({ format, scope: 'all' });
    assert.equal(response.status, 413, format);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match((await response.json()).error, /too large.*No items were exported.*(collection|filters)/i);
    assert.equal(fixture.loadedTranscripts, 0, 'oversized transcript rows were never loaded into JavaScript');
  }
  seedJob('small-selection', { title: 'Distinct selected video' });
  const selected = await csvResponse(await download({ format: 'csv', scope: 'filtered', q: 'Distinct' }));
  assert.deepEqual(selected.map(row => row['Item ID']), ['small-selection'], 'narrowing the selection makes an oversized library exportable');
});

test('text limits count UTF-8 bytes and reject the entire export with a useful 413', async () => {
  for (const [format, bytes] of [['xlsx', 2 * 1024 * 1024], ['csv', 8 * 1024 * 1024]]) {
    sqlite.exec('DELETE FROM jobs');
    seedJob('large', { transcript: '猫'.repeat(Math.floor(bytes / 3) + 1) });
    const response = await download({ format, scope: 'all' });
    assert.equal(response.status, 413, format);
    assert.equal(response.headers.get('content-disposition'), null);
    assert.match((await response.json()).error, /No items were exported/);
    assert.equal(fixture.loadedTranscripts, 0, 'oversized transcript rows were never loaded into JavaScript');
  }
});

test('XLSX route returns a private downloadable workbook with collection and Unsorted sheets', async () => {
  seedCollection('research', 'Research');
  seedCollection('empty', 'Empty collection');
  seedCollection('foreign', 'PRIVATE FOREIGN NAME', 'another-owner');
  seedJob('saved', { collection_id: 'research' });
  seedJob('unsorted');
  seedJob('foreign', { owner_id: 'another-owner', collection_id: 'foreign' });
  const response = await download({ format: 'xlsx', scope: 'all' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(response.headers.get('content-disposition'), /^attachment;.*\.xlsx/);
  assert.match(response.headers.get('cache-control'), /private.*no-store/);
  assert.match(response.headers.get('vary'), /Cookie/i);
  const workbook = inspectWorkbook(await response.arrayBuffer());
  assert.deepEqual(workbook.sheets.map(sheet => sheet.name), ['All items', 'Empty collection', 'Research', 'Unsorted']);
  assert.equal(sheetRows(workbook.sheets[0]).length, 2);
  assert.equal(sheetRows(workbook.sheets[1]).length, 0);
  assert.deepEqual(sheetRows(workbook.sheets[2]).map(row => row['Item ID']), ['saved']);
  assert.deepEqual(sheetRows(workbook.sheets[3]).map(row => row['Item ID']), ['unsorted']);
  const filteredResponse = await download({ format: 'xlsx', scope: 'filtered', collectionId: 'research', page: '99', pageSize: '1' });
  assert.equal(filteredResponse.status, 200);
  const filtered = inspectWorkbook(await filteredResponse.arrayBuffer());
  assert.deepEqual(filtered.sheets.map(sheet => sheet.name), ['All items', 'Research', 'Unsorted']);
  assert.deepEqual(sheetRows(filtered.sheets[0]).map(row => row['Item ID']), ['saved']);
  assert.equal(sheetRows(filtered.sheets[2]).length, 0);
});

test('XLSX preserves text without formulas and provides frozen headers, filters, widths, wrapping and clickable source links', async () => {
  const transcript = '=SUM(1,2)\r\n日本語 🎥\n"quoted", text\u0001 literal _x0041_';
  const source = record('formula', { title: '=HYPERLINK("https://example.invalid")', creator: '+SUM(1,2)', transcript });
  const workbook = inspectWorkbook(await exports.exportXlsx([source]));
  for (const sheet of workbook.sheets) {
    assert.equal(sheet.pane.state, 'frozen');
    assert.equal(sheet.pane.ySplit, '1');
    assert.match(sheet.autoFilter, /^A1:M[12]$/);
    assert.ok(sheet.columns.some(column => Number(column.width) >= 40));
    assert.ok(sheet.rows.flat().every(cell => !cell.formula));
    const values = sheetRows(sheet);
    assert.equal(values[0].Title, source.title);
    assert.equal(values[0].Creator, source.creator);
    assert.equal(values[0].Transcript, transcript);
    assert.ok(sheet.links.some(link => link.ref === 'G2' && link.target === source.url));
    assert.ok(sheet.rows[1].every(cell => workbook.styles[cell.style].wrap));
  }
});

test('XLSX collection names are valid, case-insensitively unique and at most 31 UTF-16 units', async () => {
  const names = ['All items', 'all ITEMS', 'Unsorted', 'Transcript parts', 'History', 'history', '[]:*?/\\', "'''", 'Collection', 'x'.repeat(60), 'x'.repeat(61), '日本語'.repeat(20), '😀'.repeat(20), 'unsafe\u0001name', '_x0041_'];
  const collections = names.map((name, index) => ({ id: 'collection-' + index, name }));
  const workbook = inspectWorkbook(await exports.exportXlsx(collections.map(collection => record(collection.id, { collectionId: collection.id, collectionName: collection.name })), collections));
  const sheetNames = workbook.sheets.map(sheet => sheet.name);
  assert.equal(new Set(sheetNames.map(name => name.toLowerCase())).size, sheetNames.length);
  assert.equal(sheetNames.length, collections.length + 2);
  for (const name of sheetNames) {
    assert.ok(name.length > 0 && name.length <= 31, name);
    assert.doesNotMatch(name, /[\\/*?:\[\]\u0000-\u001f]/);
    assert.ok(!name.startsWith("'") && !name.endsWith("'"));
    assert.notEqual(name.toLowerCase(), 'history');
    assert.doesNotMatch(name, /[\uD800-\uDBFF]$/u);
  }
  const allRows = sheetRows(workbook.sheets[0]);
  assert.deepEqual(new Set(allRows.map(row => row.Collection)), new Set(names));
});

test('long and line-heavy transcripts split into numbered Excel parts and reassemble exactly', async () => {
  const sources = [
    record('utf16-boundary', { transcript: 'a'.repeat(32766) + '🎥' + '日本語'.repeat(12000) + '\r\nend' }),
    record('line-boundary', { transcript: Array.from({ length: 700 }, (_, index) => `日本語 ${index}\r\n`).join('') }),
    record('at-limit', { transcript: 'a'.repeat(32767) }),
  ];
  const workbook = inspectWorkbook(await exports.exportXlsx(sources));
  const partsSheet = workbook.sheets.find(sheet => sheet.name === 'Transcript parts');
  assert.ok(partsSheet);
  assert.equal(partsSheet.pane.ySplit, '1');
  assert.match(partsSheet.autoFilter, /^A1:F\d+$/);
  const parts = sheetRows(partsSheet);
  for (const source of sources.slice(0, 2)) {
    const selected = parts.filter(row => row['Item ID'] === source.id);
    assert.ok(selected.length > 1);
    assert.deepEqual(selected.map(row => Number(row.Part)), selected.map((_, index) => index + 1));
    assert.ok(selected.every(row => Number(row['Total parts']) === selected.length));
    assert.ok(selected.every(row => row['Transcript text'].length <= 32767 && (row['Transcript text'].match(/\n/g) ?? []).length <= 253));
    assert.ok(selected.every(row => !/[\uD800-\uDBFF]$/u.test(row['Transcript text'])));
    assert.equal(selected.map(row => row['Transcript text']).join(''), source.transcript);
    for (const name of ['All items', 'Unsorted']) {
      const sheet = workbook.sheets.find(sheet => sheet.name === name);
      const rows = sheetRows(sheet);
      const index = rows.findIndex(row => row['Item ID'] === source.id);
      assert.match(rows[index].Transcript, /Transcript parts/);
      assert.ok(sheet.links.some(link => link.ref === `H${index + 2}` && /Transcript parts.*!A\d+/.test(link.target)));
    }
  }
  assert.equal(parts.filter(row => row['Item ID'] === 'at-limit').length, 0);
  assert.equal(sheetRows(workbook.sheets[0]).find(row => row['Item ID'] === 'at-limit').Transcript, sources[2].transcript);
});


test('exports notes and summaries, excludes historical highlights, and reconstructs long text', async () => {
  const source = record('notes-long', { notes: '=not a formula\n' + 'Notes 日本語\n'.repeat(4000), summary: 'A summary.', highlights: 'Passage\nNote: useful', reviewedAt: '2026-10-27T00:00:00.000Z' });
  const csv = parseCsv(exports.exportCsv([source]).replace(/^\uFEFF/, ''));
  assert.equal(csv[1][10], "'" + source.notes);
  assert.equal(csv[1][11], source.summary);
  assert.equal(csv[1][12], source.reviewedAt);
  assert.ok(!csv[0].includes('Highlights'));
  assert.ok(!csv.flat().includes(source.highlights));
  const workbook = inspectWorkbook(await exports.exportXlsx([source]));
  const parts = sheetRows(workbook.sheets.find(sheet => sheet.name === 'Text parts'));
  assert.equal(parts.filter(row => row.Field === 'notes').map(row => row.Text).join(''), source.notes);
  assert.ok(parts.every(row => row.Text.length <= 32767));
  assert.ok(parts.every(row => row.Field !== 'highlights'));
  assert.ok(workbook.sheets.every(sheet => !sheet.rows[0]?.some(cell => cell.value === 'Highlights')));
});
