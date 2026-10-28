import test from 'node:test';
import assert from 'node:assert/strict';
import { hexToHsv, hsvToHex, normalizeHex } from '../lib/color.ts';

test('hex entry accepts short and full colors and rejects unrelated CSS syntax', () => {
  assert.equal(normalizeHex('  #AbC  '), '#aabbcc');
  assert.equal(normalizeHex('70B0D8'), '#70b0d8');
  for (const value of ['#12', '#1234', '#12345678', 'red', 'var(--blue)', '#12 456', null]) assert.equal(normalizeHex(value), null);
  assert.throws(() => hexToHsv('not a color'), TypeError);
});

test('HSV square boundaries and hue wrap produce exact primaries and achromatic colors', () => {
  for (const [h, expected] of [[0, '#ff0000'], [60, '#ffff00'], [120, '#00ff00'], [180, '#00ffff'], [240, '#0000ff'], [300, '#ff00ff'], [360, '#ff0000'], [-60, '#ff00ff']]) {
    assert.equal(hsvToHex({h, s:100, v:100}), expected);
  }
  assert.equal(hsvToHex({h:210,s:0,v:100}), '#ffffff');
  assert.equal(hsvToHex({h:210,s:90,v:0}), '#000000');
  assert.equal(hsvToHex({h:0,s:150,v:150}), '#ff0000');
  assert.equal(hsvToHex({h:NaN,s:NaN,v:NaN}), '#000000');
});

test('RGB to HSV and back retains every sampled channel without rounding drift', () => {
  for (const red of [0, 1, 26, 70, 127, 254, 255]) for (const green of [0, 12, 56, 128, 221, 255]) for (const blue of [0, 17, 80, 216, 240, 255]) {
    const hex = '#' + [red,green,blue].map(value => value.toString(16).padStart(2,'0')).join('');
    assert.equal(hsvToHex(hexToHsv(hex)), hex);
  }
  assert.deepEqual(hexToHsv('#000000'), {h:0,s:0,v:0});
  assert.deepEqual(hexToHsv('#ffffff'), {h:0,s:0,v:100});
});
