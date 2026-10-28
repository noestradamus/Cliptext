"use client";

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { jobLabel } from './library-controls';
import type { FullJob } from './library-controls';

export default function VideoPreview({ job, engineOnline, disabled, onRetry }: {
  job: FullJob; engineOnline?: boolean; disabled: boolean; onRetry: (id: string) => Promise<void>;
}) {
  const [reload, setReload] = useState(0);
  const [loadedSource, setLoadedSource] = useState('');
  const [failedSource, setFailedSource] = useState('');
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');

  async function retry() {
    if (retrying || disabled) return;
    setRetrying(true); setRetryError('');
    try { await onRetry(job.id); }
    catch (error) { setRetryError(error instanceof Error ? error.message : 'The preview couldn’t be requested. Try again.'); }
    finally { setRetrying(false); }
  }

  if (job.frameStatus === 'ready' && job.frameUrl) {
    const source = reload ? `${job.frameUrl}${job.frameUrl.includes('?') ? '&' : '?'}reload=${reload}` : job.frameUrl;
    const failed = failedSource === source;
    const loaded = loadedSource === source;
    const kind = job.contentKind === 'carousel' ? 'First slide' : job.contentKind === 'image' ? 'Image preview' : job.frameKind === 'first_frame' ? 'First frame' : 'Thumbnail';
    const ratio = job.frameWidth && job.frameHeight && job.frameWidth > 0 && job.frameHeight > 0 ? job.frameWidth / job.frameHeight : 16 / 9;
    const style = {
      '--preview-width': `${Math.min(160, 180 * ratio)}px`,
      '--preview-height': `${Math.min(180, 160 / ratio)}px`,
      '--preview-mobile-width': `${Math.min(96, 128 * ratio)}px`,
      '--preview-mobile-height': `${Math.min(128, 96 / ratio)}px`,
      '--preview-small-width': `${Math.min(80, 108 * ratio)}px`,
      '--preview-small-height': `${Math.min(108, 80 / ratio)}px`,
    } as CSSProperties;

    return <div className="video-preview" style={style}>
      {!failed && <a className="video-preview-link" href={job.frameUrl} target="_blank" rel="noreferrer" aria-label={`Open ${kind.toLowerCase()} for ${jobLabel(job)} in a new tab`} title={`Open ${kind.toLowerCase()}`}>
        {/* Private, stored image; the API supplies its dimensions and original aspect ratio. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={source} alt={`${kind} for ${jobLabel(job)}`} width={job.frameWidth ?? undefined} height={job.frameHeight ?? undefined} className={loaded ? 'is-loaded' : ''} onLoad={() => setLoadedSource(source)} onError={() => setFailedSource(source)} />
      </a>}
      {(!loaded || failed) && <div className={`video-preview-feedback${failed ? ' is-error' : ''}`} role="status">
        {failed ? <button type="button" className="text-button" aria-label="Preview unavailable. Reload image" title="Preview unavailable. Reload image" onClick={() => setReload((current) => current + 1)}><span>Unavailable</span><span>Reload</span></button> : <span aria-label="Loading preview">Loading…</span>}
      </div>}
    </div>;
  }

  if (job.status !== 'completed' || !job.frameStatus) return null;
  if (job.frameStatus === 'pending' || job.frameStatus === 'processing') {
    return <div className="video-preview-status" role="status">{job.frameStatus === 'processing' ? 'Saving preview…' : engineOnline === false ? 'Preview waiting for Mac' : 'Preview queued'}</div>;
  }

  return <div className="video-preview-status">
    <span>Preview unavailable</span><button type="button" className="text-button" disabled={disabled || retrying} onClick={() => void retry()}>{retrying ? 'Requesting…' : 'Retry preview'}</button>
    {retryError && <p className="field-error" role="alert">{retryError}</p>}
  </div>;
}
