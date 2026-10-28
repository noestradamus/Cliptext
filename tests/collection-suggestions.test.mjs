import test from 'node:test';
import assert from 'node:assert/strict';
import {collectionMatchesSource,relevantCollectionId} from '../lib/collection-suggestions.ts';

const pricing='A baker charges one copper coin and works eighteen hours each day. He doubles his prices, loses half his customers, and earns the same money in half the time. Quality improves. A year later the price is four times higher. The price you charge is how valuable the work is.';
const design='Design rule in ten seconds. Messy design: make one element the hero. Change size and color intensity to create hierarchy: one big, two medium, the rest small.';

test('pricing does not inherit the first Design collection while actual design remains eligible',()=>{
  assert.equal(collectionMatchesSource('Design',pricing),false);
  assert.equal(collectionMatchesSource('Marketing',pricing),true);
  assert.equal(relevantCollectionId('design',{id:'design',name:'Design'},pricing),null);
  assert.equal(relevantCollectionId('design',{id:'design',name:'Design'},design),'design');
  assert.equal(relevantCollectionId('wrong',{id:'design',name:'Design'},design),null);
});

test('collection evidence supports extracted multilingual text and abstains for uncertain labels',()=>{
  assert.equal(collectionMatchesSource('Design','見出しの配色とレイアウトを改善します。'),true);
  assert.equal(collectionMatchesSource('機械学習','無料の機械学習の大学講座を紹介します。'),true);
  assert.equal(collectionMatchesSource('学習','大学で学習する方法を説明します。'),true);
  assert.equal(collectionMatchesSource('My collection','A personal note about a walk.'),false);
  assert.equal(collectionMatchesSource('Design','See https://example.org/design for a baking recipe.'),false);
  assert.equal(collectionMatchesSource('Design','We redesigned our pricing.'),false);
  assert.equal(collectionMatchesSource('Design',''),false);
});
