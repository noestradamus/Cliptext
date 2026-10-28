/** Compact local-model labels; source and owner-edited titles stay untouched. */
export function checkedGeneratedTitle(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 8000 || /\u0000/u.test(value)) throw new Error('A generated title must be text.');
  const text = value
    .replace(/https?:\/\/\S+|www\.\S+/giu, ' ')
    .replace(/(^|\s)#[\p{L}\p{N}_]+/gu, '$1')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3]/gu, ' ')
    .replace(/[\u0001-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ').trim()
    .replace(/^(?:title\s*:\s*|[-*•]\s+)/iu, '')
    .replace(/^["“”]+|["“”]+$/gu, '').trim();
  const words = text.split(' ').slice(0, 10).join(' ');
  const characters = Array.from(words);
  let title = characters.slice(0, 70).join('');
  if (characters.length > 70 && characters[70] !== ' ' && title.includes(' ')) title = title.slice(0, title.lastIndexOf(' '));
  return title.replace(/[\s,;:–—.!?。！？…-]+$/gu, '') || null;
}
