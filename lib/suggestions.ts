/** Proposal limits are separate from the owner's twelve saved tags. */
export const MAX_SUGGESTED_TAGS = 3;
export const MAX_SAVED_TAGS = 12;
export type Suggestions = { collectionId: string | null; tags: string[] };

function tagKey(value: string) {
  return value.trim().normalize('NFKC').replace(/^#+/, '').toLocaleLowerCase();
}

/** Safe for old stored proposals as well as already validated worker output. */
export function limitedSuggestedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const tag = tagKey(item);
    if (!tag || tag.length > 32 || /[\u0000-\u001f\u007f,]/.test(tag) || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length === MAX_SUGGESTED_TAGS) break;
  }
  return tags;
}

export function limitedSuggestions(value: unknown): Suggestions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const suggestion = value as Record<string, unknown>;
  return {
    collectionId: typeof suggestion.collectionId === 'string' ? suggestion.collectionId : null,
    tags: limitedSuggestedTags(suggestion.tags),
  };
}

/** UI and Apply share this selection: never fill gaps from hidden proposals. */
export function visibleSuggestedTags(proposed: unknown, saved: string[]): string[] {
  const existing = new Set(saved.map(tagKey));
  const capacity = Math.max(0, MAX_SAVED_TAGS - saved.length);
  return limitedSuggestedTags(proposed).filter(tag => !existing.has(tagKey(tag))).slice(0, capacity);
}
