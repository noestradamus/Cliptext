export type ImagePage = { index: number; text: string; allText?: string; imageUrl?: string | null };
export type TranscriptSource = {
  contentKind?: 'video' | 'image' | 'carousel';
  transcript: string | null;
  pages?: ImagePage[] | null;
};

export function isImagePost(job: { contentKind?: string } | null | undefined) {
  return job?.contentKind === 'image' || job?.contentKind === 'carousel';
}

export function pageText(page: ImagePage, allText: boolean) {
  return allText ? page.allText ?? page.text : page.text;
}

/** Copy and text-file exports follow the reading mode; collection exports use the saved main text. */
export function readableTranscript(job: TranscriptSource | null, allText = false) {
  if (!job) return '';
  if (!isImagePost(job) || !job.pages?.length) return job.transcript ?? '';
  if (job.contentKind === 'image') return pageText(job.pages[0], allText);
  return job.pages.map(page => `Slide ${page.index}\n${pageText(page, allText)}`).join('\n\n');
}

export function hasFullOcrText(job: TranscriptSource | null) {
  return isImagePost(job) && !!job?.pages?.some(page => page.allText !== undefined && page.allText !== page.text);
}
