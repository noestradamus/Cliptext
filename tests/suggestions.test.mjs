import test from 'node:test';
import assert from 'node:assert/strict';
import {limitedSuggestedTags,limitedSuggestions,visibleSuggestedTags} from '../lib/suggestions.ts';

test('legacy proposals normalize to three unique valid tags without changing source data',()=>{
  const legacy={collectionId:'learn',tags:[' #AI ','ai','日本語','Research','hidden','also-hidden']};
  const original=structuredClone(legacy);
  assert.deepEqual(limitedSuggestions(legacy),{collectionId:'learn',tags:['ai','日本語','research']});
  assert.deepEqual(legacy,original);
  assert.deepEqual(limitedSuggestedTags([null,'bad,tag','', '＃ＡＩ','ai','valid','last','hidden']),['ai','valid','last']);
});

test('visible new tags never backfill from hidden fourth or fifth proposals',()=>{
  assert.deepEqual(visibleSuggestedTags(['AI','python','new','hidden','also-hidden'],['ai','PYTHON']),['new']);
  assert.deepEqual(visibleSuggestedTags(['new','NEW','other','third','hidden'],['NeW']),['other','third']);
});

test('visible proposals respect available capacity without rewriting saved tags',()=>{
  const saved=['AI',...Array.from({length:10},(_,i)=>`saved-${i}`)];
  const original=[...saved];
  assert.deepEqual(visibleSuggestedTags(['ai','new','other','hidden'],saved),['new']);
  assert.deepEqual(visibleSuggestedTags(['new','other','third'],[...saved,'last']),[]);
  assert.deepEqual(saved,original);
});
