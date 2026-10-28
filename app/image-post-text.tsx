"use client";

import { useState } from 'react';
import { pageText } from '../lib/transcript';
import type { ImagePage } from '../lib/transcript';

function SlideImage({ page }: { page: ImagePage }) {
  const [failed, setFailed] = useState(false);
  if (!page.imageUrl) return null;
  if (failed) return <p className="slide-image-error">Image unavailable.</p>;
  return <a className="slide-image-link" href={page.imageUrl} target="_blank" rel="noreferrer" aria-label={`Open slide ${page.index} image`}>
    {/* Private saved image; only the selected post loads slide imagery. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={page.imageUrl} alt={`Slide ${page.index}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />
  </a>;
}

export default function ImagePostText({ pages, carousel, allText }: {
  pages: ImagePage[]; carousel: boolean; allText: boolean;
}) {
  return <div className="image-post-pages">
    {pages.map(page => {
      const text = pageText(page, allText);
      return <section className={`image-post-page ${page.imageUrl ? 'has-slide-image' : ''}`} key={page.index} aria-label={carousel ? `Slide ${page.index}` : 'Image text'}>
        {carousel && <h3>Slide {page.index}</h3>}
        <div className="slide-content"><div className="slide-text">{text.trim() ? <p>{text}</p> : <p className="no-speech">No text detected.</p>}</div><SlideImage page={page} /></div>
      </section>;
    })}
  </div>;
}
