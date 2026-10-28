/** Shared validation for user edits, local AI output and backup import. */
export type Highlight = { id: string; quote: string; note: string };
export type Insights = { summary: string; takeaways: string[]; resources: { label: string; url?: string }[] };
export const MAX_TEXT = 250_000;
/** A summary is one compact sentence, including legacy and imported results. */
export function shortSummary(value: string): string {
  const text = value.replace(/\s+/gu, ' ').trim().replace(/^(?:[-*•]\s+|\d+[.)]\s+)/u, '');
  const ending = /[。！？]|[.!?](?=\s|$)/u.exec(text);
  const sentence = ending ? text.slice(0, ending.index + ending[0].length) : text;
  const words = sentence.split(' ');
  const bounded = words.slice(0, 16).join(' ');
  const characters = Array.from(bounded);
  if (words.length <= 16 && characters.length <= 100) return sentence;
  let clipped = characters.slice(0, 99).join('');
  if (characters.length > 99 && !/\s/u.test(characters[99]) && clipped.includes(' ')) clipped = clipped.slice(0, clipped.lastIndexOf(' '));
  return clipped.replace(/[\s,;:–—.!?。！？…-]+$/u, '') + '…';
}
export function checkedText(value: unknown, max: number, label: string, empty = true): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /\u0000/.test(value)) throw new Error(`${label} must be ${empty ? 'at most' : '1–'}${max.toLocaleString('en-US')} characters.`);
  return value;
}
export function checkedHighlights(value: unknown): Highlight[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Keep up to 100 highlights.');
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Check the highlights.');
    const id = checkedText(item.id, 100, 'Highlight ID', false);
    if (ids.has(id)) throw new Error('Highlight IDs must be unique.');
    ids.add(id);
    return {id, quote: checkedText(item.quote, 10_000, 'Highlight', false), note: checkedText(item.note ?? '', 10_000, 'Highlight note')};
  });
}
export function checkedPages(value: unknown, originals: {index: number; text: string; allText?: string}[]) {
  if (!Array.isArray(value) || value.length !== originals.length) throw new Error('Keep every slide in its original order.');
  let length = 0;
  return value.map((page, i) => {
    if (!page || typeof page !== 'object' || page.index !== i + 1) throw new Error('Keep every slide in its original order.');
    const text = checkedText(page.text, MAX_TEXT, 'Slide text');
    length += text.length;
    if (length > MAX_TEXT) throw new Error('The edited text is too large.');
    return {...originals[i], text};
  });
}
export function pagesTranscript(pages: {index:number; text:string}[], kind: string) {
  return kind === 'image' ? pages[0]?.text ?? '' : pages.map(p => `Slide ${p.index}\n${p.text}`).join('\n\n');
}
export function parsed<T>(value: unknown, fallback: T): T {
  try { return typeof value === 'string' ? JSON.parse(value) as T : fallback; } catch { return fallback; }
}
export function checkedInsights(value: unknown, source: string): Insights {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A summary is required.');
  const v = value as Record<string, unknown>;
  const summary = shortSummary(checkedText(v.summary, 8000, 'Summary'));
  if (!Array.isArray(v.takeaways) || v.takeaways.length > 20) throw new Error('Keep up to 20 takeaways.');
  const takeaways = v.takeaways.map(t => checkedText(t, 2000, 'Takeaway', false));
  if (!Array.isArray(v.resources) || v.resources.length > 30) throw new Error('Keep up to 30 resources.');
  const resources = v.resources.map(r => {
    if (!r || typeof r !== 'object') throw new Error('Check the resource.');
    const label = checkedText(r.label, 500, 'Resource label', false);
    if (!r.url) return {label};
    const url = checkedText(r.url, 2000, 'Resource URL', false);
    if (!/^https?:\/\//i.test(url) || !source.includes(url)) throw new Error('Resource links must occur in the source text.');
    const parsed = new URL(url); if (parsed.username || parsed.password) throw new Error('Resource links must not include credentials.');
    return {label, url};
  });
  return {summary, takeaways, resources};
}
export function canonicalIdentity(platform: string, url: string): string | null {
  let u: URL; try {u = new URL(url);} catch { return null; }
  if (platform === 'youtube') { const id = u.hostname === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1]; return id && /^[\w-]{11}$/.test(id) ? `youtube:${id}` : null; }
  if (platform === 'instagram') { const id = u.pathname.match(/^\/(?:p|reel|reels|tv)\/([\w-]+)/)?.[1]; return id ? `instagram:${id}` : null; }
  if (platform === 'tiktok') { const id = u.pathname.match(/\/(?:video|photo)\/(\d+)/)?.[1]; return id ? `tiktok:${id}` : null; }
  return null;
}
