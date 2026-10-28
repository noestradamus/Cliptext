import test from 'node:test';
import assert from 'node:assert/strict';
import {checkedGeneratedTitle} from '../lib/generated-title.ts';

test('generated labels remove share boilerplate and collapse lines without changing meaningful punctuation',()=>{
  assert.equal(checkedGeneratedTitle('🔥 Title: "Learn C# with practical projects" #coding https://example.com'), 'Learn C# with practical projects');
  assert.equal(checkedGeneratedTitle('  日本語の\n学習方法 💡 #日本語  '), '日本語の 学習方法');
  assert.equal(checkedGeneratedTitle('Video: Working with C++'), 'Video: Working with C++');
  assert.equal(checkedGeneratedTitle('🔥 #viral https://example.com'), null);
  for(const value of [null,{},42,'bad\0title'])assert.throws(()=>checkedGeneratedTitle(value));
});

test('generated labels cap words and Unicode code points without splitting astral characters',()=>{
  const words=checkedGeneratedTitle('one two three four five six seven eight nine ten eleven twelve');
  assert.equal(words,'one two three four five six seven eight nine ten');
  const unicode=checkedGeneratedTitle('𠮷'.repeat(90));
  assert.equal(Array.from(unicode).length,70);
  assert.equal(unicode,'𠮷'.repeat(70));
  const title=checkedGeneratedTitle('A useful heading ' + 'lengthy '.repeat(20));
  assert.ok(Array.from(title).length<=70);
  assert.ok(title.split(' ').length<=10);
  assert.doesNotMatch(title,/[\r\n]/u);
});
