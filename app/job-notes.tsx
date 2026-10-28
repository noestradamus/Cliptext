"use client";

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { FullJob, JobChanges } from './library-controls';

export default function JobNotes({ job, saving, onSave, onDirty }: { job: FullJob; saving: boolean; onSave: (changes: JobChanges) => Promise<boolean>; onDirty: (dirty: boolean) => void }) {
  const [notes, setNotes] = useState(job.notes ?? '');
  const [noteRevision, setNoteRevision] = useState(job.revision);
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) { setNotes(job.notes ?? ''); setNoteRevision(job.revision); } }, [job.notes, job.revision, dirty]);
  useEffect(() => { onDirty(dirty); }, [dirty]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  async function saveNotes(event: FormEvent) { event.preventDefault(); if (await onSave({ notes, expectedRevision: noteRevision })) setDirty(false); }
  return <section className="job-notes" aria-labelledby="notes-heading">
    <h3 id="notes-heading">Notes</h3>
    <form className="notes-form" onSubmit={saveNotes}>
      <textarea aria-labelledby="notes-heading" id="personal-notes" value={notes} rows={4} maxLength={50000} disabled={saving || !!job.trashedAt} onChange={event => { if (!dirty) setNoteRevision(job.revision); setDirty(true); setNotes(event.target.value); }} />
      {dirty && <div className="inline-form-actions"><button className="text-button" disabled={saving || !!job.trashedAt || job.revision !== noteRevision}>{saving ? 'Saving…' : 'Save'}</button><button type="button" className="text-button muted-button" disabled={saving} onClick={() => { setNotes(job.notes ?? ''); setNoteRevision(job.revision); setDirty(false); }}>Cancel</button></div>}
      {dirty && job.revision !== noteRevision && <div className="edit-conflict" role="status"><p>The saved item changed. Your note draft is still here.</p><button type="button" className="text-button" disabled={saving} onClick={() => setNoteRevision(job.revision)}>Keep my draft</button></div>}
    </form>
  </section>;
}
