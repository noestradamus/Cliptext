import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const source = await readFile(new URL('../lib/theme-fonts.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { THEME_FONTS, DEFAULT_FONT, checkedThemeFont, fontFamily } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));
const fontsDirectory = new URL('../public/fonts/', import.meta.url);

test('font selector has exactly twenty distinct allowlisted choices and retains DM Sans', () => {
  assert.equal(THEME_FONTS.length, 20);
  assert.equal(new Set(THEME_FONTS.map(font => font.id)).size, 20);
  assert.equal(new Set(THEME_FONTS.map(font => font.label)).size, 20);
  assert.equal(DEFAULT_FONT, 'dm-sans');
  for (const font of THEME_FONTS) {
    assert.match(font.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(checkedThemeFont(font.id), font.id);
    assert.equal(fontFamily(font.id), font.family);
  }
  for (const bad of [undefined, null, {}, '', 'Arial', 'INTER', 'inter; color:red', 'url(https://example.com/font.woff2)']) {
    assert.throws(() => checkedThemeFont(bad), /Choose a font/);
  }
});

test('all additional font faces are local, licensed WOFF2 assets with regular and bold support', async () => {
  const css = await readFile(new URL('theme-fonts.css', fontsDirectory), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('theme-fonts-provenance.json', fontsDirectory), 'utf8'));
  assert.equal(manifest.fonts.length, 19);
  assert.doesNotMatch(css, /https?:\/\//);
  assert.doesNotMatch(css, /@import/);
  for (const font of THEME_FONTS.filter(font => font.id !== DEFAULT_FONT)) {
    const entry = manifest.fonts.find(entry => entry.id === font.id);
    assert.ok(entry, font.id);
    assert.equal(entry.family, font.label);
    assert.ok(entry.assets.length);
    assert.match(await readFile(new URL(entry.license_file, fontsDirectory), 'utf8'), /OPEN FONT LICENSE/i);
    const blocks = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1]).filter(block => block.includes(`font-family: '${font.label}';`));
    assert.equal(blocks.length, entry.assets.length, font.id);
    const supportedWeights = new Set();
    for (const asset of entry.assets) {
      const bytes = await readFile(new URL(asset.file, fontsDirectory));
      assert.equal(bytes.subarray(0, 4).toString(), 'wOF2', asset.file);
      assert.equal(bytes.length, asset.bytes, asset.file);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256, asset.file);
      assert.ok(blocks.some(block => block.includes('/fonts/' + asset.file) && block.includes('font-display: swap;')), asset.file);
      const [start, end = start] = asset.weight.split(' ').map(Number);
      for (const weight of [400, 700]) if (start <= weight && end >= weight) supportedWeights.add(weight);
    }
    assert.deepEqual([...supportedWeights].sort(), [400, 700], font.id);
  }
});
