import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const modules = new Map();
async function sourceModule(path) {
  if (modules.has(path)) return modules.get(path);
  const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
  let { outputText: output } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
  for (const match of [...output.matchAll(/from\s+(['"])([^'"]+)\1/g)]) {
    const specifier = match[2];
    assert.ok(specifier.startsWith('.'), 'Only local test dependencies: ' + specifier);
    const base = new URL('../', import.meta.url);
    const target = new URL(specifier.endsWith('.ts') ? specifier : specifier + '.ts', new URL(path, base));
    output = output.replace(match[0], 'from ' + JSON.stringify(await sourceModule(target.pathname.slice(base.pathname.length))));
  }
  const result = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64');
  modules.set(path, result); return result;
}
const appearance = await import(await sourceModule('lib/theme-appearance.ts'));
const fonts = await import(await sourceModule('lib/theme-fonts.ts'));
const presets = await import(await sourceModule('lib/theme-presets.ts'));

function documentFixture(hasMeta = true) {
  const properties = new Map();
  const attributes = new Map();
  return {
    properties, attributes,
    documentElement: {
      dataset: {},
      setAttribute: (name, value) => attributes.set(name, value),
      removeAttribute: name => attributes.delete(name),
      style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) },
    },
    querySelector: selector => selector === 'meta[name="theme-color"]' && hasMeta ? { setAttribute: (name, value) => attributes.set('meta:' + name, value) } : null,
  };
}

afterEach(() => { delete globalThis.document; });

test('control text chooses the higher-contrast black or white color', () => {
  for (const [background, expected] of [
    ['#000000', '#FFFFFF'], ['#FFFFFF', '#000000'], ['#808080', '#000000'], ['#404040', '#FFFFFF'], ['#2A6898', '#FFFFFF'],
  ]) assert.equal(appearance.contrastColor(background), expected);
});

test('custom painting updates exact colors and native browser color; clearing restores the Glacier fallback', () => {
  globalThis.document = documentFixture();
  document.properties.set('--unrelated-property', 'keep');
  const colors = { accent: '#5e77bd', background: '#18202c', foreground: '#eef4ff' };
  appearance.paintTheme(colors);
  assert.equal(document.attributes.has('data-custom-theme'), true);
  assert.equal(document.properties.get('--theme-accent'), colors.accent);
  assert.equal(document.properties.get('--theme-background'), colors.background);
  assert.equal(document.properties.get('--theme-foreground'), colors.foreground);
  assert.equal(document.properties.get('--on-accent'), appearance.contrastColor(colors.accent));
  assert.equal(document.properties.get('--control-thumb'), appearance.contrastColor(colors.accent));
  assert.equal(document.documentElement.dataset.themeMode, 'dark');
  assert.equal(document.attributes.get('meta:content'), colors.background);
  appearance.paintTheme(null);
  assert.deepEqual([...document.properties], [['--unrelated-property', 'keep']]);
  assert.equal(document.attributes.has('data-custom-theme'), false);
  assert.deepEqual(document.documentElement.dataset, {});
  assert.equal(document.attributes.get('meta:content'), appearance.GLACIAL_COLORS.background);
});

test('invalid colors cannot partially update a painted theme or enter CSS from cache', () => {
  globalThis.document = documentFixture();
  appearance.paintTheme(appearance.GLACIAL_COLORS);
  const before = [...document.properties];
  for (const accent of ['red', '#fff', '#12345678', '#112233;--ink:red', '</script><script>alert(1)</script>', null]) {
    const invalid = { ...appearance.GLACIAL_COLORS, accent };
    assert.equal(appearance.cachedThemeColors(invalid), null);
    assert.throws(() => appearance.paintTheme(invalid), /#RRGGBB/);
    assert.deepEqual([...document.properties], before);
  }
  assert.deepEqual(appearance.cachedThemeColors({ ...appearance.GLACIAL_COLORS, id: 'private-id', name: 'Private name' }), { ...appearance.GLACIAL_COLORS, font: fonts.DEFAULT_FONT });
});

test('early bootstrap exactly matches later paint for light and dark themes', () => {
  for (const colors of [
    appearance.GLACIAL_COLORS,
    { accent: '#5e77bd', background: '#18202c', foreground: '#eef4ff' },
    { accent: '#FFFFFF', background: '#FFFFFF', foreground: '#000000' },
    ...fonts.THEME_FONTS.map(font => ({ accent: '#82B8E3', background: '#202A36', foreground: '#EEF4FA', font: font.id })),
  ]) {
    globalThis.document = documentFixture();
    appearance.paintTheme(colors);
    const early = documentFixture();
    vm.runInNewContext(appearance.THEME_BOOTSTRAP_SCRIPT, {
      document: early,
      localStorage: { getItem: key => { assert.equal(key, appearance.THEME_CACHE_KEY); return JSON.stringify(colors); } },
    });
    assert.deepEqual([...early.properties], [...document.properties]);
    assert.deepEqual([...early.attributes], [...document.attributes]);
    assert.deepEqual(early.documentElement.dataset, document.documentElement.dataset);
  }
});

test('corrupt, empty, or blocked cache leaves the built-in appearance untouched', () => {
  for (const cached of [null, 'null', 'invalid json', '{}', '[]', JSON.stringify({ ...appearance.GLACIAL_COLORS, accent: '#112233;--ink:red' })]) {
    const document = documentFixture();
    vm.runInNewContext(appearance.THEME_BOOTSTRAP_SCRIPT, { document, localStorage: { getItem: () => cached } });
    assert.equal(document.properties.size, 0);
    assert.equal(document.attributes.size, 0);
  }
  const document = documentFixture();
  vm.runInNewContext(appearance.THEME_BOOTSTRAP_SCRIPT, { document, localStorage: { getItem: () => { throw new Error('Browser storage unavailable'); } } });
  assert.equal(document.properties.size, 0);
});

test('theme painting also works before a browser theme-color meta element exists', () => {
  globalThis.document = documentFixture(false);
  assert.doesNotThrow(() => appearance.paintTheme(appearance.GLACIAL_COLORS));
  assert.doesNotThrow(() => appearance.paintTheme(null));
  assert.doesNotThrow(() => vm.runInNewContext(appearance.THEME_BOOTSTRAP_SCRIPT, {
    document: documentFixture(false), localStorage: { getItem: () => JSON.stringify(appearance.GLACIAL_COLORS) },
  }));
});


test('font caches accept exactly the catalogue and old colors-only values retain DM Sans', () => {
  assert.equal(appearance.cachedThemeColors(appearance.GLACIAL_COLORS).font, 'dm-sans');
  for (const font of fonts.THEME_FONTS) {
    const colors = { ...appearance.GLACIAL_COLORS, font: font.id, id: 'private-id', name: 'Private name' };
    assert.deepEqual(appearance.cachedThemeColors(colors), { ...appearance.GLACIAL_COLORS, font: font.id });
    globalThis.document = documentFixture();
    appearance.paintTheme(colors);
    assert.equal(document.properties.get('--app-font-family'), font.family);
    assert.equal(document.documentElement.dataset.themeFont, font.id);
  }
});

test('unknown font IDs and injected CSS cannot alter an existing theme in paint or bootstrap', () => {
  globalThis.document = documentFixture();
  appearance.paintTheme({ ...appearance.GLACIAL_COLORS, font: 'lora' });
  const before = [...document.properties];
  for (const font of [null, '', 'unknown-font', '__proto__', 'constructor', 'Inter;--ink:red', 'var(--ink)', '</script>', { id: 'inter' }]) {
    const invalid = { ...appearance.GLACIAL_COLORS, font };
    assert.equal(appearance.cachedThemeColors(invalid), null);
    assert.throws(() => appearance.paintTheme(invalid), /listed font/);
    assert.deepEqual([...document.properties], before);
    const early = documentFixture();
    vm.runInNewContext(appearance.THEME_BOOTSTRAP_SCRIPT, { document: early, localStorage: { getItem: () => JSON.stringify(invalid) } });
    assert.equal(early.properties.size, 0);
    assert.equal(early.attributes.size, 0);
  }
});

test('preset resolution paints Glacier and every preset while prioritizing saved custom appearance', () => {
  const empty = { themes: [], activeThemeId: null, activePresetId: 'glacial' };
  const glacier = presets.THEME_PRESETS.find(preset => preset.id === 'glacial');
  assert.deepEqual(appearance.resolvedThemeAppearance(empty), glacier);
  for (const preset of presets.THEME_PRESETS) {
    assert.deepEqual(appearance.resolvedThemeAppearance({ ...empty, activePresetId: preset.id }), preset);
  }
  const custom = { id: 'custom', name: 'My typography', ...appearance.GLACIAL_COLORS, font: 'space-mono' };
  assert.deepEqual(appearance.resolvedThemeAppearance({ themes: [custom], activeThemeId: custom.id, activePresetId: 'midnight' }), custom);
  assert.deepEqual(appearance.resolvedThemeAppearance({ ...empty, activeThemeId: 'deleted' }), glacier);
  assert.deepEqual(appearance.resolvedThemeAppearance({ ...empty, activePresetId: 'unknown' }), glacier);
  globalThis.document = documentFixture();
  appearance.paintTheme(appearance.resolvedThemeAppearance(empty));
  assert.equal(document.properties.get('--theme-accent'), '#40A5DB');
  assert.equal(document.properties.get('--theme-background'), '#FFFFFF');
  assert.equal(document.properties.get('--theme-foreground'), '#2A497B');
});
