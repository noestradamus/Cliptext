/** Collection proposals need evidence in the extracted words, not list position. */
const COLLECTION_TOPICS: Record<string, string[]> = {
  design: ['design', 'typography', 'layout', 'interface', 'ui', 'ux', 'hierarchy', 'neumorphism', 'usability', 'font', 'fonts', 'デザイン', '配色', 'レイアウト'],
  marketing: ['marketing', 'pricing', 'price', 'prices', 'branding', 'brand', 'advertising', 'campaign', 'campaigns', 'sales', 'マーケティング', '価格', 'ブランディング'],
  security: ['security', 'privacy', 'encryption', 'password', 'passwords', 'authentication', 'vulnerability', 'vulnerabilities', 'malware', 'セキュリティ', '暗号化', 'パスワード'],
};
const GENERIC = new Set(['the', 'and', 'for', 'from', 'with', 'my', 'our', 'saved', 'collection', 'collections', 'notes', 'videos', 'posts', 'library', 'folder']);
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const tokens = (value: string) => normalize(value).match(/[\p{L}\p{N}]+/gu) ?? [];
const cjk = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u;

export function collectionMatchesSource(name: unknown, source: unknown): boolean {
  if (typeof name !== 'string' || typeof source !== 'string') return false;
  const text = normalize(source).replace(/https?:\/\/[^\s<>]+/gu, ' ');
  const sourceTokens = new Set(tokens(text));
  const label = normalize(name).trim();
  const matches = (term: string) => cjk.test(term) ? text.includes(term) : sourceTokens.has(term);
  if (COLLECTION_TOPICS[label]) return COLLECTION_TOPICS[label].some(matches);
  const terms = [...new Set(tokens(label).filter(term => (cjk.test(term) ? term.length >= 2 : term.length > 2) && !GENERIC.has(term)))];
  return terms.length > 0 && terms.filter(matches).length / terms.length >= .5;
}

/** Keep existing saved organisation intact; filter only the proposed move. */
export function relevantCollectionId(proposed: unknown, collection: Record<string, unknown> | null | undefined, source: unknown): string | null {
  return typeof proposed === 'string' && collection?.id === proposed && collectionMatchesSource(collection.name, source) ? proposed : null;
}
