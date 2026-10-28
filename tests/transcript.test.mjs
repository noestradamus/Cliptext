import test from 'node:test';
import assert from 'node:assert/strict';
import { readableTranscript, hasFullOcrText, isImagePost } from '../lib/transcript.ts';
import { exportCsv, toExportRecord } from '../lib/export.ts';

test('carousel copy and text export follow the selected reading mode in slide order', () => {
  const job = { contentKind: 'carousel', transcript: 'Stored main text', pages: [
    { index: 1, text: 'Heading\nExplanation', allText: 'Heading\nScreenshot detail\nExplanation' },
    { index: 2, text: '', allText: '' },
    { index: 3, text: '日本語の見出し' },
  ] };
  assert.equal(readableTranscript(job), 'Slide 1\nHeading\nExplanation\n\nSlide 2\n\n\nSlide 3\n日本語の見出し');
  assert.equal(readableTranscript(job, true), 'Slide 1\nHeading\nScreenshot detail\nExplanation\n\nSlide 2\n\n\nSlide 3\n日本語の見出し');
  assert.equal(hasFullOcrText(job), true);
  const csv = exportCsv([toExportRecord({ id: 'carousel-1', transcript: readableTranscript(job), pages: JSON.stringify(job.pages), collection_id: 'learn', collection_name: 'Learning' })]);
  assert.ok(csv.includes('Slide 3\n日本語の見出し'));
  assert.ok(csv.includes('Learning'));
  assert.ok(!csv.includes('Screenshot detail'));
});

test('single images, empty OCR and legacy speech results remain distinct', () => {
  assert.equal(readableTranscript({ contentKind: 'image', transcript: '', pages: [{ index: 1, text: '' }] }), '');
  assert.equal(readableTranscript({ contentKind: 'image', transcript: 'Headline', pages: [{ index: 1, text: 'Headline', allText: 'Headline' }] }), 'Headline');
  assert.equal(hasFullOcrText({ contentKind: 'image', transcript: 'Headline', pages: [{ index: 1, text: 'Headline', allText: 'Headline' }] }), false);
  assert.equal(readableTranscript({ transcript: 'Speech\nSecond paragraph' }, true), 'Speech\nSecond paragraph');
  assert.equal(isImagePost({ contentKind: 'video' }), false);
  assert.equal(readableTranscript(null), '');
});
