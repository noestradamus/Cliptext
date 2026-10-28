"use client";

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { isImagePost } from '../lib/transcript';
import type { FullJob, JobChanges } from './library-controls';

export default function JobEditor({ job, saving, onSave, onClose }: {
  job: FullJob; saving: boolean; onSave: (changes: JobChanges) => Promise<boolean>; onClose: () => void;
}) {
  const [title, setTitle] = useState(job.title ?? '');
  const [transcript, setTranscript] = useState(job.transcript ?? '');
  const [pages, setPages] = useState(job.pages?.map(page => ({ index: page.index, text: page.text })) ?? []);
  const [revision, setRevision] = useState(job.revision);
  const baseline = useRef({ title: job.title ?? '', transcript: job.transcript ?? '', pages: JSON.stringify(job.pages?.map(page => ({ index: page.index, text: page.text })) ?? []) });
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, []);
  function loadSaved() {
    setTitle(job.title ?? ''); setTranscript(job.transcript ?? ''); setPages(job.pages?.map(page => ({ index: page.index, text: page.text })) ?? []);
    baseline.current = { title: job.title ?? '', transcript: job.transcript ?? '', pages: JSON.stringify(job.pages?.map(page => ({ index: page.index, text: page.text })) ?? []) };
    setRevision(job.revision); titleRef.current?.focus();
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const changes: JobChanges = { expectedRevision: revision };
    if (title.trim() !== baseline.current.title) changes.title = title.trim();
    if (job.status === 'completed') {
      if (isImagePost(job) && pages.length) { if (JSON.stringify(pages) !== baseline.current.pages) changes.pages = pages; }
      else if (transcript !== baseline.current.transcript) changes.transcript = transcript;
    }
    if (Object.keys(changes).length === 1 || await onSave(changes)) onClose();
  }
  return <form className="transcript-editor" onSubmit={save} aria-label="Edit transcript">
    {job.revision !== revision && <div className="edit-conflict" role="status"><p>This item changed while you were editing.</p><button type="button" className="text-button" disabled={saving} onClick={loadSaved}>Load saved version</button><button type="button" className="text-button" disabled={saving} onClick={() => setRevision(job.revision)}>Keep my draft</button></div>}
    <label htmlFor="edit-title">Title</label><input ref={titleRef} id="edit-title" value={title} maxLength={500} disabled={saving} onChange={event => setTitle(event.target.value)} />
    {job.status === 'completed' && (isImagePost(job) && pages.length ? pages.map((page, index) => <div className="page-editor" key={page.index}><label htmlFor={`edit-page-${page.index}`}>Slide {page.index}</label><textarea id={`edit-page-${page.index}`} value={page.text} rows={Math.min(12, Math.max(4, page.text.split('\n').length))} maxLength={250000} disabled={saving} onChange={event => setPages(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, text: event.target.value } : item))} /></div>) : <><label htmlFor="edit-transcript">Transcript</label><textarea id="edit-transcript" value={transcript} rows={14} maxLength={250000} disabled={saving} onChange={event => setTranscript(event.target.value)} /></>)}
    <div className="inline-form-actions"><button className="button-primary" disabled={saving || job.revision !== revision}>{saving ? 'Saving…' : 'Save'}</button><button type="button" className="button-secondary" disabled={saving} onClick={onClose}>Cancel</button></div>
  </form>;
}
