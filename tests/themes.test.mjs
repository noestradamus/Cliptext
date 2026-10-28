import test, { after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

const fixtureKey = Symbol.for('cliptext.themes.test');
const fixture = { env: {}, signedIn: true, failActivation: false };
globalThis[fixtureKey] = fixture;
const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const loadedModules = new Map();
async function sourceModule(path, dependencies = {}) {
  if (loadedModules.has(path)) return loadedModules.get(path);
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  let { outputText: output } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  for (const match of [...output.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
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

const lookup = "globalThis[Symbol.for('cliptext.themes.test')]";
await sourceModule('lib/server.ts', {
  'cloudflare:workers': moduleUrl(`export const env = ${lookup}.env;`),
  '../app/chatgpt-auth': moduleUrl(`export async function getChatGPTUser() { return ${lookup}.signedIn ? {id:'synthetic-owner'} : null; }`),
});
const themes = await import(await sourceModule('app/api/themes/route.ts'));
const theme = await import(await sourceModule('app/api/themes/[id]/route.ts'));
const store = await import(await sourceModule('lib/theme-store.ts'));
const migrationsDirectory = new URL('../drizzle/', import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(migrationFiles.map(name => readFile(new URL(name, migrationsDirectory), 'utf8')));
let sqlite;

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const migration of migrations) sqlite.exec(migration);
  fixture.signedIn = true; fixture.failActivation = false;
  fixture.env.DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      const bound = values => ({
        async first() { const row = statement.get(...values); return row ? { ...row } : null; },
        async run() { return { success: true, meta: statement.run(...values) }; },
        async all() {
          if (fixture.failActivation && sql.includes('INSERT INTO appearance_settings')) throw new Error('Synthetic activation failure');
          return { success: true, results: statement.all(...values).map(row => ({ ...row })) };
        },
      });
      return { ...bound([]), bind: (...values) => bound(values) };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT'); return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
});
afterEach(() => sqlite.close());
after(() => { delete globalThis[fixtureKey]; });

const palette = { accent: '#5e77bd', background: '#18202c', foreground: '#eef4ff' };
const request = (method, input, path = '/api/themes', headers = {}) => new Request('https://cliptext.example' + path, {
  method, headers: { 'Content-Type': 'application/json', ...headers }, ...(input === undefined ? {} : { body: JSON.stringify(input) }),
});
const context = id => ({ params: Promise.resolve({ id }) });
async function create(name = 'Midnight', extra = {}) {
  const response = await themes.POST(request('POST', { name, ...palette, ...extra }));
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).theme;
}
const library = async () => (await themes.GET()).json();

test('themes save named colors and active choice across requests, with Glacier retaining its stored default ID', async () => {
  assert.deepEqual(await library(), { themes: [], activeThemeId: null, activePresetId: 'glacial' });
  const first = await create('  Midnight  ');
  assert.deepEqual(first, { id: first.id, name: 'Midnight', accent: '#5E77BD', background: '#18202C', foreground: '#EEF4FF', font: 'dm-sans' });
  assert.deepEqual(await library(), { themes: [first], activeThemeId: first.id, activePresetId: 'glacial' });
  const second = await create('Paper', { background: '#fffdf5', foreground: '#261f17' });
  assert.equal((await library()).activeThemeId, second.id);
  let response = await themes.PATCH(request('PATCH', { activeThemeId: first.id }));
  assert.deepEqual(await response.json(), { activeThemeId: first.id, activePresetId: 'glacial' });
  response = await themes.PATCH(request('PATCH', { activeThemeId: null }));
  assert.equal(response.status, 200);
  assert.equal((await library()).activeThemeId, null);
  assert.equal((await library()).themes.length, 2);
});

test('renaming or changing colors preserves identity and active selection; deleting active falls back safely', async () => {
  const first = await create();
  const second = await create('Paper');
  let response = await theme.PATCH(request('PATCH', { name: 'Evening', accent: '#cc8844' }), context(second.id));
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).theme, { ...second, name: 'Evening', accent: '#CC8844' });
  assert.equal((await library()).activeThemeId, second.id);
  response = await theme.DELETE(request('DELETE'), context(first.id));
  assert.deepEqual(await response.json(), { activeThemeId: second.id, activePresetId: 'glacial' });
  response = await theme.DELETE(request('DELETE'), context(second.id));
  assert.deepEqual(await response.json(), { activeThemeId: null, activePresetId: 'glacial' });
  assert.deepEqual(await library(), { themes: [], activeThemeId: null, activePresetId: 'glacial' });
});

test('case-insensitive and normalized duplicate names return conflict without changing the active theme', async () => {
  const first = await create('Aurora');
  const second = await create('Paper');
  for (const name of ['aurora', '  AURORA ', 'ＡＵＲＯＲＡ']) {
    const response = await themes.POST(request('POST', { name, ...palette }));
    assert.equal(response.status, 409, await response.clone().text());
    assert.equal((await library()).activeThemeId, second.id);
  }
  const response = await theme.PATCH(request('PATCH', { name: 'aurora', accent: '#123456' }), context(second.id));
  assert.equal(response.status, 409);
  const saved = (await library()).themes.find(item => item.id === second.id);
  assert.deepEqual(saved, second);
  assert.notEqual(saved.id, first.id);
});

test('invalid names and colors are rejected before storage, including CSS injection', async () => {
  for (const name of ['', ' ', 'x'.repeat(49), 'bad\nname', 'bad\u007fname']) {
    const response = await themes.POST(request('POST', { name, ...palette }));
    assert.equal(response.status, 400, await response.clone().text());
  }
  for (const accent of ['red', '#fff', '#00000000', 'rgb(1,2,3)', '#112233;--ink:red', null, 12]) {
    const response = await themes.POST(request('POST', { name: 'Bad color', ...palette, accent }));
    assert.equal(response.status, 400, await response.clone().text());
  }
  assert.deepEqual(await library(), { themes: [], activeThemeId: null, activePresetId: 'glacial' });
  const saved = await create('Valid');
  assert.equal((await theme.PATCH(request('PATCH', {}), context(saved.id))).status, 400);
  assert.equal((await themes.PATCH(request('PATCH', {}))).status, 400);
});

test('owner isolation, sign-in, and same-origin checks protect theme mutations', async () => {
  const owned = await create();
  const foreign = (await store.createTheme('another-owner', { name: 'Private', ...palette })).theme;
  const response = await themes.GET();
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual((await response.json()).themes, [owned]);
  assert.equal((await themes.PATCH(request('PATCH', { activeThemeId: foreign.id }))).status, 404);
  assert.equal((await theme.PATCH(request('PATCH', { name: 'Stolen' }), context(foreign.id))).status, 404);
  assert.equal((await theme.DELETE(request('DELETE'), context(foreign.id))).status, 404);
  assert.equal((await theme.DELETE(request('DELETE'), context('missing'))).status, 404);
  assert.equal((await store.themeLibrary('another-owner')).activeThemeId, foreign.id);
  assert.equal((await themes.POST(request('POST', { name: 'Cross origin', ...palette }, '/api/themes', { Origin: 'https://elsewhere.example' }))).status, 403);
  fixture.signedIn = false;
  assert.equal((await themes.GET()).status, 401);
  assert.equal((await themes.POST(request('POST', { name: 'No login', ...palette }))).status, 401);
  assert.equal((await themes.PATCH(request('PATCH', { activeThemeId: null }))).status, 401);
  assert.equal((await theme.PATCH(request('PATCH', { name: 'No login' }), context(owned.id))).status, 401);
  assert.equal((await theme.DELETE(request('DELETE'), context(owned.id))).status, 401);
});

test('theme limit does not create a partial theme or change current selection', async () => {
  let latest;
  for (let index = 0; index < 30; index++) latest = await create('Theme ' + index);
  const response = await themes.POST(request('POST', { name: 'Too many', ...palette }));
  assert.equal(response.status, 429, await response.clone().text());
  const saved = await library();
  assert.equal(saved.themes.length, 30);
  assert.equal(saved.activeThemeId, latest.id);
});

test('creation and activation roll back together on a failed storage batch', async () => {
  fixture.failActivation = true;
  const response = await themes.POST(request('POST', { name: 'Rollback', ...palette }));
  assert.equal(response.status, 500);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM appearance_themes').get().total, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM appearance_settings').get().total, 0);
});

test('existing color-only themes gain the default font without losing colors or active selection', () => {
  const legacy = new DatabaseSync(':memory:');
  try {
    legacy.exec('PRAGMA foreign_keys=ON');
    const extensionIndex = migrationFiles.findIndex(name => name.startsWith('0010_'));
    assert.ok(extensionIndex > 0);
    for (const migration of migrations.slice(0, extensionIndex)) legacy.exec(migration);
    legacy.prepare(`INSERT INTO appearance_themes(id,owner_id,name,name_key,accent,background,foreground,created_at,updated_at)
      VALUES('old-theme','old-owner','Old theme','old theme','#112233','#FAFAFA','#121212','2026-10-27','2026-10-27')`).run();
    legacy.prepare("INSERT INTO appearance_settings(owner_id,active_theme_id) VALUES('old-owner','old-theme')").run();
    for (const migration of migrations.slice(extensionIndex)) legacy.exec(migration);
    assert.deepEqual({ ...legacy.prepare("SELECT accent,background,foreground,font FROM appearance_themes WHERE id='old-theme'").get() }, {
      accent: '#112233', background: '#FAFAFA', foreground: '#121212', font: 'dm-sans',
    });
    assert.deepEqual({ ...legacy.prepare("SELECT active_theme_id,active_preset_id FROM appearance_settings WHERE owner_id='old-owner'").get() }, {
      active_theme_id: 'old-theme', active_preset_id: 'glacial',
    });
  } finally { legacy.close(); }
});

test('built-in presets persist independently without creating saved themes', async () => {
  const presets = await import(await sourceModule('lib/theme-presets.ts'));
  assert.equal(presets.THEME_PRESETS.length, 5);
  const referencePresets = [
    { id: 'glacial', name: 'Glacier', accent: '#40A5DB', background: '#FFFFFF', foreground: '#2A497B', font: 'dm-sans' },
    { id: 'midnight', name: 'Midnight', accent: '#8294E3', background: '#10151B', foreground: '#FFFFFF', font: 'dm-sans' },
    { id: 'sand', name: 'Latte', accent: '#FF8E3C', background: '#FFFAEE', foreground: '#502E1A', font: 'dm-sans' },
  ];
  for (const expected of referencePresets) assert.deepEqual(presets.THEME_PRESETS.find(preset => preset.id === expected.id), expected);
  for (const preset of presets.THEME_PRESETS) {
    const response = await themes.PATCH(request('PATCH', { activePresetId: preset.id }));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { activeThemeId: null, activePresetId: preset.id });
    assert.deepEqual(await library(), { themes: [], activeThemeId: null, activePresetId: preset.id });
  }
  await store.activateTheme('another-owner', undefined, 'midnight');
  assert.equal((await store.themeLibrary('another-owner')).activePresetId, 'midnight');
  assert.equal((await library()).activePresetId, 'lavender');
  assert.equal((await theme.PATCH(request('PATCH', { name: 'Changed' }), context('midnight'))).status, 404);
  assert.equal((await theme.DELETE(request('DELETE'), context('midnight'))).status, 404);
  assert.equal((await library()).themes.length, 0);
});

test('pinned preset palettes retain readable foregrounds and automatically contrasted accent controls', async () => {
  const { THEME_PRESETS } = await import(await sourceModule('lib/theme-presets.ts'));
  const { checkedThemeFont } = await import(await sourceModule('lib/theme-fonts.ts'));
  const { contrastColor } = await import(await sourceModule('lib/theme-appearance.ts'));
  const luminance = color => {
    assert.match(color, /^#[0-9A-F]{6}$/);
    const channels = [1, 3, 5].map(index => {
      const value = parseInt(color.slice(index, index + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const preset of THEME_PRESETS) {
    assert.equal(checkedThemeFont(preset.font), 'dm-sans');
    for (const [color, surface] of [[preset.foreground, preset.background], [contrastColor(preset.accent), preset.accent]]) {
      const foreground = luminance(color), background = luminance(surface);
      const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      assert.ok(Number.isFinite(contrast) && contrast >= 4.5, `${preset.id}: ${color} on ${surface} contrast ${contrast}`);
    }
  }
});

test('preset and custom selections restore each other and reject invalid or conflicting choices', async () => {
  const saved = await create('Personal');
  assert.equal((await themes.PATCH(request('PATCH', { activePresetId: 'midnight' }))).status, 200);
  for (const input of [
    { activePresetId: 'missing' }, { activePresetId: null }, { activePresetId: 'Midnight' },
    { activePresetId: 'midnight;--ink:red' }, { activeThemeId: saved.id, activePresetId: 'sage' },
  ]) {
    assert.equal((await themes.PATCH(request('PATCH', input))).status, 400);
    assert.equal((await library()).activePresetId, 'midnight');
  }
  assert.deepEqual(await (await themes.PATCH(request('PATCH', { activeThemeId: saved.id }))).json(), { activeThemeId: saved.id, activePresetId: 'glacial' });
  await themes.PATCH(request('PATCH', { activePresetId: 'sage' }));
  const copy = await create('Custom sage', { font: 'manrope' });
  assert.equal((await library()).activeThemeId, copy.id);
  assert.equal((await library()).activePresetId, 'glacial');
  assert.deepEqual(await (await theme.DELETE(request('DELETE'), context(copy.id))).json(), { activeThemeId: null, activePresetId: 'glacial' });
  await themes.PATCH(request('PATCH', { activePresetId: 'midnight' }));
  await theme.DELETE(request('DELETE'), context(saved.id));
  assert.equal((await library()).activePresetId, 'midnight');
  await themes.PATCH(request('PATCH', { activeThemeId: null }));
  assert.equal((await library()).activePresetId, 'glacial');
});

test('font choices survive creation, reload, rename and font-only changes', async () => {
  const saved = await create('Reading', { font: 'jetbrains-mono' });
  assert.equal(saved.font, 'jetbrains-mono');
  assert.equal((await library()).themes[0].font, 'jetbrains-mono');
  let response = await theme.PATCH(request('PATCH', { name: 'Reading notes' }), context(saved.id));
  assert.equal((await response.json()).theme.font, 'jetbrains-mono');
  response = await theme.PATCH(request('PATCH', { font: 'inter' }), context(saved.id));
  assert.equal(response.status, 200, await response.clone().text());
  const changed = (await response.json()).theme;
  assert.deepEqual(changed, { ...saved, name: 'Reading notes', font: 'inter' });
  assert.deepEqual((await library()).themes, [changed]);
});

test('invalid fonts are rejected before any saved theme or selection is changed', async () => {
  const saved = await create('Valid font', { font: 'lora' });
  await themes.PATCH(request('PATCH', { activePresetId: 'sand' }));
  for (const font of [null, 2, '', 'Arial', 'Lora', 'lora;--ink:red', '__proto__', 'constructor', 'url(https://example.com/font.woff2)']) {
    assert.equal((await themes.POST(request('POST', { name: 'Invalid', ...palette, font }))).status, 400);
    assert.equal((await theme.PATCH(request('PATCH', { font }), context(saved.id))).status, 400);
    const state = await library();
    assert.deepEqual(state.themes, [saved]);
    assert.equal(state.activeThemeId, null);
    assert.equal(state.activePresetId, 'sand');
  }
});

test('presets remain available at the saved-theme limit and failed creation preserves the selected preset', async () => {
  for (let index = 0; index < 30; index++) await create('Custom ' + index);
  assert.equal((await themes.PATCH(request('PATCH', { activePresetId: 'midnight' }))).status, 200);
  const response = await themes.POST(request('POST', { name: 'Overflow', ...palette, font: 'inter' }));
  assert.equal(response.status, 429);
  const state = await library();
  assert.equal(state.themes.length, 30);
  assert.equal(state.activeThemeId, null);
  assert.equal(state.activePresetId, 'midnight');
});
