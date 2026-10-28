import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTikTokUrl } from '../lib/tiktok.ts';

test('Android shared text accepts a short link amid commentary', () => {
  assert.equal(extractTikTokUrl('A useful video: https://vt.tiktok.com/AbCdEf12/ Watch this!'), 'https://vt.tiktok.com/AbCdEf12/');
});
test('canonical video URLs lose tracking parameters and surrounding punctuation', () => {
  assert.equal(extractTikTokUrl('(https://www.tiktok.com/@example_creator/video/7000000000000000001?_r=1&_t=abc).'), 'https://www.tiktok.com/@example_creator/video/7000000000000000001');
});
test('canonical photo posts retain their path and lose tracking parameters', () => {
  assert.equal(extractTikTokUrl('Slides: (https://www.tiktok.com/@creator/photo/7000000000000000001?photo_id=123&utm_source=share).'), 'https://www.tiktok.com/@creator/photo/7000000000000000001');
});
test('photo URLs keep exact-host, identifier and traversal validation', () => {
  for (const value of ['https://tiktok.com.evil.example/@creator/photo/7000000000000000001', 'https://www.tiktok.com/@creator/photo/not-a-number', 'https://www.tiktok.com/@creator/photo/123', 'https://www.tiktok.com/@creator/photo/../photo/7000000000000000001', 'https://www.tiktok.com/@creator/%2e%2e/photo/7000000000000000001', 'https://www.tiktok.com/@creator/photo/7000000000000000001/extra', 'https://user:pass@www.tiktok.com/@creator/photo/7000000000000000001']) assert.equal(extractTikTokUrl(value), null, value);
});
test('rejects arbitrary network locations, credentials, profiles and HTTP', () => {
  for (const value of ['https://127.0.0.1/video/7000000000000000001', 'https://tiktok.com.evil.example/abcd', 'https://tiktok.com@evil.example/abcd', 'https://user:pass@vt.tiktok.com/AbCdEf12/', 'https://vt.tiktok.com:8443/AbCdEf12/', 'http://vt.tiktok.com/AbCdEf12/', 'https://www.tiktok.com/@example_creator', 'https://vt.tiktok.com/../../secret', '', 'x'.repeat(12001)]) assert.equal(extractTikTokUrl(value), null, value.slice(0, 100));
});
test('extracts the TikTok URL even after a non-TikTok URL', () => {
  assert.equal(extractTikTokUrl('Ignore https://example.com/ hello https://vm.tiktok.com/ZAbCdEfG/'), 'https://vm.tiktok.com/ZAbCdEfG/');
});
